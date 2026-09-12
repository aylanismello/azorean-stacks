"use client";

import { createContext, useContext, useCallback, useRef, useState, useEffect } from "react";
import { useSpotify } from "./SpotifyProvider";
import { nextEpisodePositionToPrepare } from "@/lib/episode-playback";
import { refreshSignedUrl } from "@/lib/player-audio";
import { canonicalPlayerTrackId } from "@/lib/player-track-identity";
import { validatedQueueIndex } from "@/lib/queue-navigation";
import { buildQualifiedListenEvidence } from "@/lib/listen-evidence";
import { nextPlaybackHistory } from "@/lib/playback-history";
import {
  createPlaybackSessionId,
  isRepeatLoopTransition,
  nextPlaybackReport,
  samplePlaybackClock,
  type PlaybackAccountingState,
  type PlaybackClockState,
} from "@/lib/playback-accounting";
import {
  mediaSessionPositionState,
  mediaSessionSeekTarget,
  repeatIdForLoadedTrack,
  spotifyPlayCommand,
  toggleRepeatIdForCurrentTrack,
} from "@/lib/player-media-session";

export interface PlayerTrack {
  id: string;
  /** Stable source-appearance identity for exact episode ordering and repeats. */
  appearanceId?: string | null;
  /** Zero-based position in the source episode tracklist. */
  episodePosition?: number | null;
  /** Honest state for episode entries that cannot currently play. */
  episodeAvailability?: "ready" | "queued" | "unavailable" | "unresolved";
  /** Stable catalog identity shared by the library and episode snapshots. */
  catalogTrackId?: string | null;
  artist: string;
  title: string;
  coverArtUrl: string | null;
  spotifyUrl: string | null;
  audioUrl: string | null;
  episodeId?: string | null;
  episodeTitle?: string | null;
  youtubeUrl?: string | null;
  /** Authenticated endpoint that returns a fresh signed audio URL. */
  audioRefreshUrl?: string | null;

  // Vote / status fields — provider owns these
  vote_status?: "approved" | "rejected" | "skipped" | "listened" | "pending" | "bad_source" | null;
  super_liked?: boolean;
  status?: string;

  // Seed indicators
  is_seed?: boolean;
  is_re_seed?: boolean;
  is_artist_seed?: boolean;

  // Discovery metadata
  source?: string;
  episode_id?: string | null;
  episode_title?: string | null;
  storage_path?: string | null;
  youtube_url?: string | null;
  preview_url?: string | null;
  seed_id?: string | null;
  seed_track?: { artist: string; title: string } | null;
  taste_score?: number | null;

  // Source context (episode link, etc.)
  source_url?: string | null;
  source_context?: string | null;

  // Episode join data (for context modal)
  episode?: {
    id: string;
    title: string | null;
    source: string;
    aired_date: string | null;
    artwork_url: string | null;
    url?: string | null;
  } | null;

  // Metadata bag (genres, seed_artist, etc.)
  metadata?: Record<string, unknown>;

  // Scoring metadata from ranked queue
  _ranked_score?: number;
  _score_components?: Record<string, number>;
  _match_type?: string;
  _seed_name?: string;
  _seed_artist?: string;
  _seed_title?: string;
  _tangent_id?: string;
  _tangent_seed_name?: string;
  _tangent_start_rank?: number;
  _sonic_seed_name?: string;

  // Voted timestamp
  voted_at?: string | null;
}

export interface EpisodePlaybackSession {
  sessionId: string;
  episodeId: string;
  /** Position already prepared by the episode-start request. */
  preparedPosition?: number;
}

type PlaybackSource = "spotify" | "audio" | null;

interface PlaybackReportState {
  accounting: PlaybackAccountingState;
  acknowledgedMs: number;
  inFlight: boolean;
  retryTimer: ReturnType<typeof setTimeout> | null;
}

/** Connection quality based on recent stall history */
export type ConnectionQuality = "good" | "recovering" | "stalled";

/** Toast message displayed briefly in the player bar */
export interface PlayerToast {
  message: string;
  id: number;
}

interface GlobalPlayerContextType {
  currentTrack: PlayerTrack | null;
  playing: boolean;
  loading: boolean;
  /** True when the audio source is buffering (waiting/stalled events, or stall detected) */
  buffering: boolean;
  progress: number; // seconds
  duration: number; // seconds
  source: PlaybackSource;
  /** True when the current track has no playable audio source */
  noSource: boolean;
  /** Increments each time the current track finishes playing */
  trackEndedCount: number;
  /** Whether both audio and spotify sources are available for the current track */
  canSwitchSource: boolean;
  /** URL path where playback was initiated from */
  playbackOrigin: string | null;
  /** Unix ms timestamp when the current track started playing (for engagement tracking) */
  trackStartedAt: number | null;
  /** Connection quality indicator */
  connectionQuality: ConnectionQuality;
  /** Brief toast messages from the player (e.g. "Skipped — couldn't load") */
  toast: PlayerToast | null;
  /** Canonical identity of the current track when repeat-one is enabled. */
  repeatTrackId: string | null;
  /** Load a track into the player without starting playback */
  loadTrack: (track: PlayerTrack, origin?: string) => void;
  /** Load a track and immediately start playing */
  play: (track: PlayerTrack, origin?: string) => void;
  togglePlayPause: () => void;
  /** Toggle repeat-one, but only for the currently loaded canonical track. */
  toggleRepeatTrack: (canonicalTrackId: string) => void;
  seek: (seconds: number) => void;
  stop: () => void;
  /** Switch playback source (audio <-> spotify) while keeping playback going */
  switchSource: (to: "audio" | "spotify") => void;
  /** Preload next track's audio in background */
  preloadTrack: (track: PlayerTrack) => void;
  /** Ordered playback queue */
  queue: PlayerTrack[];
  /** Most recently passed tracks, newest first, retained for this browser tab. */
  history: PlayerTrack[];
  /** Clear the browser-tab playback history. */
  clearHistory: () => void;
  /** Current position within the queue */
  currentIndex: number;
  /** Replace the playback queue; if startIndex is provided, seek to that position */
  setQueue: (queue: PlayerTrack[], startIndex?: number) => void;
  /** Replace the queue with a persistent, lossless episode playback session. */
  setEpisodeQueue: (queue: PlayerTrack[], session: EpisodePlaybackSession, startIndex?: number) => void;
  /** Jump to a specific position in the queue and start playing */
  playFromQueue: (index: number, origin?: string) => void;
  /** Advance to the next track in the queue; returns false if at end */
  next: () => boolean;
  /** Go back to the previous track in the queue; returns false if at start */
  prev: () => boolean;
  /** Update a track's vote status in the queue (no array rebuild, no index change) */
  updateTrackVote: (trackId: string, status: string, superLiked?: boolean) => void;
  /** Synchronize a track's user-owned re-seed state without interrupting playback. */
  setTrackSeeded: (trackId: string, seeded: boolean, seedId?: string | null) => void;
  /** Mark a discovered track as a user re-seed without interrupting playback. */
  markTrackSeeded: (trackId: string, seedId?: string | null) => void;
  /** Append new tracks to the end of the queue (for batch loading) */
  appendToQueue: (tracks: PlayerTrack[]) => void;
  /** Replace a track's audio URL in queue + reload Audio element if currently active (does NOT auto-play) */
  replaceAudioUrl: (trackId: string, newUrl: string) => void;
}

const GlobalPlayerContext = createContext<GlobalPlayerContextType>({
  currentTrack: null,
  playing: false,
  loading: false,
  buffering: false,
  progress: 0,
  duration: 0,
  source: null,
  noSource: false,
  trackEndedCount: 0,
  canSwitchSource: false,
  playbackOrigin: null,
  trackStartedAt: null,
  connectionQuality: "good",
  toast: null,
  repeatTrackId: null,
  loadTrack: () => {},
  play: () => {},
  togglePlayPause: () => {},
  toggleRepeatTrack: () => {},
  seek: () => {},
  stop: () => {},
  switchSource: () => {},
  preloadTrack: () => {},
  queue: [],
  history: [],
  clearHistory: () => {},
  currentIndex: 0,
  setQueue: () => {},
  setEpisodeQueue: () => {},
  playFromQueue: () => {},
  next: () => false,
  prev: () => false,
  updateTrackVote: () => {},
  setTrackSeeded: () => {},
  markTrackSeeded: () => {},
  appendToQueue: () => {},
  replaceAudioUrl: () => {},
});

export function useGlobalPlayer() {
  return useContext(GlobalPlayerContext);
}

export function GlobalPlayerProvider({ children }: { children: React.ReactNode }) {
  const spotify = useSpotify();
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [currentTrack, setCurrentTrack] = useState<PlayerTrack | null>(null);
  const [playing, setPlaying] = useState(false);
  const [nativePlaybackActive, setNativePlaybackActive] = useState(false);
  const [loading, setLoading] = useState(false);
  const [buffering, setBuffering] = useState(false);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);
  const [source, setSource] = useState<PlaybackSource>(null);
  const [trackEndedCount, setTrackEndedCount] = useState(0);
  const [noSource, setNoSource] = useState(false);
  const [playbackOrigin, setPlaybackOrigin] = useState<string | null>(null);
  const [trackStartedAt, setTrackStartedAt] = useState<number | null>(null);
  const [connectionQuality, setConnectionQuality] = useState<ConnectionQuality>("good");
  const [toast, setToast] = useState<PlayerToast | null>(null);
  const [repeatTrackId, setRepeatTrackId] = useState<string | null>(null);
  const repeatTrackIdRef = useRef<string | null>(null);

  // Queue management
  const [queue, setQueueState] = useState<PlayerTrack[]>([]);
  const [history, setHistory] = useState<PlayerTrack[]>([]);
  const historyRef = useRef<PlayerTrack[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const queueRef = useRef<PlayerTrack[]>([]);
  const currentIndexRef = useRef(0);
  const [episodeSession, setEpisodeSession] = useState<EpisodePlaybackSession | null>(null);
  const episodeSessionRef = useRef<EpisodePlaybackSession | null>(null);
  const lastScheduledEpisodePositionRef = useRef<number | null>(null);
  const episodePrepareChainRef = useRef<Promise<void>>(Promise.resolve());
  const lastEpisodeEndedCountRef = useRef(0);
  // Tracks whether we've already fired the 'listened' mark for the current track session
  const listenedFiredRef = useRef(false);

  // Durable play accounting is intentionally separate from media position:
  // wall-clock samples cannot be inflated by seeking.
  const playbackSessionRef = useRef<PlaybackReportState | null>(null);
  const playbackReportsRef = useRef<Set<PlaybackReportState>>(new Set());
  const playbackClockRef = useRef<PlaybackClockState>({ sampledAtMs: 0, wasPlaying: false });
  const lastPlaybackPositionRef = useRef<number | null>(null);
  const playbackAccountingMountedRef = useRef(true);
  // Tracks whether this GlobalPlayer track has actually been started on Spotify.
  // A paused started track must resume; a merely loaded track must start its URI.
  const spotifyTrackStartedRef = useRef(false);
  const spotifyCommandChainRef = useRef<Promise<void>>(Promise.resolve());
  const spotifyPlayGenerationRef = useRef(0);

  // Stall detection refs
  const lastProgressTimeRef = useRef(0); // last audio.currentTime we saw
  const lastProgressCheckRef = useRef(0); // Date.now() when we last saw progress change
  const stallRetryCountRef = useRef(0);
  const stallRecoveryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isRecoveringRef = useRef(false);

  // Connection quality tracking
  const lastStallAtRef = useRef(0);

  // Preload ref for next track
  const preloadAudioRef = useRef<HTMLAudioElement | null>(null);
  const preloadedTrackIdRef = useRef<string | null>(null);

  // Signed URL expiry tracking: store when each URL was obtained
  const urlObtainedAtRef = useRef<Map<string, number>>(new Map());

  // Toast ID counter
  const toastIdRef = useRef(0);

  const showToast = useCallback((message: string) => {
    const id = ++toastIdRef.current;
    setToast({ message, id });
    setTimeout(() => {
      setToast((prev) => (prev?.id === id ? null : prev));
    }, 3000);
  }, []);

  const flushPlaybackReport = useCallback((report: PlaybackReportState): void => {
    const target = report.accounting.requestedMs;
    if (report.inFlight || target <= report.acknowledgedMs) return;

    report.inFlight = true;
    fetch(`/api/user-tracks/${report.accounting.trackId}/play`, {
      method: "POST",
      keepalive: true,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: report.accounting.sessionId,
        listened_ms: target,
      }),
    }).then((response) => {
      if (!response.ok) throw new Error(`Playback accounting failed (${response.status})`);
      report.acknowledgedMs = Math.max(report.acknowledgedMs, target);
      report.inFlight = false;
      if (report.accounting.requestedMs > report.acknowledgedMs) {
        flushPlaybackReport(report);
      } else if (playbackSessionRef.current !== report) {
        playbackReportsRef.current.delete(report);
      }
    }).catch(() => {
      report.inFlight = false;
      if (!playbackAccountingMountedRef.current || report.retryTimer) return;
      report.retryTimer = setTimeout(() => {
        report.retryTimer = null;
        flushPlaybackReport(report);
      }, 5_000);
    });
  }, []);

  const accountPlaybackSample = useCallback((isPlaying: boolean, nowMs = performance.now()) => {
    const sample = samplePlaybackClock(playbackClockRef.current, nowMs, isPlaying);
    playbackClockRef.current = sample.clock;
    const report = playbackSessionRef.current;
    if (!report || sample.elapsedPlayingMs <= 0) return;
    report.accounting = nextPlaybackReport(report.accounting, sample.elapsedPlayingMs);
    flushPlaybackReport(report);
  }, [flushPlaybackReport]);

  const startPlaybackAccountingSession = useCallback((track: PlayerTrack | null, continuing = false) => {
    accountPlaybackSample(false);
    const previous = playbackSessionRef.current;
    if (previous && !previous.inFlight && previous.accounting.requestedMs <= previous.acknowledgedMs) {
      playbackReportsRef.current.delete(previous);
    }

    const now = performance.now();
    playbackClockRef.current = { sampledAtMs: now, wasPlaying: continuing };
    lastPlaybackPositionRef.current = null;
    const trackId = canonicalPlayerTrackId(track);
    if (!trackId) {
      playbackSessionRef.current = null;
      return;
    }

    const report: PlaybackReportState = {
      accounting: {
        sessionId: createPlaybackSessionId(),
        trackId,
        listenedMs: 0,
        requestedMs: 0,
      },
      acknowledgedMs: 0,
      inFlight: false,
      retryTimer: null,
    };
    playbackReportsRef.current.add(report);
    playbackSessionRef.current = report;
  }, [accountPlaybackSample]);

  useEffect(() => {
    playbackAccountingMountedRef.current = true;
    return () => {
      // Queue the final complete chunk before disabling retries. `keepalive`
      // lets the request survive page close/navigation when the browser permits.
      accountPlaybackSample(false);
      playbackAccountingMountedRef.current = false;
      for (const report of playbackReportsRef.current) {
        if (report.retryTimer) clearTimeout(report.retryTimer);
      }
    };
  }, [accountPlaybackSample]);

  // Track the current track ref for use in stall recovery (avoids stale closures)
  const currentTrackRef = useRef<PlayerTrack | null>(null);
  useEffect(() => { currentTrackRef.current = currentTrack; }, [currentTrack]);

  useEffect(() => {
    try {
      const stored = sessionStorage.getItem("stacks-playback-history-v1");
      if (!stored) return;
      const parsed = JSON.parse(stored);
      if (!Array.isArray(parsed)) return;
      const valid = parsed.filter((track): track is PlayerTrack =>
        !!track && typeof track.id === "string" && typeof track.artist === "string" && typeof track.title === "string"
      ).slice(0, 50);
      historyRef.current = valid;
      setHistory(valid);
    } catch {
      sessionStorage.removeItem("stacks-playback-history-v1");
    }
  }, []);

  const clearHistory = useCallback(() => {
    historyRef.current = [];
    setHistory([]);
    try { sessionStorage.removeItem("stacks-playback-history-v1"); } catch {}
  }, []);

  const rememberCurrentTrack = useCallback((nextTrackId: string) => {
    const next = nextPlaybackHistory(historyRef.current, currentTrackRef.current, nextTrackId);
    if (next === historyRef.current) return;
    historyRef.current = next;
    setHistory(next);
    try { sessionStorage.setItem("stacks-playback-history-v1", JSON.stringify(next)); } catch {}
  }, []);

  const sourceRef = useRef<PlaybackSource>(null);
  useEffect(() => { sourceRef.current = source; }, [source]);
  const playingRef = useRef(false);
  useEffect(() => { playingRef.current = playing; }, [playing]);
  const progressRef = useRef(0);
  useEffect(() => { progressRef.current = progress; }, [progress]);
  const durationRef = useRef(0);
  useEffect(() => { durationRef.current = duration; }, [duration]);

  // Sample both native and Spotify playback from the same monotonic clock.
  // Buffering closes the active interval just like pausing does.
  useEffect(() => {
    const sourceIsAdvancing = source === "audio" ? nativePlaybackActive : playing;
    const active = sourceIsAdvancing && !buffering && currentTrack !== null;
    accountPlaybackSample(active);
    if (!active) return;

    const interval = setInterval(() => accountPlaybackSample(true), 1_000);
    return () => {
      clearInterval(interval);
      accountPlaybackSample(false);
    };
  }, [accountPlaybackSample, buffering, currentTrack, nativePlaybackActive, playing, source]);

  // A repeat-one wrap is a new playback session. Position is used only to
  // identify the wrap; elapsed listening still comes exclusively from the clock.
  useEffect(() => {
    const canonicalId = canonicalPlayerTrackId(currentTrack);
    const repeated = canonicalId !== null && repeatTrackId === canonicalId;
    const looped = isRepeatLoopTransition(
      lastPlaybackPositionRef.current,
      progress,
      duration,
      repeated,
    );
    lastPlaybackPositionRef.current = progress;
    if (looped) {
      const sourceIsAdvancing = source === "audio" ? nativePlaybackActive : playing;
      startPlaybackAccountingSession(currentTrack, sourceIsAdvancing && !buffering);
      lastPlaybackPositionRef.current = progress;
    }
  }, [buffering, currentTrack, duration, nativePlaybackActive, playing, progress, repeatTrackId, source, startPlaybackAccountingSession]);

  // Keep native audio repeat tied to canonical identity. The browser handles
  // the loop without emitting `ended`, so ordinary auto-advance stays intact.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.loop = source === "audio"
      && repeatTrackId !== null
      && repeatTrackId === canonicalPlayerTrackId(currentTrack);
  }, [currentTrack, repeatTrackId, source]);

  // Create a persistent audio element
  useEffect(() => {
    const audio = new Audio();
    audio.preload = "metadata";
    audioRef.current = audio;

    const onPlay = () => { setPlaying(true); setLoading(false); setBuffering(false); };
    const onPause = () => { setPlaying(false); setNativePlaybackActive(false); };
    const onEnded = () => { setPlaying(false); setNativePlaybackActive(false); setProgress(0); setTrackEndedCount((c) => c + 1); };
    const onWaiting = () => { setNativePlaybackActive(false); setLoading(true); setBuffering(true); };
    const onStalled = () => { setNativePlaybackActive(false); setBuffering(true); };
    const onPlaying = () => { setNativePlaybackActive(true); setLoading(false); setBuffering(false); isRecoveringRef.current = false; };
    const onCanPlay = () => { setLoading(false); };
    const onTimeUpdate = () => setProgress(audio.currentTime);
    const onLoadedMetadata = () => setDuration(audio.duration);
    const onError = () => {
      setNativePlaybackActive(false);
      // Audio element error — could be expired URL or network issue
      // Only trigger recovery if we were supposed to be playing
      if (!audio.paused || isRecoveringRef.current) {
        setBuffering(true);
      }
    };

    audio.addEventListener("play", onPlay);
    audio.addEventListener("pause", onPause);
    audio.addEventListener("ended", onEnded);
    audio.addEventListener("waiting", onWaiting);
    audio.addEventListener("stalled", onStalled);
    audio.addEventListener("playing", onPlaying);
    audio.addEventListener("canplay", onCanPlay);
    audio.addEventListener("timeupdate", onTimeUpdate);
    audio.addEventListener("loadedmetadata", onLoadedMetadata);
    audio.addEventListener("error", onError);

    return () => {
      audio.pause();
      audio.removeEventListener("play", onPlay);
      audio.removeEventListener("pause", onPause);
      audio.removeEventListener("ended", onEnded);
      audio.removeEventListener("waiting", onWaiting);
      audio.removeEventListener("stalled", onStalled);
      audio.removeEventListener("playing", onPlaying);
      audio.removeEventListener("canplay", onCanPlay);
      audio.removeEventListener("timeupdate", onTimeUpdate);
      audio.removeEventListener("loadedmetadata", onLoadedMetadata);
      audio.removeEventListener("error", onError);
    };
  }, []);

  // ── Stall detection: poll every second to check if currentTime is progressing ──
  useEffect(() => {
    if (source !== "audio") return;

    const interval = setInterval(() => {
      const audio = audioRef.current;
      const track = currentTrackRef.current;
      if (!audio || !track || audio.paused || isRecoveringRef.current) return;

      const now = Date.now();
      const currentTime = audio.currentTime;

      if (Math.abs(currentTime - lastProgressTimeRef.current) > 0.1) {
        // Progress is moving — all good
        lastProgressTimeRef.current = currentTime;
        lastProgressCheckRef.current = now;
        return;
      }

      // currentTime hasn't changed — initialize check timer if first detection
      if (lastProgressCheckRef.current === 0) {
        lastProgressCheckRef.current = now;
        return;
      }

      // Check if 3 seconds have elapsed since we first noticed stall
      if (now - lastProgressCheckRef.current >= 3000) {
        // Stall detected — reset check timer so next stall starts fresh
        lastProgressCheckRef.current = 0;
        setBuffering(true);
        setConnectionQuality("stalled");
        lastStallAtRef.current = now;
        attemptRecovery(audio, track, currentTime);
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [source]);

  // Update connection quality based on time since last stall
  // Only updates state when the quality actually changes to avoid unnecessary re-renders
  useEffect(() => {
    if (source !== "audio" || !playing) return;

    const interval = setInterval(() => {
      const since = Date.now() - lastStallAtRef.current;
      let newQuality: typeof connectionQuality;
      if (lastStallAtRef.current === 0 || since >= 60000) {
        newQuality = "good";
      } else if (since >= 5000) {
        newQuality = "recovering";
      } else {
        return; // still stalled, no change needed
      }
      setConnectionQuality((prev) => prev === newQuality ? prev : newQuality);
    }, 5000);

    return () => clearInterval(interval);
  }, [source, playing]);

  /** Attempt recovery from a stall with escalating strategies */
  const attemptRecovery = useCallback(async (audio: HTMLAudioElement, track: PlayerTrack, position: number) => {
    if (isRecoveringRef.current) return;
    isRecoveringRef.current = true;
    const retryCount = stallRetryCountRef.current;

    if (retryCount >= 2) {
      // Max retries reached — auto-advance
      isRecoveringRef.current = false;
      stallRetryCountRef.current = 0;
      showToast("Skipped — couldn't load");
      setBuffering(false);
      setTrackEndedCount((c) => c + 1);
      return;
    }

    stallRetryCountRef.current = retryCount + 1;

    if (retryCount === 0) {
      // First attempt: reload from same position
      try {
        audio.load();
        audio.currentTime = position;
        await audio.play();
        // If we get here, recovery succeeded
        setBuffering(false);
        setConnectionQuality("good");
        lastStallAtRef.current = 0;
        isRecoveringRef.current = false;
        return;
      } catch {
        // Fall through to URL refresh after timeout
      }
    }

    // Second attempt: try re-fetching the signed URL (it may have expired)
    const freshUrl = await refreshSignedUrl(track);
    if (freshUrl && freshUrl !== audio.src) {
      audio.src = freshUrl;
      audio.currentTime = position;
      // Update track's audioUrl so future operations use the fresh URL
      if (currentTrackRef.current?.id === track.id) {
        setCurrentTrack((prev) => prev ? { ...prev, audioUrl: freshUrl } : prev);
        urlObtainedAtRef.current.set(track.id, Date.now());
      }
      try {
        await audio.play();
        setBuffering(false);
        isRecoveringRef.current = false;
        setConnectionQuality("good");
        lastStallAtRef.current = 0;
        return;
      } catch {
        // Failed — fall through
      }
    }

    // All retries failed — set a timeout, then auto-advance
    stallRecoveryTimerRef.current = setTimeout(() => {
      isRecoveringRef.current = false;
      stallRetryCountRef.current = 0;
      showToast("Skipped — couldn't load");
      setBuffering(false);
      setTrackEndedCount((c) => c + 1);
    }, 5000);
  }, [showToast]);

  // Sync Spotify playback state + detect track end
  const prevSpotifyPositionRef = useRef(0);
  useEffect(() => {
    if (source !== "spotify" || !spotify.playerState) return;

    const pos = (spotify.playerState.position || 0) / 1000;
    const dur = (spotify.playerState.duration || 0) / 1000;
    setPlaying(!spotify.playerState.paused);
    setLoading(false);
    setProgress(pos);
    setDuration(dur);

    // Detect track ended: position resets to 0 and paused, after we were playing
    if (spotify.playerState.paused && pos === 0 && prevSpotifyPositionRef.current > 0 && dur > 0) {
      setTrackEndedCount((c) => c + 1);
    }
    prevSpotifyPositionRef.current = pos;
  }, [spotify.playerState, source]);

  // Poll Spotify progress while playing
  useEffect(() => {
    if (source !== "spotify" || !playing) return;

    const interval = setInterval(() => {
      setProgress((prev) => prev + 0.5);
    }, 500);

    return () => clearInterval(interval);
  }, [source, playing]);

  // Reset the listened guard whenever the track changes
  useEffect(() => {
    listenedFiredRef.current = false;
  }, [currentTrack?.id]);

  // Reset stall tracking when track changes
  useEffect(() => {
    stallRetryCountRef.current = 0;
    lastProgressTimeRef.current = 0;
    lastProgressCheckRef.current = 0;
    isRecoveringRef.current = false;
    setBuffering(false);
    if (stallRecoveryTimerRef.current) {
      clearTimeout(stallRecoveryTimerRef.current);
      stallRecoveryTimerRef.current = null;
    }
  }, [currentTrack?.id]);

  // Auto-skip tracks with no playable source — fire trackEnded so the page
  // auto-advances to the next track in the queue.
  useEffect(() => {
    if (!noSource || !currentTrack) return;
    // Small delay so the UI can briefly show "No audio source" before advancing
    const timer = setTimeout(() => {
      setTrackEndedCount((c) => c + 1);
    }, 800);
    return () => clearTimeout(timer);
  }, [noSource, currentTrack]);

  // Auto-mark as 'listened' when user reaches 80% of a track without taking action.
  // Fire-and-forget — backend guards against overwriting explicit votes.
  useEffect(() => {
    if (listenedFiredRef.current) return;
    const catalogTrackId = canonicalPlayerTrackId(currentTrack);
    if (!catalogTrackId) return;
    const evidence = buildQualifiedListenEvidence(progress, duration);
    if (!evidence) return;

    listenedFiredRef.current = true;
    fetch(`/api/tracks/${catalogTrackId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(evidence),
    }).catch(() => {});
  }, [progress, duration, currentTrack]);

  // ── Proactive signed URL refresh ──
  // Supabase signed URLs expire after 1 hour. Refresh at ~50 minutes to avoid mid-playback expiry.
  useEffect(() => {
    if (source !== "audio" || !currentTrack?.audioUrl || !currentTrack.episodeId) return;

    // Track when URL was obtained
    if (!urlObtainedAtRef.current.has(currentTrack.id)) {
      urlObtainedAtRef.current.set(currentTrack.id, Date.now());
    }

    const interval = setInterval(async () => {
      const obtainedAt = urlObtainedAtRef.current.get(currentTrack.id) || 0;
      const age = Date.now() - obtainedAt;
      // Refresh if URL is older than 50 minutes (3_000_000 ms)
      if (age < 3_000_000) return;

      const freshUrl = await refreshSignedUrl(currentTrack);
      if (freshUrl && currentTrackRef.current?.id === currentTrack.id) {
        const audio = audioRef.current;
        const wasPlaying = audio && !audio.paused;
        const pos = audio?.currentTime || 0;

        setCurrentTrack((prev) => prev ? { ...prev, audioUrl: freshUrl } : prev);
        urlObtainedAtRef.current.set(currentTrack.id, Date.now());

        // Only swap the active src if audio element is using the old URL
        if (audio && sourceRef.current === "audio") {
          audio.src = freshUrl;
          audio.currentTime = pos;
          if (wasPlaying) {
            audio.play().catch(() => {});
          }
        }
      }
    }, 60_000); // Check every minute

    return () => clearInterval(interval);
  }, [source, currentTrack?.id, currentTrack?.audioUrl, currentTrack?.episodeId]);

  const stopAudio = useCallback(() => {
    const audio = audioRef.current;
    if (audio) {
      audio.pause();
      audio.currentTime = 0;
      audio.src = "";
    }
  }, []);

  const stopSpotify = useCallback(async () => {
    try {
      await spotify.pause();
    } catch {}
  }, [spotify]);

  const updateRepeatState = useCallback((trackId: string | null) => {
    repeatTrackIdRef.current = trackId;
    setRepeatTrackId(trackId);
  }, []);

  const clearRepeatForDifferentTrack = useCallback((track: PlayerTrack | null) => {
    const retainedRepeatId = repeatIdForLoadedTrack(
      repeatTrackIdRef.current,
      canonicalPlayerTrackId(track),
    );
    if (retainedRepeatId === repeatTrackIdRef.current) return;

    updateRepeatState(null);
    if (audioRef.current) audioRef.current.loop = false;
    if (sourceRef.current === "spotify") {
      spotify.setRepeat("off").catch(() => {});
    }
  }, [spotify, updateRepeatState]);

  const toggleRepeatTrack = useCallback((canonicalTrackId: string) => {
    const previousRepeatId = repeatTrackIdRef.current;
    const toggle = toggleRepeatIdForCurrentTrack(
      canonicalTrackId,
      canonicalPlayerTrackId(currentTrackRef.current),
      previousRepeatId,
    );
    if (!toggle.accepted) return;
    const nextRepeatId = toggle.repeatTrackId;
    updateRepeatState(nextRepeatId);

    if (sourceRef.current === "spotify") {
      spotify.setRepeat(nextRepeatId ? "track" : "off").catch(() => {
        if (
          canonicalPlayerTrackId(currentTrackRef.current) === canonicalTrackId
          && repeatTrackIdRef.current === nextRepeatId
        ) {
          updateRepeatState(previousRepeatId);
        }
      });
      return;
    }

    if (audioRef.current) audioRef.current.loop = nextRepeatId !== null;
  }, [spotify, updateRepeatState]);

  const setQueue = useCallback((newQueue: PlayerTrack[], startIndex?: number) => {
    // Ordinary queues end any dedicated episode session without changing their behavior.
    episodeSessionRef.current = null;
    setEpisodeSession(null);
    lastScheduledEpisodePositionRef.current = null;
    queueRef.current = newQueue;
    setQueueState(newQueue);
    if (startIndex !== undefined) {
      currentIndexRef.current = startIndex;
      setCurrentIndex(startIndex);
    } else {
      // Preserve current track position in updated queue
      const currentId = currentTrackRef.current?.id;
      const newIdx = currentId
        ? newQueue.findIndex(t => t.id === currentId)
        : (newQueue.length > 0 ? 0 : -1);
      currentIndexRef.current = newIdx;
      setCurrentIndex(newIdx);
    }
  }, []);

  const setEpisodeQueue = useCallback((
    newQueue: PlayerTrack[],
    session: EpisodePlaybackSession,
    startIndex = 0,
  ) => {
    queueRef.current = newQueue;
    setQueueState(newQueue);
    currentIndexRef.current = startIndex;
    setCurrentIndex(startIndex);
    episodeSessionRef.current = session;
    setEpisodeSession(session);
    lastScheduledEpisodePositionRef.current = session.preparedPosition ?? null;
    lastEpisodeEndedCountRef.current = trackEndedCount;
    episodePrepareChainRef.current = Promise.resolve();
  }, [trackEndedCount]);

  // Keep lookahead and the durable session position moving with each source
  // appearance. Serialization prevents rapid unavailable-track skips from
  // writing an older position after a newer one.
  useEffect(() => {
    if (!episodeSession) return;
    const position = nextEpisodePositionToPrepare(
      queueRef.current,
      currentIndex,
      lastScheduledEpisodePositionRef.current,
    );
    if (position === null) return;
    lastScheduledEpisodePositionRef.current = position;
    const scheduledSession = episodeSession;
    episodePrepareChainRef.current = episodePrepareChainRef.current
      .catch(() => {})
      .then(async () => {
        if (episodeSessionRef.current?.sessionId !== scheduledSession.sessionId) return;
        await fetch(`/api/episodes/${scheduledSession.episodeId}/prepare`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ session_id: scheduledSession.sessionId, current_position: position }),
        });
      })
      .catch(() => {});
  }, [currentIndex, episodeSession]);

  const updateTrackVote = useCallback((trackId: string, status: string, superLiked?: boolean) => {
    const updater = (list: PlayerTrack[]) =>
      list.map((t) =>
        t.id === trackId || t.catalogTrackId === trackId
          ? {
              ...t,
              vote_status: status as PlayerTrack["vote_status"],
              status,
              super_liked: superLiked ?? (status === "approved" ? t.super_liked : false),
              voted_at: new Date().toISOString(),
            }
          : t
      );
    queueRef.current = updater(queueRef.current);
    setQueueState(updater);
    // Also update currentTrack if it matches
    if (currentTrackRef.current?.id === trackId || currentTrackRef.current?.catalogTrackId === trackId) {
      setCurrentTrack((prev) =>
        prev
          ? {
              ...prev,
              vote_status: status as PlayerTrack["vote_status"],
              status,
              super_liked: superLiked ?? (status === "approved" ? prev.super_liked : false),
              voted_at: new Date().toISOString(),
            }
          : prev
      );
    }
  }, []);

  const setTrackSeeded = useCallback((trackId: string, seeded: boolean, seedId?: string | null) => {
    const patchSeedState = (track: PlayerTrack): PlayerTrack => seeded
      ? { ...track, seed_id: seedId || track.seed_id || track.id, is_re_seed: true }
      : { ...track, seed_id: null, is_re_seed: false };
    const updater = (list: PlayerTrack[]) =>
      list.map((track) => track.id === trackId || track.catalogTrackId === trackId
        ? patchSeedState(track)
        : track);
    queueRef.current = updater(queueRef.current);
    setQueueState(updater);
    if (currentTrackRef.current?.id === trackId || currentTrackRef.current?.catalogTrackId === trackId) {
      setCurrentTrack((track) => track ? patchSeedState(track) : track);
    }
  }, []);

  const markTrackSeeded = useCallback((trackId: string, seedId?: string | null) => {
    setTrackSeeded(trackId, true, seedId);
  }, [setTrackSeeded]);

  const appendToQueue = useCallback((tracks: PlayerTrack[]) => {
    const existingIds = new Set(queueRef.current.map((t) => t.id));
    const fresh = tracks.filter((t) => !existingIds.has(t.id));
    if (fresh.length === 0) return;
    const updated = [...queueRef.current, ...fresh];
    queueRef.current = updated;
    setQueueState(updated);
  }, []);

  const replaceAudioUrl = useCallback((trackId: string, newUrl: string) => {
    // Update the track in the queue
    const updater = (list: PlayerTrack[]) =>
      list.map((t) => (t.id === trackId || t.catalogTrackId === trackId ? { ...t, audioUrl: newUrl } : t));
    queueRef.current = updater(queueRef.current);
    setQueueState(updater);

    // Update currentTrack if it matches
    if (currentTrackRef.current?.id === trackId || currentTrackRef.current?.catalogTrackId === trackId) {
      setCurrentTrack((prev) => (prev ? { ...prev, audioUrl: newUrl } : prev));
      urlObtainedAtRef.current.set(trackId, Date.now());

      // Reload the Audio element with the new URL (don't auto-play)
      if (sourceRef.current === "audio") {
        const audio = audioRef.current;
        if (audio) {
          audio.pause();
          audio.src = newUrl;
          audio.load();
          setPlaying(false);
          setProgress(0);
          setDuration(0);
          setBuffering(false);
          setNoSource(false);
        }
      } else {
        // Track was on spotify or had no source — switch to audio source
        setSource("audio");
        setNoSource(false);
        const audio = audioRef.current;
        if (audio) {
          audio.src = newUrl;
          audio.load();
          setPlaying(false);
          setProgress(0);
          setDuration(0);
          setBuffering(false);
        }
      }
    }
  }, []);

  const loadTrack = useCallback((track: PlayerTrack, origin?: string) => {
    startPlaybackAccountingSession(track);
    clearRepeatForDifferentTrack(track);
    // Stop whatever is currently playing
    stopAudio();
    stopSpotify();
    spotifyTrackStartedRef.current = false;

    rememberCurrentTrack(track.id);
    currentTrackRef.current = track;
    setCurrentTrack(track);
    setProgress(0);
    setDuration(0);
    setPlaying(false);
    setLoading(false);
    setBuffering(false);
    setTrackStartedAt(null);
    if (origin !== undefined) setPlaybackOrigin(origin);

    // Sync queue index
    const queueIdx = queueRef.current.findIndex(t => t.id === track.id);
    if (queueIdx >= 0) {
      currentIndexRef.current = queueIdx;
      setCurrentIndex(queueIdx);
    }

    // Determine source but don't start playback — prefer downloaded audio over Spotify
    if (track.audioUrl) {
      setSource("audio");
      setNoSource(false);
      urlObtainedAtRef.current.set(track.id, Date.now());
      // Check if we have this track preloaded
      const audio = audioRef.current;
      if (audio) {
        if (preloadedTrackIdRef.current === track.id && preloadAudioRef.current) {
          // Use preloaded data — swap src
          audio.src = preloadAudioRef.current.src;
        } else {
          audio.src = track.audioUrl;
        }
      }
    } else if (spotify.connected && spotify.deviceId && track.spotifyUrl) {
      setSource("spotify");
      setNoSource(false);
    } else {
      setSource(null);
      setNoSource(true);
    }
  }, [clearRepeatForDifferentTrack, spotify, startPlaybackAccountingSession, stopAudio, stopSpotify, rememberCurrentTrack]);

  const play = useCallback((track: PlayerTrack, origin?: string) => {
    startPlaybackAccountingSession(track);
    clearRepeatForDifferentTrack(track);
    // Serialize a Spotify-to-Spotify track change so a late pause request cannot
    // land after the new URI starts.
    stopAudio();
    const spotifyGeneration = ++spotifyPlayGenerationRef.current;
    spotifyCommandChainRef.current = spotifyCommandChainRef.current
      .catch(() => {})
      .then(() => stopSpotify());
    spotifyTrackStartedRef.current = false;

    rememberCurrentTrack(track.id);
    currentTrackRef.current = track;
    setCurrentTrack(track);
    setProgress(0);
    setDuration(0);
    setNoSource(false);
    setLoading(true);
    setBuffering(false);
    setTrackStartedAt(Date.now());
    // Always update playbackOrigin when play() is called — use provided origin or
    // fall back to the current page URL so the now-playing button always returns
    // to the correct context.
    const newOrigin = origin !== undefined
      ? origin
      : (typeof window !== "undefined" ? window.location.pathname + window.location.search : "/");
    setPlaybackOrigin(newOrigin);

    // Sync queue index
    const queueIdx = queueRef.current.findIndex(t => t.id === track.id);
    if (queueIdx >= 0) {
      currentIndexRef.current = queueIdx;
      setCurrentIndex(queueIdx);
    }

    // Decide source: prefer downloaded audio over Spotify
    if (track.audioUrl) {
      setSource("audio");
      urlObtainedAtRef.current.set(track.id, Date.now());
      const audio = audioRef.current;
      if (audio) {
        // Use preloaded audio if available
        if (preloadedTrackIdRef.current === track.id && preloadAudioRef.current) {
          audio.src = preloadAudioRef.current.src;
        } else {
          audio.src = track.audioUrl;
        }
        audio.play().catch(() => setLoading(false));
      }
    } else if (track.audioRefreshUrl) {
      // Queue entries may intentionally carry only an authenticated refresh URL.
      // Resolve it lazily so next/previous and auto-advance work without eagerly
      // generating signed URLs for the whole session.
      setSource("audio");
      refreshSignedUrl(track).then((freshUrl) => {
        if (!freshUrl || currentTrackRef.current?.id !== track.id) {
          if (currentTrackRef.current?.id === track.id) {
            setLoading(false);
            setNoSource(true);
          }
          return;
        }
        replaceAudioUrl(track.id, freshUrl);
        urlObtainedAtRef.current.set(track.id, Date.now());
        const audio = audioRef.current;
        if (!audio) {
          setLoading(false);
          setNoSource(true);
          return;
        }
        audio.src = freshUrl;
        audio.play().catch(() => {
          setLoading(false);
          setNoSource(true);
        });
      });
    } else if (spotify.connected && spotify.deviceId && track.spotifyUrl) {
      setSource("spotify");
      spotifyCommandChainRef.current = spotifyCommandChainRef.current
        .then(async () => {
          if (spotifyPlayGenerationRef.current !== spotifyGeneration) return;
          await spotify.playUri(track.spotifyUrl!);
          if (spotifyPlayGenerationRef.current !== spotifyGeneration) return;
          spotifyTrackStartedRef.current = true;
        })
        .catch(() => {
          if (spotifyPlayGenerationRef.current !== spotifyGeneration) return;
          spotifyTrackStartedRef.current = false;
          setLoading(false);
          setNoSource(true);
        });
    } else {
      setLoading(false);
      setNoSource(true);
    }
  }, [clearRepeatForDifferentTrack, spotify, startPlaybackAccountingSession, stopAudio, stopSpotify, replaceAudioUrl, rememberCurrentTrack]);

  const playFromQueue = useCallback((index: number, origin?: string) => {
    const track = queueRef.current[index];
    if (!track) return;
    currentIndexRef.current = index;
    setCurrentIndex(index);
    play(track, origin);
  }, [play]);

  const next = useCallback(() => {
    const queueIndex = validatedQueueIndex(
      queueRef.current,
      currentIndexRef.current,
      currentTrackRef.current?.id,
    );
    const nextIdx = queueIndex + 1;
    if (nextIdx >= queueRef.current.length) return false;
    playFromQueue(nextIdx);
    return true;
  }, [playFromQueue]);

  const prev = useCallback(() => {
    const queueIndex = validatedQueueIndex(
      queueRef.current,
      currentIndexRef.current,
      currentTrackRef.current?.id,
    );
    const prevIdx = queueIndex - 1;
    if (prevIdx < 0) return false;
    playFromQueue(prevIdx);
    return true;
  }, [playFromQueue]);

  // Ordinary queue pages retain their existing end handling. Dedicated episode
  // sessions advance here so playback survives navigation away from the mix page
  // and can skip unresolved/unavailable appearances without dropping them.
  useEffect(() => {
    if (!episodeSession) return;
    if (trackEndedCount === lastEpisodeEndedCountRef.current) return;
    lastEpisodeEndedCountRef.current = trackEndedCount;
    next();
  }, [episodeSession, next, trackEndedCount]);

  const togglePlayPause = useCallback(() => {
    if (!currentTrack) return;
    if (noSource) return;

    if (source === "audio") {
      const audio = audioRef.current;
      if (!audio) return;
      if (audio.paused) {
        // If we have a src loaded but never played, start it
        if (audio.src) {
          setBuffering(false);
          audio.play().catch(() => {});
        } else if (currentTrack.audioUrl) {
          audio.src = currentTrack.audioUrl;
          audio.play().catch(() => {});
        }
      } else {
        audio.pause();
        setBuffering(false);
      }
    } else if (source === "spotify") {
      if (playing) {
        spotify.pause();
      } else {
        if (spotifyPlayCommand(spotifyTrackStartedRef.current) === "start" && currentTrack.spotifyUrl) {
          setLoading(true);
          spotify.playUri(currentTrack.spotifyUrl)
            .then(() => { spotifyTrackStartedRef.current = true; })
            .catch(() => setLoading(false));
        } else {
          spotify.resume();
        }
      }
    } else if (currentTrack) {
      // Source not set yet — treat like first play
      play(currentTrack);
    }
  }, [source, playing, spotify, currentTrack, play, noSource]);

  const seek = useCallback((seconds: number) => {
    if (source === "audio") {
      const audio = audioRef.current;
      if (!audio) return;
      audio.currentTime = Math.max(0, Math.min(audio.duration || 0, seconds));
      lastPlaybackPositionRef.current = audio.currentTime;
      setProgress(audio.currentTime);
      // Reset stall detection after seek
      lastProgressTimeRef.current = audio.currentTime;
      lastProgressCheckRef.current = Date.now();
    } else if (source === "spotify") {
      spotify.seek(seconds * 1000);
      lastPlaybackPositionRef.current = seconds;
      setProgress(seconds);
    }
  }, [source, spotify]);

  // Whether both sources are available for the current track
  const canSwitchSource = !!(
    currentTrack?.audioUrl &&
    currentTrack?.spotifyUrl &&
    spotify.connected &&
    spotify.deviceId
  );

  const switchSource = useCallback((to: "audio" | "spotify") => {
    if (!currentTrack || source === to) return;
    const wasPlaying = playing;
    lastPlaybackPositionRef.current = null;

    if (to === "audio" && currentTrack.audioUrl) {
      spotifyTrackStartedRef.current = false;
      if (repeatTrackIdRef.current) spotify.setRepeat("off").catch(() => {});
      stopSpotify();
      setSource("audio");
      setProgress(0);
      setDuration(0);
      setBuffering(false);
      const audio = audioRef.current;
      if (audio) {
        audio.src = currentTrack.audioUrl;
        if (wasPlaying) {
          setLoading(true);
          audio.play().catch(() => setLoading(false));
        }
      }
    } else if (to === "spotify" && currentTrack.spotifyUrl && spotify.connected && spotify.deviceId) {
      stopAudio();
      setSource("spotify");
      setProgress(0);
      setDuration(0);
      setBuffering(false);
      spotifyTrackStartedRef.current = false;
      spotify.setRepeat(repeatTrackIdRef.current ? "track" : "off").catch(() => {});
      if (wasPlaying) {
        setLoading(true);
        spotify.playUri(currentTrack.spotifyUrl)
          .then(() => { spotifyTrackStartedRef.current = true; })
          .catch(() => setLoading(false));
      }
    }
  }, [currentTrack, source, playing, spotify, stopAudio, stopSpotify]);

  const stop = useCallback(() => {
    startPlaybackAccountingSession(null);
    clearRepeatForDifferentTrack(null);
    stopAudio();
    stopSpotify();
    spotifyTrackStartedRef.current = false;
    setCurrentTrack(null);
    setPlaying(false);
    setLoading(false);
    setBuffering(false);
    setProgress(0);
    setDuration(0);
    setSource(null);
    setNoSource(false);
    setPlaybackOrigin(null);
    setTrackStartedAt(null);
    setConnectionQuality("good");
    episodeSessionRef.current = null;
    setEpisodeSession(null);
    lastScheduledEpisodePositionRef.current = null;
    // Clear queue
    queueRef.current = [];
    setQueueState([]);
    currentIndexRef.current = 0;
    setCurrentIndex(0);
    // Clean up preload
    if (preloadAudioRef.current) {
      preloadAudioRef.current.src = "";
      preloadAudioRef.current = null;
      preloadedTrackIdRef.current = null;
    }
  }, [clearRepeatForDifferentTrack, startPlaybackAccountingSession, stopAudio, stopSpotify]);

  /** Preload a track's audio in the background for instant transitions */
  const preloadTrack = useCallback((track: PlayerTrack) => {
    if (!track.audioUrl) return;
    if (preloadedTrackIdRef.current === track.id) return; // Already preloading this one

    // Clean up previous preload
    if (preloadAudioRef.current) {
      preloadAudioRef.current.src = "";
    }

    const preloadEl = new Audio();
    preloadEl.preload = "auto";
    preloadEl.src = track.audioUrl;
    preloadEl.load();
    preloadAudioRef.current = preloadEl;
    preloadedTrackIdRef.current = track.id;
    urlObtainedAtRef.current.set(track.id, Date.now());
  }, []);

  // ── Auto-preload next track at 75% completion ──
  // This is triggered from the page level via the preloadTrack function
  // (the provider doesn't know about the queue, so the page calls preloadTrack)

  // Publish current-track details to lock-screen/control-center surfaces.
  useEffect(() => {
    if (!("mediaSession" in navigator)) return;
    try {
      navigator.mediaSession.metadata = currentTrack && "MediaMetadata" in window
        ? new MediaMetadata({
            title: currentTrack.title,
            artist: currentTrack.artist,
            album: currentTrack.episodeTitle ?? currentTrack.source_context ?? "The Stacks",
            artwork: currentTrack.coverArtUrl ? [{ src: currentTrack.coverArtUrl }] : [],
          })
        : null;
    } catch {
      // Safari may expose a partial Media Session implementation.
    }
  }, [currentTrack]);

  // Install each action independently: Safari throws for handlers it exposes
  // but does not implement, while Chromium accepts the full action set.
  useEffect(() => {
    if (!("mediaSession" in navigator)) return;
    const mediaSession = navigator.mediaSession;
    const handlers: Array<[MediaSessionAction, MediaSessionActionHandler]> = [
      ["play", () => { if (!playingRef.current) togglePlayPause(); }],
      ["pause", () => { if (playingRef.current) togglePlayPause(); }],
      ["previoustrack", () => { prev(); }],
      ["nexttrack", () => { next(); }],
      ["seekbackward", (details) => {
        const target = mediaSessionSeekTarget(
          "seekbackward",
          progressRef.current,
          durationRef.current,
          details,
        );
        if (target !== null) seek(target);
      }],
      ["seekforward", (details) => {
        const target = mediaSessionSeekTarget(
          "seekforward",
          progressRef.current,
          durationRef.current,
          details,
        );
        if (target !== null) seek(target);
      }],
      ["seekto", (details) => {
        const target = mediaSessionSeekTarget(
          "seekto",
          progressRef.current,
          durationRef.current,
          details,
        );
        if (target !== null) seek(target);
      }],
      ["stop", () => { stop(); }],
    ];

    for (const [action, handler] of handlers) {
      try { mediaSession.setActionHandler(action, handler); } catch {}
    }
    return () => {
      for (const [action] of handlers) {
        try { mediaSession.setActionHandler(action, null); } catch {}
      }
    };
  }, [next, prev, seek, stop, togglePlayPause]);

  useEffect(() => {
    if (!("mediaSession" in navigator)) return;
    try {
      navigator.mediaSession.playbackState = currentTrack
        ? (playing ? "playing" : "paused")
        : "none";
    } catch {}
  }, [currentTrack, playing]);

  useEffect(() => {
    if (!("mediaSession" in navigator) || !("setPositionState" in navigator.mediaSession)) return;
    const positionState = mediaSessionPositionState(progress, duration);
    try {
      if (positionState) navigator.mediaSession.setPositionState(positionState);
      else navigator.mediaSession.setPositionState();
    } catch {}
  }, [duration, progress]);

  // Global spacebar → play/pause (works on every page, not just the stack page)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== " ") return;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || tag === "BUTTON") return;
      if (!currentTrackRef.current) return;
      e.preventDefault();
      togglePlayPause();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [togglePlayPause]);

  return (
    <GlobalPlayerContext.Provider
      value={{
        currentTrack,
        playing,
        loading,
        buffering,
        progress,
        duration,
        source,
        noSource,
        trackEndedCount,
        canSwitchSource,
        playbackOrigin,
        trackStartedAt,
        connectionQuality,
        toast,
        repeatTrackId,
        loadTrack,
        play,
        togglePlayPause,
        toggleRepeatTrack,
        seek,
        stop,
        switchSource,
        preloadTrack,
        queue,
        history,
        clearHistory,
        currentIndex,
        setQueue,
        setEpisodeQueue,
        playFromQueue,
        next,
        prev,
        updateTrackVote,
        setTrackSeeded,
        markTrackSeeded,
        appendToQueue,
        replaceAudioUrl,
      }}
    >
      {children}
    </GlobalPlayerContext.Provider>
  );
}
