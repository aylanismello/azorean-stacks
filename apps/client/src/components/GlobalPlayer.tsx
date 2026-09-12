"use client";

import { useRef, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { useGlobalPlayer } from "./GlobalPlayerProvider";
import { openYouTube } from "@/lib/youtube";
import { openSpotify } from "@/lib/spotify-link";
import { canonicalPlayerTrackId } from "@/lib/player-track-identity";
import {
  beginSeekDrag,
  cancelSeekDrag,
  finishSeekDrag,
  moveSeekDrag,
  type SeekDrag,
} from "@/lib/player-seek";

function fmt(s: number): string {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

function generateGradient(artist: string, title: string): string {
  let hash = 0;
  const str = artist + title;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  const h1 = Math.abs(hash % 360);
  return `hsl(${h1}, 40%, 20%)`;
}

/** Connection quality icon — phone-only in the player chrome. */
function ConnectionIcon({ quality }: { quality: "good" | "recovering" | "stalled" }) {
  const color = quality === "good" ? "#22c55e" : quality === "recovering" ? "#eab308" : "#ef4444";
  const label = quality === "good" ? "Connection stable" : quality === "recovering" ? "Recovering from stall" : "Connection stalled";
  return (
    <span className="flex flex-shrink-0 items-center justify-center" aria-label={label} title={label}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M1 1l22 22" opacity={quality === "stalled" ? 1 : 0} />
        <path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55" opacity={quality === "good" ? 1 : 0.25} />
        <path d="M5 12.55a10.94 10.94 0 0 1 5.17-2.39" opacity={quality === "good" ? 1 : 0.25} />
        <path d="M10.71 5.05A16 16 0 0 1 22.56 9" opacity={quality === "good" ? 1 : 0.2} />
        <path d="M1.42 9a15.91 15.91 0 0 1 4.7-2.88" opacity={quality === "good" ? 1 : 0.2} />
        <path d="M8.53 16.11a6 6 0 0 1 6.95 0" opacity={quality !== "stalled" ? 1 : 0.3} />
        <line x1="12" y1="20" x2="12.01" y2="20" />
      </svg>
    </span>
  );
}

export function GlobalPlayer() {
  const {
    currentTrack,
    playing,
    loading,
    buffering,
    progress,
    duration,
    source,
    noSource,
    togglePlayPause,
    seek,
    stop,
    playbackOrigin,
    connectionQuality,
    toast,
    queue,
    currentIndex,
    prev,
    next,
    repeatTrackId,
    toggleRepeatTrack,
  } = useGlobalPlayer();
  const router = useRouter();
  const progressRef = useRef<HTMLDivElement>(null);
  const seekDragRef = useRef<SeekDrag | null>(null);
  const [previewPosition, setPreviewPosition] = useState<number | null>(null);

  const displayedProgress = previewPosition ?? progress;
  const pct = duration > 0 ? (displayedProgress / duration) * 100 : 0;
  const dragging = previewPosition !== null;
  const isCurrentQueueTrack = queue[currentIndex]?.id === currentTrack?.id;
  const canGoPrevious = isCurrentQueueTrack && currentIndex > 0;
  const canGoNext = (currentIndex === -1 && queue.length > 0)
    || (isCurrentQueueTrack && currentIndex < queue.length - 1);
  const canonicalTrackId = canonicalPlayerTrackId(currentTrack);
  const isRepeating = canonicalTrackId !== null && repeatTrackId === canonicalTrackId;

  const seekGeometry = useCallback(() => {
    if (!progressRef.current) return null;
    const rect = progressRef.current.getBoundingClientRect();
    return { left: rect.left, width: rect.width };
  }, []);

  const handleSeekStart = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const geometry = seekGeometry();
    if (!geometry) return;
    const drag = beginSeekDrag(event.pointerId, event.clientX, geometry, duration);
    if (!drag) return;

    event.preventDefault();
    seekDragRef.current = drag;
    setPreviewPosition(drag.position);
    event.currentTarget.setPointerCapture(event.pointerId);
  }, [duration, seekGeometry]);

  const handleSeekMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const geometry = seekGeometry();
    if (!geometry) return;
    const drag = moveSeekDrag(
      seekDragRef.current,
      event.pointerId,
      event.clientX,
      geometry,
      duration,
    );
    if (drag === seekDragRef.current) return;

    event.preventDefault();
    seekDragRef.current = drag;
    setPreviewPosition(drag?.position ?? null);
  }, [duration, seekGeometry]);

  const finishDrag = useCallback((pointerId: number) => {
    const result = finishSeekDrag(seekDragRef.current, pointerId);
    if (result.commit === null) return;

    seekDragRef.current = result.drag;
    setPreviewPosition(null);
    seek(result.commit);
  }, [seek]);

  const handleSeekFinish = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (seekDragRef.current?.pointerId !== event.pointerId) return;
    event.preventDefault();
    finishDrag(event.pointerId);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, [finishDrag]);

  const cancelDrag = useCallback((pointerId: number) => {
    const drag = cancelSeekDrag(seekDragRef.current, pointerId);
    if (drag === seekDragRef.current) return;
    seekDragRef.current = drag;
    setPreviewPosition(null);
  }, []);

  if (!currentTrack) return null;

  const bgColor = currentTrack.coverArtUrl ? undefined : generateGradient(currentTrack.artist, currentTrack.title);
  const showBuffering = loading || buffering;

  return (
    <div className="global-player fixed left-0 right-0 bottom-[calc(3.5rem+env(safe-area-inset-bottom))] z-40 lg:bottom-0">
      {/* Toast notification */}
      {toast && (
        <div className="absolute -top-10 left-1/2 -translate-x-1/2 px-3 py-1.5 rounded-full bg-surface-2 border border-surface-3 text-xs text-foreground/80 shadow-lg backdrop-enter whitespace-nowrap z-50">
          {toast.message}
        </div>
      )}
      {/* Player bar */}
      <div className="global-player-shell border-t border-surface-3 px-3 py-2">
        {/* Progress bar */}
        <div
          ref={progressRef}
          className="group relative z-10 mb-2 flex h-4 cursor-pointer items-center touch-none"
          onPointerDown={handleSeekStart}
          onPointerMove={handleSeekMove}
          onPointerUp={handleSeekFinish}
          onPointerCancel={(event) => cancelDrag(event.pointerId)}
          onLostPointerCapture={(event) => cancelDrag(event.pointerId)}
          role="slider"
          tabIndex={0}
          aria-label="Playback position"
          aria-valuemin={0}
          aria-valuemax={Math.max(0, Math.round(duration))}
          aria-valuenow={Math.max(0, Math.round(displayedProgress))}
          aria-valuetext={`${fmt(displayedProgress)} of ${fmt(duration)}`}
          onKeyDown={(event) => {
            if (event.key === "ArrowLeft" || event.key === "ArrowDown") {
              event.preventDefault();
              seek(progress - 5);
            } else if (event.key === "ArrowRight" || event.key === "ArrowUp") {
              event.preventDefault();
              seek(progress + 5);
            } else if (event.key === "Home") {
              event.preventDefault();
              seek(0);
            } else if (event.key === "End") {
              event.preventDefault();
              seek(duration);
            }
          }}
        >
          <div className="relative h-1.5 w-full overflow-visible rounded-full bg-surface-3/80 transition-all group-hover:bg-surface-3">
            <div
              className={`absolute inset-y-0 left-0 rounded-full bg-accent transition-[width] duration-75 ${buffering ? "animate-pulse" : ""}`}
              style={{ width: `${pct}%` }}
            />
            <div
              className={`absolute top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border border-black/10 bg-accent shadow-lg shadow-black/40 transition-all ${
                dragging ? "scale-125 opacity-100" : "scale-0 group-hover:scale-100 opacity-0 group-hover:opacity-100"
              }`}
              style={{ left: `${pct}%` }}
            />
          </div>
        </div>

        {/* Controls row */}
        <div className="flex items-center gap-1.5 sm:gap-3">
        {/* Album art / gradient — click to return to where playback started */}
        <button
          onClick={() => {
            // Navigate back to the origin URL where the user started playing.
            // Always trust the stored playbackOrigin — it was set when play() was called.
            if (playbackOrigin) {
              router.push(playbackOrigin);
            } else if (currentTrack.episodeId) {
              const params = new URLSearchParams();
              params.set("episode_id", currentTrack.episodeId);
              if (currentTrack.episodeTitle) params.set("episode_title", currentTrack.episodeTitle);
              router.push(`/?${params.toString()}`);
            } else {
              router.push("/");
            }
          }}
          className="h-9 w-9 flex-shrink-0 overflow-hidden rounded-md transition-all hover:ring-1 hover:ring-accent/50 active:scale-95 sm:h-10 sm:w-10"
          style={
            currentTrack.coverArtUrl
              ? { backgroundImage: `url(${currentTrack.coverArtUrl})`, backgroundSize: "cover", backgroundPosition: "center" }
              : { backgroundColor: bgColor }
          }
          title="Go to playing track"
        />

        {/* Track info */}
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-foreground truncate leading-tight">
            {currentTrack.title}
          </p>
          <p className="text-xs text-muted truncate leading-tight">
            {currentTrack.artist}
          </p>
        </div>

        {/* External links: Spotify + YouTube — clickable */}
        {currentTrack.spotifyUrl && (
          <button
            onClick={() => openSpotify(currentTrack.spotifyUrl!)}
            className="hidden h-8 w-8 flex-shrink-0 items-center justify-center rounded-full transition-all hover:bg-surface-3 hover:scale-105 active:scale-95 sm:flex"
            title="Open in Spotify"
            aria-label="Open in Spotify"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="#1DB954">
              <path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z" />
            </svg>
          </button>
        )}
        {currentTrack.youtubeUrl && (
          <button
            onClick={() => openYouTube(currentTrack.youtubeUrl!)}
            className="hidden h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-red-400/80 transition-all hover:bg-surface-3 hover:text-red-400 hover:scale-105 active:scale-95 sm:flex"
            title="Open on YouTube"
            aria-label="Open on YouTube"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/></svg>
          </button>
        )}

        {noSource ? (
          <span className="flex items-center gap-1.5 text-xs text-white/30 flex-shrink-0 px-2">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="opacity-60">
              <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
              <line x1="23" y1="9" x2="17" y2="15" />
              <line x1="17" y1="9" x2="23" y2="15" />
            </svg>
            No audio source
          </span>
        ) : (
          <>
            {/* Time stays on larger screens; connection status is phone-only. */}
            <span className="hidden flex-shrink-0 items-center font-mono text-[11px] text-muted md:flex">
              {duration > 0 ? `${fmt(displayedProgress)} / ${fmt(duration)}` : ""}
            </span>

            {source === "audio" && (
              <span className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-surface-2 sm:hidden">
                <ConnectionIcon quality={connectionQuality} />
              </span>
            )}

            <div className="flex flex-shrink-0 items-center gap-1 sm:gap-2">
            {/* Previous track */}
            <button
              onClick={prev}
              disabled={!canGoPrevious}
              className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-foreground/75 transition-all hover:bg-surface-3 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-muted sm:h-9 sm:w-9"
              title="Previous track"
              aria-label="Previous track"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                <rect x="4" y="5" width="3" height="14" rx="1" />
                <path d="M20 5v14l-11-7z" />
              </svg>
            </button>

            {/* Play/pause — shows spinner when buffering */}
            <button
              onClick={togglePlayPause}
              className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full bg-foreground text-surface-0 transition-transform hover:scale-105 active:scale-95 sm:h-11 sm:w-11"
              title={showBuffering ? "Buffering…" : playing ? "Pause track" : "Play track"}
              aria-label={showBuffering ? "Buffering" : playing ? "Pause track" : "Play track"}
            >
              {showBuffering ? (
                <svg className="animate-spin" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M12 2a10 10 0 0 1 10 10" strokeLinecap="round" />
                </svg>
              ) : playing ? (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                  <rect x="6" y="4" width="4" height="16" rx="1" />
                  <rect x="14" y="4" width="4" height="16" rx="1" />
                </svg>
              ) : (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M8 5v14l11-7z" />
                </svg>
              )}
            </button>

            {/* Next track */}
            <button
              onClick={next}
              disabled={!canGoNext}
              className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-foreground/75 transition-all hover:bg-surface-3 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-muted sm:h-9 sm:w-9"
              title="Next track"
              aria-label="Next track"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                <path d="M4 5v14l11-7z" />
                <rect x="17" y="5" width="3" height="14" rx="1" />
              </svg>
            </button>

            {/* Repeat current track */}
            <button
              onClick={() => {
                if (canonicalTrackId) toggleRepeatTrack(canonicalTrackId);
              }}
              disabled={!canonicalTrackId}
              className={`flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full transition-all disabled:cursor-not-allowed disabled:opacity-30 sm:h-9 sm:w-9 ${
                isRepeating
                  ? "bg-accent/15 text-accent"
                  : "text-muted hover:text-foreground hover:bg-surface-3"
              }`}
              title={isRepeating ? "Turn off repeat track" : "Repeat current track"}
              aria-label={isRepeating ? "Turn off repeat track" : "Repeat current track"}
              aria-pressed={isRepeating}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M17 1l4 4-4 4" />
                <path d="M3 11V9a4 4 0 0 1 4-4h14" />
                <path d="M7 23l-4-4 4-4" />
                <path d="M21 13v2a4 4 0 0 1-4 4H3" />
                <path d="M12 9v6" />
                <path d="M10 11l2-2" />
              </svg>
            </button>
            </div>
          </>
        )}

        {/* Close */}
        <button
          onClick={stop}
          className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-foreground/70 transition-all hover:bg-surface-3 hover:text-foreground sm:h-9 sm:w-9"
          title="Close player"
          aria-label="Close player"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
        </div>
      </div>
    </div>
  );
}
