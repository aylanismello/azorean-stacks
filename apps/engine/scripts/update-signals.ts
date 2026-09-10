#!/usr/bin/env bun
import { getSupabase } from "../lib/supabase";
import {
  addYield,
  buildTrackSeedLineage,
  emptyYield,
  episodeContextKey,
  estimateYield,
  explicitOutcomeWeight,
  indexTrackEpisodes,
  recencyWeight,
  resolveUserId,
  type YieldAccumulator,
} from "../lib/taste-scoring";

interface SignalAccumulator {
  positive: number;
  negative: number;
  samples: number;
}

const IN_BATCH_SIZE = 300;

async function selectInBatches<T = any>(
  db: any,
  table: string,
  columns: string,
  column: string,
  values: string[],
  batchSize = IN_BATCH_SIZE
): Promise<T[]> {
  const rows: T[] = [];
  const uniqueValues = Array.from(new Set(values.filter(Boolean)));
  for (let i = 0; i < uniqueValues.length; i += batchSize) {
    const { data, error } = await db
      .from(table)
      .select(columns)
      .in(column, uniqueValues.slice(i, i + batchSize));
    if (error) throw error;
    rows.push(...((data || []) as T[]));
  }
  return rows;
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
      .in("status", ["approved", "rejected", "skipped", "listened"])
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
      .select("track_id, status, super_liked, voted_at, listen_pct")
      .eq("user_id", userId)
      .in("status", ["approved", "rejected", "skipped", "listened"]);
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
      return {
        ...track,
        status: vote!.status,
        _super_liked: !!vote!.super_liked,
        _voted_at: vote!.voted_at,
        _listen_pct: vote!.listen_pct,
      };
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
  const { data: superLikedRows, error: superLikedError } = await superLikedQuery;
  if (superLikedError) throw superLikedError;
  const superLikedSet = new Set((superLikedRows || []).map((r: any) => r.track_id as string));

  const signals = new Map<string, SignalAccumulator>();

  function addSignal(type: string, value: string, weight: number) {
    if (weight === 0) return;
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
    return explicitOutcomeWeight(
      track.status,
      track._super_liked || superLikedSet.has(track.id),
      track._listen_pct,
    );
  }

  const globalYield = emptyYield();
  for (const track of tracks) {
    addYield(globalYield, trackWeight(track), recencyWeight(track._voted_at));
  }
  const globalRate = globalYield.positive + globalYield.negative > 0
    ? globalYield.positive / (globalYield.positive + globalYield.negative)
    : 0.5;

  const trackIds = tracks.map((track: any) => track.id);
  const trackEpisodeRows = trackIds.length > 0
    ? await selectInBatches(db, "episode_tracks", "track_id, episode_id", "track_id", trackIds)
    : [];
  const episodesByTrack = indexTrackEpisodes(tracks, trackEpisodeRows);

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

  const { data: seeds, error: seedsError } = await db
    .from("seeds")
    .select("id, track_id, artist, title")
    .eq("active", true)
    .eq("user_id", userId);
  if (seedsError) throw seedsError;

  if (seeds && seeds.length > 0) {
    const seedIds = seeds.map((seed: any) => seed.id);
    const episodeSeedRows = seedIds.length > 0
      ? await selectInBatches(db, "episode_seeds", "episode_id, seed_id, match_type", "seed_id", seedIds)
      : [];
    const lineageByTrack = buildTrackSeedLineage(
      tracks,
      trackEpisodeRows,
      episodeSeedRows,
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

  const { data: curators, error: curatorsError } = await db
    .from("curators")
    .select("id, slug");
  if (curatorsError) throw curatorsError;
  console.log(`Computing episode and show yield signals...`);
  const votedEpisodeIds = Array.from(new Set(
    tracks.flatMap((track: any) => [...(episodesByTrack.get(track.id) || [])]),
  ));
  const { data: votedEpisodes, error: votedEpisodesError } = votedEpisodeIds.length > 0
    ? await db.from("episodes").select("id, curator_id, series_id, source, url, title").in("id", votedEpisodeIds)
    : { data: [], error: null };
  if (votedEpisodesError) throw votedEpisodesError;
  const episodeMap = new Map<string, any>((votedEpisodes || []).map((episode: any) => [episode.id, episode]));
  const curatorSlugMap = new Map<string, string>((curators || []).map((curator: any) => [curator.id, curator.slug]));
  const curatorStats = new Map<string, YieldAccumulator>();
  const contextStats = new Map<string, YieldAccumulator>();
  const episodeStats = new Map<string, YieldAccumulator>();
  const artistStats = new Map<string, YieldAccumulator>();

  for (const track of tracks) {
    const outcome = trackWeight(track);
    const decay = recencyWeight(track._voted_at);
    if (track.artist) {
      const artistKey = track.artist.toLowerCase().trim();
      const artistAcc = artistStats.get(artistKey) || emptyYield();
      addYield(artistAcc, outcome, decay);
      artistStats.set(artistKey, artistAcc);
    }
    const episodeIds = [...(episodesByTrack.get(track.id) || [])];
    if (!episodeIds.length) continue;
    const episodeOutcome = outcome / episodeIds.length;
    const contexts = new Set<string>();
    const curatorSlugs = new Set<string>();

    for (const episodeId of episodeIds) {
      const episode = episodeMap.get(episodeId);
      const epAcc = episodeStats.get(episodeId) || emptyYield();
      addYield(epAcc, episodeOutcome, decay);
      episodeStats.set(episodeId, epAcc);

      const contextKey = episode ? episodeContextKey(episode) : null;
      if (contextKey) contexts.add(contextKey);
      const slug = episode?.curator_id ? curatorSlugMap.get(episode.curator_id) : null;
      if (slug) curatorSlugs.add(slug);
    }

    for (const contextKey of contexts) {
      const acc = contextStats.get(contextKey) || emptyYield();
      addYield(acc, outcome / contexts.size, decay);
      contextStats.set(contextKey, acc);
    }
    for (const slug of curatorSlugs) {
      const acc = curatorStats.get(slug) || emptyYield();
      addYield(acc, outcome / curatorSlugs.size, decay);
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

  // Build artist → set of canonical episode IDs from voted tracks
  const artistEpisodes = new Map<string, Set<string>>();
  for (const track of tracks) {
    if (!track.artist) continue;
    const key = track.artist.toLowerCase().trim();
    if (!artistEpisodes.has(key)) artistEpisodes.set(key, new Set());
    for (const episodeId of episodesByTrack.get(track.id) || []) {
      artistEpisodes.get(key)!.add(episodeId);
    }
  }

  for (const [artistKey, epSet] of artistEpisodes) {
    if (epSet.size < 2) continue;
    const estimate = estimateYield(artistStats.get(artistKey) || emptyYield(), globalRate, 5, 3);
    if (estimate) setYieldSignal("co_occurrence", artistKey, estimate);
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

  // Materialize the complete replacement before touching live rows. Existing
  // rows are retained until every upsert succeeds, so a failed batch cannot
  // leave the user with a cleared or truncated snapshot.
  const refreshedAt = new Date().toISOString();
  const signalRows = Array.from(signals, ([key, acc]) => {
    const [signalType, value] = key.split("::");
    const totalWeight = acc.positive + acc.negative;
    const weight = totalWeight > 0 ? (acc.positive - acc.negative) / totalWeight : 0;
    return {
      user_id: userId,
      signal_type: signalType,
      value,
      weight: Math.round(weight * 1000) / 1000,
      sample_count: acc.samples,
      updated_at: refreshedAt,
    };
  });
  const liveSignals: Array<{ id: string; signal_type: string; value: string }> = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db
      .from("taste_signals")
      .select("id, signal_type, value")
      .eq("user_id", userId)
      .range(from, from + 999);
    if (error) throw error;
    liveSignals.push(...(data || []));
    if (!data || data.length < 1000) break;
  }

  // Upsert the complete computed set. Any batch failure aborts the refresh
  // before stale rows are deleted and propagates to main's nonzero exit.
  let upserted = 0;
  for (let i = 0; i < signalRows.length; i += 500) {
    const batch = signalRows.slice(i, i + 500);
    const { error: upsertError } = await db
      .from("taste_signals")
      .upsert(batch, { onConflict: "user_id,signal_type,value" });
    if (upsertError) {
      throw new Error(`Failed signal batch ${i / 500 + 1}: ${upsertError.message}`);
    }
    upserted += batch.length;
  }

  const nextSignalKeys = new Set(signalRows.map((row) => `${row.signal_type}::${row.value}`));
  const staleSignalIds = liveSignals
    .filter((row) => !nextSignalKeys.has(`${row.signal_type}::${row.value}`))
    .map((row) => row.id);
  for (let i = 0; i < staleSignalIds.length; i += 500) {
    const { error } = await db
      .from("taste_signals")
      .delete()
      .eq("user_id", userId)
      .in("id", staleSignalIds.slice(i, i + 500));
    if (error) throw new Error(`Failed stale signal cleanup batch ${i / 500 + 1}: ${error.message}`);
  }

  console.log(`\n=== Summary ===`);
  console.log(`Signals upserted: ${upserted}`);
  console.log(`Stale signals deleted: ${staleSignalIds.length}`);

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
  const { data: topSignals, error: topSignalsError } = await topSignalsQuery;
  if (topSignalsError) throw topSignalsError;

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

  const signalMap = new Map<string, number>();
  const signalConfidenceMap = new Map<string, number>();
  for (const s of signalRows) {
    const samples = s.sample_count || 0;
    const dampened = s.weight * (samples / (samples + CONFIDENCE_PRIOR));
    const key = `${s.signal_type}::${s.value}`;
    signalMap.set(key, dampened);
    signalConfidenceMap.set(key, samples / (samples + CONFIDENCE_PRIOR));
  }

  // Score only this user's pending candidate set. Shared catalog rows are not
  // queue eligibility and must never make another user's discoveries visible.
  const eligiblePendingIds: string[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from("user_tracks")
      .select("track_id")
      .eq("user_id", userId)
      .eq("status", "pending")
      .range(from, from + 999);
    if (error) throw error;
    eligiblePendingIds.push(...(data || []).map((row: any) => row.track_id));
    if (!data || data.length < 1000) break;
  }
  const pending = eligiblePendingIds.length > 0
    ? (await selectInBatches<any>(
        db,
        "tracks",
        "id, artist, metadata, episode_id, seed_track_id",
        "id",
        eligiblePendingIds,
      ))
    : [];

  console.log(`Scoring ${pending.length} pending tracks`);

  const pendingTrackIds = pending.map((track: any) => track.id);
  const seedIds = (seeds || []).map((seed: any) => seed.id);
  const pendingEpisodeRows = pendingTrackIds.length > 0
    ? await selectInBatches(db, "episode_tracks", "track_id, episode_id", "track_id", pendingTrackIds)
    : [];
  const scopedEpisodeSeedRows = seedIds.length > 0
    ? await selectInBatches(db, "episode_seeds", "episode_id, seed_id, match_type", "seed_id", seedIds)
    : [];
  const pendingLineage = buildTrackSeedLineage(
    pending,
    pendingEpisodeRows,
    scopedEpisodeSeedRows,
    seeds || []
  );
  const pendingEpisodesByTrack = indexTrackEpisodes(pending, pendingEpisodeRows);

  // Build per-episode vote stats for negative penalties
  const episodeVoteStats = new Map<string, { approved: number; rejected: number }>();
  for (const track of tracks) {
    const weight = trackWeight(track);
    for (const episodeId of episodesByTrack.get(track.id) || []) {
      const accumulator = episodeVoteStats.get(episodeId) || { approved: 0, rejected: 0 };
      if (weight >= 1) accumulator.approved++;
      else if (weight < -0.5) accumulator.rejected++; // rejected (not skipped)
      episodeVoteStats.set(episodeId, accumulator);
    }
  }

  // Match quality comes from the same user-scoped canonical lineage used for
  // seed affinity; no second global episode lookup is necessary.

  // Build episode → curator/context lookup for every canonical appearance.
  const pendingEpisodeIds = Array.from(new Set(
    pending.flatMap((track: any) => [...(pendingEpisodesByTrack.get(track.id) || [])]),
  ));
  const epCuratorLinks = pendingEpisodeIds.length > 0
    ? await selectInBatches<any>(db, "episodes", "id, curator_id, series_id, source, url, title", "id", pendingEpisodeIds)
    : [];

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
  // Batch updates: collect scores then update in chunks
  const updates: Array<{
    id: string;
    taste_score: number;
    score_components: Record<string, number>;
    confidence: number;
  }> = [];

  for (const track of pending) {
    const meta = (track.metadata || {}) as Record<string, unknown>;
    const episodeIds = [...(pendingEpisodesByTrack.get(track.id) || [])];
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

    // Curator signal (0.12), averaged across canonical appearances.
    const curatorKeys = new Set(episodeIds.flatMap((episodeId) => {
      const curatorId = epToCuratorMap.get(episodeId);
      const slug = curatorId ? curatorIdToSlug.get(curatorId) : null;
      return slug ? [`curator::${slug.toLowerCase()}`] : [];
    }));
    const curatorValues = [...curatorKeys]
      .map((key) => ({ value: signalMap.get(key), confidence: signalConfidenceMap.get(key) || 0 }))
      .filter((item): item is { value: number; confidence: number } => item.value !== undefined);
    if (curatorValues.length) {
      const curatorWeight = curatorValues.reduce((sum, item) => sum + item.value, 0) / curatorValues.length;
      const curatorConfidence = curatorValues.reduce((sum, item) => sum + item.confidence, 0) / curatorValues.length;
      components.push({ weight: curatorWeight, typeWeight: 0.12 });
      componentConfidences.push({ confidence: curatorConfidence, typeWeight: 0.12 });
      scoreComponents.curator = Math.round(curatorWeight * 1000) / 1000;
    }

    // Stable show/source context (0.18), distinct from a specific episode.
    const contextKeys = new Set(episodeIds.flatMap((episodeId) => {
      const context = epToContextMap.get(episodeId);
      return context ? [`source_context::${context}`] : [];
    }));
    const contextValues = [...contextKeys]
      .map((key) => ({ value: signalMap.get(key), confidence: signalConfidenceMap.get(key) || 0 }))
      .filter((item): item is { value: number; confidence: number } => item.value !== undefined);
    if (contextValues.length) {
      const contextWeight = contextValues.reduce((sum, item) => sum + item.value, 0) / contextValues.length;
      const contextConfidence = contextValues.reduce((sum, item) => sum + item.confidence, 0) / contextValues.length;
      components.push({ weight: contextWeight, typeWeight: 0.18 });
      componentConfidences.push({ confidence: contextConfidence, typeWeight: 0.18 });
      scoreComponents.source_context = Math.round(contextWeight * 1000) / 1000;
    }

    // Bayesian-smoothed episode yield (0.12; legacy signal name retained).
    const densityValues = episodeIds
      .map((episodeId) => {
        const key = `episode_density::${episodeId.toLowerCase()}`;
        return { value: signalMap.get(key), confidence: signalConfidenceMap.get(key) || 0 };
      })
      .filter((item): item is { value: number; confidence: number } => item.value !== undefined);
    if (densityValues.length) {
      const densityWeight = densityValues.reduce((sum, item) => sum + item.value, 0) / densityValues.length;
      const densityConfidence = densityValues.reduce((sum, item) => sum + item.confidence, 0) / densityValues.length;
      components.push({ weight: densityWeight, typeWeight: 0.12 });
      componentConfidences.push({ confidence: densityConfidence, typeWeight: 0.12 });
      scoreComponents.episode_density = Math.round(densityWeight * 1000) / 1000;
    }

    // Co-occurrence signal (0.08)
    const coOccKey = `co_occurrence::${(track.artist || "").toLowerCase().trim()}`;
    const coOccWeight = signalMap.get(coOccKey);
    if (coOccWeight !== undefined) {
      components.push({ weight: coOccWeight, typeWeight: 0.08 });
      componentConfidences.push({ confidence: signalConfidenceMap.get(coOccKey) || 0, typeWeight: 0.08 });
      scoreComponents.co_occurrence = Math.round(coOccWeight * 1000) / 1000;
    }

    // Missing evidence is neutral, not a reason to renormalize a single weak
    // signal to full strength. Model weights sum to one when all components
    // are present, so a straight weighted sum naturally shrinks sparse rows.
    let score = Math.round(
      components.reduce((sum, component) => sum + component.weight * component.typeWeight, 0) * 1000,
    ) / 1000;

    // ── Match type boost ──────────────────────────────────────────────
    // Tracks from "full" match episodes (seed song was actually in the tracklist)
    // get a boost. "artist"-only matches get a small penalty since the connection
    // is weaker — the DJ played the artist but not necessarily the seed song.
    const lineageMatchTypes = [...(pendingLineage.get(track.id)?.values() || [])];
    if (lineageMatchTypes.includes("full")) {
      score += 0.10;
      scoreComponents.match_type = 0.10;
    } else if (lineageMatchTypes.includes("artist")) {
      score -= 0.05;
      scoreComponents.match_type = -0.05;
    }

    // ── Negative penalties ──────────────────────────────────────────────
    let penalty = 0;

    // Rejected artist penalty
    const artistNegSignal = signalMap.get(artistKey);
    if (artistNegSignal !== undefined && artistNegSignal < -0.5) {
      penalty += 0.15; // heavily rejected artist
    }

    // Bad episode penalty (>50% rejection rate across canonical appearances).
    const relevantEpisodeStats = episodeIds
      .map((episodeId) => episodeVoteStats.get(episodeId))
      .filter((stats): stats is { approved: number; rejected: number } => Boolean(stats));
    const episodeDecisions = relevantEpisodeStats.reduce((sum, stats) => sum + stats.approved + stats.rejected, 0);
    const episodeRejections = relevantEpisodeStats.reduce((sum, stats) => sum + stats.rejected, 0);
    if (episodeDecisions >= 3 && episodeRejections / episodeDecisions > 0.5) {
      penalty += 0.20;
    }

    // Bad curator penalty
    if ([...curatorKeys].some((key) => (signalMap.get(key) ?? 0) < -0.3)) {
      penalty += 0.10;
    }

    score = Math.round((score - penalty) * 1000) / 1000;
    scoreComponents.penalty = penalty > 0 ? -Math.round(penalty * 1000) / 1000 : 0;

    // Keep explainability per-user. The shared tracks row must not be mutated
    // with one user's score or component snapshot.
    const scoreConfidence = componentConfidences.reduce(
      (sum, component) => sum + component.confidence * component.typeWeight,
      0,
    );
    updates.push({
      id: track.id,
      taste_score: score,
      score_components: scoreComponents,
      confidence: Math.round(scoreConfidence * 1000) / 1000,
    });
  }

  // Stage the complete score replacement in memory and retain the current
  // snapshot until every score batch has been written successfully.
  const liveScoreTrackIds: string[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db
      .from("user_track_scores")
      .select("track_id")
      .eq("user_id", userId)
      .range(from, from + 999);
    if (error) throw error;
    liveScoreTrackIds.push(...(data || []).map((row: any) => row.track_id));
    if (!data || data.length < 1000) break;
  }
  const scoredAt = new Date().toISOString();
  for (let i = 0; i < updates.length; i += 500) {
    const batch = updates.slice(i, i + 500).map((update) => ({
      user_id: userId,
      track_id: update.id,
      score: update.taste_score,
      confidence: update.confidence,
      components: update.score_components,
      scoring_version: "taste_context_v3",
      scored_at: scoredAt,
    }));
    const { error } = await db.from("user_track_scores").upsert(batch, { onConflict: "user_id,track_id" });
    if (error) {
      throw new Error(`Failed score batch ${i / 500 + 1}: ${error.message}`);
    }
    scored += batch.length;
  }

  const nextScoreTrackIds = new Set(updates.map((update) => update.id));
  const staleScoreTrackIds = liveScoreTrackIds.filter((trackId) => !nextScoreTrackIds.has(trackId));
  for (let i = 0; i < staleScoreTrackIds.length; i += 500) {
    const { error } = await db
      .from("user_track_scores")
      .delete()
      .eq("user_id", userId)
      .in("track_id", staleScoreTrackIds.slice(i, i + 500));
    if (error) throw new Error(`Failed stale score cleanup batch ${i / 500 + 1}: ${error.message}`);
  }

  console.log(`Scored: ${scored}, stale scores deleted: ${staleScoreTrackIds.length}`);

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
