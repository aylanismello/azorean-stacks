#!/usr/bin/env bun
import { getSupabase } from "../lib/supabase";
import {
  addYield,
  buildTrackSeedLineage,
  emptyYield,
  episodeContextKey,
  estimateYield,
  recencyWeight,
  resolveUserId,
  type YieldAccumulator,
} from "../lib/taste-scoring";

interface SignalAccumulator {
  positive: number;
  negative: number;
  samples: number;
}

async function main() {
  console.log(`\n=== Update Taste Signals ===`);
  console.log(`Time: ${new Date().toISOString()}\n`);

  const db = getSupabase();

  // Parse --user-id CLI arg. Without one, update every user with explicit
  // decisions; never choose an arbitrary "first" account.
  let explicitUserId: string | null = null;
  const userIdArgIdx = process.argv.indexOf("--user-id");
  if (userIdArgIdx !== -1 && process.argv[userIdArgIdx + 1]) {
    explicitUserId = process.argv[userIdArgIdx + 1];
  }

  const detectedUserIds: string[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db
      .from("user_tracks")
      .select("user_id")
      .not("user_id", "is", null)
      .in("status", ["approved", "rejected", "skipped"])
      .range(from, from + 999);
    if (error) throw error;
    detectedUserIds.push(...(data || []).map((row: any) => row.user_id));
    if (!data || data.length < 1000) break;
  }
  const userIds = explicitUserId
    ? [resolveUserId(explicitUserId, detectedUserIds)]
    : Array.from(new Set(detectedUserIds)).sort();
  if (!userIds.length) {
    console.log("No users with explicit votes found.");
    return;
  }
  console.log(`${explicitUserId ? "User filter" : "Users detected"}: ${userIds.join(", ")}`);

  for (const userId of userIds) {
    console.log(`\n--- User ${userId} ---`);
    // All outcomes come from this user's user_tracks. tracks.status is pipeline/
    // legacy state and must never be used as a taste label.
    const { data: userVotes, error: uvError } = await db
      .from("user_tracks")
      .select("track_id, status, super_liked, voted_at")
      .eq("user_id", userId)
      .in("status", ["approved", "rejected", "skipped"]);
    if (uvError) throw uvError;
    if (!userVotes || userVotes.length === 0) continue;

    const votedTrackIds = userVotes.map((vote: any) => vote.track_id);
    const userVoteMap = new Map<string, any>(userVotes.map((vote: any) => [vote.track_id, vote]));
    const tracksData: any[] = [];
    for (let i = 0; i < votedTrackIds.length; i += 300) {
      const { data, error } = await db
        .from("tracks")
        .select("id, artist, title, metadata, episode_id, seed_track_id")
        .in("id", votedTrackIds.slice(i, i + 300));
      if (error) throw error;
      tracksData.push(...(data || []));
    }

    // Merge only this user's outcome; never fall back to global tracks.status.
    const tracks = tracksData.map((track: any) => {
      const vote = userVoteMap.get(track.id);
      return { ...track, status: vote!.status, _super_liked: !!vote!.super_liked, _voted_at: vote!.voted_at };
    });
    await computeAndUpsertSignals(db, tracks, userId);
  }
}

// ─── CORE SIGNAL COMPUTATION ──────────────────────────────────────────────────
// Computes taste signals from the given voted tracks and upserts them into
// taste_signals scoped to the given userId.

async function computeAndUpsertSignals(db: any, tracks: any[], userId: string) {
  console.log(`Processing ${tracks.length} voted tracks`);

  // Fetch super-liked track IDs (scoped to user when userId is set)
  let superLikedQuery = db.from("user_tracks").select("track_id").eq("super_liked", true);
  if (userId) superLikedQuery = (superLikedQuery as any).eq("user_id", userId);
  const { data: superLikedRows } = await superLikedQuery;
  const superLikedSet = new Set((superLikedRows || []).map((r: any) => r.track_id as string));

  const signals = new Map<string, SignalAccumulator>();

  function addSignal(type: string, value: string, weight: number) {
    const key = `${type}::${value.toLowerCase().trim()}`;
    const existing = signals.get(key) || { positive: 0, negative: 0, samples: 0 };
    if (weight > 0) {
      existing.positive += weight;
    } else {
      existing.negative += Math.abs(weight);
    }
    existing.samples++;
    signals.set(key, existing);
  }

  function setYieldSignal(type: string, value: string, estimate: NonNullable<ReturnType<typeof estimateYield>>) {
    const key = `${type}::${value.toLowerCase().trim()}`;
    signals.set(key, {
      positive: (estimate.signal + 1) / 2,
      negative: (1 - estimate.signal) / 2,
      samples: estimate.samples,
    });
  }

  function trackWeight(track: any): number {
    // For user-path tracks, _super_liked flag is already merged in
    if (track._super_liked || superLikedSet.has(track.id)) return 3.0;
    if (track.status === "approved") return 1.0;
    if (track.status === "skipped") return -0.3;
    return -1.0; // rejected
  }

  const globalYield = emptyYield();
  for (const track of tracks) {
    addYield(globalYield, trackWeight(track), recencyWeight(track._voted_at));
  }
  const globalRate = globalYield.positive + globalYield.negative > 0
    ? globalYield.positive / (globalYield.positive + globalYield.negative)
    : 0.5;

  for (const track of tracks) {
    const weight = trackWeight(track);

    // Artist signal (improved: stronger negative for heavy rejecters)
    if (track.artist) {
      addSignal("artist", track.artist, weight);
    }

    // Extract signals from metadata
    const meta = (track.metadata || {}) as Record<string, unknown>;

    if (Array.isArray(meta.genres)) {
      for (const g of meta.genres) {
        if (typeof g === "string") addSignal("genre", g, weight);
      }
    }

    // NOTE: album signal removed — too sparse, mostly noise
  }

  // ─── SEED AFFINITY SIGNALS ────────────────────────────────
  // Seeds with high approval rate → boost tracks from those seeds
  console.log(`\nComputing seed affinity signals...`);

  const { data: seeds } = await db
    .from("seeds")
    .select("id, track_id, artist, title")
    .eq("active", true)
    .eq("user_id", userId);

  if (seeds && seeds.length > 0) {
    const trackIds = tracks.map((track: any) => track.id);
    const seedIds = seeds.map((seed: any) => seed.id);
    const [{ data: trackEpisodeLinks }, { data: episodeSeedLinks }] = await Promise.all([
      db.from("episode_tracks").select("track_id, episode_id").in("track_id", trackIds),
      db.from("episode_seeds").select("episode_id, seed_id, match_type").in("seed_id", seedIds),
    ]);
    const lineageByTrack = buildTrackSeedLineage(
      tracks,
      trackEpisodeLinks || [],
      episodeSeedLinks || [],
      seeds
    );
    const tracksBySeed = new Map<string, YieldAccumulator>();

    for (const track of tracks) {
      for (const [seedId, matchType] of lineageByTrack.get(track.id) || []) {
        const matchWeight = matchType === "full" ? 1 : matchType === "artist" ? 0.65 : 0.4;
        const acc = tracksBySeed.get(seedId) || emptyYield();
        addYield(acc, trackWeight(track) * matchWeight, recencyWeight(track._voted_at));
        tracksBySeed.set(seedId, acc);
      }
    }

    for (const seed of seeds) {
      const acc = tracksBySeed.get(seed.id);
      if (!acc) continue;
      const estimate = estimateYield(acc, globalRate);
      if (estimate) setYieldSignal("seed_affinity", seed.id, estimate);
    }
  }

  // ─── CURATOR QUALITY SIGNALS ──────────────────────────────
  // NTS show curators with consistent approval rates boost their episode tracks
  console.log(`Computing curator quality signals...`);

  const { data: curators } = await db
    .from("curators")
    .select("id, slug");
  console.log(`Computing episode and show yield signals...`);
  const votedEpisodeIds = Array.from(new Set(tracks.map((track: any) => track.episode_id).filter(Boolean)));
  const { data: votedEpisodes } = votedEpisodeIds.length > 0
    ? await db.from("episodes").select("id, curator_id, source, url, title").in("id", votedEpisodeIds)
    : { data: [] };
  const episodeMap = new Map<string, any>((votedEpisodes || []).map((episode: any) => [episode.id, episode]));
  const curatorSlugMap = new Map<string, string>((curators || []).map((curator: any) => [curator.id, curator.slug]));
  const curatorStats = new Map<string, YieldAccumulator>();
  const contextStats = new Map<string, YieldAccumulator>();
  const episodeStats = new Map<string, YieldAccumulator>();

  for (const track of tracks) {
    if (!track.episode_id) continue;
    const episode = episodeMap.get(track.episode_id);
    const outcome = trackWeight(track);
    const decay = recencyWeight(track._voted_at);
    const epAcc = episodeStats.get(track.episode_id) || emptyYield();
    addYield(epAcc, outcome, decay);
    episodeStats.set(track.episode_id, epAcc);

    const contextKey = episode ? episodeContextKey(episode) : null;
    if (contextKey) {
      const acc = contextStats.get(contextKey) || emptyYield();
      addYield(acc, outcome, decay);
      contextStats.set(contextKey, acc);
    }
    const slug = episode?.curator_id ? curatorSlugMap.get(episode.curator_id) : null;
    if (slug) {
      const acc = curatorStats.get(slug) || emptyYield();
      addYield(acc, outcome, decay);
      curatorStats.set(slug, acc);
    }
  }

  for (const [slug, acc] of curatorStats) {
    const estimate = estimateYield(acc, globalRate);
    if (estimate) setYieldSignal("curator", slug, estimate);
  }
  for (const [context, acc] of contextStats) {
    const estimate = estimateYield(acc, globalRate);
    if (estimate) setYieldSignal("source_context", context, estimate);
  }
  for (const [episodeId, acc] of episodeStats) {
    const estimate = estimateYield(acc, globalRate);
    if (estimate) setYieldSignal("episode_density", episodeId, estimate);
  }

  // ─── CO-OCCURRENCE SIGNALS ──────────────────────────────────
  // Artists appearing across multiple seed episodes → positive signal
  console.log(`Computing co-occurrence signals...`);

  // Build artist → set of episode IDs from voted tracks
  const artistEpisodes = new Map<string, Set<string>>();
  for (const track of tracks) {
    if (!track.artist || !track.episode_id) continue;
    const key = track.artist.toLowerCase().trim();
    if (!artistEpisodes.has(key)) artistEpisodes.set(key, new Set());
    artistEpisodes.get(key)!.add(track.episode_id);
  }

  for (const [artistKey, epSet] of artistEpisodes) {
    if (epSet.size >= 2) {
      // Normalize: log scale so 2 episodes = moderate, 5+ = strong
      const strength = Math.min(1.0, Math.log2(epSet.size) / 3);
      addSignal("co_occurrence", artistKey, strength);
    }
  }

  console.log(`Computed ${signals.size} unique signals`);

  // ─── ARTIST NEGATIVE SIGNAL IMPROVEMENT ───────────────────
  // Artists with >3 negative weight and <25% positive rate get extra negative weight
  // We do this by boosting the negative accumulator
  for (const [key, acc] of signals) {
    if (!key.startsWith("artist::")) continue;
    const total = acc.positive + acc.negative;
    const rate = total > 0 ? acc.positive / total : 0;
    if (acc.negative > 3 && rate < 0.25) {
      // Add extra negative weight — effectively increases the negative signal
      acc.negative = Math.round(acc.negative * 1.5);
      signals.set(key, acc);
    }
  }

  // Remove stale values for this user before writing the complete fresh profile.
  const { error: clearSignalsError } = await db
    .from("taste_signals")
    .delete()
    .eq("user_id", userId);
  if (clearSignalsError) throw clearSignalsError;

  // Upsert signals
  let upserted = 0;
  let errors = 0;

  for (const [key, acc] of signals) {
    const [signalType, value] = key.split("::");
    const totalWeight = acc.positive + acc.negative;
    const weight = totalWeight > 0 ? (acc.positive - acc.negative) / totalWeight : 0;

    const { error: upsertError } = await db.from("taste_signals").upsert(
      {
        user_id: userId,
        signal_type: signalType,
        value,
        weight: Math.round(weight * 1000) / 1000,
        sample_count: acc.samples,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id,signal_type,value" }
    );

    if (upsertError) {
      console.error(`  Failed to upsert ${key}: ${upsertError.message}`);
      errors++;
    } else {
      upserted++;
    }
  }

  console.log(`\n=== Summary ===`);
  console.log(`Signals upserted: ${upserted}`);
  console.log(`Errors: ${errors}`);

  // Show top positive signals (scoped to this user)
  let topSignalsQuery = db
    .from("taste_signals")
    .select("*")
    .gt("weight", 0)
    .order("weight", { ascending: false })
    .limit(10);
  if (userId) {
    topSignalsQuery = (topSignalsQuery as any).eq("user_id", userId);
  } else {
    topSignalsQuery = (topSignalsQuery as any).is("user_id", null);
  }
  const { data: topSignals } = await topSignalsQuery;

  if (topSignals && topSignals.length > 0) {
    console.log(`\nTop positive signals:`);
    for (const s of topSignals) {
      console.log(
        `  ${s.signal_type}:${s.value} — weight: ${s.weight} (${s.sample_count} samples)`
      );
    }
  }

  // ─── SCORE PENDING TRACKS ─────────────────────────────────
  // Lineage/show context carry more weight than broad genre labels.
  //   match_type: bonus +0.10 for full match, -0.05 for artist-only (applied post-score)

  console.log(`\n=== Scoring Pending Tracks ===`);

  // Bayesian dampening: weight * samples / (samples + prior)
  // With prior=3: 1 sample → 25%, 3 → 50%, 6 → 67%, 10 → 77%, 20 → 87%
  const CONFIDENCE_PRIOR = 3;

  // Load signals scoped to this user (or null for legacy global signals)
  let allSignalsQuery = db
    .from("taste_signals")
    .select("signal_type, value, weight, sample_count");
  if (userId) {
    allSignalsQuery = (allSignalsQuery as any).eq("user_id", userId);
  } else {
    allSignalsQuery = (allSignalsQuery as any).is("user_id", null);
  }
  const { data: allSignals } = await allSignalsQuery;

  const signalMap = new Map<string, number>();
  const signalConfidenceMap = new Map<string, number>();
  for (const s of allSignals || []) {
    const samples = s.sample_count || 0;
    const dampened = s.weight * (samples / (samples + CONFIDENCE_PRIOR));
    const key = `${s.signal_type}::${s.value}`;
    signalMap.set(key, dampened);
    signalConfidenceMap.set(key, samples / (samples + CONFIDENCE_PRIOR));
  }

  // Fetch all pending tracks (paginate past 1000-row cap)
  const pending: any[] = [];
  let page = 0;
  while (true) {
    const { data: batch } = await db
      .from("tracks")
      .select("id, artist, metadata, episode_id, seed_track_id")
      .eq("status", "pending")
      .range(page * 1000, (page + 1) * 1000 - 1);
    if (!batch || batch.length === 0) break;
    pending.push(...batch);
    if (batch.length < 1000) break;
    page++;
  }

  console.log(`Scoring ${pending.length} pending tracks`);

  const pendingTrackIds = pending.map((track: any) => track.id);
  const seedIds = (seeds || []).map((seed: any) => seed.id);
  const [{ data: pendingEpisodeLinks }, { data: scopedEpisodeSeedLinks }] = await Promise.all([
    pendingTrackIds.length > 0
      ? db.from("episode_tracks").select("track_id, episode_id").in("track_id", pendingTrackIds)
      : Promise.resolve({ data: [] }),
    seedIds.length > 0
      ? db.from("episode_seeds").select("episode_id, seed_id, match_type").in("seed_id", seedIds)
      : Promise.resolve({ data: [] }),
  ]);
  const pendingLineage = buildTrackSeedLineage(
    pending,
    pendingEpisodeLinks || [],
    scopedEpisodeSeedLinks || [],
    seeds || []
  );

  // Build per-episode vote stats for negative penalties
  const episodeVoteStats = new Map<string, { approved: number; rejected: number }>();
  for (const track of tracks) {
    if (!track.episode_id) continue;
    const w = trackWeight(track);
    const acc = episodeVoteStats.get(track.episode_id) || { approved: 0, rejected: 0 };
    if (w > 0) acc.approved++;
    else if (w < -0.5) acc.rejected++; // rejected (not skipped)
    episodeVoteStats.set(track.episode_id, acc);
  }

  // Build episode → best match_type lookup for match_type scoring boost
  // "full" match = seed track was in the tracklist, "artist" = only the artist appeared
  const episodeMatchType = new Map<string, string>();
  {
    let mtPage = 0;
    while (true) {
      if (seedIds.length === 0) break;
      const { data: mtBatch } = await db
        .from("episode_seeds")
        .select("episode_id, match_type")
        .in("seed_id", seedIds)
        .range(mtPage * 1000, (mtPage + 1) * 1000 - 1);
      if (!mtBatch || mtBatch.length === 0) break;
      for (const row of mtBatch as any[]) {
        const existing = episodeMatchType.get(row.episode_id);
        // "full" is stronger than "artist" or "unknown"
        if (!existing || row.match_type === "full") {
          episodeMatchType.set(row.episode_id, row.match_type || "unknown");
        }
      }
      if (mtBatch.length < 1000) break;
      mtPage++;
    }
    console.log(`Loaded match_type for ${episodeMatchType.size} episodes`);
  }

  // Build episode → curator lookup for pending tracks
  const { data: epCuratorLinks } = await db
    .from("episodes")
    .select("id, curator_id, source, url, title");

  const epToCuratorMap = new Map<string, string>();
  const epToContextMap = new Map<string, string>();
  if (epCuratorLinks) {
    for (const ep of epCuratorLinks) {
      if (ep.curator_id) epToCuratorMap.set(ep.id, ep.curator_id);
      const context = episodeContextKey(ep);
      if (context) epToContextMap.set(ep.id, context);
    }
  }

  // Build curator id → slug map
  const curatorIdToSlug = new Map<string, string>();
  if (curators) {
    for (const c of curators as any[]) {
      curatorIdToSlug.set(c.id, c.slug);
    }
  }

  let scored = 0;
  let scoreErrors = 0;

  // Batch updates: collect scores then update in chunks
  const updates: Array<{
    id: string;
    taste_score: number;
    score_components: Record<string, number>;
    confidence: number;
  }> = [];

  for (const track of pending) {
    const meta = (track.metadata || {}) as Record<string, unknown>;
    const components: Array<{ weight: number; typeWeight: number }> = [];
    const componentConfidences: Array<{ confidence: number; typeWeight: number }> = [];

    // Artist signal (0.18)
    const artistKey = `artist::${(track.artist || "").toLowerCase().trim()}`;
    const artistSignal = signalMap.get(artistKey);
    const scoreComponents: Record<string, number> = {};
    if (artistSignal !== undefined) {
      components.push({ weight: artistSignal, typeWeight: 0.18 });
      componentConfidences.push({ confidence: signalConfidenceMap.get(artistKey) || 0, typeWeight: 0.18 });
      scoreComponents.artist = Math.round(artistSignal * 1000) / 1000;
    }

    // Genre is intentionally a weak prior; broad labels are less predictive than lineage.
    const genres = Array.isArray(meta.genres) ? meta.genres : [];
    const genreWeights: number[] = [];
    for (const g of genres) {
      if (typeof g !== "string") continue;
      const w = signalMap.get(`genre::${g.toLowerCase().trim()}`);
      if (w !== undefined) genreWeights.push(w);
    }
    if (genreWeights.length > 0) {
      const avgGenre = genreWeights.reduce((a, b) => a + b, 0) / genreWeights.length;
      components.push({ weight: avgGenre, typeWeight: 0.08 });
      const avgConfidence = genres
        .map((g: unknown) => typeof g === "string" ? signalConfidenceMap.get(`genre::${g.toLowerCase().trim()}`) : undefined)
        .filter((value: number | undefined): value is number => value !== undefined)
        .reduce((sum: number, value: number, _: number, values: number[]) => sum + value / values.length, 0);
      componentConfidences.push({ confidence: avgConfidence, typeWeight: 0.08 });
      scoreComponents.genre = Math.round(avgGenre * 1000) / 1000;
    }

    // Seed affinity (0.24): average every canonical/direct lineage, weighted by match quality.
    const seedAffinities: Array<{ value: number; confidence: number; matchWeight: number }> = [];
    for (const [seedId, matchType] of pendingLineage.get(track.id) || []) {
      const key = `seed_affinity::${seedId.toLowerCase()}`;
      const value = signalMap.get(key);
      if (value === undefined) continue;
      seedAffinities.push({
        value,
        confidence: signalConfidenceMap.get(key) || 0,
        matchWeight: matchType === "full" ? 1 : matchType === "artist" ? 0.65 : 0.4,
      });
    }
    if (seedAffinities.length > 0) {
      const denominator = seedAffinities.reduce((sum, item) => sum + item.matchWeight, 0);
      const seedAffinity = seedAffinities.reduce((sum, item) => sum + item.value * item.matchWeight, 0) / denominator;
      const seedConfidence = seedAffinities.reduce((sum, item) => sum + item.confidence * item.matchWeight, 0) / denominator;
      components.push({ weight: seedAffinity, typeWeight: 0.24 });
      componentConfidences.push({ confidence: seedConfidence, typeWeight: 0.24 });
      scoreComponents.seed = Math.round(seedAffinity * 1000) / 1000;
    }

    // Curator signal (0.12)
    if (track.episode_id) {
      const curatorId = epToCuratorMap.get(track.episode_id);
      if (curatorId) {
        const slug = curatorIdToSlug.get(curatorId);
        if (slug) {
          const curatorKey = `curator::${slug.toLowerCase()}`;
          const curatorWeight = signalMap.get(curatorKey);
          if (curatorWeight !== undefined) {
            components.push({ weight: curatorWeight, typeWeight: 0.12 });
            componentConfidences.push({ confidence: signalConfidenceMap.get(curatorKey) || 0, typeWeight: 0.12 });
            scoreComponents.curator = Math.round(curatorWeight * 1000) / 1000;
          }
        }
      }
    }

    // Stable show/source context (0.18), distinct from a specific episode.
    if (track.episode_id) {
      const context = epToContextMap.get(track.episode_id);
      const contextKey = context ? `source_context::${context}` : null;
      const contextWeight = contextKey ? signalMap.get(contextKey) : undefined;
      if (contextKey && contextWeight !== undefined) {
        components.push({ weight: contextWeight, typeWeight: 0.18 });
        componentConfidences.push({ confidence: signalConfidenceMap.get(contextKey) || 0, typeWeight: 0.18 });
        scoreComponents.source_context = Math.round(contextWeight * 1000) / 1000;
      }
    }

    // Bayesian-smoothed episode yield (0.12; legacy signal name retained).
    if (track.episode_id) {
      const epDensityKey = `episode_density::${track.episode_id.toLowerCase()}`;
      const epDensityWeight = signalMap.get(epDensityKey);
      if (epDensityWeight !== undefined) {
        components.push({ weight: epDensityWeight, typeWeight: 0.12 });
        componentConfidences.push({ confidence: signalConfidenceMap.get(epDensityKey) || 0, typeWeight: 0.12 });
        scoreComponents.episode_density = Math.round(epDensityWeight * 1000) / 1000;
      }
    }

    // Co-occurrence signal (0.08)
    const coOccKey = `co_occurrence::${(track.artist || "").toLowerCase().trim()}`;
    const coOccWeight = signalMap.get(coOccKey);
    if (coOccWeight !== undefined) {
      components.push({ weight: coOccWeight, typeWeight: 0.08 });
      componentConfidences.push({ confidence: signalConfidenceMap.get(coOccKey) || 0, typeWeight: 0.08 });
      scoreComponents.co_occurrence = Math.round(coOccWeight * 1000) / 1000;
    }

    // Discovery co-occurrence boost: tracks found in multiple seed episodes
    // get a confidence boost (stored in metadata.co_occurrence by discover.ts)
    const discoveryCoOcc = typeof meta.co_occurrence === "number" ? meta.co_occurrence : 0;
    if (discoveryCoOcc > 1) {
      // Normalize: log scale, capped at 0.15 for tracks in 4+ episodes
      const coOccBoost = Math.min(0.15, Math.log2(discoveryCoOcc) * 0.08);
      scoreComponents.discovery_co_occ = Math.round(coOccBoost * 1000) / 1000;
    }

    // Composite score: weighted average of components
    let score = 0;
    if (components.length > 0) {
      const totalTypeWeight = components.reduce((s, c) => s + c.typeWeight, 0);
      score = components.reduce((s, c) => s + c.weight * c.typeWeight, 0) / totalTypeWeight;
      score = Math.round(score * 1000) / 1000;
    }

    // Apply discovery co-occurrence boost after weighted average
    if (scoreComponents.discovery_co_occ) {
      score += scoreComponents.discovery_co_occ;
    }

    // ── Match type boost ──────────────────────────────────────────────
    // Tracks from "full" match episodes (seed song was actually in the tracklist)
    // get a boost. "artist"-only matches get a small penalty since the connection
    // is weaker — the DJ played the artist but not necessarily the seed song.
    if (track.episode_id) {
      const mt = episodeMatchType.get(track.episode_id);
      if (mt === "full") {
        score += 0.10;
        scoreComponents.match_type = 0.10;
      } else if (mt === "artist") {
        score -= 0.05;
        scoreComponents.match_type = -0.05;
      }
    }

    // ── Negative penalties ──────────────────────────────────────────────
    let penalty = 0;

    // Rejected artist penalty
    const artistNegSignal = signalMap.get(artistKey);
    if (artistNegSignal !== undefined && artistNegSignal < -0.5) {
      penalty += 0.15; // heavily rejected artist
    }

    // Bad episode penalty (>50% rejection rate from episode density data)
    if (track.episode_id) {
      const epStats = episodeVoteStats.get(track.episode_id);
      if (epStats) {
        const epTotal = epStats.approved + epStats.rejected;
        if (epTotal >= 3 && epStats.rejected / epTotal > 0.5) {
          penalty += 0.20; // bad episode
        }
      }
    }

    // Bad curator penalty
    if (track.episode_id) {
      const curatorId = epToCuratorMap.get(track.episode_id);
      if (curatorId) {
        const slug = curatorIdToSlug.get(curatorId);
        if (slug) {
          const curatorSig = signalMap.get(`curator::${slug.toLowerCase()}`);
          if (curatorSig !== undefined && curatorSig < -0.3) {
            penalty += 0.10; // bad curator
          }
        }
      }
    }

    score = Math.round((score - penalty) * 1000) / 1000;
    scoreComponents.penalty = penalty > 0 ? -Math.round(penalty * 1000) / 1000 : 0;

    // Keep explainability per-user. The shared tracks row must not be mutated
    // with one user's score or component snapshot.
    const confidenceWeight = componentConfidences.reduce((sum, component) => sum + component.typeWeight, 0);
    const scoreConfidence = confidenceWeight > 0
      ? componentConfidences.reduce((sum, component) => sum + component.confidence * component.typeWeight, 0) / confidenceWeight
      : 0;
    updates.push({
      id: track.id,
      taste_score: score,
      score_components: scoreComponents,
      confidence: Math.round(scoreConfidence * 1000) / 1000,
    });
  }

  // Replace this user's score snapshot in bulk. This is intentionally separate
  // from tracks.taste_score, which is legacy/shared and can leak between users.
  const { error: clearScoreError } = await db
    .from("user_track_scores")
    .delete()
    .eq("user_id", userId);
  if (clearScoreError) throw clearScoreError;

  for (let i = 0; i < updates.length; i += 500) {
    const batch = updates.slice(i, i + 500).map((update) => ({
      user_id: userId,
      track_id: update.id,
      score: update.taste_score,
      confidence: update.confidence,
      components: update.score_components,
      scoring_version: "taste_context_v2",
      scored_at: new Date().toISOString(),
    }));
    const { error } = await db.from("user_track_scores").upsert(batch, { onConflict: "user_id,track_id" });
    if (error) {
      console.error(`  Failed score batch ${i / 500 + 1}: ${error.message}`);
      scoreErrors += batch.length;
    } else {
      scored += batch.length;
    }
  }

  console.log(`Scored: ${scored}, Errors: ${scoreErrors}`);

  // Show score distribution
  const scoreDist = { positive: 0, zero: 0, negative: 0 };
  for (const u of updates) {
    if (u.taste_score > 0) scoreDist.positive++;
    else if (u.taste_score < 0) scoreDist.negative++;
    else scoreDist.zero++;
  }
  console.log(`Distribution: +${scoreDist.positive} positive, ${scoreDist.zero} neutral, -${scoreDist.negative} negative`);

  console.log("");
}

main().catch((err) => {
  console.error("Signal update failed:", err);
  process.exit(1);
});
