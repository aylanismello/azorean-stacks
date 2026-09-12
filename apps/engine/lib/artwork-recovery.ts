export interface EpisodeArtworkCandidate {
  id: string;
  url: string;
}

export interface TrackArtworkCandidate {
  id: string;
  episodeId: string | null;
}

export interface ArtworkRecoveryStore {
  listMissingNtsEpisodes(afterId: string | null, limit: number): Promise<EpisodeArtworkCandidate[]>;
  setEpisodeArtworkIfMissing(id: string, artworkUrl: string): Promise<boolean>;
  listMissingTrackArtwork(afterId: string | null, limit: number): Promise<TrackArtworkCandidate[]>;
  getEpisodeArtworkForTracks(tracks: TrackArtworkCandidate[]): Promise<Map<string, string>>;
  setTrackArtworkIfMissing(id: string, artworkUrl: string): Promise<boolean>;
}

export interface ArtworkRecoveryMetrics {
  episodePages: number;
  episodesScanned: number;
  episodeArtworkFound: number;
  episodesUpdated: number;
  episodeUpdateRaces: number;
  episodeFetchFailed: number;
  trackPages: number;
  tracksScanned: number;
  trackFallbackFound: number;
  tracksUpdated: number;
  trackUpdateRaces: number;
  tracksWithoutFallback: number;
  writesSkipped: number;
}

export interface ArtworkRecoveryCursor {
  episodeAfterId: string | null;
  trackAfterId: string | null;
}

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface ArtworkRecoveryOptions {
  store: ArtworkRecoveryStore;
  dryRun?: boolean;
  pageSize?: number;
  concurrency?: number;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  retries?: number;
  retryDelayMs?: number;
  /** Bound each kind of work per invocation. Omit for a complete CLI backfill. */
  maxPagesPerKind?: number;
  /** Mutable keyset checkpoint for bounded recurring runs. */
  cursor?: ArtworkRecoveryCursor;
  sleep?: (ms: number) => Promise<void>;
  onProgress?: (metrics: Readonly<ArtworkRecoveryMetrics>) => void;
}

export interface FetchArtworkOptions {
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  retries?: number;
  retryDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface RecurringTaskLoopOptions {
  task: () => Promise<void>;
  intervalMs: number;
  initialDelayMs?: number;
  onError?: (error: unknown) => void;
  setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

/** A self-rescheduling loop: idempotent start and never overlaps task runs. */
export function createRecurringTaskLoop(options: RecurringTaskLoopOptions) {
  const setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const clearTimer = options.clearTimer ?? clearTimeout;
  const intervalMs = Math.max(1, Math.floor(options.intervalMs));
  const initialDelayMs = Math.max(0, Math.floor(options.initialDelayMs ?? intervalMs));
  let started = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const schedule = (delayMs: number) => {
    if (!started || timer) return;
    timer = setTimer(() => {
      timer = null;
      void run();
    }, delayMs);
  };
  const run = async () => {
    if (!started) return;
    try {
      await options.task();
    } catch (error) {
      options.onError?.(error);
    } finally {
      schedule(intervalMs);
    }
  };

  return {
    start() {
      if (started) return;
      started = true;
      schedule(initialDelayMs);
    },
    stop() {
      started = false;
      if (timer) clearTimer(timer);
      timer = null;
    },
  };
}

const NTS_ORIGIN = "https://www.nts.live";
const NTS_API_ORIGIN = "https://www.nts.live/api/v2";

function isJsonContentType(value: string | null): boolean {
  if (!value) return false;
  const mediaType = value.split(";", 1)[0]?.trim().toLowerCase();
  return mediaType === "application/json" || Boolean(mediaType?.endsWith("+json"));
}

function validArtworkUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.trim() === "") return false;
  try {
    const url = new URL(value, NTS_ORIGIN);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function absoluteArtworkUrl(value: string): string {
  return new URL(value, NTS_ORIGIN).toString();
}

function ntsApiUrl(episodeUrl: string): string | null {
  try {
    const parsed = new URL(episodeUrl);
    if (parsed.origin !== NTS_ORIGIN) return null;
    if (!parsed.pathname.startsWith("/shows/")) return null;
    return `${NTS_API_ORIGIN}${parsed.pathname}${parsed.search}`;
  } catch {
    return null;
  }
}

function shouldRetry(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

export async function fetchNtsEpisodeArtwork(
  episodeUrl: string,
  options: FetchArtworkOptions = {},
): Promise<string | null> {
  const apiUrl = ntsApiUrl(episodeUrl);
  if (!apiUrl) return null;

  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const retries = Math.max(0, options.retries ?? 2);
  const retryDelayMs = Math.max(0, options.retryDelayMs ?? 250);
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetchImpl(apiUrl, {
        signal: AbortSignal.timeout(timeoutMs),
        headers: { accept: "application/json" },
      });
      if (!response.ok) {
        if (attempt < retries && shouldRetry(response.status)) {
          await sleep(retryDelayMs * 2 ** attempt);
          continue;
        }
        return null;
      }
      if (!isJsonContentType(response.headers.get("content-type"))) return null;

      const data = await response.json() as {
        media?: Record<string, unknown>;
      };
      const candidates = [
        data.media?.picture_large,
        data.media?.picture_medium_large,
        data.media?.picture_medium,
        data.media?.background_large,
        data.media?.background_medium_large,
      ];
      const artwork = candidates.find(validArtworkUrl);
      return artwork ? absoluteArtworkUrl(artwork) : null;
    } catch {
      if (attempt >= retries) return null;
      await sleep(retryDelayMs * 2 ** attempt);
    }
  }
  return null;
}

export async function mapConcurrent<T>(
  values: readonly T[],
  concurrency: number,
  worker: (value: T, index: number) => Promise<void>,
): Promise<void> {
  const width = Math.max(1, Math.floor(concurrency));
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(width, values.length) }, async () => {
    while (true) {
      const index = next++;
      if (index >= values.length) return;
      await worker(values[index]!, index);
    }
  }));
}

function emptyMetrics(): ArtworkRecoveryMetrics {
  return {
    episodePages: 0,
    episodesScanned: 0,
    episodeArtworkFound: 0,
    episodesUpdated: 0,
    episodeUpdateRaces: 0,
    episodeFetchFailed: 0,
    trackPages: 0,
    tracksScanned: 0,
    trackFallbackFound: 0,
    tracksUpdated: 0,
    trackUpdateRaces: 0,
    tracksWithoutFallback: 0,
    writesSkipped: 0,
  };
}

export async function recoverArtwork(options: ArtworkRecoveryOptions): Promise<ArtworkRecoveryMetrics> {
  const pageSize = Math.max(1, Math.floor(options.pageSize ?? 100));
  const concurrency = Math.max(1, Math.floor(options.concurrency ?? 4));
  const maxPagesPerKind = options.maxPagesPerKind === undefined
    ? Number.POSITIVE_INFINITY
    : Math.max(1, Math.floor(options.maxPagesPerKind));
  const metrics = emptyMetrics();
  const progress = () => options.onProgress?.({ ...metrics });

  let episodeCursor = options.cursor?.episodeAfterId ?? null;
  while (metrics.episodePages < maxPagesPerKind) {
    const page = await options.store.listMissingNtsEpisodes(episodeCursor, pageSize);
    if (page.length === 0) {
      if (options.cursor) options.cursor.episodeAfterId = null;
      break;
    }
    metrics.episodePages++;
    metrics.episodesScanned += page.length;
    await mapConcurrent(page, concurrency, async (episode) => {
      const artwork = await fetchNtsEpisodeArtwork(episode.url, options);
      if (!artwork) {
        metrics.episodeFetchFailed++;
        return;
      }
      metrics.episodeArtworkFound++;
      if (options.dryRun) {
        metrics.writesSkipped++;
      } else if (await options.store.setEpisodeArtworkIfMissing(episode.id, artwork)) {
        metrics.episodesUpdated++;
      } else {
        metrics.episodeUpdateRaces++;
      }
    });
    progress();
    episodeCursor = page[page.length - 1]!.id;
    if (options.cursor) options.cursor.episodeAfterId = episodeCursor;
    if (page.length < pageSize) {
      if (options.cursor) options.cursor.episodeAfterId = null;
      break;
    }
  }

  let trackCursor = options.cursor?.trackAfterId ?? null;
  while (metrics.trackPages < maxPagesPerKind) {
    const page = await options.store.listMissingTrackArtwork(trackCursor, pageSize);
    if (page.length === 0) {
      if (options.cursor) options.cursor.trackAfterId = null;
      break;
    }
    metrics.trackPages++;
    metrics.tracksScanned += page.length;
    const fallback = await options.store.getEpisodeArtworkForTracks(page);
    await mapConcurrent(page, concurrency, async (track) => {
      const artwork = fallback.get(track.id);
      if (!artwork) {
        metrics.tracksWithoutFallback++;
        return;
      }
      metrics.trackFallbackFound++;
      if (options.dryRun) {
        metrics.writesSkipped++;
      } else if (await options.store.setTrackArtworkIfMissing(track.id, artwork)) {
        metrics.tracksUpdated++;
      } else {
        metrics.trackUpdateRaces++;
      }
    });
    progress();
    trackCursor = page[page.length - 1]!.id;
    if (options.cursor) options.cursor.trackAfterId = trackCursor;
    if (page.length < pageSize) {
      if (options.cursor) options.cursor.trackAfterId = null;
      break;
    }
  }

  return metrics;
}

export function resolveTrackArtwork(
  tracks: readonly TrackArtworkCandidate[],
  junctionRows: readonly { track_id: string; episode_id: string }[],
  episodeRows: readonly { id: string; artwork_url: string | null }[],
): Map<string, string> {
  const byEpisode = new Map(
    episodeRows.filter((row) => row.artwork_url).map((row) => [row.id, row.artwork_url!]),
  );
  const result = new Map<string, string>();

  // Direct episode ownership is authoritative. Sorted junction links are the fallback.
  for (const track of tracks) {
    if (track.episodeId && byEpisode.has(track.episodeId)) {
      result.set(track.id, byEpisode.get(track.episodeId)!);
    }
  }
  for (const row of junctionRows) {
    const artwork = byEpisode.get(row.episode_id);
    if (artwork && !result.has(row.track_id)) result.set(row.track_id, artwork);
  }
  return result;
}

type QueryResult<T> = { data: T[] | null; error: { message: string } | null };
type SupabaseLike = { from(table: string): any };

function rowsOrThrow<T>(result: QueryResult<T>, operation: string): T[] {
  if (result.error) throw new Error(`${operation}: ${result.error.message}`);
  return result.data ?? [];
}

export function createSupabaseArtworkRecoveryStore(db: SupabaseLike): ArtworkRecoveryStore {
  return {
    async listMissingNtsEpisodes(afterId, limit) {
      let query = db.from("episodes")
        .select("id, url")
        .eq("source", "nts")
        .or("artwork_url.is.null,artwork_url.eq.")
        .order("id", { ascending: true })
        .limit(limit);
      if (afterId) query = query.gt("id", afterId);
      const rows = rowsOrThrow<{ id: string; url: string }>(await query, "list missing NTS episodes");
      return rows;
    },

    async setEpisodeArtworkIfMissing(id, artworkUrl) {
      const result = await db.from("episodes")
        .update({ artwork_url: artworkUrl })
        .eq("id", id)
        .or("artwork_url.is.null,artwork_url.eq.")
        .select("id");
      return rowsOrThrow<{ id: string }>(result, `update episode ${id}`).length === 1;
    },

    async listMissingTrackArtwork(afterId, limit) {
      let query = db.from("tracks")
        .select("id, episode_id")
        .or("cover_art_url.is.null,cover_art_url.eq.")
        .order("id", { ascending: true })
        .limit(limit);
      if (afterId) query = query.gt("id", afterId);
      const rows = rowsOrThrow<{ id: string; episode_id: string | null }>(await query, "list tracks missing artwork");
      return rows.map((row) => ({ id: row.id, episodeId: row.episode_id }));
    },

    async getEpisodeArtworkForTracks(tracks) {
      if (tracks.length === 0) return new Map();
      const trackIds = tracks.map((track) => track.id);
      const directEpisodeIds = tracks.map((track) => track.episodeId).filter((id): id is string => Boolean(id));
      const junctionRows = rowsOrThrow<{ track_id: string; episode_id: string }>(
        await db.from("episode_tracks")
          .select("track_id, episode_id")
          .in("track_id", trackIds)
          .order("episode_id", { ascending: true }),
        "list episode-track artwork links",
      );
      const episodeIds = Array.from(new Set([...directEpisodeIds, ...junctionRows.map((row) => row.episode_id)]));
      if (episodeIds.length === 0) return new Map();
      const episodeRows = rowsOrThrow<{ id: string; artwork_url: string | null }>(
        await db.from("episodes")
          .select("id, artwork_url")
          .in("id", episodeIds)
          .not("artwork_url", "is", null)
          .order("id", { ascending: true }),
        "list episode artwork",
      );
      return resolveTrackArtwork(tracks, junctionRows, episodeRows);
    },

    async setTrackArtworkIfMissing(id, artworkUrl) {
      const result = await db.from("tracks")
        .update({ cover_art_url: artworkUrl })
        .eq("id", id)
        .or("cover_art_url.is.null,cover_art_url.eq.")
        .select("id");
      return rowsOrThrow<{ id: string }>(result, `update track ${id}`).length === 1;
    },
  };
}
