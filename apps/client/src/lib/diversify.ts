/**
 * Shared track diversification logic.
 *
 * Rules:
 *  - Max 2 consecutive tracks from the same episode
 *  - Max 2 consecutive tracks from the same artist
 *  - No 3 consecutive tracks with the same primary genre
 *  - Reserve roughly 10–15% of positions for low-confidence exploration
 *    rather than forcing a medium-score wildcard every fifth track.
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

export function diversifyTracks(tracks: any[]): any[] {
  if (tracks.length === 0) return [];

  const prefixLength = highConfidencePrefixLength(tracks);
  const reservedPrefix = tracks.slice(0, prefixLength);
  const reservedIds = new Set(reservedPrefix.map((track) => track.id));

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
    // Controlled exploration must come from outside the raw top 20. For a
    // single 20-row page, the queue's already-materialized exploration stands.
    .filter((entry) => entry.index >= Math.max(20, Math.ceil(tracks.length * 0.25)))
    // Exploration means uncertain and near-neutral, never known-negative.
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
  const explorationPool = rankedExploration.map((entry) => entry.track);
  const mainPool = tracks.filter((track) => !reservedIds.has(track.id) && !explorationIds.has(track.id));
  const result: any[] = [];
  const explorationInterval = explorationPool.length
    ? Math.max(7, Math.round(tracks.length / explorationPool.length))
    : Number.POSITIVE_INFINITY;

  let consecEpId: string | null = null;
  let consecEpCount = 0;
  let consecArtist: string | null = null;
  let consecArtistCount = 0;
  let consecGenre: string | null = null;
  let consecGenreCount = 0;

  function updateConsecState(track: any) {
    const epId = track.episode_id || null;
    if (epId !== null && epId === consecEpId) consecEpCount++;
    else { consecEpId = epId; consecEpCount = 1; }

    const artist = (track.artist || "").toLowerCase();
    if (artist && artist === consecArtist) consecArtistCount++;
    else { consecArtist = artist || null; consecArtistCount = 1; }

    const genre = primaryGenre(track);
    if (genre && genre === consecGenre) consecGenreCount++;
    else { consecGenre = genre; consecGenreCount = 1; }
  }

  function violatesConstraints(track: any): boolean {
    const epId = track.episode_id || null;
    if (epId !== null && epId === consecEpId && consecEpCount >= 2) return true;

    const artist = (track.artist || "").toLowerCase();
    if (artist && artist === consecArtist && consecArtistCount >= 2) return true;

    const genre = primaryGenre(track);
    if (genre && genre === consecGenre && consecGenreCount >= 2) return true;

    return false;
  }

  function takeFirstEligible(pool: any[]): any | null {
    if (!pool.length) return null;
    const index = pool.findIndex((track) => !violatesConstraints(track));
    const [track] = pool.splice(index === -1 ? 0 : index, 1);
    return track;
  }

  // Preserve the strongest evidence-based prefix before enforcing context caps.
  for (const track of reservedPrefix) {
    result.push(track);
    updateConsecState(track);
  }

  while (mainPool.length || explorationPool.length) {
    const explorationDue = explorationPool.length > 0
      && result.length > 0
      && (result.length + 1) % explorationInterval === 0;
    let track = explorationDue ? takeFirstEligible(explorationPool) : takeFirstEligible(mainPool);
    if (!track) track = takeFirstEligible(explorationPool);
    if (!track) break;
    result.push(track);
    updateConsecState(track);
  }

  return result;
}

function primaryGenre(track: any): string | null {
  const genres = track.metadata?.genres;
  if (Array.isArray(genres) && genres.length > 0 && typeof genres[0] === "string") {
    return genres[0].toLowerCase();
  }
  return null;
}
