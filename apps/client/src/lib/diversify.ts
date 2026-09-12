/**
 * Shared track diversification logic.
 *
 * Rules:
 *  - Never repeat an artist, exact episode, or originating show back-to-back when alternatives exist
 *  - In the upcoming 10-track window, cap an artist/episode at 2 and a show at 3
 *  - Reserve roughly 10–15% of positions for low-confidence exploration
 *  - Re-run pacing after optional exploration so no lane bypasses the digging cadence
 */
export function highConfidencePrefixLength(tracks: any[]): number {
  const bound = Math.min(5, tracks.length);
  let length = 0;
  while (length < bound) {
    const track = tracks[length];
    const score = Number(track.taste_score);
    const confidence = Number(track.metadata?._score_confidence);
    if (!Number.isFinite(score) || score < 0.5
      || !Number.isFinite(confidence) || confidence < 0.8) break;
    length++;
  }
  return length;
}

function normalize(value: unknown): string | null {
  const key = String(value || "").normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
  return key || null;
}

const ARTIST_ALIASES: Record<string, string> = {
  flylo: "flying lotus",
  "flying lotus": "flying lotus",
};

function artistKeys(track: any): string[] {
  const values = [track.artist, ...(Array.isArray(track.metadata?.artists) ? track.metadata.artists : [])];
  const keys = new Set<string>();
  for (const value of values) {
    const full = normalize(value);
    if (!full) continue;
    keys.add(ARTIST_ALIASES[full] || full);
    const primary = normalize(full.split(/\s+(?:feat(?:uring)?|ft|with)\.?\s+/i)[0]);
    if (primary) keys.add(ARTIST_ALIASES[primary] || primary);
  }
  return [...keys];
}

function episodeKeys(track: any): string[] {
  const keys = new Set<string>();
  for (const value of [track.episode?.id, track.episode_id, ...(track.episode_ids || [])]) {
    const key = normalize(value);
    if (key) keys.add(key);
  }
  return [...keys];
}

function showKeys(track: any): string[] {
  const keys = new Set<string>();
  for (const value of [
    track.source_context,
    track.metadata?._source_context_key,
    ...(track.source_contexts || []),
  ]) {
    const key = normalize(value);
    if (key) keys.add(key);
  }
  const rawUrl = track.episode?.url;
  if (typeof rawUrl === "string") {
    try {
      const url = new URL(rawUrl);
      const show = url.pathname.match(/\/(?:shows?|programs?)\/([^/]+)/i)?.[1];
      if (show) keys.add(`${url.hostname.toLowerCase()}:${show.toLowerCase()}`);
    } catch {}
  }
  return [...keys];
}

function overlaps(left: string[], right: string[]): boolean {
  const rightSet = new Set(right);
  return left.some((key) => rightSet.has(key));
}

/** Final display-order pacing. This runs after optional exploration is inserted,
 * so no API-side lane can bypass the crate-digging cadence. */
export function paceTracks(tracks: any[]): any[] {
  const pool = [...tracks];
  const result: any[] = [];
  const window = 10;

  const violates = (track: any, strictWindow: boolean) => {
    const previous = result[result.length - 1];
    const artist = artistKeys(track);
    const episode = episodeKeys(track);
    const show = showKeys(track);
    if (previous) {
      if (artist.length && overlaps(artist, artistKeys(previous))) return true;
      if (episode.length && overlaps(episode, episodeKeys(previous))) return true;
      if (show.length && overlaps(show, showKeys(previous))) return true;
    }
    if (!strictWindow) return false;
    const recent = result.slice(-(window - 1));
    if (artist.length && recent.filter((item) => overlaps(artist, artistKeys(item))).length >= 2) return true;
    if (episode.length && recent.filter((item) => overlaps(episode, episodeKeys(item))).length >= 2) return true;
    if (show.length && recent.filter((item) => overlaps(show, showKeys(item))).length >= 3) return true;
    return false;
  };

  while (pool.length) {
    let index = pool.findIndex((track) => !violates(track, true));
    if (index < 0) index = pool.findIndex((track) => !violates(track, false));
    if (index < 0) index = 0;
    result.push(pool.splice(index, 1)[0]);
  }
  return result;
}

export function diversifyTracks(tracks: any[]): any[] {
  if (tracks.length === 0) return [];

  const explorationCount = tracks.length >= 8
    ? Math.max(1, Math.round(tracks.length * 0.125))
    : 0;

  // Avoid replacing the strongest first-page candidates. Among the remainder,
  // explore where the model is least certain and closest to neutral.
  const rankedExploration = tracks
    .map((track, index) => {
      const meta = (track.metadata || {}) as Record<string, unknown>;
      const confidenceValue = meta._score_confidence;
      const confidence = typeof confidenceValue === "number"
        ? Math.max(0, Math.min(1, confidenceValue))
        : 0;
      const score = Math.max(-1, Math.min(1, Number(track.taste_score || 0)));
      const uncertainty = (1 - confidence) * 0.75 + (1 - Math.abs(score)) * 0.25;
      return { track, index, uncertainty };
    })
    .filter((entry) => entry.index >= Math.max(20, Math.ceil(tracks.length * 0.25)))
    .filter((entry) => {
      if (Number(entry.track.taste_score || 0) < 0) return false;
      const artist = String(entry.track.artist || "").trim().toLowerCase();
      const title = String(entry.track.title || "").trim().toLowerCase();
      if (!artist || !title || artist === "tracklist" || title === "tracklist") return false;
      const components = entry.track.metadata?._score_components || {};
      return ![components.source_context, components.episode_density]
        .some((value) => typeof value === "number" && value < 0);
    })
    .sort((a, b) => b.uncertainty - a.uncertainty || a.index - b.index)
    .slice(0, explorationCount);

  const explorationIds = new Set(rankedExploration.map((entry) => entry.track.id));
  const staged = tracks.filter((track) => !explorationIds.has(track.id));
  const interval = rankedExploration.length
    ? Math.max(7, Math.round(tracks.length / rankedExploration.length))
    : Number.POSITIVE_INFINITY;
  rankedExploration.forEach(({ track }, index) => {
    staged.splice(Math.min(staged.length, Math.round((index + 1) * interval) - 1), 0, track);
  });
  return paceTracks(staged);
}
