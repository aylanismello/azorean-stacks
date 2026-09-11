#!/usr/bin/env bun
/**
 * The Stacks — Realtime Seed Watcher
 *
 * Subscribes to Supabase Realtime INSERT events on the `seeds` table.
 * When a new seed is inserted, immediately runs the discover+enrich+download
 * pipeline for that seed — no waiting for the next engine cycle.
 *
 * Usage: bun run watcher
 */
import { getSupabase } from "../lib/supabase";
import {
  log, elapsed, sleep,
  isSameTrack,
  enrichTrack, enrichTrackFast, enrichTrackMetadata, downloadTrack, DownloadSupersededError,
  spotifyLookup,
  logEngineEvent,
  GARBAGE_TITLES, GARBAGE_PATTERNS, isGarbageTrack,
} from "../lib/pipeline";
import { SOURCES } from "../lib/sources/index";
import { SOULECTION_RECENT_EPISODE_LIMIT } from "../lib/sources/soulection";
import { runCuratorRadar } from "./radar-curator";
import { crawlSoulection } from "./crawl-soulection";
import {
  claimPreparationTracks,
  evictRetiredQueueAudio,
  materializeAllQueues,
  materializeUserQueue,
  markPreparationState,
  QUEUE_TARGET,
  releasePreparationTracks,
  selectPreparationBatch,
} from "../lib/predictive-queue";
import { writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync } from "fs";
import { downloadConcurrency, preferredAcquisitionUrl, ytDlpAudioArgs } from "../lib/yt-dlp";
import { isExplicitDecision, refreshDecisionQueue } from "../lib/decision-refresh";
import {
  createQueueMutationSerializer,
  isPriorityManagedSeed,
  latestStatelessUserSeeds,
  recoverSeedFypRefreshes,
} from "../lib/seed-refresh";

const db = getSupabase();
const STATUS_FILE = `${process.env.HOME}/.hermes/data/azorean-engine-status.json`;

const decisionRefreshTimers = new Map<string, ReturnType<typeof setTimeout>>();
const serializeQueueMutation = createQueueMutationSerializer();

async function refreshPersonalizedQueue(userId: string, freshInsertions = 0): Promise<void> {
  await refreshDecisionQueue(userId, {
    refreshPersonalizedScores: async () => {
      const proc = Bun.spawn([Bun.which("bun") || "bun", "run", "scripts/update-signals.ts", "--user-id", userId], {
        cwd: `${import.meta.dir}/..`, stdout: "inherit", stderr: "inherit",
      });
      const exitCode = await proc.exited;
      if (exitCode !== 0) throw new Error(`signal refresh exited ${exitCode}`);
    },
    materializeUserQueue: () => materializeUserQueue(userId, db, QUEUE_TARGET, freshInsertions),
  });
}

function scheduleDecisionRefresh(userId: string) {
  const existing = decisionRefreshTimers.get(userId);
  if (existing) clearTimeout(existing);
  if (!existing && decisionRefreshTimers.size >= 100) return;
  decisionRefreshTimers.set(userId, setTimeout(() => {
    decisionRefreshTimers.delete(userId);
    void serializeQueueMutation(() => refreshPersonalizedQueue(userId))
      .catch((error) => log("fail", `Decision refresh failed for ${userId}: ${error instanceof Error ? error.message : error}`));
  }, 2_000));
}

// ─── CONCURRENCY LIMITS ─────────────────────────────────────
// Tuned for M4 Mac Mini — all bottlenecks are network I/O
const CONCURRENCY = {
  enrich: 3,          // Spotify + YouTube lookups per batch (low to avoid Spotify 429s)
  download: 4,        // yt-dlp audio downloads per batch
  repair: 20,         // Background track repair tasks
  superLike: 2,       // Simultaneous super-like downloads
  ntsMaxEpisodes: 10, // Max episodes to check per source per seed
} as const;

const PRIORITY_DOWNLOAD_CONCURRENCY = downloadConcurrency();
const PRIORITY_ENRICH_CONCURRENCY = 3;    // Max concurrent enrichments (low to avoid Spotify 429s)

// GARBAGE_TITLES, GARBAGE_PATTERNS, and isGarbageTrack imported from pipeline.ts

// ─── STATUS TRACKING ────────────────────────────────────────

let watcherConnectedAt: string | null = null;
let lastEventAt: string | null = null;
let lastRealtimeEventAt: string | null = null;
let currentChannel: ReturnType<typeof db.channel> | null = null;
let intervalsStarted = false;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

// ─── CONNECTION FAILURE TRACKING ────────────────────────────
let reconnectFailures = 0;

function updateStatusFile() {
  try {
    if (!existsSync(STATUS_FILE)) return;
    const raw = readFileSync(STATUS_FILE, "utf-8");
    const status = JSON.parse(raw);
    status.watcher_connected_at = watcherConnectedAt;
    status.last_event_at = lastEventAt;
    writeFileSync(STATUS_FILE, JSON.stringify(status, null, 2));
  } catch {
    // Non-critical — don't crash
  }
}

// ─── USER HELPERS ────────────────────────────────────────────

// Scope single-user scheduled jobs to the account with the latest explicit
// activity rather than the oldest arbitrary row. Returns null if no user exists.
async function getPrimaryUserId(): Promise<string | null> {
  try {
    const { data } = await db
      .from("user_tracks")
      .select("user_id")
      .not("user_id", "is", null)
      .not("voted_at", "is", null)
      .order("voted_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    return data?.user_id ?? null;
  } catch {
    return null;
  }
}

// ─── SEED PIPELINE ──────────────────────────────────────────

async function queueLegacyUserSeedForPriority(seed: {
  id: string;
  user_id: string;
  pipeline_status?: Record<string, unknown> | null;
  fyp_refresh_required_at?: string | null;
}): Promise<void> {
  const now = new Date();
  const status = seed.pipeline_status || {};
  const logs = Array.isArray(status.log) ? status.log : [];
  const { data, error } = await db.from("seeds").update({
    pipeline_status: {
      ...status,
      state: "queued",
      started_at: now.toISOString(),
      log: [...logs, { t: now.toTimeString().slice(0, 8), msg: "legacy seed queued for priority discovery" }],
    },
    fyp_refresh_required_at: seed.fyp_refresh_required_at || now.toISOString(),
    fyp_refreshed_at: null,
    fyp_refresh_claimed_at: null,
  })
    .eq("id", seed.id)
    .eq("user_id", seed.user_id)
    .eq("active", true)
    .filter("pipeline_status->>state", "is", null)
    .select("id")
    .maybeSingle();
  if (error) throw new Error(`legacy seed priority adoption failed: ${error.message}`);
  // No row means another worker adopted it or its owner/activation changed.
  // Either way, this legacy processor must stop and let the current owner win.
  if (!data) return;
}

async function processSeed(seedId: string) {
  const t0 = Date.now();

  // Read seed record
  const { data: seed, error: seedErr } = await db.from("seeds")
    .select("*").eq("id", seedId).single();

  if (seedErr || !seed) {
    log("fail", `Could not read seed ${seedId}: ${seedErr?.message ?? "not found"}`);
    await logEngineEvent("error", "failed", {
      seedId,
      message: `Could not read seed: ${seedErr?.message ?? "not found"}`,
    });
    return;
  }

  // User-owned seeds are handled end-to-end by processPriorityQueue. Legacy
  // stateless rows are first upgraded to durable queued work, then returned.
  if (seed.user_id) {
    if (!isPriorityManagedSeed(seed)) {
      await queueLegacyUserSeedForPriority(seed as typeof seed & { user_id: string });
      log("info", `Legacy user seed ${seedId} delegated to priority pipeline`);
    } else {
      log("skip", `Priority-managed seed ${seedId} ignored by legacy seed queue`);
    }
    return;
  }

  const seedLabel = `${seed.artist} – ${seed.title}`;
  console.log(`\n━━━ WATCHER: New seed detected ━━━`);
  console.log(`  ${seedLabel}`);

  await logEngineEvent("seed_detected", "info", {
    seedId,
    message: seedLabel,
    metadata: { artist: seed.artist, title: seed.title },
  });

  // ── Phase 1: Multi-source Discovery (first matching episode per source) ──
  await logEngineEvent("discover_started", "started", { seedId, message: seedLabel });

  let tracksAdded = 0;
  let episodeProcessed: string | null = null;
  let totalEpisodesFound = 0;

  for (const source of SOURCES) {
    let sourceEpisodes: Array<{ url: string; title: string; date: string | null }> = [];

    if (source.name === "lotradio") {
      // Lot Radio: tracklist matching ONLY — find episodes where a DJ played the seed track
      // Paginated to avoid Supabase's default 1000-row cap
      try {
        const seedArtistLower = seed.artist.toLowerCase().trim();
        const seedTitleLower = seed.title.toLowerCase().trim();
        const PAGE_SIZE = 1000;
        let from = 0;

        while (true) {
          const { data: dbEpisodes } = await db
            .from("episodes")
            .select("url, title, aired_date, metadata")
            .eq("source", "lotradio")
            .not("metadata", "is", null)
            .range(from, from + PAGE_SIZE - 1);

          if (!dbEpisodes || dbEpisodes.length === 0) break;

          for (const ep of dbEpisodes as any[]) {
            const tracklist: Array<{ artist: string; title: string }> = ep.metadata?.tracklist || [];
            if (tracklist.length === 0) continue;
            const hasMatch = tracklist.some((t) =>
              t.artist?.toLowerCase().trim() === seedArtistLower &&
              t.title?.toLowerCase().trim() === seedTitleLower
            );
            if (hasMatch) {
              sourceEpisodes.push({ url: ep.url, title: ep.title || ep.url, date: ep.aired_date || null });
            }
          }

          if (dbEpisodes.length < PAGE_SIZE) break;
          from += PAGE_SIZE;
        }
        log("info", `Lot Radio: ${sourceEpisodes.length} tracklist matches for ${seedLabel}`);
      } catch (err) {
        log("fail", `Lot Radio tracklist search error for ${seedLabel}: ${err instanceof Error ? err.message : err}`);
      }
    } else {
      try {
        const results = await source.searchForSeed(seed.artist, seed.title);
        sourceEpisodes = results.map((e) => ({ url: e.url, title: e.title, date: e.date }));
      } catch (err) {
        log("fail", `${source.name} search failed for ${seedLabel}: ${err instanceof Error ? err.message : err}`);
        continue;
      }
    }

    if (sourceEpisodes.length === 0) {
      log("warn", `No ${source.name} episodes found for ${seedLabel}`);
      continue;
    }

    totalEpisodesFound += sourceEpisodes.length;
    log("info", `${source.name}: ${sourceEpisodes.length} episodes found`);

    for (const ep of sourceEpisodes.slice(0, CONCURRENCY.ntsMaxEpisodes)) {
      await sleep(1000);

      const episodeUrl = ep.url;
      const context = `${ep.title}${ep.date ? ` (${ep.date})` : ""}`;

      const { data: existingEp } = await db.from("episodes")
        .select("id").eq("url", episodeUrl).limit(1).single();

      let episodeId: string;

      if (existingEp) {
        episodeId = existingEp.id;
      } else {
        const artworkUrl = await source.getArtwork(episodeUrl);
        const { data: newEp, error: epErr } = await db.from("episodes").upsert({
          url: episodeUrl,
          title: ep.title || null,
          source: source.name,
          aired_date: ep.date || null,
          artwork_url: artworkUrl,
        }, { onConflict: "url" }).select("id").single();

        if (!newEp) {
          log("fail", `Episode insert failed: ${context} — ${epErr?.message}`);
          continue;
        }
        episodeId = newEp.id;
      }

      const rawTracks = await source.getTracklist(episodeUrl);
      if (rawTracks.length === 0) {
        log("fail", `Empty tracklist: ${context}`);
        continue;
      }

      // Verify the seed track actually appears in this episode's tracklist before
      // treating it as a valid co-occurrence source. Without this check, NTS full-text
      // search can return false-positive episodes (matching tags/descriptions) whose
      // tracklists have no relation to the seed — producing tracks with no meaningful
      // artist/title connection to the seed.
      const hasFullMatch = rawTracks.some((t) => isSameTrack(t, { artist: seed.artist, title: seed.title }));
      const hasArtistMatch = !hasFullMatch && rawTracks.some(
        (t) => t.artist.toLowerCase().trim() === seed.artist.toLowerCase().trim()
      );
      const matchType = hasFullMatch ? "full" : hasArtistMatch ? "artist" : null;
      if (!matchType) {
        log("skip", `No match for seed "${seed.artist} - ${seed.title}" in ${context} — skipping`);
        continue;
      }

      await db.from("episode_seeds").upsert(
        { episode_id: episodeId, seed_id: seedId, match_type: matchType },
        { onConflict: "episode_id,seed_id" },
      );

      // Insert candidate tracks from this episode
      const insertedTracks: any[] = [];
      for (let pos = 0; pos < rawTracks.length; pos++) {
        const track = rawTracks[pos];
        if (isSameTrack(track, { artist: seed.artist, title: seed.title })) continue;

        if (isGarbageTrack(track.artist, track.title)) continue;

        const escArtist = track.artist.trim().replace(/[%_\\]/g, (c) => `\\${c}`);
        const escTitle = track.title.trim().replace(/[%_\\]/g, (c) => `\\${c}`);
        const { data: existing } = await db.from("tracks")
          .select("*").ilike("artist", escArtist).ilike("title", escTitle).limit(1);
        let candidate = existing?.[0] || null;
        if (!candidate) {
          const { data: inserted, error } = await db.from("tracks").insert({
            artist: track.artist.trim(),
            title: track.title.trim(),
            source: source.name,
            source_url: episodeUrl,
            source_context: context,
            metadata: { co_occurrence: 1, seed_artist: seed.artist, seed_title: seed.title },
            status: "pending",
            episode_id: episodeId,
            seed_track_id: seed.track_id || null,
          }).select("*").single();
          if (error || !inserted) continue;
          candidate = inserted;
          insertedTracks.push(inserted);
          tracksAdded++;
        }

        const { error: episodeTrackError } = await db.from("episode_tracks").upsert(
          { episode_id: episodeId, track_id: candidate.id, position: pos },
          { onConflict: "episode_id,track_id" },
        );
        if (episodeTrackError) log("fail", `Episode link failed for ${candidate.id}: ${episodeTrackError.message}`);
        if (seed.user_id) {
          const { error: userTrackError } = await db.from("user_tracks").upsert(
            { user_id: seed.user_id, track_id: candidate.id, status: "pending" },
            { onConflict: "user_id,track_id", ignoreDuplicates: true },
          );
          if (userTrackError) log("fail", `User candidate link failed for ${candidate.id}: ${userTrackError.message}`);
        }
      }

      if (episodeProcessed === null) episodeProcessed = context;
      log("ok", `${context} — ${rawTracks.length} tracks, ${insertedTracks.length} new`);

      // Log discovery run
      await db.from("discovery_runs").insert({
        started_at: new Date(t0).toISOString(),
        completed_at: new Date().toISOString(),
        seed_id: seedId,
        user_id: seed.user_id || null,
        seed_track_id: seed.track_id || null,
        sources_searched: [source.name],
        tracks_found: rawTracks.length,
        tracks_added: insertedTracks.length,
        notes: `Watcher: processed first episode "${context}" from ${source.name}`,
      });

      await logEngineEvent("discover_completed", "completed", {
        seedId,
        message: `${context}: ${insertedTracks.length} tracks added`,
        metadata: { episode: context, source: source.name, tracks_found: rawTracks.length, tracks_added: insertedTracks.length },
      });

      // ── Phase 2: Enrich tracks from this episode ──
      if (insertedTracks.length > 0) {
        await logEngineEvent("enrich_started", "started", {
          seedId,
          message: `Enriching ${insertedTracks.length} tracks`,
        });

        let enriched = 0;
        let enrichFailed = 0;

        for (let i = 0; i < insertedTracks.length; i += CONCURRENCY.enrich) {
          const batch = insertedTracks.slice(i, i + CONCURRENCY.enrich);
          const results = await Promise.allSettled(batch.map(enrichTrack));
          for (const r of results) {
            if (r.status === "fulfilled" && r.value) enriched++;
            else enrichFailed++;
          }
        }

        await logEngineEvent("enrich_completed", "completed", {
          seedId,
          message: `Enriched: ${enriched}, Failed: ${enrichFailed}`,
          metadata: { enriched, failed: enrichFailed },
        });

        // Audio is prepared separately from the ranked per-user queue. Discovery
        // continues enriching every candidate without downloading the whole episode.
      }

      // Only process the first episode with tracks per source
      break;
    }
  }

  if (totalEpisodesFound === 0) {
    log("warn", `No episodes found across all sources for ${seedLabel}`);
    await logEngineEvent("discover_completed", "completed", {
      seedId,
      message: "No episodes found",
      metadata: { episodes_found: 0 },
    });
  }

  // ── Phase 4: Populate seed cover art if missing ──
  if (!seed.cover_art_url) {
    try {
      const spot = await spotifyLookup(seed.artist, seed.title);
      if (spot?.cover_art_url) {
        await db.from("seeds").update({ cover_art_url: spot.cover_art_url }).eq("id", seedId);
        log("ok", `Set seed cover art for ${seedLabel}`);
      }
    } catch (err) {
      log("fail", `Seed cover art lookup failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  const materialized = await serializeQueueMutation(() => materializeAllQueues(db));
  log("info", `Materialized ${materialized.tracks} queue entries for ${materialized.users} user(s)`);

  console.log(`\n  Watcher pipeline done for ${seedLabel} (${elapsed(t0)})`);
  console.log(`  Tracks added: ${tracksAdded}, Episode: ${episodeProcessed || "none"}\n`);
}

// ─── REALTIME SUBSCRIPTION ──────────────────────────────────

const seedQueue: string[] = [];
const trackQueue: string[] = [];

const MAX_SEED_QUEUE = 500;
const MAX_TRACK_QUEUE = 5000;

function enqueueSeed(seedId: string) {
  if (!seedId) return;
  if (seedQueue.includes(seedId)) return;
  if (seedQueue.length >= MAX_SEED_QUEUE) {
    log("warn", `Seed queue at capacity (${MAX_SEED_QUEUE}) — dropping oldest entries`);
    seedQueue.splice(0, Math.floor(MAX_SEED_QUEUE * 0.2));
  }
  seedQueue.push(seedId);
}

function enqueueTrack(trackId: string) {
  if (!trackId) return;
  if (trackQueue.includes(trackId)) return;
  if (trackQueue.length >= MAX_TRACK_QUEUE) {
    log("warn", `Track queue at capacity (${MAX_TRACK_QUEUE}) — dropping oldest entries`);
    trackQueue.splice(0, Math.floor(MAX_TRACK_QUEUE * 0.2));
  }
  trackQueue.push(trackId);
}

async function enqueueBacklogSeeds() {
  const PAGE = 1000;
  const seeds: Array<{
    id: string;
    artist: string;
    title: string;
    created_at: string;
    user_id: string | null;
    pipeline_status: Record<string, unknown> | null;
  }> = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db.from("seeds")
      .select("id,artist,title,created_at,user_id,pipeline_status")
      .eq("active", true)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) {
      log("fail", `Backlog seed scan failed: ${error.message}`);
      return;
    }
    seeds.push(...(data || []));
    if (!data || data.length < PAGE) break;
  }

  if (seeds.length === 0) return;

  const seedIds = seeds.map((seed) => seed.id);

  // Paginate both the seed IDs and each link table's result rows. One seed can
  // have many links, so batching IDs alone does not avoid PostgREST's row cap.
  const loadLinkedSeedIds = async (
    table: "episode_seeds" | "discovery_runs",
    batch: string[],
  ): Promise<Array<{ seed_id: string }>> => {
    const links: Array<{ seed_id: string }> = [];
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await db.from(table)
        .select("seed_id")
        .in("seed_id", batch)
        .order("seed_id", { ascending: true })
        .range(from, from + PAGE - 1);
      if (error) throw new Error(`${table} backlog scan failed: ${error.message}`);
      links.push(...((data || []) as Array<{ seed_id: string }>));
      if (!data || data.length < PAGE) break;
    }
    return links;
  };

  const allEpisodeLinks: Array<{ seed_id: string }> = [];
  const allRunLinks: Array<{ seed_id: string }> = [];
  for (let i = 0; i < seedIds.length; i += PAGE) {
    const batch = seedIds.slice(i, i + PAGE);
    try {
      const [episodeLinks, runLinks] = await Promise.all([
        loadLinkedSeedIds("episode_seeds", batch),
        loadLinkedSeedIds("discovery_runs", batch),
      ]);
      allEpisodeLinks.push(...episodeLinks);
      allRunLinks.push(...runLinks);
    } catch (error) {
      log("fail", error instanceof Error ? error.message : String(error));
      return;
    }
  }

  const seedsWithEpisodes = new Set(allEpisodeLinks.map((link: any) => link.seed_id));
  const seedsWithRuns = new Set(allRunLinks.map((link: any) => link.seed_id));
  const freshSharedSeeds = seeds.filter((seed) =>
    !seed.user_id
      && !seedsWithEpisodes.has(seed.id)
      && !seedsWithRuns.has(seed.id)
  );
  const freshSeeds = [...freshSharedSeeds, ...latestStatelessUserSeeds(seeds)];

  if (freshSeeds.length === 0) {
    log("info", "No backlog seeds to recover");
    return;
  }

  for (const seed of freshSeeds) {
    enqueueSeed(seed.id);
  }

  log("info", `Recovered ${freshSeeds.length} fresh seed(s) missed before watcher startup`);
}

async function enqueueBacklogTracks() {
  const MAX_DL_ATTEMPTS = 3;
  const { data: tracks, error } = await db.from("tracks")
    .select("id, status, spotify_url, youtube_url, storage_path, created_at, dl_attempts")
    .in("status", ["pending", "approved"])
    .is("storage_path", null)
    .lt("dl_attempts", MAX_DL_ATTEMPTS)
    .order("created_at", { ascending: true })
    .limit(500);

  if (error) {
    log("fail", `Backlog track scan failed: ${error.message}`);
    return;
  }

  // Only enrich tracks that truly need it:
  // - spotify_url is null (not empty string — empty string = already tried, found nothing)
  // - OR no youtube_url and no storage_path
  const incomplete = (tracks || []).filter((track) =>
    !track.youtube_url || (track.status === "pending" && track.spotify_url === null)
  );

  if (incomplete.length === 0) {
    log("info", "No backlog tracks to recover");
    return;
  }

  for (const track of incomplete) {
    enqueueTrack(track.id);
  }

  log("info", `Recovered ${incomplete.length} incomplete track(s) for enrich/download repair`);
}

async function enqueueBacklogSuperLikes() {
  const { data: superLiked, error } = await db.from("user_tracks")
    .select("track_id, tracks(artist, title)")
    .eq("super_liked", true);

  if (error) {
    log("fail", `Backlog super-like scan failed: ${error.message}`);
    return;
  }

  if (!superLiked || superLiked.length === 0) {
    log("info", "No backlog super likes to recover");
    return;
  }

  let existingFiles: Set<string>;
  try {
    existingFiles = new Set(readdirSync(SUPER_LIKE_DIR));
  } catch {
    existingFiles = new Set();
  }

  let enqueued = 0;
  for (const row of superLiked) {
    const track = Array.isArray(row.tracks) ? row.tracks[0] : row.tracks;
    if (!track?.artist || !track?.title) continue;
    const expected = `${sanitizeFilename(track.artist)} - ${sanitizeFilename(track.title)}.mp3`;
    if (!existingFiles.has(expected)) {
      enqueueSuperLike(row.track_id);
      enqueued++;
    }
  }

  if (enqueued === 0) {
    log("info", "All super-liked tracks already downloaded");
  } else {
    log("info", `Recovered ${enqueued} super-liked track(s) missing from local directory`);
  }
}

async function pollForMissingSuperLikes() {
  try {
    const { data: superLiked, error } = await db.from("user_tracks")
      .select("track_id, tracks(artist, title)")
      .eq("super_liked", true);

    if (error || !superLiked?.length) return;

    let existingFiles: Set<string>;
    try {
      existingFiles = new Set(readdirSync(SUPER_LIKE_DIR));
    } catch {
      existingFiles = new Set();
    }

    let enqueued = 0;
    for (const row of superLiked) {
      const track = Array.isArray(row.tracks) ? row.tracks[0] : row.tracks;
      if (!track?.artist || !track?.title) continue;
      const expected = `${sanitizeFilename(track.artist)} - ${sanitizeFilename(track.title)}.mp3`;
      if (!existingFiles.has(expected)) {
        enqueueSuperLike(row.track_id);
        enqueued++;
      }
    }

    if (enqueued > 0) {
      log("info", `[Poll] ${enqueued} super-like(s) missing locally — enqueuing`);
      processSuperLikeQueue();
    }
  } catch (err) {
    log("fail", `pollForMissingSuperLikes error: ${err instanceof Error ? err.message : err}`);
  }
}

async function processTrack(trackId: string, prefetched?: any) {
  const { data: track, error } = prefetched
    ? { data: prefetched, error: null }
    : await db.from("tracks").select("*").eq("id", trackId).single();

  if (error || !track) {
    log("fail", `Could not read track ${trackId}: ${error?.message ?? "not found"}`);
    return;
  }

  const label = `${track.artist} – ${track.title}`;
  const MAX_DL_ATTEMPTS = 3;
  // Only consider Spotify missing if it's truly null (not empty string — empty string means
  // enrichment already ran and found nothing, so don't re-enrich repeatedly).
  const spotifyMissing = track.spotify_url === null || track.spotify_url === undefined;
  const shouldEnrich =
    track.status === "pending" &&
    (spotifyMissing || (!track.youtube_url && !track.storage_path));
  if (!shouldEnrich) {
    return;
  }

  log("info", `Repairing track: ${label}`);
  await logEngineEvent("repair_started", "started", {
    message: label,
    metadata: {
      track_id: trackId,
      should_enrich: shouldEnrich,
      audio_preparation: "deferred_to_ranked_queue",
    },
  });

  if (shouldEnrich) {
    await enrichTrackFast(track);
  }

  const { data: refreshed } = await db.from("tracks")
    .select("*")
    .eq("id", trackId)
    .single();

  if (!refreshed) return;

  await logEngineEvent("repair_completed", "completed", {
    message: label,
    metadata: {
      track_id: trackId,
      audio_preparation: "deferred_to_ranked_queue",
    },
  });
}

// ─── SUPER LIKE PIPELINE ────────────────────────────────────

const SUPER_LIKE_DIR = `${process.env.HOME}/Music/PicoDrops/AzoreanStacks`;

function sanitizeFilename(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\w\s\-.,()&+]/g, "").replace(/\s+/g, " ").trim().slice(0, 100) || "unknown";
}

async function processSuperLike(trackId: string) {
  const { data: track, error } = await db.from("tracks")
    .select("*")
    .eq("id", trackId)
    .single();

  if (error || !track) {
    log("fail", `Super Like: could not read track ${trackId}: ${error?.message ?? "not found"}`);
    await logEngineEvent("error", "failed", {
      message: `Super Like: could not read track: ${error?.message ?? "not found"}`,
      metadata: { track_id: trackId },
    });
    return;
  }

  const label = `${track.artist} – ${track.title}`;
  console.log(`\n━━━ SUPER LIKE: Local download triggered ━━━`);
  console.log(`  ${label}`);

  await logEngineEvent("super_like_detected", "started", {
    message: label,
    metadata: { track_id: trackId },
  });

  // Ensure YouTube URL is available — enrich first if needed
  let ytUrl = track.youtube_url;
  if (!ytUrl) {
    log("info", `Super Like: no YouTube URL yet, enriching ${label}`);
    await enrichTrack(track);
    const { data: refreshed } = await db.from("tracks").select("*").eq("id", trackId).single();
    ytUrl = refreshed?.youtube_url ?? null;
  }

  if (!ytUrl) {
    log("warn", `Super Like: no YouTube URL found for ${label} — skipping local download`);
    await logEngineEvent("error", "failed", {
      message: `Super Like: no YouTube URL for ${label}`,
      metadata: { track_id: trackId },
    });
    markSuperLikeFailed(trackId);
    return;
  }

  // Ensure output directory exists
  if (!existsSync(SUPER_LIKE_DIR)) {
    mkdirSync(SUPER_LIKE_DIR, { recursive: true });
    log("info", `Created PicoDrops dir: ${SUPER_LIKE_DIR}`);
  }

  const safeArtist = sanitizeFilename(track.artist);
  const safeTitle = sanitizeFilename(track.title);
  const outFilename = `${safeArtist} - ${safeTitle}.mp3`;
  const outPath = `${SUPER_LIKE_DIR}/${outFilename}`;
  const outTemplate = `${SUPER_LIKE_DIR}/${safeArtist} - ${safeTitle}.%(ext)s`;

  const YT_DLP_BIN =
    process.env.YT_DLP_BIN ||
    Bun.which("yt-dlp") ||
    "/opt/homebrew/bin/yt-dlp";

  log("info", `Super Like: downloading "${outFilename}" via yt-dlp`);

  const dlProc = Bun.spawn(
    [YT_DLP_BIN, ...ytDlpAudioArgs(ytUrl, outTemplate)],
    { stdout: "ignore", stderr: "pipe" },
  );
  const stderrPromise = new Response(dlProc.stderr).text();

  let exitCode: number;
  try {
    exitCode = await Promise.race([
      dlProc.exited,
      new Promise<number>((_, reject) =>
        setTimeout(() => reject(new Error("Timeout after 120s")), 120_000)
      ),
    ]);
  } catch (err) {
    try { dlProc.kill(); } catch {} // kill orphaned yt-dlp process
    markSuperLikeFailed(trackId);
    log("fail", `Super Like: yt-dlp timed out for ${label}`);
    await logEngineEvent("error", "failed", {
      message: `Super Like: download timeout for ${label}`,
      metadata: { track_id: trackId },
    });
    return;
  }

  if (exitCode !== 0) {
    const stderr = (await stderrPromise).trim().slice(-1200);
    log("fail", `Super Like: yt-dlp exited with ${exitCode} for ${label}${stderr ? ` — ${stderr}` : ""}`);
    markSuperLikeFailed(trackId);
    await logEngineEvent("error", "failed", {
      message: `Super Like: yt-dlp failed (exit ${exitCode}) for ${label}`,
      metadata: { track_id: trackId },
    });
    return;
  }

  log("ok", `Super Like: downloaded → ${outPath}`);
  await logEngineEvent("super_like_completed", "completed", {
    message: `${label} → ${outFilename}`,
    metadata: { track_id: trackId, path: outPath },
  });
}

const superLikeQueue: string[] = [];
const MAX_SUPER_LIKE_QUEUE = 200;
const superLikeFailures = new Map<string, number>(); // trackId → fail count
const MAX_SUPER_LIKE_RETRIES = 3;

function enqueueSuperLike(trackId: string) {
  if (!trackId) return;
  if (superLikeQueue.includes(trackId)) return;
  const fails = superLikeFailures.get(trackId) || 0;
  if (fails >= MAX_SUPER_LIKE_RETRIES) return; // stop retrying after 3 failures
  if (superLikeQueue.length >= MAX_SUPER_LIKE_QUEUE) {
    log("warn", `Super-like queue at capacity (${MAX_SUPER_LIKE_QUEUE}) — dropping oldest entries`);
    superLikeQueue.splice(0, Math.floor(MAX_SUPER_LIKE_QUEUE * 0.2));
  }
  superLikeQueue.push(trackId);
}

function markSuperLikeFailed(trackId: string) {
  const count = (superLikeFailures.get(trackId) || 0) + 1;
  superLikeFailures.set(trackId, count);
  if (count >= MAX_SUPER_LIKE_RETRIES) {
    log("warn", `Super Like: giving up on ${trackId} after ${count} failures`);
  }
}

// ─── PRIORITY PIPELINE ──────────────────────────────────────

type SeedPipelineFence = {
  id: string;
  user_id: string;
  fyp_refresh_required_at: string;
};

async function updatePipelineStatus(
  fence: SeedPipelineFence,
  updates: Record<string, unknown>,
  logMsg?: string,
): Promise<void> {
  const { data: seed, error: readError } = await db.from("seeds")
    .select("pipeline_status")
    .eq("id", fence.id)
    .eq("user_id", fence.user_id)
    .eq("active", true)
    .eq("fyp_refresh_required_at", fence.fyp_refresh_required_at)
    .maybeSingle();
  if (readError) throw new Error(`pipeline status read failed: ${readError.message}`);
  if (!seed) throw new Error("seed pipeline generation changed");

  const current = (seed.pipeline_status as Record<string, unknown>) || {};
  const timeStr = new Date().toTimeString().slice(0, 8);
  const newLogs = logMsg
    ? [...((current.log as unknown[]) || []), { t: timeStr, msg: logMsg }]
    : (current.log as unknown[]) || [];
  const newStatus = { ...current, ...updates, log: newLogs };
  const { data: updated, error: updateError } = await db.from("seeds")
    .update({ pipeline_status: newStatus })
    .eq("id", fence.id)
    .eq("user_id", fence.user_id)
    .eq("active", true)
    .eq("fyp_refresh_required_at", fence.fyp_refresh_required_at)
    .select("id")
    .maybeSingle();
  if (updateError) throw new Error(`pipeline status write failed: ${updateError.message}`);
  if (!updated) throw new Error("seed pipeline generation changed before status write");
}

async function loadSeedFypRefresh(seedId: string): Promise<{
  id: string;
  user_id: string;
  fyp_refresh_required_at: string;
} | null> {
  const { data, error } = await db.from("seeds")
    .select("id,user_id,fyp_refresh_required_at")
    .eq("id", seedId)
    .eq("active", true)
    .maybeSingle();
  if (error) throw new Error(`seed FYP requirement lookup failed: ${error.message}`);
  if (!data?.user_id || !data.fyp_refresh_required_at) return null;
  return data as { id: string; user_id: string; fyp_refresh_required_at: string };
}

async function claimSeedFypRefresh(seed: {
  id: string;
  fyp_refresh_required_at?: string | null;
}): Promise<string | null> {
  if (!seed.fyp_refresh_required_at) return null;
  const { data, error } = await db.rpc("claim_seed_fyp_refresh", {
    p_seed_id: seed.id,
    p_required_at: seed.fyp_refresh_required_at,
  });
  if (error) throw new Error(`seed FYP claim failed: ${error.message}`);
  return typeof data === "string" && data ? data : null;
}

async function writeSeedFypCheckpoint(
  seed: { id: string; user_id?: string | null; fyp_refresh_required_at?: string | null },
  claimToken: string,
): Promise<void> {
  if (!seed.user_id || !seed.fyp_refresh_required_at) {
    throw new Error("seed FYP owner or requirement marker is missing");
  }
  const { data, error: updateError } = await db.from("seeds").update({
    fyp_refreshed_at: new Date().toISOString(),
    fyp_refresh_claimed_at: null,
  })
    .eq("id", seed.id)
    .eq("user_id", seed.user_id)
    .eq("active", true)
    .eq("fyp_refresh_required_at", seed.fyp_refresh_required_at)
    .eq("fyp_refresh_claimed_at", claimToken)
    .is("fyp_refreshed_at", null)
    .select("id")
    .maybeSingle();
  if (updateError) throw new Error(`seed FYP checkpoint write failed: ${updateError.message}`);
  if (data) return;

  const { data: current, error: readError } = await db.from("seeds")
    .select("user_id,active,fyp_refresh_required_at,fyp_refreshed_at")
    .eq("id", seed.id)
    .maybeSingle();
  if (readError) throw new Error(`seed FYP checkpoint verification failed: ${readError.message}`);
  if (
    current?.user_id === seed.user_id
      && current.active === true
      && current.fyp_refresh_required_at === seed.fyp_refresh_required_at
      && current.fyp_refreshed_at
  ) return;
  throw new Error("seed FYP generation changed before checkpoint");
}

async function releaseSeedFypClaim(
  seed: { id: string; user_id?: string | null; fyp_refresh_required_at?: string | null },
  claimToken: string,
): Promise<void> {
  if (!seed.user_id || !seed.fyp_refresh_required_at) return;
  const { error } = await db.from("seeds").update({ fyp_refresh_claimed_at: null })
    .eq("id", seed.id)
    .eq("user_id", seed.user_id)
    .eq("active", true)
    .eq("fyp_refresh_required_at", seed.fyp_refresh_required_at)
    .eq("fyp_refresh_claimed_at", claimToken)
    .is("fyp_refreshed_at", null);
  if (error) throw new Error(`seed FYP claim release failed: ${error.message}`);
}

async function refreshSeedFypWithCheckpoint(
  seedId: string,
  expectedUserId: string | null | undefined,
  expectedRequiredAt?: string,
  afterRefresh?: (ownerUserId: string) => Promise<void>,
): Promise<boolean> {
  if (!expectedUserId) return false;
  let seed: Awaited<ReturnType<typeof loadSeedFypRefresh>> = null;
  let claimToken: string | null = null;
  try {
    seed = await loadSeedFypRefresh(seedId);
    if (
      !seed
        || seed.user_id !== expectedUserId
        || (expectedRequiredAt && seed.fyp_refresh_required_at !== expectedRequiredAt)
    ) return false;
    claimToken = await claimSeedFypRefresh(seed);
    if (!claimToken) return false;
    await serializeQueueMutation(() => refreshPersonalizedQueue(seed!.user_id, 3));
    await afterRefresh?.(seed.user_id);
    await writeSeedFypCheckpoint(seed, claimToken);
    return true;
  } catch (error) {
    if (seed && claimToken) {
      try {
        await releaseSeedFypClaim(seed, claimToken);
      } catch (releaseError) {
        log("fail", `Seed FYP claim release failed for ${seedId}: ${releaseError instanceof Error ? releaseError.message : releaseError}`);
      }
    }
    log("fail", `Seed FYP refresh failed for ${expectedUserId}: ${error instanceof Error ? error.message : error}`);
    return false;
  }
}

let seedFypRecoveryRunning = false;
async function recoverMissedSeedFypRefreshes(): Promise<void> {
  if (seedFypRecoveryRunning) return;
  seedFypRecoveryRunning = true;
  try {
    const seeds: Array<{
      id: string;
      user_id: string | null;
      pipeline_status: Record<string, unknown> | null;
      fyp_refresh_required_at: string | null;
      fyp_refreshed_at: string | null;
    }> = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await db.from("seeds")
        .select("id,user_id,pipeline_status,fyp_refresh_required_at,fyp_refreshed_at")
        .eq("active", true)
        .not("user_id", "is", null)
        .not("fyp_refresh_required_at", "is", null)
        .is("fyp_refreshed_at", null)
        .order("created_at", { ascending: false })
        .range(from, from + 999);
      if (error) throw new Error(`Seed FYP recovery scan failed: ${error.message}`);
      seeds.push(...(data || []));
      if (!data || data.length < 1000) break;
    }
    const result = await recoverSeedFypRefreshes(
      seeds,
      claimSeedFypRefresh,
      (ownerUserId) => serializeQueueMutation(() => refreshPersonalizedQueue(ownerUserId, 3)),
      writeSeedFypCheckpoint,
      releaseSeedFypClaim,
      (seed, refreshError) => log(
        "fail",
        `Seed FYP recovery failed for ${seed.id}: ${refreshError instanceof Error ? refreshError.message : refreshError}`,
      ),
    );
    if (result.recovered > 0) {
      log("ok", `Recovered ${result.recovered}/${result.claimed} claimed seed FYP refresh(es); ${result.pending} pending`);
    }
  } catch (error) {
    log("fail", error instanceof Error ? error.message : String(error));
  } finally {
    seedFypRecoveryRunning = false;
  }
}

async function processPrioritySeed(fence: SeedPipelineFence) {
  const seedId = fence.id;
  const startTime = Date.now();
  const { data: seed, error: seedErr } = await db.from("seeds")
    .select("*")
    .eq("id", fence.id)
    .eq("user_id", fence.user_id)
    .eq("active", true)
    .eq("fyp_refresh_required_at", fence.fyp_refresh_required_at)
    .maybeSingle();
  if (seedErr || !seed) {
    throw new Error(`Priority seed ${seedId} changed owner, activation, or generation`);
  }

  const seedLabel = `${seed.artist} – ${seed.title}`;
  log("info", `\n━━━ PRIORITY: Pipeline starting for ${seedLabel} ━━━`);

  await updatePipelineStatus(fence, { state: "discovering" }, `searching for "${seedLabel}"`);

  type Candidate = {
    url: string;
    title: string;
    date: string | null;
    sourceName: string;
    existingEpisodeId: string | null;
    trackCount: number;
    rawTracklist: Array<{ artist: string; title: string }>;
  };

  const candidates: Candidate[] = [];

  for (const source of SOURCES) {
    let sourceEpisodes: Array<{ url: string; title: string; date: string | null }> = [];

    if (source.name === "lotradio") {
      const seedArtistLower = seed.artist.toLowerCase().trim();
      const seedTitleLower = seed.title.toLowerCase().trim();

      // Paginated scan of all lotradio episodes in DB
      let page = 0;
      const pageSize = 1000;
      while (true) {
        const { data: dbEpisodes } = await db.from("episodes")
          .select("url, title, aired_date, metadata")
          .eq("source", "lotradio")
          .not("metadata", "is", null)
          .range(page * pageSize, (page + 1) * pageSize - 1);

        if (!dbEpisodes || dbEpisodes.length === 0) break;

        for (const ep of dbEpisodes as any[]) {
          const tracklist: Array<{ artist: string; title: string }> = ep.metadata?.tracklist || [];
          if (tracklist.length === 0) continue;
          const hasMatch = tracklist.some((t) =>
            t.artist?.toLowerCase().trim() === seedArtistLower &&
            t.title?.toLowerCase().trim() === seedTitleLower
          );
          if (hasMatch) {
            sourceEpisodes.push({ url: ep.url, title: ep.title || ep.url, date: ep.aired_date || null });
          }
        }

        if (dbEpisodes.length < pageSize) break;
        page++;
      }

      await updatePipelineStatus(fence, {}, `lot radio: ${sourceEpisodes.length} matches`);
    } else {
      try {
        const results = await source.searchForSeed(seed.artist, seed.title);
        sourceEpisodes = results.map((e) => ({ url: e.url, title: e.title, date: e.date }));
      } catch (err) {
        log("fail", `Priority: ${source.name} search error: ${err instanceof Error ? err.message : err}`);
        continue;
      }
      await updatePipelineStatus(fence, {}, `${source.name}: ${sourceEpisodes.length} episodes found`);
    }

    // Score episodes by track count
    for (const ep of sourceEpisodes.slice(0, CONCURRENCY.ntsMaxEpisodes)) {
      const { data: existingEp } = await db.from("episodes")
        .select("id").eq("url", ep.url).limit(1).maybeSingle();

      let trackCount = 0;
      let rawTracklist: Array<{ artist: string; title: string }> = [];
      const existingEpisodeId = existingEp?.id || null;

      if (existingEp) {
        const { count } = await db.from("tracks")
          .select("*", { count: "exact", head: true })
          .eq("episode_id", existingEp.id);
        trackCount = count || 0;
      }

      if (trackCount === 0) {
        try {
          rawTracklist = await source.getTracklist(ep.url);
          trackCount = rawTracklist.length;
        } catch {
          continue;
        }
      }

      if (trackCount > 0) {
        candidates.push({
          url: ep.url,
          title: ep.title,
          date: ep.date,
          sourceName: source.name,
          existingEpisodeId,
          trackCount,
          rawTracklist,
        });
      }
    }
  }

  if (candidates.length === 0) {
    await updatePipelineStatus(
      fence,
      { state: "done", completed_at: new Date().toISOString() },
      "no episodes found",
    );
    log("warn", `Priority: no episodes found for ${seedLabel}`);
    return;
  }

  // Pick best: most tracks
  const best = candidates.sort((a, b) => b.trackCount - a.trackCount)[0];
  await updatePipelineStatus(fence, { episode_title: best.title }, `best episode: "${best.title}" (${best.trackCount} tracks)`);

  const sourceObj = SOURCES.find((s) => s.name === best.sourceName)!;
  let episodeId = best.existingEpisodeId;

  // Create episode if it doesn't exist
  if (!episodeId) {
    const artworkUrl = await sourceObj.getArtwork(best.url);
    const { data: newEp, error: epErr } = await db.from("episodes").upsert({
      url: best.url,
      title: best.title || null,
      source: best.sourceName,
      aired_date: best.date || null,
      artwork_url: artworkUrl,
    }, { onConflict: "url" }).select("id").single();

    if (!newEp) {
      await updatePipelineStatus(
        fence,
        { state: "error", error: `Episode insert failed: ${epErr?.message}` },
        "episode insert failed",
      );
      return;
    }
    episodeId = newEp.id;
  }

  // Determine match type: full if seed track appears in the tracklist, artist if only artist matches
  let priorityMatchType: "full" | "artist" | "unknown" = "unknown";
  if (best.rawTracklist.length > 0) {
    const hasFullMatch = best.rawTracklist.some((t) => isSameTrack(t, { artist: seed.artist, title: seed.title }));
    const hasArtistMatch = !hasFullMatch && best.rawTracklist.some(
      (t) => t.artist.toLowerCase().trim() === seed.artist.toLowerCase().trim()
    );
    priorityMatchType = hasFullMatch ? "full" : hasArtistMatch ? "artist" : "unknown";
  }

  await db.from("episode_seeds").upsert(
    { episode_id: episodeId, seed_id: seedId, match_type: priorityMatchType },
    { onConflict: "episode_id,seed_id" },
  );

  // Insert new tracks (skip if episode already has tracks in DB)
  let tracksToProcess: any[] = [];

  if (best.rawTracklist.length > 0) {
    const context = `${best.title}${best.date ? ` (${best.date})` : ""}`;
    for (let pos = 0; pos < best.rawTracklist.length; pos++) {
      const track = best.rawTracklist[pos];
      if (isSameTrack(track, { artist: seed.artist, title: seed.title })) continue;
      if (isGarbageTrack(track.artist, track.title)) continue;

      const escArtist = track.artist.trim().replace(/[%_\\]/g, (c: string) => `\\${c}`);
      const escTitle = track.title.trim().replace(/[%_\\]/g, (c: string) => `\\${c}`);
      const { data: existing } = await db.from("tracks")
        .select("*").ilike("artist", escArtist).ilike("title", escTitle).limit(1);
      let candidate = existing?.[0] || null;
      if (!candidate) {
        const { data: inserted } = await db.from("tracks").insert({
          artist: track.artist.trim(),
          title: track.title.trim(),
          source: best.sourceName,
          source_url: best.url,
          source_context: context,
          metadata: { co_occurrence: 1, seed_artist: seed.artist, seed_title: seed.title },
          status: "pending",
          episode_id: episodeId,
          seed_track_id: seed.track_id || null,
        }).select("*").single();
        if (!inserted) continue;
        candidate = inserted;
        tracksToProcess.push(inserted);
      }

      const { error: episodeTrackError } = await db.from("episode_tracks").upsert(
        { episode_id: episodeId, track_id: candidate.id, position: pos },
        { onConflict: "episode_id,track_id" },
      );
      if (episodeTrackError) log("fail", `Priority episode link failed for ${candidate.id}: ${episodeTrackError.message}`);
      if (seed.user_id) {
        const { error: userTrackError } = await db.from("user_tracks").upsert(
          { user_id: seed.user_id, track_id: candidate.id, status: "pending" },
          { onConflict: "user_id,track_id", ignoreDuplicates: true },
        );
        if (userTrackError) log("fail", `Priority user candidate link failed for ${candidate.id}: ${userTrackError.message}`);
      }
    }
  } else {
    const { data: links, error: linksError } = await db.from("episode_tracks")
      .select("track_id")
      .eq("episode_id", episodeId);
    if (linksError) log("fail", `Priority episode lookup failed: ${linksError.message}`);
    const trackIds = [...new Set((links || []).map((link) => link.track_id))];
    if (trackIds.length > 0) {
      const { data: episodeTracks, error: tracksError } = await db.from("tracks")
        .select("*")
        .in("id", trackIds);
      if (tracksError) log("fail", `Priority track lookup failed: ${tracksError.message}`);
      tracksToProcess = (episodeTracks || []).filter((track) =>
        track.status === "pending" || (track.youtube_url && !track.storage_path)
      );
      if (seed.user_id) {
        const { error: userTrackError } = await db.from("user_tracks").upsert(
          trackIds.map((trackId) => ({ user_id: seed.user_id, track_id: trackId, status: "pending" })),
          { onConflict: "user_id,track_id", ignoreDuplicates: true },
        );
        if (userTrackError) log("fail", `Priority user candidate batch failed: ${userTrackError.message}`);
      }
    }
  }

  if (tracksToProcess.length === 0) {
    await refreshSeedFypWithCheckpoint(
      seedId,
      seed.user_id,
      fence.fyp_refresh_required_at,
    );
    await updatePipelineStatus(
      fence,
      { state: "done", completed_at: new Date().toISOString() },
      "no tracks to enrich",
    );
    return;
  }

  // Phase 2: Enrich all tracks
  await updatePipelineStatus(
    fence,
    { state: "enriching", progress: `0/${tracksToProcess.length}` },
    `enriching ${tracksToProcess.length} tracks`,
  );

  let enriched = 0;
  for (let i = 0; i < tracksToProcess.length; i += PRIORITY_ENRICH_CONCURRENCY) {
    const batch = tracksToProcess.slice(i, i + PRIORITY_ENRICH_CONCURRENCY);
    const results = await Promise.allSettled(batch.map(enrichTrackFast));
    for (const r of results) {
      if (r.status === "fulfilled" && r.value) enriched++;
    }
    await updatePipelineStatus(fence, { progress: `${Math.min(i + PRIORITY_ENRICH_CONCURRENCY, tracksToProcess.length)}/${tracksToProcess.length}` });
  }

  await updatePipelineStatus(fence, {}, `enriched ${enriched}/${tracksToProcess.length} tracks`);

  // Phase 3: Re-rank per-user preparation queues. The bounded drain owns audio;
  // priority discovery must not download every track from the selected episode.
  let materializedTracks = 0;
  await refreshSeedFypWithCheckpoint(
    seedId,
    seed.user_id,
    fence.fyp_refresh_required_at,
    async (userId) => {
      const { count } = await db.from("audio_preparation_queue")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId);
      materializedTracks = count || 0;
    },
  );

  await updatePipelineStatus(
    fence,
    { state: "preparing", progress: `0/${materializedTracks}` },
    `queued bounded audio preparation for ${materializedTracks} ranked entries`,
  );

  // Phase 4: Cleanup — mark dangling pending tracks (no spotify_url AND no youtube_url) as skipped
  const trackIds = tracksToProcess.map((t) => t.id);
  if (trackIds.length > 0) {
    const { data: dangling } = await db.from("tracks")
      .select("id")
      .in("id", trackIds)
      .eq("status", "pending")
      .is("spotify_url", null)
      .is("youtube_url", null);

    if (dangling && dangling.length > 0) {
      // Update each track individually to preserve existing metadata
      for (const t of dangling) {
        const { data: existing } = await db.from("tracks").select("metadata").eq("id", t.id).single();
        await db.from("tracks")
          .update({ status: "skipped", metadata: { ...(existing?.metadata || {}), skip_reason: "no_spotify_or_youtube_match" } })
          .eq("id", t.id);
      }
      await updatePipelineStatus(fence, {}, `skipped ${dangling.length} tracks with no match`);
      log("info", `Priority: skipped ${dangling.length} dangling tracks for ${seedLabel}`);
    }
  }

  const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1);
  await updatePipelineStatus(
    fence,
    { state: "done", completed_at: new Date().toISOString() },
    `pipeline complete — ${tracksToProcess.length} tracks processed, ${enriched} enriched, audio queued in ${elapsedSec}s`,
  );

  log("ok", `Priority pipeline done for ${seedLabel} — ${tracksToProcess.length} tracks, ${enriched} enriched, bounded audio queued in ${elapsedSec}s`);
}

async function processPriorityQueue() {
  while (true) {
    if (shuttingDown) break;
    await sleep(3000);
    if (shuttingDown) break;

    try {
      const { data: queuedSeeds } = await db.from("seeds")
        .select("id,user_id,fyp_refresh_required_at")
        .not("user_id", "is", null)
        .filter("pipeline_status->>state", "eq", "queued")
        .limit(1);

      if (!queuedSeeds || queuedSeeds.length === 0) continue;

      const queuedSeed = queuedSeeds[0];
      if (!queuedSeed.user_id) continue;
      const seedId = queuedSeed.id;
      const requiredAt = queuedSeed.fyp_refresh_required_at || new Date().toISOString();
      log("info", `Priority queue: picked up seed ${seedId}`);

      // Mark as in-progress using owner, activation, state, and generation CAS.
      const timeStr = new Date().toTimeString().slice(0, 8);
      let claimQuery = db.from("seeds")
        .update({
          pipeline_status: {
            state: "discovering",
            started_at: new Date().toISOString(),
            log: [{ t: timeStr, msg: "pipeline started" }],
          },
          fyp_refresh_required_at: requiredAt,
        })
        .eq("id", seedId)
        .eq("user_id", queuedSeed.user_id)
        .eq("active", true)
        .filter("pipeline_status->>state", "eq", "queued");
      claimQuery = queuedSeed.fyp_refresh_required_at
        ? claimQuery.eq("fyp_refresh_required_at", queuedSeed.fyp_refresh_required_at)
        : claimQuery.is("fyp_refresh_required_at", null);
      const { data: updated, error: claimError } = await claimQuery
        .select("id,user_id,fyp_refresh_required_at")
        .maybeSingle();
      if (claimError) throw new Error(`priority seed claim failed: ${claimError.message}`);

      if (!updated?.user_id || !updated.fyp_refresh_required_at) {
        // Another processor or generation won the claim.
        continue;
      }
      const fence: SeedPipelineFence = {
        id: updated.id,
        user_id: updated.user_id,
        fyp_refresh_required_at: updated.fyp_refresh_required_at,
      };

      try {
        await processPrioritySeed(fence);
      } catch (err) {
        try {
          await updatePipelineStatus(
            fence,
            { state: "error", error: err instanceof Error ? err.message : String(err) },
            `error: ${err instanceof Error ? err.message : err}`,
          );
        } catch (statusError) {
          log("skip", `Priority generation changed before error status for ${seedId}: ${statusError instanceof Error ? statusError.message : statusError}`);
        }
        log("fail", `Priority pipeline error for ${seedId}: ${err instanceof Error ? err.message : err}`);
      }
    } catch (err) {
      log("fail", `Priority queue loop error: ${err instanceof Error ? err.message : err}`);
    }
  }
}

async function resetStalePipelineStatuses() {
  // Use 30 minutes — priority pipeline can take 10-20+ min for large episode sets
  const fiveMinutesAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  try {
    const { data: stale } = await db.from("seeds")
      .select("id,user_id,pipeline_status,fyp_refresh_required_at")
      .eq("active", true)
      .not("user_id", "is", null)
      .not("fyp_refresh_required_at", "is", null)
      .not("pipeline_status", "is", null)
      .not("pipeline_status->>state", "eq", "done")
      .not("pipeline_status->>state", "eq", "error")
      .lt("pipeline_status->>started_at", fiveMinutesAgo);

    if (!stale || stale.length === 0) return;

    for (const seed of stale) {
      const startedAt = seed.pipeline_status?.started_at;
      if (!seed.user_id || !seed.fyp_refresh_required_at || typeof startedAt !== "string") continue;
      await db.from("seeds").update({
        pipeline_status: { ...seed.pipeline_status, state: "queued" },
      })
        .eq("id", seed.id)
        .eq("user_id", seed.user_id)
        .eq("active", true)
        .eq("fyp_refresh_required_at", seed.fyp_refresh_required_at)
        .filter("pipeline_status->>started_at", "eq", startedAt);
    }

    log("info", `Reset ${stale.length} stale pipeline status(es) to "queued"`);
  } catch (err) {
    log("fail", `resetStalePipelineStatuses error: ${err instanceof Error ? err.message : err}`);
  }
}

// ─── INDEPENDENT QUEUE PROCESSORS ───────────────────────────

let seedProcessing = false;
async function processSeedQueue() {
  if (seedProcessing) return;
  seedProcessing = true;
  while (seedQueue.length > 0) {
    lastEventAt = new Date().toISOString();
    updateStatusFile();
    const seedId = seedQueue.shift()!;
    try {
      await processSeed(seedId);
    } catch (err) {
      log("fail", `Pipeline error for seed ${seedId}: ${err instanceof Error ? err.message : err}`);
      await logEngineEvent("error", "failed", {
        seedId,
        message: `Pipeline error: ${err instanceof Error ? err.message : err}`,
      });
    }
  }
  seedProcessing = false;
}

let superLikeProcessing = false;
async function processSuperLikeQueue() {
  if (superLikeProcessing) return;
  superLikeProcessing = true;
  while (superLikeQueue.length > 0) {
    lastEventAt = new Date().toISOString();
    updateStatusFile();
    const batch = superLikeQueue.splice(0, CONCURRENCY.superLike);
    await Promise.allSettled(
      batch.map(async (trackId) => {
        try {
          await processSuperLike(trackId);
        } catch (err) {
          log("fail", `Super Like error for track ${trackId}: ${err instanceof Error ? err.message : err}`);
          await logEngineEvent("error", "failed", {
            message: `Super Like error: ${err instanceof Error ? err.message : err}`,
            metadata: { track_id: trackId },
          });
        }
      }),
    );
  }
  superLikeProcessing = false;
}

let repairProcessing = false;
async function processRepairQueue() {
  if (repairProcessing) return;
  repairProcessing = true;
  while (trackQueue.length > 0) {
    lastEventAt = new Date().toISOString();
    updateStatusFile();
    const batchIds = trackQueue.splice(0, CONCURRENCY.repair);
    const { data: batchTracks } = await db.from("tracks")
      .select("*")
      .in("id", batchIds);
    const trackMap = new Map((batchTracks || []).map((t: any) => [t.id, t]));
    await Promise.allSettled(
      batchIds.map(async (trackId) => {
        try {
          await processTrack(trackId, trackMap.get(trackId));
        } catch (err) {
          log("fail", `Repair error for track ${trackId}: ${err instanceof Error ? err.message : err}`);
        }
      }),
    );
  }
  repairProcessing = false;
}

async function ensureApprovalSeed(trackId: string, userId: string): Promise<void> {
  const { data: track, error: trackError } = await db.from("tracks")
    .select("artist,title")
    .eq("id", trackId)
    .maybeSingle();
  if (trackError) throw new Error(`track lookup failed: ${trackError.message}`);
  if (!track?.artist || !track?.title) return;

  const { data: byTrack, error: byTrackError } = await db.from("seeds")
    .select("id,track_id")
    .eq("user_id", userId)
    .eq("track_id", trackId)
    .limit(1)
    .maybeSingle();
  if (byTrackError) throw new Error(`seed track lookup failed: ${byTrackError.message}`);

  let existing = byTrack;
  if (!existing) {
    const escapedArtist = track.artist.replace(/[%_\\]/g, (c: string) => `\\${c}`);
    const escapedTitle = track.title.replace(/[%_\\]/g, (c: string) => `\\${c}`);
    const legacyResult = await db.from("seeds")
      .select("id,track_id")
      .eq("user_id", userId)
      .ilike("artist", escapedArtist)
      .ilike("title", escapedTitle)
      .limit(1)
      .maybeSingle();
    if (legacyResult.error) throw new Error(`legacy seed lookup failed: ${legacyResult.error.message}`);
    existing = legacyResult.data;
  }
  if (existing) {
    if (!existing.track_id) await db.from("seeds").update({ track_id: trackId }).eq("id", existing.id);
    return;
  }

  const now = new Date();
  const { error } = await db.from("seeds").insert({
    track_id: trackId,
    artist: track.artist,
    title: track.title,
    user_id: userId,
    source: "auto:approved",
    fyp_refresh_required_at: now.toISOString(),
    pipeline_status: {
      state: "queued",
      started_at: now.toISOString(),
      log: [{ t: now.toTimeString().slice(0, 8), msg: "seed auto-created from approved track" }],
    },
  });
  // The partial unique index makes concurrent INSERT/UPDATE events idempotent.
  if (error && error.code !== "23505") throw new Error(`seed insert failed: ${error.message}`);
  log("ok", `Re-seed queued for approved track: ${track.artist} – ${track.title} (user: ${userId})`);
}

function startWatcher() {
  log("info", "Connecting to Supabase Realtime...");

  currentChannel = db.channel("seeds-watcher")
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "seeds" },
      (payload) => {
        lastRealtimeEventAt = new Date().toISOString();
        const seedId = payload.new?.id;
        if (!seedId) {
          log("warn", "Received INSERT event without seed ID");
          return;
        }
        log("ok", `Seed INSERT detected: ${payload.new?.artist} – ${payload.new?.title} (${seedId})`);
        if (isPriorityManagedSeed(payload.new || {})) {
          log("info", `Seed ${seedId} delegated to priority pipeline`);
          return;
        }
        enqueueSeed(seedId);
        processSeedQueue();
      },
    )
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "user_tracks" },
      async (payload) => {
        lastRealtimeEventAt = new Date().toISOString();
        const trackId = payload.new?.track_id;
        const userId = payload.new?.user_id;
        if (!trackId) {
          log("warn", "Received user_track INSERT without track_id");
          return;
        }
        log("ok", `user_track INSERT detected for track ${trackId}`);
        enqueueTrack(trackId);
        processRepairQueue();
        if (userId && isExplicitDecision(payload.new?.status)) {
          scheduleDecisionRefresh(userId);
        }

        // Re-seed: when a track is approved, auto-create a seed for it so
        // the pipeline discovers co-occurring tracks. The seed is scoped to
        // the approving user so results stay isolated per-user.
        if (payload.new?.status === "approved" && userId) {
          try {
            await ensureApprovalSeed(trackId, userId);
          } catch (err) {
            log("fail", `Re-seed on approve failed for track ${trackId}: ${err instanceof Error ? err.message : err}`);
          }
        }
      },
    )
    .on(
      "postgres_changes",
      { event: "UPDATE", schema: "public", table: "user_tracks" },
      async (payload) => {
        lastRealtimeEventAt = new Date().toISOString();
        const trackId = payload.new?.track_id;
        const userId = payload.new?.user_id;
        const becameApproved = payload.new?.status === "approved" && payload.old?.status !== "approved";
        if (!trackId || !userId) return;
        const explicitDecision = isExplicitDecision(payload.new?.status);
        if (explicitDecision || payload.new?.super_liked !== payload.old?.super_liked) scheduleDecisionRefresh(userId);
        if (!becameApproved) return;
        try {
          await ensureApprovalSeed(trackId, userId);
        } catch (err) {
          log("fail", `Re-seed on approval UPDATE failed for track ${trackId}: ${err instanceof Error ? err.message : err}`);
        }
      },
    )
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "user_tracks", filter: "super_liked=eq.true" },
      (payload) => {
        lastRealtimeEventAt = new Date().toISOString();
        const trackId = payload.new?.track_id;
        if (!trackId) {
          log("warn", "Received super_liked INSERT without track_id");
          return;
        }
        log("ok", `Super Like INSERT detected for track ${trackId} — queuing local download`);
        enqueueSuperLike(trackId);
        processSuperLikeQueue();
      },
    )
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "download_requests", filter: "status=eq.pending" },
      (payload) => {
        lastRealtimeEventAt = new Date().toISOString();
        const requestId = payload.new?.id;
        if (!requestId) {
          log("warn", "Received download_request INSERT without id");
          return;
        }
        log("ok", `[DL Request] New download request detected: ${requestId}`);
        enqueueDownloadRequest(requestId);
        processDownloadRequestQueue();
      },
    )
    .on(
      "postgres_changes",
      { event: "UPDATE", schema: "public", table: "user_tracks", filter: "super_liked=eq.true" },
      (payload) => {
        lastRealtimeEventAt = new Date().toISOString();
        const trackId = payload.new?.track_id;
        if (!trackId) {
          log("warn", "Received super_liked UPDATE without track_id");
          return;
        }
        log("ok", `Super Like detected for track ${trackId} — queuing local download`);
        enqueueSuperLike(trackId);
        processSuperLikeQueue();
      },
    )
    .subscribe(async (status) => {
      if (status === "SUBSCRIBED") {
        reconnectFailures = 0;
        if (reconnectTimer) {
          clearTimeout(reconnectTimer);
          reconnectTimer = null;
        }
        watcherConnectedAt = new Date().toISOString();
        log("ok", "Realtime subscription active — watching for new seeds");
        logEngineEvent("watcher_connected", "info", {
          message: "Watcher connected to Supabase Realtime",
        });
        updateStatusFile();
        await resetStalePipelineStatuses();
        await recoverMissedSeedFypRefreshes();
        await enqueueBacklogSeeds();
        await enqueueBacklogTracks();
        await enqueueBacklogSuperLikes();
        // Recover any pending download requests missed before watcher startup
        {
          const { data: pendingReqs } = await db.from("download_requests")
            .select("id")
            .eq("status", "pending")
            .order("created_at", { ascending: true })
            .limit(50);
          if (pendingReqs?.length) {
            for (const r of pendingReqs) enqueueDownloadRequest(r.id);
            log("info", `Recovered ${pendingReqs.length} pending download request(s)`);
          }
        }
        processSeedQueue();
        processRepairQueue();
        processSuperLikeQueue();
        processDownloadRequestQueue();

        // Start polling + health-check intervals only once (survive reconnects)
        if (!intervalsStarted) {
          intervalsStarted = true;

          // Poll every 60s for super-likes missing from local directory
          setInterval(async () => {
            if (shuttingDown) return;
            await pollForMissingSuperLikes();
          }, 60_000);

          setInterval(async () => {
            if (shuttingDown) return;
            await recoverMissedSeedFypRefreshes();
          }, 60_000);

          // Every 6 hours: run the curator affinity radar to discover new tracks
          // from trusted NTS shows based on voting patterns
          const SIX_HOURS = 6 * 60 * 60 * 1000;
          setInterval(async () => {
            if (shuttingDown) return;
            log("info", "[Radar] Starting scheduled curator affinity run");
            await logEngineEvent("radar_curator_run", "started", {
              message: "Scheduled curator radar run",
            });
            try {
              // Pass primary user ID so curator affinity scores are user-scoped
              const primaryUserId = await getPrimaryUserId();
              await runCuratorRadar(primaryUserId);
              await logEngineEvent("radar_curator_run", "completed", {
                message: "Scheduled curator radar run complete",
              });
            } catch (err) {
              log("fail", `[Radar] Curator radar failed: ${err instanceof Error ? err.message : err}`);
              await logEngineEvent("radar_curator_run", "failed", {
                message: `Curator radar error: ${err instanceof Error ? err.message : err}`,
              });
            }
          }, SIX_HOURS);

          // Keep the shared Soulection series fresh independently from seed discovery.
          let soulectionCrawlRunning = false;
          const refreshSoulection = async () => {
            if (shuttingDown || soulectionCrawlRunning) return;
            soulectionCrawlRunning = true;
            try {
              const result = await crawlSoulection({ limit: SOULECTION_RECENT_EPISODE_LIMIT, db });
              log("ok", `[Soulection] ${result.episodes} episodes / ${result.appearances} appearances refreshed`);
              for (const failure of result.failures) log("fail", `[Soulection] ${failure}`);
            } catch (err) {
              // Preserve the previous index on source/schema failure; retry next interval.
              log("fail", `[Soulection] Refresh failed: ${err instanceof Error ? err.message : err}`);
            } finally {
              soulectionCrawlRunning = false;
            }
          };
          setTimeout(refreshSoulection, 30_000);
          setInterval(refreshSoulection, SIX_HOURS);

          // Every 2 min: drain pending-enrichment backlog from DB
          setInterval(async () => {
            if (shuttingDown) return;
            if (trackQueue.length > 0) return;
            // Only queue tracks that truly need enrichment:
            // - spotify_url IS NULL (not empty string — empty string means we already tried and found nothing)
            // - OR no youtube_url AND no storage_path (need YouTube lookup still)
            // Also exclude tracks with too many failed download attempts (dl_attempts >= 3)
            const { data: pending, error } = await db.from("tracks")
              .select("id, dl_attempts")
              .eq("status", "pending")
              .or("spotify_url.is.null,and(youtube_url.is.null,storage_path.is.null)")
              .lt("dl_attempts", 3)
              .order("created_at", { ascending: true })
              .limit(100);
            if (error) {
              log("fail", `[Drain] Pending track scan failed: ${error.message}`);
              return;
            }
            const toQueue = (pending || []).filter((t: any) => !trackQueue.includes(t.id));
            if (toQueue.length === 0) {
              // Check for tracks stuck without any match — mark as skipped
              // These are tracks where enrichment already ran (spotify_url is empty string = tried, found nothing)
              // AND youtube_url is still null (YouTube also found nothing)
              const { data: unfindable } = await db.from("tracks")
                .select("id")
                .eq("status", "pending")
                .is("youtube_url", null)
                .eq("spotify_url", "")  // empty string = enrichment ran, found nothing
                .limit(100);
              if (unfindable?.length) {
                // Merge skip_reason into existing metadata to preserve co_occurrence, genres, etc.
                for (const t of unfindable) {
                  const { data: existing } = await db.from("tracks").select("metadata").eq("id", t.id).single();
                  await db.from("tracks").update({
                    status: "skipped",
                    metadata: { ...(existing?.metadata || {}), skip_reason: "no_youtube_or_spotify_match" },
                  }).eq("id", t.id);
                }
                log("info", `[Drain] Marked ${unfindable.length} unfindable tracks as skipped`);
              }
              return;
            }
            for (const t of toQueue) enqueueTrack(t.id);
            log("info", `[Drain] Queued ${toQueue.length} pending tracks for enrichment`);
            processRepairQueue();
          }, 2 * 60_000);

          // Every 2 min (offset by 60s): drain pending downloads independently
          // Downloads operate on tracks that have youtube_url but no storage_path yet
          let downloadDrainRunning = false;
          setTimeout(() => {
            setInterval(async () => {
              if (shuttingDown) return;
              if (downloadDrainRunning) {
                log("info", "[DL Drain] Previous batch still running — skipping");
                return;
              }
              downloadDrainRunning = true;
              try {
                const materialized = await serializeQueueMutation(() => materializeAllQueues(db));
                const eviction = await evictRetiredQueueAudio(db);
                const downloadable = await selectPreparationBatch(db, 20);
                log("info", `[DL Drain] Ranked ${materialized.tracks} entries for ${materialized.users} user(s)`);
                if (eviction.clearedPaths) {
                  log("info", `[DL Drain] Evicted ${eviction.removedPaths}/${eviction.clearedPaths} retired audio path(s)${eviction.leakedPaths ? `; ${eviction.leakedPaths} object(s) leaked safely` : ""}`);
                }
                if (!downloadable?.length) {
                  // Mark tracks with 3+ failed attempts as 'failed' so they stop being re-queued
                  const { data: gaveUp } = await db.from("tracks")
                    .select("id")
                    .not("youtube_url", "is", null)
                    .neq("youtube_url", "")
                    .is("storage_path", null)
                    .eq("status", "pending")
                    .gte("dl_attempts", 3)
                    .limit(100);
                  if (gaveUp?.length) {
                    // Merge fail_reason into existing metadata to preserve co_occurrence, genres, etc.
                    for (const t of gaveUp) {
                      const { data: existing } = await db.from("tracks").select("metadata").eq("id", t.id).single();
                      await db.from("tracks").update({
                        status: "failed",
                        metadata: { ...(existing?.metadata || {}), fail_reason: "download_failed_3_attempts" },
                      }).eq("id", t.id);
                    }
                    log("info", `[DL Drain] Marked ${gaveUp.length} tracks as failed (3+ download attempts)`);
                  }
                  return;
                }
                log("info", `[DL Drain] Found ${downloadable.length} tracks to download`);
                await logEngineEvent("download_drain_started", "started", {
                  message: `Downloading ${downloadable.length} tracks`,
                  metadata: { count: downloadable.length },
                });
                let downloaded = 0;
                // Keep acquisition concurrency bounded; excessive yt-dlp workers
                // make YouTube throttling and local transcoding slower, not faster.
                for (let i = 0; i < downloadable.length; i += PRIORITY_DOWNLOAD_CONCURRENCY) {
                  if (shuttingDown) break;
                  const batch = downloadable.slice(i, i + PRIORITY_DOWNLOAD_CONCURRENCY);
                  const ownerToken = crypto.randomUUID();
                  const claimed = await claimPreparationTracks(batch, ownerToken, db);
                  if (claimed.length < batch.length) {
                    log("info", `[DL Drain] Skipped ${batch.length - claimed.length} track(s) leased by another downloader`);
                  }
                  const results = await Promise.allSettled(
                    claimed.map(async (track: any) => {
                      try {
                        await markPreparationState(track, "preparing", null, db);
                        const ok = await downloadTrack(track);
                        if (ok) {
                          await markPreparationState(track, "ready", null, db);
                          downloaded++;
                          log("ok", `[DL Drain] Downloaded: ${track.artist} – ${track.title}`);
                        } else {
                          await markPreparationState(track, "failed", "download failed", db);
                        }
                        return ok;
                      } catch (err) {
                        await markPreparationState(track, "failed", err instanceof Error ? err.message : String(err), db);
                        log("fail", `[DL Drain] Error: ${track.artist} – ${track.title}: ${err instanceof Error ? err.message : err}`);
                        return false;
                      } finally {
                        await releasePreparationTracks([track], ownerToken, db).catch((err) => {
                          log("fail", `[DL Drain] Claim release failed for ${track.id}; lease will expire: ${err instanceof Error ? err.message : err}`);
                        });
                      }
                    }),
                  );
                }
                if (downloaded > 0) {
                  await logEngineEvent("download_drain_completed", "completed", {
                    message: `Downloaded ${downloaded}/${downloadable.length} tracks`,
                    metadata: { downloaded, total: downloadable.length },
                  });
                  log("ok", `[DL Drain] Completed: ${downloaded}/${downloadable.length} downloaded`);
                }
              } catch (err) {
                log("fail", `[DL Drain] Error: ${err instanceof Error ? err.message : err}`);
              } finally {
                downloadDrainRunning = false;
              }
            }, 2 * 60_000); // Periodic reconciliation; Realtime handles the fast path
          }, 5_000); // Start 5s after watcher connects

          // Every 60s: backfill metadata (Spotify + MusicBrainz) for tracks
          // that already have youtube_url but haven't been spotify-enriched yet.
          // This runs at low priority so it never blocks youtube lookups or downloads.
          let metadataBackfillRunning = false;
          setInterval(async () => {
            if (shuttingDown) return;
            if (metadataBackfillRunning) return;
            metadataBackfillRunning = true;
            try {
              const { data: needsMetadata, error } = await db.from("tracks")
                .select("*")
                .not("youtube_url", "is", null)
                .neq("youtube_url", "")
                .is("spotify_url", null)
                .in("status", ["pending", "approved"])
                .order("created_at", { ascending: true })
                .limit(10);
              if (error) {
                log("fail", `[Metadata Backfill] Query failed: ${error.message}`);
                return;
              }
              if (!needsMetadata?.length) return;
              log("info", `[Metadata Backfill] Enriching ${needsMetadata.length} tracks with Spotify/MusicBrainz`);
              let enriched = 0;
              // Low concurrency — 3 at a time to respect rate limits
              for (let i = 0; i < needsMetadata.length; i += 3) {
                if (shuttingDown) break;
                const batch = needsMetadata.slice(i, i + 3);
                const results = await Promise.allSettled(batch.map(enrichTrackMetadata));
                for (const r of results) {
                  if (r.status === "fulfilled" && r.value) enriched++;
                }
              }
              if (enriched > 0) {
                log("ok", `[Metadata Backfill] Enriched ${enriched}/${needsMetadata.length} tracks`);
              }
            } catch (err) {
              log("fail", `[Metadata Backfill] Error: ${err instanceof Error ? err.message : err}`);
            } finally {
              metadataBackfillRunning = false;
            }
          }, 60_000);

        }
      } else if (status === "CLOSED" || status === "CHANNEL_ERROR") {
        reconnectFailures++;
        log("warn", `Realtime channel ${status} — will attempt reconnect (failure ${reconnectFailures})`);
        logEngineEvent("watcher_disconnected", "info", {
          message: `Channel ${status} (failure ${reconnectFailures})`,
        });

        // Replace the failed channel once. Quiet channels are healthy; only
        // explicit channel errors trigger reconnects.
        if (!reconnectTimer) {
          reconnectTimer = setTimeout(async () => {
            reconnectTimer = null;
            log("info", "Replacing failed Realtime channel...");
            if (currentChannel) await db.removeChannel(currentChannel);
            currentChannel = null;
            if (!shuttingDown) startWatcher();
          }, Math.min(30_000, 5_000 * reconnectFailures));
        }
      }
    });
}

// ─── SEGUNDO SOL SESSIONS IMPORT WORKER ─────────────────────
// Vercel only writes authenticated jobs. The local engine owns media retrieval,
// PicoDrops reuse, private storage upload, and final per-track status.

const SEGUNDO_SOL_SYNC_SCRIPT = `${import.meta.dir}/segundo-sol-sessions-sync.py`;
let segundoSolImportRunning = false;
let activeSegundoSolJob: { id: string; userId: string } | null = null;

function safeSegundoSolStorageName(value: string): string {
  return value.normalize("NFC").replace(/[/\\?%*:|"<>]/g, "-").replace(/\s+/g, " ").trim().slice(0, 180) || "untitled";
}

async function processSegundoSolImportJobs() {
  if (segundoSolImportRunning || segundoSolDownloadRunning || shuttingDown || !existsSync(SEGUNDO_SOL_SYNC_SCRIPT)) return;
  segundoSolImportRunning = true;
  try {
    const { data: job, error: jobError } = await db
      .from("segundo_sol_import_jobs")
      .select("*")
      .eq("status", "pending")
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (jobError || !job) return;

    const { data: claimed } = await db
      .from("segundo_sol_import_jobs")
      .update({ status: "processing", started_at: new Date().toISOString(), error: null })
      .eq("id", job.id)
      .eq("status", "pending")
      .select("id")
      .maybeSingle();
    if (!claimed) return;
    activeSegundoSolJob = { id: job.id, userId: job.user_id };

    const { data: episode, error: episodeError } = await db
      .from("segundo_sol_episodes")
      .select("id, episode_number")
      .eq("id", job.episode_id)
      .eq("user_id", job.user_id)
      .maybeSingle();
    if (episodeError || !episode) throw new Error(episodeError?.message || "Episode not found");

    const python = Bun.which("python3") || "/usr/bin/python3";
    const sourceFlag = job.source_type === "spotify" ? "--spotify-url" : "--source-url";
    const proc = Bun.spawn(
      [python, SEGUNDO_SOL_SYNC_SCRIPT, String(episode.episode_number), sourceFlag, job.source_url, "--download"],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (exitCode !== 0) throw new Error(stderr.trim().slice(-1600) || `PicoDrops sync exited ${exitCode}`);

    const result = JSON.parse(stdout) as { items?: Array<Record<string, any>> };
    const items = result.items || [];
    const { data: last } = await db
      .from("segundo_sol_episode_tracks")
      .select("position")
      .eq("episode_id", job.episode_id)
      .eq("user_id", job.user_id)
      .order("position", { ascending: false })
      .limit(1)
      .maybeSingle();
    let nextPosition = (last?.position ?? -1) + 1;
    let importedCount = 0;

    for (const [index, item] of items.entries()) {
      const artist = String(item.artist || "Unknown artist").normalize("NFC");
      const title = String(item.title || "Untitled").normalize("NFC");
      const sourceUrl = String(item.source_url || `${job.source_url}#track-${index + 1}`);
      const localPath = String(item.file_path || "");
      const reusable = ["exists", "copied_existing"].includes(String(item.status));
      const ready = reusable || item.status === "downloaded";
      let storagePath: string | null = null;
      let audioError: string | null = ready ? null : `PicoDrops status: ${item.status || "failed"}`;

      if (ready && localPath && existsSync(localPath)) {
        storagePath = `${job.user_id}/${job.episode_id}/${safeSegundoSolStorageName(`${artist} - ${title}`)}.mp3`;
        const { error: uploadError } = await db.storage
          .from("segundo-sol-audio")
          .upload(storagePath, Bun.file(localPath), { contentType: "audio/mpeg", upsert: true });
        if (uploadError) {
          storagePath = null;
          audioError = uploadError.message;
        }
      }

      const { data: existing } = await db
        .from("segundo_sol_episode_tracks")
        .select("id")
        .eq("episode_id", job.episode_id)
        .eq("user_id", job.user_id)
        .eq("source_url", sourceUrl)
        .maybeSingle();
      const audioStatus = storagePath ? (reusable ? "reused" : "downloaded") : "failed";
      const payload = {
        artist,
        title,
        source_origin: "manual",
        source_type: job.source_type,
        source_url: sourceUrl,
        metadata: {
          import_job_id: job.id,
          imported_from: job.source_url,
          source_title: item.source_title || null,
          spotify_uri: item.spotify_uri || null,
          picodrops_file_path: localPath || null,
          picodrops_status: item.status || null,
          bpm: typeof item.bpm === "number" ? item.bpm : null,
          bpm_source: item.bpm_source || null,
        },
        audio_status: audioStatus,
        audio_storage_path: storagePath,
        audio_error: audioError,
        audio_requested_at: job.created_at,
        audio_completed_at: new Date().toISOString(),
      };

      const write = existing
        ? await db.from("segundo_sol_episode_tracks").update(payload).eq("id", existing.id).eq("user_id", job.user_id)
        : await db.from("segundo_sol_episode_tracks").insert({
            ...payload,
            episode_id: job.episode_id,
            user_id: job.user_id,
            position: nextPosition++,
          });
      if (!write.error) importedCount += 1;
    }

    await db.from("segundo_sol_import_jobs").update({
      status: "completed",
      total_count: items.length,
      imported_count: importedCount,
      completed_at: new Date().toISOString(),
    }).eq("id", job.id).eq("user_id", job.user_id);
    log("ok", `[Segundo Sol] Imported ${importedCount}/${items.length} tracks into Session #${episode.episode_number}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (activeSegundoSolJob) {
      await db.from("segundo_sol_import_jobs").update({
        status: "failed",
        error: message.slice(0, 2000),
        completed_at: new Date().toISOString(),
      }).eq("id", activeSegundoSolJob.id).eq("user_id", activeSegundoSolJob.userId);
    }
    log("fail", `[Segundo Sol] ${message}`);
  } finally {
    activeSegundoSolJob = null;
    segundoSolImportRunning = false;
  }
}

let segundoSolDownloadRunning = false;

async function processSegundoSolDownloadRequests() {
  if (segundoSolDownloadRunning || segundoSolImportRunning) return;
  segundoSolDownloadRunning = true;

  try {
    const staleCutoff = new Date(Date.now() - 20 * 60 * 1_000).toISOString();
    const { error: recoveryError } = await db
      .from("segundo_sol_download_requests")
      .update({ status: "pending", started_at: null, error: "Recovered after an interrupted worker" })
      .eq("status", "processing")
      .lt("started_at", staleCutoff);
    if (recoveryError) throw recoveryError;

    const { data: requests, error } = await db
      .from("segundo_sol_download_requests")
      .select("id,user_id,episode_id,episode_track_id,source_url")
      .eq("status", "pending")
      .order("created_at", { ascending: true })
      .limit(2);
    if (error) throw error;

    for (const request of requests || []) {
      const now = new Date().toISOString();
      const { data: claimed } = await db
        .from("segundo_sol_download_requests")
        .update({ status: "processing", started_at: now, error: null })
        .eq("id", request.id)
        .eq("status", "pending")
        .select("id")
        .maybeSingle();
      if (!claimed) continue;

      const [{ data: episodeTrack }, { data: episodeRecord }] = await Promise.all([
        db.from("segundo_sol_episode_tracks")
          .select("id,track_id,artist,title,source_type,metadata")
          .eq("id", request.episode_track_id)
          .eq("episode_id", request.episode_id)
          .eq("user_id", request.user_id)
          .maybeSingle(),
        db.from("segundo_sol_episodes")
          .select("episode_number")
          .eq("id", request.episode_id)
          .eq("user_id", request.user_id)
          .maybeSingle(),
      ]);

      try {
        await db.from("segundo_sol_episode_tracks").update({
          audio_status: "processing",
          audio_error: null,
        }).eq("id", request.episode_track_id).eq("user_id", request.user_id);

        if (episodeTrack?.track_id) {
          const { data: backingTrack } = await db
            .from("tracks")
            .select("storage_path")
            .eq("id", episodeTrack.track_id)
            .maybeSingle();
          if (backingTrack?.storage_path) {
            await db.from("segundo_sol_episode_tracks").update({
              audio_status: "reused",
              audio_storage_path: null,
              audio_error: null,
            }).eq("id", request.episode_track_id).eq("user_id", request.user_id);
            await db.from("segundo_sol_download_requests").update({
              status: "completed",
              completed_at: new Date().toISOString(),
              result_storage_path: backingTrack.storage_path,
              error: null,
            }).eq("id", request.id);
            continue;
          }
        }

        if (!episodeTrack || !episodeRecord?.episode_number || !request.source_url) {
          throw new Error("Download request is missing its episode track or source URL");
        }

        const sourceFlag = episodeTrack.source_type === "spotify"
          ? "--spotify-url"
          : episodeTrack.source_type === "soundcloud"
            ? "--soundcloud-url"
            : "--source-url";
        const script = `${process.cwd()}/scripts/segundo-sol-sessions-sync.py`;
        const proc = Bun.spawn([
          "python3",
          script,
          String(episodeRecord.episode_number),
          sourceFlag,
          request.source_url,
          "--download",
          "--fast",
        ], {
          cwd: process.cwd(),
          env: process.env,
          stdout: "pipe",
          stderr: "pipe",
        });
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ]);
        if (exitCode !== 0) throw new Error(stderr.trim() || `sync worker exited ${exitCode}`);

        const result = JSON.parse(stdout.trim()) as {
          items?: Array<{ status: string; file_path?: string; bpm?: number }>;
        };
        const readyStatuses = new Set(["downloaded", "exists", "copied_existing"]);
        const item = result.items?.find((candidate) => readyStatuses.has(candidate.status) && candidate.file_path);
        if (!item?.file_path || !existsSync(item.file_path)) {
          throw new Error("Audio preparation finished without a playable file");
        }

        const safeArtist = sanitizeFilename(episodeTrack.artist);
        const safeTitle = sanitizeFilename(episodeTrack.title);
        const storagePath = `${request.user_id}/${request.episode_id}/${request.episode_track_id}/${safeArtist} - ${safeTitle}.mp3`;
        const bytes = readFileSync(item.file_path);
        const { error: uploadError } = await db.storage
          .from("segundo-sol-audio")
          .upload(storagePath, bytes, { contentType: "audio/mpeg", upsert: true });
        if (uploadError) throw uploadError;

        const metadata = {
          ...(episodeTrack.metadata || {}),
          ...(item.bpm ? { bpm: item.bpm, bpm_source: "librosa" } : {}),
        };
        await db.from("segundo_sol_episode_tracks").update({
          audio_status: "downloaded",
          audio_storage_path: storagePath,
          audio_error: null,
          metadata,
        }).eq("id", request.episode_track_id).eq("user_id", request.user_id);
        await db.from("segundo_sol_download_requests").update({
          status: "completed",
          completed_at: new Date().toISOString(),
          result_storage_path: storagePath,
          error: null,
        }).eq("id", request.id);
        log("ok", `[Segundo Sol] Prepared ${episodeTrack.artist} — ${episodeTrack.title}`);
      } catch (requestError) {
        const message = requestError instanceof Error ? requestError.message : String(requestError);
        await db.from("segundo_sol_episode_tracks").update({
          audio_status: "failed",
          audio_error: message.slice(0, 1_000),
        }).eq("id", request.episode_track_id).eq("user_id", request.user_id);
        await db.from("segundo_sol_download_requests").update({
          status: "failed",
          completed_at: new Date().toISOString(),
          error: message.slice(0, 1_000),
        }).eq("id", request.id);
        log("fail", `[Segundo Sol] Audio preparation failed: ${message}`);
      }
    }
  } catch (error) {
    const message = error instanceof Error
      ? error.message
      : typeof error === "object" && error
        ? JSON.stringify(error)
        : String(error);
    log("fail", `[Segundo Sol] Download poll failed: ${message}`);
  } finally {
    segundoSolDownloadRunning = false;
  }
}

// ─── DOWNLOAD REQUEST HANDLER ─────────────────────────────────
// Watches download_requests table for INSERT events with status='pending'.
// Downloads the track via yt-dlp, uploads to storage, updates tracks table,
// and marks the request as completed with a signed audio URL.
const DOWNLOAD_REQUEST_LEASE_MS = 20 * 60 * 1000;
let downloadRequestLeaseSupported: boolean | null = null;

function isMissingDownloadRequestColumn(error: unknown, column: string): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as { code?: string; message?: string };
  return ["42703", "PGRST204"].includes(value.code || "")
    && (value.message || "").includes(column);
}

function downloadRequestError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object") {
    const value = error as { code?: string; message?: string };
    return [value.code, value.message].filter(Boolean).join(": ") || JSON.stringify(error);
  }
  return String(error);
}

async function processDownloadRequest(requestId: string) {
  const { data: req, error: reqErr } = await db.from("download_requests")
    .select("*").eq("id", requestId).single();

  if (reqErr || !req) {
    log("fail", `[DL Request] Could not read request ${requestId}: ${reqErr?.message ?? "not found"}`);
    return;
  }

  if (req.status !== "pending") {
    log("skip", `[DL Request] ${requestId} already ${req.status}`);
    return;
  }

  // Mark as downloading (CAS on 'pending')
  let claimResult = await db.from("download_requests")
    .update({
      status: "downloading",
      ...(downloadRequestLeaseSupported === false ? {} : { claimed_at: new Date().toISOString() }),
    })
    .eq("id", requestId)
    .eq("status", "pending")
    .select("id")
    .maybeSingle();

  if (isMissingDownloadRequestColumn(claimResult.error, "claimed_at")) {
    downloadRequestLeaseSupported = false;
    claimResult = await db.from("download_requests")
      .update({ status: "downloading" })
      .eq("id", requestId)
      .eq("status", "pending")
      .select("id")
      .maybeSingle();
  }

  const { data: claimed, error: claimError } = claimResult;

  if (claimError) {
    log("fail", `[DL Request] Claim failed for ${requestId}: ${claimError.message}`);
    return;
  }
  if (!claimed) {
    log("skip", `[DL Request] ${requestId} claimed by another processor`);
    return;
  }
  if (downloadRequestLeaseSupported === null) downloadRequestLeaseSupported = true;

  await db.from("audio_preparation_queue").update({
    state: "preparing",
    preparing_at: new Date().toISOString(),
    failed_at: null,
    last_error: null,
    updated_at: new Date().toISOString(),
  }).eq("track_id", req.track_id).in("state", ["ranked", "failed"]);

  log("info", `[DL Request] Processing request ${requestId} for track ${req.track_id}`);

  // Fetch the track to get artist/title for storage path
  const { data: track, error: trackErr } = await db.from("tracks")
    .select("*").eq("id", req.track_id).single();

  if (trackErr || !track) {
    await db.from("download_requests").update({
      status: "failed",
      ...(downloadRequestLeaseSupported === false ? {} : { claimed_at: null }),
      error: `Track not found: ${trackErr?.message ?? "not found"}`,
      completed_at: new Date().toISOString(),
    }).eq("id", requestId);
    log("fail", `[DL Request] Track ${req.track_id} not found`);
    return;
  }

  try {
    // Explicit play requests may carry a corrected YouTube or SoundCloud URL.
    // Use that exact source before falling back to catalog enrichment.
    let acquisitionUrl = preferredAcquisitionUrl(req.youtube_url, track.youtube_url);
    if (!acquisitionUrl) {
      log("info", `[DL Request] Resolving source before download: ${track.artist} – ${track.title}`);
      await enrichTrack(track);
      const { data: enriched } = await db.from("tracks")
        .select("youtube_url")
        .eq("id", req.track_id)
        .maybeSingle();
      acquisitionUrl = enriched?.youtube_url || null;
    }
    if (!acquisitionUrl) throw new Error("Could not resolve a downloadable source");

    const trackForDownload = { ...track, youtube_url: acquisitionUrl };
    const ok = await downloadTrack(
      trackForDownload,
      downloadRequestLeaseSupported === false
        ? {}
        : {
          commit: async ({ storagePath, downloadUrl }) => {
            const { data, error } = await db.rpc("complete_download_request", {
              p_request_id: requestId,
              p_storage_path: storagePath,
              p_download_url: downloadUrl,
            });
            if (error) throw new Error(`Download commit failed: ${error.message}`);
            return data === true;
          },
        },
    );

    if (ok) {
      // Fetch updated track to get the signed URL
      const { data: updated } = await db.from("tracks")
        .select("storage_path, download_url").eq("id", req.track_id).single();

      if (track.storage_path && updated?.storage_path && track.storage_path !== updated.storage_path) {
        const { error: cleanupError } = await db.storage.from("tracks").remove([track.storage_path]);
        if (cleanupError) {
          log("warn", `[DL Request] Could not remove superseded object ${track.storage_path}: ${cleanupError.message}`);
        }
      }

      if (downloadRequestLeaseSupported === false) {
        await db.from("download_requests").update({
          status: "completed",
          result_audio_url: updated?.download_url || null,
          completed_at: new Date().toISOString(),
        }).eq("id", requestId);
      }
      await db.from("audio_preparation_queue").update({
        state: "ready",
        ready_at: new Date().toISOString(),
        last_error: null,
        updated_at: new Date().toISOString(),
      }).eq("track_id", req.track_id);

      log("ok", `[DL Request] Completed: ${track.artist} – ${track.title}`);
    } else {
      await db.from("download_requests").update({
        status: "failed",
        ...(downloadRequestLeaseSupported === false ? {} : { claimed_at: null }),
        error: "Download failed (yt-dlp returned non-zero or upload failed)",
        completed_at: new Date().toISOString(),
      }).eq("id", requestId);
      await db.from("audio_preparation_queue").update({
        state: "failed",
        failed_at: new Date().toISOString(),
        last_error: "Download failed",
        updated_at: new Date().toISOString(),
      }).eq("track_id", req.track_id);

      log("fail", `[DL Request] Failed: ${track.artist} – ${track.title}`);
    }
  } catch (err) {
    if (err instanceof DownloadSupersededError) {
      log("skip", `[DL Request] ${requestId} was superseded before audio commit`);
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    await db.from("download_requests").update({
      status: "failed",
      ...(downloadRequestLeaseSupported === false ? {} : { claimed_at: null }),
      error: message,
      completed_at: new Date().toISOString(),
    }).eq("id", requestId);
    await db.from("audio_preparation_queue").update({
      state: "failed",
      failed_at: new Date().toISOString(),
      last_error: message.slice(0, 1_000),
      updated_at: new Date().toISOString(),
    }).eq("track_id", req.track_id);

    log("fail", `[DL Request] Error: ${message}`);
  }
}

const downloadRequestQueue: string[] = [];
const MAX_DL_REQUEST_QUEUE = 500;

function enqueueDownloadRequest(requestId: string) {
  if (!requestId) return;
  if (downloadRequestQueue.includes(requestId)) return;
  if (downloadRequestQueue.length >= MAX_DL_REQUEST_QUEUE) {
    log("warn", `Download request queue at capacity (${MAX_DL_REQUEST_QUEUE}) — dropping oldest`);
    downloadRequestQueue.splice(0, Math.floor(MAX_DL_REQUEST_QUEUE * 0.2));
  }
  downloadRequestQueue.push(requestId);
}

let downloadRequestProcessing = false;
async function processDownloadRequestQueue() {
  if (downloadRequestProcessing) return;
  downloadRequestProcessing = true;
  while (downloadRequestQueue.length > 0) {
    const requestId = downloadRequestQueue.shift()!;
    try {
      await processDownloadRequest(requestId);
    } catch (err) {
      log("fail", `[DL Request] Queue error for ${requestId}: ${err instanceof Error ? err.message : err}`);
    }
  }
  downloadRequestProcessing = false;
}

async function pollPendingDownloadRequests() {
  try {
    if (downloadRequestLeaseSupported !== false) {
      const staleBefore = new Date(Date.now() - DOWNLOAD_REQUEST_LEASE_MS).toISOString();
      const { data: reclaimed, error: reclaimError } = await db.from("download_requests")
        .update({
          status: "pending",
          claimed_at: null,
          error: "Previous download lease expired; reclaimed by watcher",
        })
        .eq("status", "downloading")
        .or(`claimed_at.is.null,claimed_at.lt.${staleBefore}`)
        .select("id");
      if (isMissingDownloadRequestColumn(reclaimError, "claimed_at")) {
        downloadRequestLeaseSupported = false;
        log("warn", "[DL Request] Lease recovery unavailable until pipeline migration is applied");
      } else if (reclaimError) {
        throw reclaimError;
      } else {
        downloadRequestLeaseSupported = true;
        if (reclaimed?.length) {
          log("warn", `[DL Request] Reclaimed ${reclaimed.length} stale download lease(s)`);
        }
      }
    }
    const { data, error } = await db.from("download_requests")
      .select("id")
      .eq("status", "pending")
      .order("created_at", { ascending: true })
      .limit(20);
    if (error) throw error;
    for (const request of data || []) enqueueDownloadRequest(request.id);
    void processDownloadRequestQueue();
  } catch (error) {
    log("warn", `[DL Request] Poll failed: ${downloadRequestError(error)}`);
  }
}

// ─── GRACEFUL SHUTDOWN ──────────────────────────────────────

let shuttingDown = false;

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    if (shuttingDown) { console.log("\n  Force quit."); process.exit(1); }
    shuttingDown = true;
    console.log(`\n  ${sig} received — shutting down watcher...`);
    await logEngineEvent("watcher_disconnected", "info", {
      message: `Watcher stopped (${sig})`,
    });
    watcherConnectedAt = null;
    updateStatusFile();
    // Give pending operations a moment to complete
    setTimeout(() => process.exit(0), 2_000);
  });
}

// ─── MAIN ───────────────────────────────────────────────────

console.log(`\n  The Stacks — Realtime Seed Watcher`);
console.log(`  ${new Date().toISOString()}\n`);

startWatcher();
void processPriorityQueue();

// Polling is intentional: it keeps the worker reliable if Realtime misses an
// insert while the Mac mini reconnects.
setTimeout(processSegundoSolImportJobs, 2_000);
setInterval(processSegundoSolImportJobs, 8_000);
setTimeout(processSegundoSolDownloadRequests, 4_000);
setInterval(processSegundoSolDownloadRequests, 6_000);
setTimeout(pollPendingDownloadRequests, 3_000);
setInterval(pollPendingDownloadRequests, 5_000);

// Keep process alive
setInterval(() => {}, 60_000);
