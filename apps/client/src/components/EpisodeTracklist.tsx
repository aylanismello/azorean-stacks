"use client";

import { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useGlobalPlayer } from "./GlobalPlayerProvider";
import { supabase } from "@/lib/supabase";
import { getSeedBadge } from "@/lib/seed-badge";
import { canonicalPlayerTrackId } from "@/lib/player-track-identity";
import {
  canonicalEpisodeTracklistRowId,
  performEpisodeTracklistAction,
  type EpisodeTracklistAction,
} from "@/lib/episode-tracklist-actions";

interface TrackListItem {
  id: string;
  artist: string;
  title: string;
  status: string;
  spotify_url: string | null;
  youtube_url: string | null;
  cover_art_url: string | null;
  preview_url: string | null;
  audio_url?: string | null;
  storage_path: string | null;
  dl_failed_at?: string | null;
  is_seed?: boolean;
  is_re_seed?: boolean;
  is_artist_seed?: boolean;
  super_liked?: boolean;
  vote_status?: "approved" | "rejected" | "skipped" | "listened" | "pending" | "bad_source" | null;
  appearance_id?: string | null;
  appearanceId?: string | null;
  catalogTrackId?: string | null;
  track?: { id: string } | null;
  // Ranked queue scoring metadata
  _match_type?: "full" | "artist" | "unknown";
  _ranked_score?: number;
  _live_mutation?: boolean;
}

interface BaseTracklistProps {
  listTitle?: string | null;
  onClose?: () => void;
  onTrackSelect?: (trackId: string) => void;
  variant?: "sidebar" | "sheet";
}

interface EpisodeTracklistProps extends BaseTracklistProps {
  episodeId: string;
  episodeTitle?: string | null;
  refreshKey?: number;
  seedId?: string | null;
  directTracks?: never;
}

interface DirectTracklistProps extends BaseTracklistProps {
  directTracks: TrackListItem[];
  episodeId?: never;
  episodeTitle?: never;
  refreshKey?: never;
}

type TracklistProps = EpisodeTracklistProps | DirectTracklistProps;

function safeCoverUrl(url: string | null): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "https:" || parsed.protocol === "http:") return url;
  } catch {}
  return null;
}

export function EpisodeTracklist(props: TracklistProps) {
  const {
    listTitle,
    onClose,
    onTrackSelect,
    variant = "sidebar",
  } = props;

  const isDirectMode = "directTracks" in props && !!props.directTracks;
  const episodeId = isDirectMode ? undefined : (props as EpisodeTracklistProps).episodeId;
  const episodeTitle = isDirectMode ? undefined : (props as EpisodeTracklistProps).episodeTitle;
  const refreshKey = isDirectMode ? 0 : ((props as EpisodeTracklistProps).refreshKey || 0);
  const seedId = isDirectMode ? undefined : (props as EpisodeTracklistProps).seedId;

  const [fetchedTracks, setFetchedTracks] = useState<TrackListItem[]>([]);
  const [loading, setLoading] = useState(!isDirectMode);
  const [error, setError] = useState<string | null>(null);
  const [showUnplayable, setShowUnplayable] = useState(false);
  const [directOverrides, setDirectOverrides] = useState<Record<string, Partial<TrackListItem>>>({});
  const [contextMenu, setContextMenu] = useState<{
    track: TrackListItem;
    canonicalId: string;
    x: number;
    y: number;
  } | null>(null);
  const [contextAction, setContextAction] = useState<EpisodeTracklistAction | null>(null);
  const [contextError, setContextError] = useState<string | null>(null);
  const globalPlayer = useGlobalPlayer();
  const playingRef = useRef<HTMLButtonElement>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const prevEpisodeIdRef = useRef(episodeId);
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);

  // Fetch tracks from API when in episode mode, then subscribe to realtime updates
  useEffect(() => {
    if (isDirectMode || !episodeId) return;

    // Tear down any existing realtime subscription
    if (channelRef.current) {
      supabase.removeChannel(channelRef.current);
      channelRef.current = null;
    }

    const isNewEpisode = prevEpisodeIdRef.current !== episodeId;
    prevEpisodeIdRef.current = episodeId;
    if (isNewEpisode || fetchedTracks.length === 0) {
      setLoading(true);
    }
    setError(null);

    let mounted = true;

    const seedParam = seedId ? `&seed_id=${seedId}` : "";
    fetch(`/api/episodes/${episodeId}/tracks?_t=${Date.now()}${seedParam}`)
      .then((r) => {
        if (!r.ok) throw new Error(`Failed to load tracks (${r.status})`);
        return r.json();
      })
      .then((data) => {
        if (!mounted) return;
        const tracks: TrackListItem[] = Array.isArray(data) ? data : [];
        setFetchedTracks(tracks);

        // Subscribe to realtime updates for these specific tracks
        if (tracks.length > 0) {
          const trackIds = tracks.map((t) => t.id);
          const channel = supabase
            .channel(`tracks-ep-${episodeId}`)
            .on(
              "postgres_changes",
              {
                event: "UPDATE",
                schema: "public",
                table: "tracks",
                filter: `id=in.(${trackIds.join(",")})`,
              },
              (payload) => {
                setFetchedTracks((prev) =>
                  prev.map((t) =>
                    t.id === (payload.new as TrackListItem).id
                      ? { ...t, ...(payload.new as Partial<TrackListItem>) }
                      : t
                  )
                );
              }
            )
            .subscribe();
          channelRef.current = channel;
        }
      })
      .catch((err) => {
        if (!mounted) return;
        setFetchedTracks([]);
        setError(err instanceof Error ? err.message : "Failed to load tracklist");
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });

    return () => {
      mounted = false;
      if (channelRef.current) {
        supabase.removeChannel(channelRef.current);
        channelRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [episodeId, refreshKey, isDirectMode]);

  const canonicalIdForRow = (track: TrackListItem): string | null => {
    const queued = globalPlayer.queue.find((candidate) =>
      candidate.id === track.id || candidate.catalogTrackId === track.id
    );
    return canonicalEpisodeTracklistRowId(track, canonicalPlayerTrackId(queued));
  };

  const rawTracks = isDirectMode ? (props as DirectTracklistProps).directTracks : fetchedTracks;
  const allTracks = isDirectMode
    ? rawTracks.map((track) => ({
        ...track,
        ...(directOverrides[canonicalIdForRow(track) || track.id] || {}),
      }))
    : rawTracks;
  const isPlayable = (t: TrackListItem) => !!(t.storage_path || t.audio_url || t.preview_url || t.spotify_url);
  const playableTracks = allTracks.filter(isPlayable);
  const unplayableTracks = allTracks.filter((t) => !isPlayable(t));
  const tracks = playableTracks;

  // Auto-scroll to playing track when tracklist loads or track changes
  useEffect(() => {
    if (!loading && playingRef.current) {
      playingRef.current.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [loading, globalPlayer.currentTrack?.id]);

  useEffect(() => {
    if (!contextMenu) return;

    const close = () => setContextMenu(null);
    const onPointerDown = (event: PointerEvent) => {
      if (!contextMenuRef.current?.contains(event.target as Node)) close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);

    const frame = requestAnimationFrame(() => {
      const menu = contextMenuRef.current;
      if (!menu) return;
      const rect = menu.getBoundingClientRect();
      const x = Math.max(8, Math.min(contextMenu.x, window.innerWidth - rect.width - 8));
      const y = Math.max(8, Math.min(contextMenu.y, window.innerHeight - rect.height - 8));
      if (x !== contextMenu.x || y !== contextMenu.y) {
        setContextMenu((current) => current ? { ...current, x, y } : null);
      }
      menu.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    });

    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [contextMenu]);

  const handlePlay = (t: TrackListItem) => {
    const audioUrl = t.audio_url || t.preview_url || null;
    const origin = typeof window !== "undefined" ? window.location.pathname + window.location.search : "/";
    const queuedTrack = globalPlayer.queue.find((queued) => queued.id === t.id);
    if (queuedTrack) {
      globalPlayer.play(queuedTrack, origin);
      return;
    }
    const trackPayload = {
      id: t.id,
      artist: t.artist,
      title: t.title,
      coverArtUrl: safeCoverUrl(t.cover_art_url),
      spotifyUrl: t.spotify_url,
      audioUrl,
      episodeId: episodeId,
      episodeTitle: episodeTitle || undefined,
      youtubeUrl: t.youtube_url,
    };

    if (audioUrl || t.spotify_url) {
      globalPlayer.play(trackPayload, origin);
    } else {
      globalPlayer.loadTrack(trackPayload, origin);
    }
  };

  const openContextMenu = (event: React.MouseEvent, track: TrackListItem) => {
    const canonicalId = canonicalIdForRow(track);
    if (!canonicalId) return;
    event.preventDefault();
    event.stopPropagation();
    setContextError(null);
    setContextAction(null);
    setContextMenu({ track, canonicalId, x: event.clientX, y: event.clientY });
  };

  const applyLocalTrackPatch = (canonicalId: string, trackPatch: Partial<TrackListItem>) => {
    setFetchedTracks((current) => current.map((track) =>
      canonicalIdForRow(track) === canonicalId ? { ...track, ...trackPatch } : track
    ));
    setDirectOverrides((current) => ({
      ...current,
      [canonicalId]: { ...(current[canonicalId] || {}), ...trackPatch },
    }));
  };

  const handleContextAction = async (action: EpisodeTracklistAction) => {
    if (!contextMenu || contextAction) return;
    setContextAction(action);
    setContextError(null);
    try {
      const result = await performEpisodeTracklistAction(
        action,
        contextMenu.canonicalId,
        contextMenu.track,
      );
      if (result.voteStatus) {
        const trackPatch: Partial<TrackListItem> = {
          vote_status: result.voteStatus,
          status: result.voteStatus,
        };
        if (result.superLiked !== undefined) trackPatch.super_liked = result.superLiked;
        applyLocalTrackPatch(contextMenu.canonicalId, trackPatch);
        globalPlayer.updateTrackVote(
          contextMenu.canonicalId,
          result.voteStatus,
          result.superLiked,
        );
      } else {
        applyLocalTrackPatch(contextMenu.canonicalId, { is_re_seed: true });
        globalPlayer.markTrackSeeded(contextMenu.canonicalId, result.seedId);
      }
      setContextMenu(null);
    } catch (actionError) {
      setContextError(actionError instanceof Error ? actionError.message : "Action failed");
    } finally {
      setContextAction(null);
    }
  };

  const statusText = (s: string) => {
    if (s === "approved") return "text-foreground/80";
    if (s === "rejected") return "text-foreground/30 line-through";
    if (s === "skipped") return "text-foreground/40";
    if (s === "listened") return "text-foreground/40";
    if (s === "bad_source") return "text-orange-400/40 line-through";
    return "text-foreground/60";
  };

  const voteDot = (t: TrackListItem) => {
    if (t.super_liked)
      return <span className="w-1.5 h-1.5 rounded-full bg-yellow-400 flex-shrink-0" title="Super liked" />;
    if (t.vote_status === "approved")
      return <span className="w-1.5 h-1.5 rounded-full bg-green-500 flex-shrink-0" title="Approved" />;
    if (t.vote_status === "rejected")
      return <span className="w-1.5 h-1.5 rounded-full bg-red-500 flex-shrink-0" title="Rejected" />;
    if (t.vote_status === "skipped")
      return <span className="w-1.5 h-1.5 rounded-full bg-amber-400 flex-shrink-0" title="Skipped" />;
    if (t.vote_status === "listened")
      return <span className="w-1.5 h-1.5 rounded-full bg-gray-400 flex-shrink-0" title="Listened" />;
    if (t.vote_status === "bad_source")
      return <span className="w-1.5 h-1.5 rounded-full bg-orange-400 flex-shrink-0" title="Bad source" />;
    return null;
  };

  // Header stats
  const playable = playableTracks.length;

  const displayTitle = listTitle || episodeTitle || "Tracklist";

  const contextMenuPortal = contextMenu && typeof document !== "undefined"
    ? createPortal(
        <div
          ref={contextMenuRef}
          role="menu"
          aria-label={`Actions for ${contextMenu.track.title}`}
          aria-busy={contextAction !== null}
          className="fixed z-[100] w-52 overflow-hidden rounded-xl border border-surface-4 bg-surface-1/95 p-1.5 shadow-2xl backdrop-blur-xl"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onContextMenu={(event) => event.preventDefault()}
          onKeyDown={(event) => {
            if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
            event.preventDefault();
            const items = Array.from(
              contextMenuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') || [],
            );
            if (!items.length) return;
            const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement);
            const nextIndex = event.key === "Home"
              ? 0
              : event.key === "End"
                ? items.length - 1
                : event.key === "ArrowDown"
                  ? (currentIndex + 1 + items.length) % items.length
                  : (currentIndex - 1 + items.length) % items.length;
            items[nextIndex]?.focus();
          }}
        >
          <div className="truncate border-b border-surface-3 px-2.5 py-2 text-[10px] font-medium text-muted">
            {contextMenu.track.artist} — {contextMenu.track.title}
          </div>
          {([
            ["like", "♥", "Like"],
            ["star", "★", "Star / super-like"],
            ["reject", "×", "Reject"],
            ["skip", "→", "Skip"],
            ["reseed", "🌿", "Re-seed"],
            ["bad_source", "⚠", "Bad source"],
          ] as const).map(([action, icon, label]) => (
            <button
              key={action}
              role="menuitem"
              type="button"
              disabled={contextAction !== null}
              onClick={() => void handleContextAction(action)}
              className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-xs text-foreground/85 outline-none transition-colors hover:bg-surface-3 focus:bg-surface-3 disabled:cursor-wait disabled:opacity-50"
            >
              <span className="w-4 text-center text-sm" aria-hidden="true">{icon}</span>
              <span>{contextAction === action ? `${label}…` : label}</span>
            </button>
          ))}
          {contextAction && (
            <p role="status" className="border-t border-surface-3 px-2.5 py-2 text-[10px] text-muted">
              Updating…
            </p>
          )}
          {contextError && (
            <p role="alert" className="border-t border-surface-3 px-2.5 py-2 text-[10px] text-red-400">
              {contextError}
            </p>
          )}
        </div>,
        document.body,
      )
    : null;

  const content = (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex-shrink-0 px-4 pt-4 pb-3 border-b border-surface-3">
        <div className="flex items-center justify-between">
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-medium text-foreground truncate">
              {displayTitle}
            </h3>
            {!loading && (
              <div className="flex items-center gap-3 mt-1 text-[10px] font-mono text-muted">
                <span>{allTracks.length} tracks</span>
                {playable > 0 && <span className="text-green-400/70">{playable} playable</span>}
              </div>
            )}
          </div>
          {onClose && (
            <button
              onClick={onClose}
              className="p-2 rounded-full bg-foreground/10 hover:bg-foreground/20 text-foreground/80 hover:text-foreground transition-colors"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          )}
        </div>
      </div>

      {/* Track list */}
      <div className="flex-1 overflow-y-auto px-2 py-2">
        {loading ? (
          <div className="flex justify-center py-8">
            <div className="w-5 h-5 border-2 border-accent/30 border-t-accent rounded-full animate-spin" />
          </div>
        ) : error ? (
          <p className="text-center text-red-400/70 text-xs py-8">{error}</p>
        ) : tracks.length === 0 && unplayableTracks.length === 0 ? (
          <p className="text-center text-muted text-xs py-8">No tracks</p>
        ) : tracks.length === 0 && unplayableTracks.length > 0 ? (
          <p className="text-center text-muted text-xs py-8">No playable tracks yet — processing</p>
        ) : (
          <div className="space-y-0.5">
            {tracks.map((t) => {
              const isPlaying = globalPlayer.currentTrack?.id === t.id;
              const seedBadge = getSeedBadge(t);
              return (
                <button
                  key={t.id}
                  ref={isPlaying ? playingRef : undefined}
                  onClick={() => {
                    onTrackSelect?.(t.id);
                    handlePlay(t);
                  }}
                  onContextMenu={(event) => openContextMenu(event, t)}
                  aria-haspopup={canonicalIdForRow(t) ? "menu" : undefined}
                  disabled={false}
                  className={`w-full text-left px-2 py-1.5 rounded-lg flex items-center gap-2.5 transition-[color,background-color,border-color,transform,box-shadow] group border ${
                    seedBadge === "seed"
                      ? "bg-green-500/5 border-green-500/15 cursor-default"
                      : isPlaying
                        ? "bg-accent/10 border-accent/20"
                        : t.storage_path
                          ? "hover:bg-surface-2 border-surface-3/60"
                          : "hover:bg-surface-2/50 border-transparent"
                  } ${t._live_mutation ? "fyp-branch-mutation" : ""}`}
                >
                  {/* Cover art thumbnail — 36x36 */}
                  <span className="relative w-9 h-9 flex-shrink-0 rounded-md overflow-hidden">
                    {isPlaying && (globalPlayer.currentTrack?.coverArtUrl || t.cover_art_url) ? (
                      <>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={globalPlayer.currentTrack?.coverArtUrl || t.cover_art_url!}
                          alt=""
                          className="w-full h-full object-cover"
                        />
                        <span className="absolute inset-0 flex items-center justify-center bg-black/40">
                          <span className="flex gap-0.5 items-end h-3">
                            <span className={`w-0.5 bg-white rounded-full ${globalPlayer.playing ? "animate-bounce" : ""}`} style={{ height: "40%", animationDelay: "0ms" }} />
                            <span className={`w-0.5 bg-white rounded-full ${globalPlayer.playing ? "animate-bounce" : ""}`} style={{ height: "70%", animationDelay: "150ms" }} />
                            <span className={`w-0.5 bg-white rounded-full ${globalPlayer.playing ? "animate-bounce" : ""}`} style={{ height: "50%", animationDelay: "300ms" }} />
                          </span>
                        </span>
                      </>
                    ) : t.cover_art_url ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={t.cover_art_url} alt="" className="w-full h-full object-cover" />
                    ) : (
                      <span className="w-full h-full flex items-center justify-center bg-gradient-to-br from-surface-3 to-surface-4">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-foreground/30">
                          <path d="M9 18V5l12-2v13" />
                          <circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" />
                        </svg>
                      </span>
                    )}
                  </span>

                  {/* Track info */}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1 mb-0.5">
                      {seedBadge === "seed" ? (
                        <span className="text-[9px] leading-none flex-shrink-0" title="Seed">🌱</span>
                      ) : seedBadge === "re-seed" ? (
                        <span className="text-[9px] leading-none flex-shrink-0" title="Re-seed">🌿</span>
                      ) : t.super_liked ? (
                        <span className="text-[9px] leading-none text-amber-400 flex-shrink-0" title="Super liked">⭐</span>
                      ) : null}
                      <p className={`text-xs truncate ${
                        isPlaying
                          ? "text-accent font-medium"
                          : t.vote_status === "rejected"
                            ? "line-through text-red-400/40"
                            : t.vote_status === "skipped"
                              ? "text-amber-400/40"
                              : t.vote_status === "listened"
                                ? "text-foreground/40"
                                : seedBadge === "seed"
                                  ? "text-green-400/90 font-medium"
                                  : seedBadge === "re-seed"
                                    ? "text-emerald-400/80 font-medium"
                                    : t.super_liked
                                      ? "text-amber-300/90 font-medium"
                                      : t.vote_status === "approved"
                                        ? "text-green-400/80"
                                        : "text-foreground/85"
                      }`}>
                        {t.title}
                      </p>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <p className={`text-[10px] truncate ${
                        t.vote_status === "rejected" ? "line-through text-muted/30" : "text-muted"
                      }`}>{t.artist}</p>

                    </div>
                  </div>

                  {/* Vote status indicator */}
                  {t.vote_status && t.vote_status !== "pending" && (
                    <span className="flex-shrink-0" title={t.vote_status}>
                      {t.super_liked ? (
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="#facc15" stroke="#facc15" strokeWidth="1" className="text-yellow-400">
                          <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
                        </svg>
                      ) : t.vote_status === "approved" ? (
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="#4ade80" className="text-green-400">
                          <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z" />
                        </svg>
                      ) : t.vote_status === "rejected" ? (
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-red-400/50">
                          <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                        </svg>
                      ) : t.vote_status === "skipped" ? (
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-amber-400/40">
                          <path d="M5 12h14" /><path d="M12 5l7 7-7 7" />
                        </svg>
                      ) : t.vote_status === "bad_source" ? (
                        <span className="text-[10px] text-orange-400/60">⚠️</span>
                      ) : null}
                    </span>
                  )}

                  {/* Right: vote status dot */}
                  <span className="flex-shrink-0">
                    {voteDot(t)}
                  </span>
                </button>
              );
            })}

            {/* Unplayable tracks toggle */}
            {unplayableTracks.length > 0 && (
              <>
                <button
                  onClick={() => setShowUnplayable((prev) => !prev)}
                  className="w-full text-center py-2 mt-2 text-[10px] font-mono text-muted/60 hover:text-muted transition-colors"
                >
                  {showUnplayable ? "Hide unenriched" : `Show ${unplayableTracks.length} unenriched tracks`}
                </button>
                {showUnplayable && unplayableTracks.map((t) => (
                  <div
                    key={t.id}
                    className="w-full text-left px-2 py-1.5 rounded-lg flex items-center gap-2.5 border border-transparent opacity-40 cursor-default"
                    onContextMenu={(event) => {
                      if (canonicalIdForRow(t)) openContextMenu(event, t);
                    }}
                    tabIndex={canonicalIdForRow(t) ? 0 : undefined}
                    aria-haspopup={canonicalIdForRow(t) ? "menu" : undefined}
                  >
                    <span className="relative w-9 h-9 flex-shrink-0 rounded-md overflow-hidden opacity-30">
                      {t.cover_art_url ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={t.cover_art_url} alt="" className="w-full h-full object-cover" />
                      ) : (
                        <span className="w-full h-full flex items-center justify-center bg-gradient-to-br from-surface-3 to-surface-4">
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-foreground/30">
                            <path d="M9 18V5l12-2v13" />
                            <circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" />
                          </svg>
                        </span>
                      )}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="text-xs truncate line-through text-foreground/30">{t.title}</p>
                      <p className="text-[10px] truncate line-through text-muted/30">{t.artist}</p>
                    </div>
                  </div>
                ))}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );

  if (variant === "sheet") {
    return (
      <>
        <div className="flex-1 min-h-0 flex flex-col">{content}</div>
        {contextMenuPortal}
      </>
    );
  }

  return (
    <>
      <div className="h-full w-full bg-surface-1 rounded-xl border border-surface-3 overflow-hidden">
        {content}
      </div>
      {contextMenuPortal}
    </>
  );
}

// Mobile bottom sheet wrapper — liquid glass overlay
// Supports both episode-based (fetch) and direct tracks modes
export function TracklistSheet({
  episodeId,
  episodeTitle,
  listTitle,
  directTracks,
  refreshKey,
  seedId,
  open,
  onClose,
  onTrackSelect,
}: {
  episodeId?: string;
  episodeTitle?: string | null;
  listTitle?: string | null;
  directTracks?: TrackListItem[];
  refreshKey?: number;
  seedId?: string | null;
  open: boolean;
  onClose: () => void;
  onTrackSelect?: (trackId: string) => void;
}) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 md:hidden sheet-enter">
      {/* Liquid glass sheet — full page coverage */}
      <div className="absolute inset-0 liquid-glass flex flex-col overflow-hidden">
        {/* Drag handle */}
        <div className="flex justify-center pt-3 pb-1 flex-shrink-0">
          <div className="w-10 h-1 rounded-full bg-foreground/25" />
        </div>
        {directTracks ? (
          <EpisodeTracklist
            directTracks={directTracks}
            listTitle={listTitle}
            onClose={onClose}
            onTrackSelect={onTrackSelect}
            variant="sheet"
          />
        ) : episodeId ? (
          <EpisodeTracklist
            episodeId={episodeId}
            episodeTitle={episodeTitle}
            listTitle={listTitle}
            refreshKey={refreshKey}
            seedId={seedId}
            onClose={onClose}
            onTrackSelect={onTrackSelect}
            variant="sheet"
          />
        ) : null}
      </div>
    </div>
  );
}
