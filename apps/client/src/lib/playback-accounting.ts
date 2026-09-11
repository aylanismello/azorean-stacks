import { PLAY_CHUNK_MS } from "./track-play";

export interface PlaybackAccountingState {
  sessionId: string;
  trackId: string;
  listenedMs: number;
  requestedMs: number;
}

export interface PlaybackClockState {
  sampledAtMs: number;
  wasPlaying: boolean;
}

export interface PlaybackClockSample {
  clock: PlaybackClockState;
  elapsedPlayingMs: number;
}

export function createPlaybackSessionId(): string {
  return crypto.randomUUID();
}

/** Return the cumulative, retry-safe total worth reporting to the backend. */
export function reportablePlaybackMs(listenedMs: number): number {
  if (!Number.isFinite(listenedMs) || listenedMs < PLAY_CHUNK_MS) return 0;
  return Math.floor(listenedMs / PLAY_CHUNK_MS) * PLAY_CHUNK_MS;
}

export function nextPlaybackReport(
  state: PlaybackAccountingState,
  elapsedMs: number,
): PlaybackAccountingState {
  const listenedMs = state.listenedMs + Math.max(0, elapsedMs);
  const target = reportablePlaybackMs(listenedMs);
  return {
    ...state,
    listenedMs,
    requestedMs: Math.max(state.requestedMs, target),
  };
}

/**
 * Account from a monotonic wall clock instead of media position. This keeps
 * pauses out of the total and means seeking cannot manufacture listening time.
 */
export function samplePlaybackClock(
  clock: PlaybackClockState,
  nowMs: number,
  isPlaying: boolean,
): PlaybackClockSample {
  const elapsedPlayingMs = clock.wasPlaying
    ? Math.max(0, nowMs - clock.sampledAtMs)
    : 0;
  return {
    clock: { sampledAtMs: nowMs, wasPlaying: isPlaying },
    elapsedPlayingMs,
  };
}

/** Detect a natural repeat-one wrap without treating an explicit seek as a loop. */
export function isRepeatLoopTransition(
  previousPosition: number | null,
  position: number,
  duration: number,
  repeatEnabled: boolean,
  explicitSeek = false,
): boolean {
  if (
    !repeatEnabled
    || explicitSeek
    || previousPosition === null
    || !Number.isFinite(position)
    || !Number.isFinite(duration)
    || duration <= 0
  ) {
    return false;
  }

  const edgeWindow = Math.min(3, duration * 0.2);
  return previousPosition >= duration - edgeWindow && position <= edgeWindow;
}
