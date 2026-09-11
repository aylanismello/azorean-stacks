export type MediaSessionSeekAction = "seekbackward" | "seekforward" | "seekto";
export type SpotifyPlayCommand = "start" | "resume";

export function spotifyPlayCommand(trackStarted: boolean): SpotifyPlayCommand {
  return trackStarted ? "resume" : "start";
}

export interface MediaSessionSeekDetails {
  seekOffset?: number | null;
  seekTime?: number | null;
}

const DEFAULT_SEEK_OFFSET_SECONDS = 30;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

/** Resolve Media Session seek actions without trusting browser-provided values. */
export function mediaSessionSeekTarget(
  action: MediaSessionSeekAction,
  progress: number,
  duration: number,
  details: MediaSessionSeekDetails = {},
): number | null {
  if (!Number.isFinite(progress) || !Number.isFinite(duration) || duration <= 0) return null;

  if (action === "seekto") {
    if (details.seekTime == null || !Number.isFinite(details.seekTime)) return null;
    return clamp(details.seekTime, 0, duration);
  }

  const suppliedOffset = details.seekOffset;
  const offset = suppliedOffset != null && Number.isFinite(suppliedOffset) && suppliedOffset >= 0
    ? suppliedOffset
    : DEFAULT_SEEK_OFFSET_SECONDS;
  return clamp(action === "seekbackward" ? progress - offset : progress + offset, 0, duration);
}

export interface MediaSessionPositionState {
  duration: number;
  playbackRate: number;
  position: number;
}

/** Build a valid setPositionState payload, or null until duration is known. */
export function mediaSessionPositionState(
  progress: number,
  duration: number,
): MediaSessionPositionState | null {
  if (!Number.isFinite(progress) || !Number.isFinite(duration) || duration <= 0) return null;
  return {
    duration,
    playbackRate: 1,
    position: clamp(progress, 0, duration),
  };
}

/** Repeat belongs only to the loaded canonical track. */
export function repeatIdForLoadedTrack(
  repeatTrackId: string | null,
  loadedCanonicalTrackId: string | null,
): string | null {
  return repeatTrackId !== null && repeatTrackId === loadedCanonicalTrackId
    ? repeatTrackId
    : null;
}

export interface RepeatToggleResult {
  accepted: boolean;
  repeatTrackId: string | null;
}

/** Resolve repeat-one toggles while rejecting stale/non-current track actions. */
export function toggleRepeatIdForCurrentTrack(
  requestedCanonicalTrackId: string,
  loadedCanonicalTrackId: string | null,
  repeatTrackId: string | null,
): RepeatToggleResult {
  if (!loadedCanonicalTrackId || requestedCanonicalTrackId !== loadedCanonicalTrackId) {
    return { accepted: false, repeatTrackId };
  }
  return {
    accepted: true,
    repeatTrackId: repeatTrackId === loadedCanonicalTrackId ? null : loadedCanonicalTrackId,
  };
}
