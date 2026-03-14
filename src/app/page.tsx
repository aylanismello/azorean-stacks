"use client";

import { useState, useEffect, useCallback, useRef, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { Track } from "@/lib/types";
import { TrackCard } from "@/components/TrackCard";
import { StackBrowser } from "@/components/StackBrowser";
import { useGlobalPlayer } from "@/components/GlobalPlayerProvider";

export default function StackPage() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center min-h-[80vh]">
          <div className="w-8 h-8 border-2 border-accent/30 border-t-accent rounded-full animate-spin" />
        </div>
      }
    >
      <StackPageContent />
    </Suspense>
  );
}

// Deterministic hue from a string (seed name, episode id, etc.)
function hueFromString(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  return Math.abs(hash % 360);
}

function ContextBar({ track, total, onBrowse }: { track: Track; total: number; onBrowse: () => void }) {
  const seed = track.seed_track || (track.metadata as any)?.seed_artist
    ? { artist: track.seed_track?.artist || (track.metadata as any)?.seed_artist, title: track.seed_track?.title }
    : null;
  const episode = track.episode;

  const seedKey = seed ? `${seed.artist}-${seed.title || ""}` : "";
  const episodeKey = episode?.id || "";
  const seedHue = seedKey ? hueFromString(seedKey) : 0;
  const episodeHue = episodeKey ? hueFromString(episodeKey) : 0;

  return (
    <button
      onClick={onBrowse}
      className="max-w-card mx-auto mb-3 flex items-center gap-2.5 px-3 py-2 text-[11px] text-muted rounded-xl bg-surface-1/60 hover:bg-surface-1 border border-surface-2/50 hover:border-surface-3 transition-all group w-full"
      title="Browse all stacks"
    >
      {/* Zoom-out icon */}
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="flex-shrink-0 text-muted/60 group-hover:text-accent transition-colors">
        <rect x="3" y="3" width="7" height="7" rx="1" />
        <rect x="14" y="3" width="7" height="7" rx="1" />
        <rect x="3" y="14" width="7" height="7" rx="1" />
        <rect x="14" y="14" width="7" height="7" rx="1" />
      </svg>

      {/* Breadcrumb trail */}
      <div className="flex items-center gap-1.5 min-w-0 flex-1">
        {seed && (
          <div className="flex items-center gap-1 min-w-0">
            <span
              className="w-1.5 h-1.5 rounded-full flex-shrink-0"
              style={{ backgroundColor: `hsl(${seedHue}, 50%, 55%)` }}
            />
            <span className="truncate" style={{ color: `hsl(${seedHue}, 40%, 70%)` }}>
              {seed.artist}
            </span>
          </div>
        )}
        {seed && episode && <span className="text-muted/30 flex-shrink-0">›</span>}
        {episode && (
          <div className="flex items-center gap-1 min-w-0">
            <span
              className="w-1.5 h-1.5 rounded-full flex-shrink-0"
              style={{ backgroundColor: `hsl(${episodeHue}, 45%, 50%)` }}
            />
            <span className="truncate" style={{ color: `hsl(${episodeHue}, 35%, 65%)` }}>
              {episode.title || episode.source}
            </span>
          </div>
        )}
        {!seed && !episode && (
          <span className="text-muted/60">All stacks</span>
        )}
      </div>

      {/* Track count */}
      <span className="text-[10px] font-mono text-muted/50 flex-shrink-0">
        {total}
      </span>

      {/* Browse hint */}
      <span className="flex-shrink-0 text-[10px] text-muted/40 group-hover:text-accent transition-colors">
        All stacks
      </span>
    </button>
  );
}

function StackPageContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const globalPlayer = useGlobalPlayer();
  const episodeId = searchParams.get("episode_id");
  const episodeTitle = searchParams.get("episode_title");

  const [tracks, setTracks] = useState<Track[]>([]);
  const [loading, setLoading] = useState(true);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [skippingEpisode, setSkippingEpisode] = useState(false);
  const [browsing, setBrowsing] = useState(false);

  const buildUrl = useCallback((extra?: string) => {
    let url = `/api/tracks?status=pending&limit=20`;
    if (episodeId) url += `&episode_id=${encodeURIComponent(episodeId)}`;
    if (extra) url += extra;
    return url;
  }, [episodeId]);

  const fetchTracks = useCallback(async () => {
    try {
      const res = await fetch(buildUrl());
      if (!res.ok) throw new Error(`Failed to load tracks (${res.status})`);
      const data = await res.json();
      setTracks(data.tracks || []);
      setTotal(data.total || 0);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load tracks");
    } finally {
      setLoading(false);
    }
  }, [buildUrl]);

  useEffect(() => {
    fetchTracks();
  }, [fetchTracks]);

  const handleVote = async (id: string, status: "approved" | "rejected", advance: boolean = true) => {
    try {
      const res = await fetch(`/api/tracks/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      if (!res.ok) throw new Error(`Vote failed (${res.status})`);

      // If not advancing (user wants to keep listening), don't remove from list
      if (!advance) return;

      setTracks((prev) => {
        const remaining = prev.filter((t) => t.id !== id);

        // Refetch when running low
        if (remaining.length <= 3) {
          const votedId = id;
          const existingIds = new Set(remaining.map((t) => t.id));
          fetch(buildUrl())
            .then((r) => r.ok ? r.json() : null)
            .then((data) => {
              if (!data) return;
              const newTracks = (data.tracks || []).filter(
                (t: Track) => t.id !== votedId && !existingIds.has(t.id)
              );
              if (newTracks.length > 0) {
                setTracks((curr) => {
                  const currIds = new Set(curr.map((t: Track) => t.id));
                  const fresh = newTracks.filter((t: Track) => !currIds.has(t.id));
                  return [...curr, ...fresh];
                });
              }
              setTotal(data.total || 0);
            });
        }

        return remaining;
      });
      setTotal((prev) => prev - 1);
    } catch (err) {
      console.error("Vote error:", err);
      setError("Failed to vote. Please try again.");
    }
  };

  // The episode to skip: either from URL param or from the current track
  const currentEpisodeId = episodeId || (tracks.length > 0 ? tracks[0].episode_id : null);

  const handleSkipEpisode = async () => {
    if (!currentEpisodeId || skippingEpisode) return;
    setSkippingEpisode(true);
    try {
      const res = await fetch(`/api/episodes/${currentEpisodeId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ skipped: true }),
      });
      if (!res.ok) throw new Error("Failed to skip episode");

      if (episodeId) {
        // Came from episodes page — go back
        router.push("/episodes");
      } else {
        // Main swipe — remove all tracks from this episode and refetch
        setTracks((prev) => prev.filter((t) => t.episode_id !== currentEpisodeId));
        fetchTracks();
        setSkippingEpisode(false);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to skip episode");
      setSkippingEpisode(false);
    }
  };

  const handleSelectStack = (stackEpisodeId: string | null, stackEpisodeTitle: string | null) => {
    setBrowsing(false);
    if (stackEpisodeId) {
      // Navigate to filtered stack
      const params = new URLSearchParams();
      params.set("episode_id", stackEpisodeId);
      if (stackEpisodeTitle) params.set("episode_title", stackEpisodeTitle);
      router.push(`/?${params.toString()}`);
    } else {
      // "Everything" mode — clear filters
      router.push("/");
    }
  };

  // Auto-play next track when top card changes (after vote)
  const currentTopTrackId = tracks.length > 0 ? tracks[0].id : null;
  useEffect(() => {
    if (!currentTopTrackId || browsing) return;
    const t = tracks.find((t) => t.id === currentTopTrackId);
    if (!t) return;
    const hasPlayable = !!(t.audio_url || t.preview_url || t.spotify_url);
    if (!hasPlayable) return;
    // Don't reload if already loaded/playing this track
    if (globalPlayer.currentTrack?.id === currentTopTrackId) return;
    globalPlayer.play({
      id: t.id,
      artist: t.artist,
      title: t.title,
      coverArtUrl: t.cover_art_url,
      spotifyUrl: t.spotify_url,
      audioUrl: t.audio_url || t.preview_url || null,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentTopTrackId, browsing]);

  // Auto-advance to next track when current song ends
  const lastEndedCount = useRef(globalPlayer.trackEndedCount);
  useEffect(() => {
    if (globalPlayer.trackEndedCount === lastEndedCount.current) return;
    lastEndedCount.current = globalPlayer.trackEndedCount;
    if (browsing || tracks.length < 2) return;
    // Current track is tracks[0] — move it to the back and play the next one
    const currentId = tracks[0].id;
    if (globalPlayer.currentTrack?.id !== currentId) return;
    setTracks((prev) => {
      if (prev.length < 2) return prev;
      return [...prev.slice(1), prev[0]];
    });
    // The top card change will trigger the auto-play effect above
  }, [globalPlayer.trackEndedCount, browsing, tracks, globalPlayer.currentTrack?.id]);

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Escape to toggle browse mode
      if (e.key === "Escape") {
        setBrowsing((prev) => !prev);
        return;
      }
      if (browsing || tracks.length === 0) return;
      // Don't trigger shortcuts when typing in inputs
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (e.key === "ArrowLeft" || e.key === "j") {
        handleVote(tracks[0].id, "rejected");
      } else if (e.key === "ArrowRight" || e.key === "k") {
        handleVote(tracks[0].id, "approved");
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tracks, browsing]);

  // ── Browse mode ──
  if (browsing) {
    return (
      <StackBrowser
        onSelectStack={handleSelectStack}
        onClose={() => setBrowsing(false)}
      />
    );
  }

  // ── Loading ──
  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[80vh]">
        <div className="w-8 h-8 border-2 border-accent/30 border-t-accent rounded-full animate-spin" />
      </div>
    );
  }

  // ── Error ──
  if (error) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[80vh] px-6 text-center">
        <p className="text-sm text-red-400 mb-4">{error}</p>
        <button
          onClick={() => { setError(null); fetchTracks(); }}
          className="px-5 py-2 text-sm bg-surface-2 hover:bg-surface-3 rounded-lg text-muted hover:text-white transition-colors"
        >
          Retry
        </button>
      </div>
    );
  }

  // ── Empty ──
  if (tracks.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[80vh] px-6 text-center">
        {episodeId ? (
          <>
            <h2 className="text-xl font-medium text-white/80 mb-2">
              All done!
            </h2>
            <p className="text-sm text-muted max-w-xs">
              No pending tracks left{episodeTitle ? ` in "${episodeTitle}"` : " in this episode"}.
            </p>
            <div className="flex gap-3 mt-6">
              <button
                onClick={() => setBrowsing(true)}
                className="px-5 py-2 text-sm bg-accent/20 hover:bg-accent/30 text-accent rounded-lg transition-colors"
              >
                Browse Stacks
              </button>
              <a
                href="/episodes"
                className="px-5 py-2 text-sm bg-surface-2 hover:bg-surface-3 rounded-lg text-muted hover:text-white transition-colors"
              >
                Back to Episodes
              </a>
            </div>
          </>
        ) : (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="https://theaggie.org/wp-content/uploads/2019/10/kdvs_fe_JUSTIN_HAN-1536x864.jpg"
              alt=""
              className="w-64 h-40 object-cover rounded-xl mb-6 opacity-60 grayscale hover:grayscale-0 hover:opacity-100 transition-all duration-500"
            />
            <h2 className="text-xl font-medium text-white/80 mb-2">
              Pico&apos;s digging...
            </h2>
            <p className="text-sm text-muted max-w-xs">
              No tracks waiting right now. New discoveries will appear here when the
              agent finds something.
            </p>
            <button
              onClick={fetchTracks}
              className="mt-6 px-5 py-2 text-sm bg-surface-2 hover:bg-surface-3 rounded-lg text-muted hover:text-white transition-colors"
            >
              Refresh
            </button>
          </>
        )}
      </div>
    );
  }

  // ── Main stack view ──
  return (
    <div className="px-4 pt-4 md:pt-8">
      {/* Episode filter header — shown when zoomed into a specific episode */}
      {episodeId && (
        <div className="max-w-card mx-auto mb-2 flex items-center gap-2 px-1">
          <button
            onClick={() => setBrowsing(true)}
            className="text-xs text-accent hover:text-accent-bright transition-colors flex items-center gap-1"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="15 18 9 12 15 6" />
            </svg>
            All Stacks
          </button>
          {episodeTitle && (
            <p className="text-xs text-white/40 truncate flex-1">
              / {episodeTitle}
            </p>
          )}
        </div>
      )}

      {/* Context bar — seed + episode — clickable to browse all stacks */}
      <ContextBar track={tracks[0]} total={total} onBrowse={() => setBrowsing(true)} />

      {/* Current card */}
      <TrackCard
        key={tracks[0].id}
        track={tracks[0]}
        onVote={handleVote}
        onSkipEpisode={currentEpisodeId ? handleSkipEpisode : undefined}
        skippingEpisode={skippingEpisode}
      />

      {/* Keyboard hint (desktop only) */}
      <div className="hidden md:flex justify-center gap-6 mt-6 text-xs text-muted">
        <span>← / j skip</span>
        <span>→ / k keep</span>
        <span>esc all stacks</span>
      </div>

    </div>
  );
}
