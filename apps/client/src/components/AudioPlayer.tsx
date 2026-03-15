"use client";

import { useRef, useState, useEffect, useCallback, forwardRef, useImperativeHandle } from "react";

export interface AudioPlayerHandle {
  toggle: () => Promise<void>;
  playing: boolean;
  loading: boolean;
}

interface AudioPlayerProps {
  src: string | null;
  compact?: boolean;
  autoPlay?: boolean;
  /** Hide the inline play button (when parent renders its own overlay) */
  externalPlayButton?: boolean;
  /** Called whenever playing/loading state changes */
  onStateChange?: (state: { playing: boolean; loading: boolean }) => void;
}

export const AudioPlayer = forwardRef<AudioPlayerHandle, AudioPlayerProps>(
  function AudioPlayer({ src, compact = false, autoPlay = false, externalPlayButton = false, onStateChange }, ref) {
    const audioRef = useRef<HTMLAudioElement>(null);
    const progressRef = useRef<HTMLDivElement>(null);
    const autoPlayedRef = useRef<string | null>(null);

    const [playing, setPlaying] = useState(false);
    const [loading, setLoading] = useState(false);
    const [progress, setProgress] = useState(0);
    const [duration, setDuration] = useState(0);
    const [dragging, setDragging] = useState(false);

    // Notify parent of state changes
    const stateRef = useRef({ playing: false, loading: false });
    const notifyParent = useCallback((p: boolean, l: boolean) => {
      if (stateRef.current.playing !== p || stateRef.current.loading !== l) {
        stateRef.current = { playing: p, loading: l };
        onStateChange?.({ playing: p, loading: l });
      }
    }, [onStateChange]);

    // Reset on src change
    useEffect(() => {
      setProgress(0);
      setDuration(0);
      setPlaying(false);
      setLoading(false);
      notifyParent(false, false);

      const audio = audioRef.current;
      if (!audio) return;

      audio.pause();
      audio.currentTime = 0;

      if (autoPlay && src && autoPlayedRef.current !== src) {
        autoPlayedRef.current = src;
        setLoading(true);
        notifyParent(false, true);
        audio.play().catch(() => {
          setLoading(false);
          notifyParent(false, false);
        });
      }
    }, [src, autoPlay, notifyParent]);

    const toggle = useCallback(async () => {
      const audio = audioRef.current;
      if (!audio) return;
      if (audio.paused) {
        setLoading(true);
        notifyParent(playing, true);
        try {
          await audio.play();
        } catch {
          setLoading(false);
          notifyParent(playing, false);
        }
      } else {
        audio.pause();
      }
    }, [playing, notifyParent]);

    // Expose handle to parent
    useImperativeHandle(ref, () => ({
      toggle,
      get playing() { return stateRef.current.playing; },
      get loading() { return stateRef.current.loading; },
    }), [toggle]);

    // Audio element events — single source of truth
    const onPlay = useCallback(() => { setPlaying(true); notifyParent(true, stateRef.current.loading); }, [notifyParent]);
    const onPause = useCallback(() => { setPlaying(false); notifyParent(false, stateRef.current.loading); }, [notifyParent]);
    const onEnded = useCallback(() => { setPlaying(false); notifyParent(false, false); }, [notifyParent]);
    const onWaiting = useCallback(() => { setLoading(true); notifyParent(stateRef.current.playing, true); }, [notifyParent]);
    const onPlaying = useCallback(() => { setLoading(false); notifyParent(stateRef.current.playing, false); }, [notifyParent]);
    const onCanPlay = useCallback(() => { setLoading(false); notifyParent(stateRef.current.playing, false); }, [notifyParent]);

    if (!src) return null;

    // YouTube links: show as external link
    if (src.includes("youtube.com") || src.includes("youtu.be")) {
      return (
        <a
          href={src}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-2 px-4 py-2.5 bg-surface-2 hover:bg-surface-3 rounded-lg text-sm text-accent transition-colors"
        >
          <span className="text-lg">▶</span>
          <span>Play on YouTube</span>
        </a>
      );
    }

    const skip = (seconds: number) => {
      if (!audioRef.current) return;
      audioRef.current.currentTime = Math.max(
        0,
        Math.min(audioRef.current.duration || 0, audioRef.current.currentTime + seconds)
      );
    };

    const handleTimeUpdate = () => {
      if (!audioRef.current || dragging) return;
      setProgress(audioRef.current.currentTime);
    };

    const handleLoadedMetadata = () => {
      if (!audioRef.current) return;
      setDuration(audioRef.current.duration);
    };

    const seekTo = (clientX: number) => {
      if (!audioRef.current || !duration || !progressRef.current) return;
      const rect = progressRef.current.getBoundingClientRect();
      const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      const time = pct * duration;
      audioRef.current.currentTime = time;
      setProgress(time);
    };

    const handleSeekStart = (e: React.MouseEvent<HTMLDivElement>) => {
      setDragging(true);
      seekTo(e.clientX);
      const handleMove = (ev: MouseEvent) => seekTo(ev.clientX);
      const handleUp = () => {
        setDragging(false);
        window.removeEventListener("mousemove", handleMove);
        window.removeEventListener("mouseup", handleUp);
      };
      window.addEventListener("mousemove", handleMove);
      window.addEventListener("mouseup", handleUp);
    };

    const handleTouchSeek = (e: React.TouchEvent<HTMLDivElement>) => {
      setDragging(true);
      seekTo(e.touches[0].clientX);
      const handleMove = (ev: TouchEvent) => {
        ev.preventDefault();
        seekTo(ev.touches[0].clientX);
      };
      const handleEnd = () => {
        setDragging(false);
        window.removeEventListener("touchmove", handleMove);
        window.removeEventListener("touchend", handleEnd);
      };
      window.addEventListener("touchmove", handleMove, { passive: false });
      window.addEventListener("touchend", handleEnd);
    };

    const fmt = (s: number) => {
      const m = Math.floor(s / 60);
      const sec = Math.floor(s % 60);
      return `${m}:${sec.toString().padStart(2, "0")}`;
    };

    const pct = duration ? (progress / duration) * 100 : 0;

    const playIcon = loading ? (
      <svg className="animate-spin" width={compact ? 12 : 20} height={compact ? 12 : 20} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
        <path d="M12 2a10 10 0 0 1 10 10" strokeLinecap="round" />
      </svg>
    ) : playing ? (
      <svg width={compact ? 12 : 20} height={compact ? 12 : 20} viewBox="0 0 24 24" fill="currentColor">
        <rect x="6" y="4" width="4" height="16" rx="1" />
        <rect x="14" y="4" width="4" height="16" rx="1" />
      </svg>
    ) : (
      <svg width={compact ? 12 : 20} height={compact ? 12 : 20} viewBox="0 0 24 24" fill="currentColor">
        <path d="M8 5v14l11-7z" />
      </svg>
    );

    const audioEl = (
      <audio
        ref={audioRef}
        src={src}
        onTimeUpdate={handleTimeUpdate}
        onLoadedMetadata={handleLoadedMetadata}
        onPlay={onPlay}
        onPause={onPause}
        onEnded={onEnded}
        onWaiting={onWaiting}
        onPlaying={onPlaying}
        onCanPlay={onCanPlay}
        preload="metadata"
      />
    );

    if (compact) {
      return (
        <div className="w-full bg-surface-2 rounded-lg p-2 flex items-center gap-2">
          {audioEl}
          {!externalPlayButton && (
            <button
              onClick={toggle}
              disabled={loading}
              className="w-8 h-8 flex-shrink-0 flex items-center justify-center rounded-full bg-accent text-surface-0 hover:bg-accent-bright transition-all active:scale-95 disabled:opacity-70"
            >
              {playIcon}
            </button>
          )}
          <div
            ref={progressRef}
            className="group relative flex-1 h-1.5 bg-surface-3 rounded-full cursor-pointer touch-none"
            onMouseDown={handleSeekStart}
            onTouchStart={handleTouchSeek}
          >
            <div
              className="absolute inset-y-0 left-0 bg-accent rounded-full transition-[width] duration-75"
              style={{ width: `${pct}%` }}
            />
            <div
              className={`absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-3.5 h-3.5 bg-accent rounded-full shadow-lg shadow-black/50 transition-transform ${
                dragging ? "scale-125" : "scale-100 sm:scale-0 sm:group-hover:scale-100"
              }`}
              style={{ left: `${pct}%` }}
            />
          </div>
          <span className="text-[10px] text-muted font-mono flex-shrink-0 w-8 text-right">
            {duration ? fmt(progress) : loading ? "..." : "--:--"}
          </span>
        </div>
      );
    }

    return (
      <div className="w-full bg-surface-2 rounded-xl p-3 space-y-2.5">
        {audioEl}

        {/* Progress bar */}
        <div
          ref={progressRef}
          className="group relative h-2 bg-surface-3 rounded-full cursor-pointer touch-none"
          onMouseDown={handleSeekStart}
          onTouchStart={handleTouchSeek}
        >
          <div
            className="absolute inset-y-0 left-0 bg-accent rounded-full transition-[width] duration-75"
            style={{ width: `${pct}%` }}
          />
          <div
            className={`absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-4 h-4 bg-accent rounded-full shadow-lg shadow-black/50 transition-transform ${
              dragging ? "scale-125" : "scale-100 sm:scale-0 sm:group-hover:scale-100"
            }`}
            style={{ left: `${pct}%` }}
          />
        </div>

        {/* Time labels */}
        <div className="flex justify-between text-[10px] text-muted font-mono px-0.5">
          <span>{fmt(progress)}</span>
          <span>{duration ? fmt(duration) : loading ? "..." : "--:--"}</span>
        </div>

        {/* Controls */}
        <div className="flex items-center justify-center gap-1">
          <button onClick={() => skip(-15)} className="w-10 h-10 flex items-center justify-center rounded-full text-white/50 hover:text-white hover:bg-surface-3 transition-all active:scale-90" title="Back 15s">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M1 4v6h6" /><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" /><text x="12" y="15.5" textAnchor="middle" fill="currentColor" stroke="none" fontSize="7" fontWeight="700" fontFamily="sans-serif">15</text></svg>
          </button>
          <button onClick={() => skip(-5)} className="w-9 h-9 flex items-center justify-center rounded-full text-white/40 hover:text-white hover:bg-surface-3 transition-all active:scale-90" title="Back 5s">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="11 17 6 12 11 7" /><polyline points="18 17 13 12 18 7" /></svg>
          </button>

          {!externalPlayButton && (
            <button onClick={toggle} disabled={loading} className="w-12 h-12 flex items-center justify-center rounded-full bg-accent text-surface-0 hover:bg-accent-bright transition-all active:scale-95 mx-1 disabled:opacity-70">
              {playIcon}
            </button>
          )}

          <button onClick={() => skip(5)} className="w-9 h-9 flex items-center justify-center rounded-full text-white/40 hover:text-white hover:bg-surface-3 transition-all active:scale-90" title="Forward 5s">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="13 17 18 12 13 7" /><polyline points="6 17 11 12 6 7" /></svg>
          </button>
          <button onClick={() => skip(15)} className="w-10 h-10 flex items-center justify-center rounded-full text-white/50 hover:text-white hover:bg-surface-3 transition-all active:scale-90" title="Forward 15s">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M23 4v6h-6" /><path d="M20.49 15a9 9 0 1 1-2.13-9.36L23 10" /><text x="12" y="15.5" textAnchor="middle" fill="currentColor" stroke="none" fontSize="7" fontWeight="700" fontFamily="sans-serif">15</text></svg>
          </button>
        </div>
      </div>
    );
  }
);
