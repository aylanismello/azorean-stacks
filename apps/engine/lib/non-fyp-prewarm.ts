const PAGE_SIZE = 1000;
export const NON_FYP_PREWARM_TTL_HOURS = 30;

interface Candidate {
  id: string;
  storage_path?: string | null;
  youtube_url?: string | null;
  source_url?: string | null;
  spotify_url?: string | null;
  dl_attempts?: number | null;
  metadata?: { genres?: unknown; seed_artist?: unknown } | null;
}

interface SeedRow {
  id: string;
  track_id?: string | null;
}

interface SeedEpisodeRow {
  seed_id: string;
  episode_id: string;
}

interface EpisodeTrackRow {
  episode_id: string;
  track_id: string;
}

export interface NonFypPrewarmSelection {
  feeds: Array<{ feedKey: string; trackId: string }>;
  requestCandidates: Candidate[];
}

function normalized(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const key = value.normalize("NFC").trim().toLowerCase();
  return key || null;
}

function acquisitionUrl(track: Candidate): string | null {
  if (Number(track.dl_attempts || 0) >= 3) return null;
  return track.youtube_url || track.spotify_url || track.source_url || null;
}

function firstRepresentedCandidate(candidates: Candidate[]): Candidate | null {
  for (const track of candidates) {
    if (track.storage_path || acquisitionUrl(track)) return track;
  }
  return null;
}

/** Select one immediately playable-or-acquirable front track for every stack. */
export function selectNonFypPrewarmTargets(
  candidates: Candidate[],
  seeds: SeedRow[],
  seedEpisodes: SeedEpisodeRow[],
  appearances: EpisodeTrackRow[],
): NonFypPrewarmSelection {
  const groups = new Map<string, Candidate[]>();
  const add = (feedKey: string, track: Candidate) => {
    const rows = groups.get(feedKey) || [];
    rows.push(track);
    groups.set(feedKey, rows);
  };

  for (const track of candidates) {
    const genres = Array.isArray(track.metadata?.genres) ? track.metadata.genres : [];
    for (const genre of genres) {
      const key = normalized(genre);
      if (key) add(`genre:${key}`, track);
    }
    const seedArtist = normalized(track.metadata?.seed_artist);
    if (seedArtist) add(`seed-artist:${seedArtist}`, track);
  }

  const episodesBySeed = new Map<string, Set<string>>();
  for (const link of seedEpisodes) {
    const episodeIds = episodesBySeed.get(link.seed_id) || new Set<string>();
    episodeIds.add(link.episode_id);
    episodesBySeed.set(link.seed_id, episodeIds);
  }
  const tracksByEpisode = new Map<string, Set<string>>();
  for (const appearance of appearances) {
    const trackIds = tracksByEpisode.get(appearance.episode_id) || new Set<string>();
    trackIds.add(appearance.track_id);
    tracksByEpisode.set(appearance.episode_id, trackIds);
  }
  for (const seed of seeds) {
    const allowed = new Set<string>();
    for (const episodeId of episodesBySeed.get(seed.id) || []) {
      for (const trackId of tracksByEpisode.get(episodeId) || []) allowed.add(trackId);
    }
    if (seed.track_id) allowed.add(seed.track_id);
    for (const track of candidates) {
      if (allowed.has(track.id)) add(`seed:${seed.id}`, track);
    }
  }

  const feeds: Array<{ feedKey: string; trackId: string }> = [];
  const requests = new Map<string, Candidate>();
  for (const [feedKey, rows] of groups) {
    const first = firstRepresentedCandidate(rows);
    if (!first) continue;
    feeds.push({ feedKey, trackId: first.id });
    if (!first.storage_path) requests.set(first.id, first);
  }
  return { feeds, requestCandidates: Array.from(requests.values()) };
}

async function pagedRows(build: (from: number, to: number) => PromiseLike<{ data: any[] | null; error: any }>) {
  const rows: any[] = [];
  for (let page = 0; ; page++) {
    const result = await build(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);
    if (result.error) throw new Error(result.error.message);
    rows.push(...(result.data || []));
    if (!result.data || result.data.length < PAGE_SIZE) break;
  }
  return rows;
}

function chunks<T>(rows: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let offset = 0; offset < rows.length; offset += size) {
    result.push(rows.slice(offset, offset + size));
  }
  return result;
}

async function loadPersonalizedCandidateTracks(db: any, userId: string): Promise<Candidate[]> {
  const pending = new Set<string>();
  const opinions = await pagedRows((from, to) => db.from("user_tracks")
    .select("track_id,status")
    .eq("user_id", userId)
    .range(from, to));
  for (const row of opinions) {
    if (row.status === "pending") pending.add(row.track_id);
  }
  const played = await pagedRows((from, to) => db.from("user_track_play_totals")
    .select("track_id")
    .eq("user_id", userId)
    .gt("play_count", 0)
    .range(from, to));
  for (const row of played) pending.delete(row.track_id);
  const seedTracks = await pagedRows((from, to) => db.from("seeds")
    .select("track_id")
    .eq("user_id", userId)
    .eq("active", true)
    .not("track_id", "is", null)
    .range(from, to));
  for (const row of seedTracks) pending.delete(row.track_id);

  const candidates: Candidate[] = [];
  const seen = new Set<string>();
  for (let page = 0; ; page++) {
    const result = await db.from("user_track_scores")
      .select("track_id,score,confidence,components,track:tracks!inner(*)")
      .eq("user_id", userId)
      .order("score", { ascending: false })
      .order("confidence", { ascending: false })
      .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);
    if (result.error) throw new Error(result.error.message);
    for (const scoreRow of result.data || []) {
      const track = Array.isArray(scoreRow.track) ? scoreRow.track[0] : scoreRow.track;
      if (!track || !pending.has(track.id) || seen.has(track.id)) continue;
      seen.add(track.id);
      candidates.push({
        ...track,
        metadata: {
          ...(track.metadata || {}),
          _score_components: scoreRow.components || {},
          _score_confidence: Number(scoreRow.confidence || 0),
        },
      });
    }
    if (!result.data || result.data.length < PAGE_SIZE) break;
  }
  return candidates;
}

async function queuePrewarmRequests(db: any, userId: string, candidates: Candidate[]): Promise<number> {
  if (!candidates.length) return 0;
  const activeIds = new Set<string>();
  for (const trackIds of chunks(candidates.map((track) => track.id), 100)) {
    const active = await db.from("download_requests")
      .select("track_id")
      .in("track_id", trackIds)
      .in("status", ["pending", "downloading"]);
    if (active.error) throw new Error(active.error.message);
    for (const row of active.data || []) activeIds.add(row.track_id);
  }
  const missing = candidates.filter((track) => !activeIds.has(track.id));
  let requested = 0;
  for (let offset = 0; offset < missing.length; offset += 20) {
    const results = await Promise.all(missing.slice(offset, offset + 20).map((track) =>
      db.from("download_requests").insert({
        track_id: track.id,
        user_id: userId,
        youtube_url: acquisitionUrl(track),
        status: "pending",
      })
    ));
    for (const result of results) {
      if (!result.error) requested += 1;
      else if (result.error.code !== "23505") throw new Error(result.error.message);
    }
  }
  return requested;
}

export async function prewarmNonFypStacks(
  db: any,
  userIds: string[],
): Promise<{ users: number; feeds: number; uniqueTracks: number; requested: number; failedUsers: number }> {
  const summary = { users: 0, feeds: 0, uniqueTracks: 0, requested: 0, failedUsers: 0 };
  for (const userId of userIds) {
    try {
      const candidates = await loadPersonalizedCandidateTracks(db, userId);
      const seedsResult = await db.from("seeds")
        .select("id,track_id")
        .eq("user_id", userId)
        .eq("active", true);
      if (seedsResult.error) throw new Error(seedsResult.error.message);
      const seeds = (seedsResult.data || []) as SeedRow[];
      const seedIds = seeds.map((seed) => seed.id);
      const seedEpisodes: SeedEpisodeRow[] = [];
      for (const ids of chunks(seedIds, 100)) {
        seedEpisodes.push(...await pagedRows((from, to) => db.from("episode_seeds")
          .select("seed_id,episode_id")
          .in("seed_id", ids)
          .range(from, to)) as SeedEpisodeRow[]);
      }
      const episodeIds = Array.from(new Set(seedEpisodes.map((row) => row.episode_id)));
      const appearances: EpisodeTrackRow[] = [];
      for (const ids of chunks(episodeIds, 100)) {
        appearances.push(...await pagedRows((from, to) => db.from("episode_tracks")
          .select("episode_id,track_id")
          .in("episode_id", ids)
          .range(from, to)) as EpisodeTrackRow[]);
      }

      const selection = selectNonFypPrewarmTargets(candidates, seeds, seedEpisodes, appearances);
      const refreshedAt = new Date();
      const expiresAt = new Date(refreshedAt.getTime() + NON_FYP_PREWARM_TTL_HOURS * 60 * 60 * 1000);
      if (selection.feeds.length) {
        const reservations = selection.feeds.map((feed) => ({
            user_id: userId,
            feed_key: feed.feedKey,
            track_id: feed.trackId,
            refreshed_at: refreshedAt.toISOString(),
            expires_at: expiresAt.toISOString(),
        }));
        for (const batch of chunks(reservations, 250)) {
          const write = await db.from("non_fyp_stack_prewarm").upsert(
            batch,
            { onConflict: "user_id,feed_key" },
          );
          if (write.error) throw new Error(write.error.message);
        }
      }
      const requested = selection.requestCandidates.length
        ? await queuePrewarmRequests(db, userId, selection.requestCandidates)
        : 0;
      summary.users += 1;
      summary.feeds += selection.feeds.length;
      summary.uniqueTracks += new Set(selection.feeds.map((feed) => feed.trackId)).size;
      summary.requested += requested;
    } catch (error) {
      summary.failedUsers += 1;
      console.error(`[non-fyp-prewarm] user pass failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return summary;
}
