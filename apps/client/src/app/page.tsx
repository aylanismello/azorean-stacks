"use client";

import { useState, useEffect, useCallback, useRef, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { Track } from "@/lib/types";
import { TrackCard } from "@/components/TrackCard";
import { EpisodeTracklist, TracklistSheet } from "@/components/EpisodeTracklist";
import { useGlobalPlayer, PlayerTrack } from "@/components/GlobalPlayerProvider";
import { useSpotify } from "@/components/SpotifyProvider";
import { getFypKeyboardAction } from "@/lib/fyp-keyboard";
import { destinationQueueStartIndex } from "@/lib/queue-navigation";
import { canonicalPlayerTrackId, displayedPlayerTrackId, playerTrackActionId } from "@/lib/player-track-identity";
import { formatRankingScore, rankingContributions } from "@/lib/ranking-display";
import { explainTrackSelection } from "@/lib/track-explanation";
import {
  shouldRevealTangent,
  tangentDetail,
  tangentHeadline,
  type FypTangent,
} from "@/lib/fyp-tangent";
import { createClient as createBrowserClient } from "@/lib/supabase-browser";
import {
  reconcileLiveFypQueue,
  shouldApplyFypGeneration,
  type FypGeneration,
} from "@/lib/live-fyp";

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

/** Convert an API Track to a PlayerTrack with all fields the UI needs */
function toPlayerTrack(track: Track): PlayerTrack {
  return {
    id: track.id,
    artist: track.artist,
    title: track.title,
    coverArtUrl: track.cover_art_url || track.episode?.artwork_url || null,
    spotifyUrl: track.spotify_url,
    audioUrl: track.audio_url || track.preview_url || null,
    episodeId: track.episode_id,
    episodeTitle: track.episode?.title,
    youtubeUrl: track.youtube_url,

    // Vote / status
    vote_status: (track as any).vote_status || track.status || "pending",
    super_liked: track.super_liked || false,
    status: track.status,

    // Seed indicators
    is_seed: track.is_seed,
    is_re_seed: track.is_re_seed,
    is_artist_seed: (track as any).is_artist_seed,

    // Discovery metadata
    source: track.source,
    episode_id: track.episode_id,
    episode_title: track.episode?.title || null,
    storage_path: track.storage_path,
    youtube_url: track.youtube_url,
    preview_url: track.preview_url,
    seed_id: track.seed_id,
    seed_track: track.seed_track,
    taste_score: track.taste_score,

    // Source context
    source_url: track.source_url,
    source_context: track.source_context,

    // Episode join data
    episode: track.episode,

    // Metadata bag
    metadata: track.metadata,

    // Scoring metadata
    _ranked_score: (track as any)._ranked_score,
    _score_components: (track as any)._score_components,
    _match_type: (track as any)._match_type,
    _seed_name: (track as any)._seed_name,
    _seed_artist: (track as any)._seed_artist,
    _seed_title: (track as any)._seed_title,
    _tangent_id: (track as any)._tangent_id,
    _tangent_seed_name: (track as any)._tangent_seed_name,
    _tangent_start_rank: (track as any)._tangent_start_rank,
    _sonic_seed_name: (track as any)._sonic_seed_name,

    // Voted timestamp
    voted_at: track.voted_at,
  };
}

/** Convert a PlayerTrack back to a Track-like object for components that still expect Track */
function toTrackLike(pt: PlayerTrack): Track {
  return {
    // TrackCard writes to the catalog row; PlayerTrack.id keeps queue identity.
    id: displayedPlayerTrackId(pt),
    artist: pt.artist,
    title: pt.title,
    cover_art_url: pt.coverArtUrl,
    spotify_url: pt.spotifyUrl,
    audio_url: pt.audioUrl,
    youtube_url: pt.youtubeUrl || pt.youtube_url || null,
    preview_url: pt.preview_url || null,
    episode_id: pt.episodeId || pt.episode_id || null,
    episode: pt.episode || null,
    source: pt.source || "",
    source_url: pt.source_url || null,
    source_context: pt.source_context || null,
    seed_track_id: null,
    download_url: null,
    storage_path: pt.storage_path || null,
    seed_track: pt.seed_track || null,
    metadata: pt.metadata || {},
    status: (pt.vote_status || pt.status || "pending") as Track["status"],
    created_at: "",
    voted_at: pt.voted_at || null,
    downloaded_at: null,
    dl_attempts: 0,
    dl_failed_at: null,
    seed_id: pt.seed_id,
    taste_score: pt.taste_score,
    super_liked: pt.super_liked,
    is_seed: pt.is_seed,
    is_re_seed: pt.is_re_seed,
    // Pass through scoring metadata
    _ranked_score: pt._ranked_score,
    _score_components: pt._score_components,
    _match_type: pt._match_type,
    _seed_name: pt._seed_name,
    _seed_artist: pt._seed_artist,
    _seed_title: pt._seed_title,
    _tangent_id: (pt as any)._tangent_id,
    _tangent_seed_name: (pt as any)._tangent_seed_name,
    _tangent_start_rank: (pt as any)._tangent_start_rank,
    _sonic_seed_name: (pt as any)._sonic_seed_name,
    // Pass through vote_status for TrackCard
    vote_status: pt.vote_status,
    is_artist_seed: pt.is_artist_seed,
  } as any;
}

/** Check if a PlayerTrack has playable audio in the current session. */
function isPlayable(t: PlayerTrack, spotifyConnected: boolean): boolean {
  return !!(t.audioUrl || t.storage_path || t.preview_url || (spotifyConnected && t.spotifyUrl));
}

function StackPageContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const globalPlayer = useGlobalPlayer();
  const { connected: spotifyConnected } = useSpotify();
  // Mobile: account for top bar (3.5rem) + bottom tab bar + player (~4.5rem)
  // Desktop: override with md: classes that account for sidebar nav + player
  const mobileHeightClass = globalPlayer.currentTrack
    ? "h-[calc(100dvh-8rem-env(safe-area-inset-bottom,0px))]"
    : "h-[calc(100dvh-7rem-env(safe-area-inset-bottom,0px))]";
  const desktopPlayerFrameClass = globalPlayer.currentTrack
    ? "md:h-[calc(100dvh-148px)] md:pb-6"
    : "md:h-[calc(100dvh-100px)] md:pb-4";

  // URL-driven state
  const episodeId = searchParams.get("episode_id");
  const episodeTitle = searchParams.get("episode_title");
  const fromSeedId = searchParams.get("seed_id");
  const fromEpisodes = searchParams.get("from") === "episodes";

  // Stack source: "taste" (For You), "genre", "seed", "episode" (legacy), "ranked" (new)
  // Default to taste mode when no source/episode params are set
  const stackSource = searchParams.get("source");
  const genreFilter = searchParams.get("genre");
  const seedFilter = searchParams.get("seed_artist");
  const seedName = searchParams.get("seed_name"); // "Artist — Title" for display
  const isSeedMode = stackSource === "seed";
  const isRankedMode = stackSource === "ranked";
  const isTasteMode = stackSource === "taste" || stackSource === "genre" || isSeedMode || isRankedMode || (!stackSource && !episodeId);
  const isHomeFyp = !episodeId && !fromSeedId && !genreFilter && !seedFilter;

  // Page-level UI state (no track state — provider owns that)
  const [loading, setLoading] = useState(true);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [hideLowScored, setHideLowScored] = useState(false);
  const [recentTangents, setRecentTangents] = useState<FypTangent[]>([]);
  const [activeTangent, setActiveTangent] = useState<FypTangent | null>(null);
  const [tangentExpanded, setTangentExpanded] = useState(false);
  const [liveMutationIds, setLiveMutationIds] = useState<Set<string>>(() => new Set());
  const lastFypGenerationRef = useRef(0);
  const lastSeenTangentRef = useRef<string | null>(null);
  const playerQueueRef = useRef(globalPlayer.queue);
  const liveRefreshChainRef = useRef<Promise<void>>(Promise.resolve());

  const queueViewKey = episodeId
    ? `episode:${episodeId}`
    : fromSeedId
      ? `seed:${fromSeedId}`
      : genreFilter
        ? `genre:${genreFilter}`
        : seedFilter
          ? `seed-artist:${seedFilter}`
          : `fyp:${hideLowScored ? "hide-low" : "all"}`;
  const activeQueueViewRef = useRef<string | null>(null);

  useEffect(() => {
    const stored = sessionStorage.getItem("stacks-hide-low-scored");
    if (stored === "1") setHideLowScored(true);
    activeQueueViewRef.current = sessionStorage.getItem("stacks-active-queue-view");
    lastSeenTangentRef.current = localStorage.getItem("stacks-last-tangent");
  }, []);
  const [skippingEpisode, setSkippingEpisode] = useState(false);
  const [tracklistOpen, setTracklistOpen] = useState(false);
  const [voteCount, setVoteCount] = useState(0);
  const [advancingEpisode, setAdvancingEpisode] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);

  // Don't auto-play until the user has interacted (vote, skip, click track, etc.)
  const userHasInteracted = useRef(false);

  // Ref for global player's current track (avoids stale closures in fetchTracks)
  const playerCurrentTrackRef = useRef(globalPlayer.currentTrack);
  useEffect(() => { playerCurrentTrackRef.current = globalPlayer.currentTrack; }, [globalPlayer.currentTrack]);
  useEffect(() => { playerQueueRef.current = globalPlayer.queue; }, [globalPlayer.queue]);

  useEffect(() => {
    setAdvancingEpisode(false);
  }, [episodeId]);

  // Whether we're operating in "episode mode" (full episode tracks + position index)
  const [hasEpisodeTracks, setHasEpisodeTracks] = useState(!!episodeId);

  // The current track is ALWAYS from the provider — single source of truth
  const currentTrack = globalPlayer.currentTrack;

  // Position of current track in the queue (for display)
  const currentDisplayIndex = globalPlayer.currentIndex;

  const buildUrl = useCallback((_extra?: string) => {
    // Episode mode: fetch ALL tracks in episode order (not just pending)
    if (episodeId) {
      return `/api/tracks?episode_id=${encodeURIComponent(episodeId)}&limit=100`;
    }
    // Unified FYP endpoint for taste/genre/seed/ranked modes
    let url = `/api/fyp?limit=20`;
    if (hideLowScored) {
      url += `&hide_low=true`;
    }
    if (fromSeedId) {
      url += `&seed_id=${encodeURIComponent(fromSeedId)}`;
    }
    if (genreFilter) {
      url += `&genre=${encodeURIComponent(genreFilter)}`;
    }
    if (seedFilter) {
      url += `&seed_artist=${encodeURIComponent(seedFilter)}`;
    }
    return url;
  }, [episodeId, hideLowScored, fromSeedId, genreFilter, seedFilter]);

  const fetchTracks = useCallback(async (
    mode: "navigation" | "live" = "navigation",
    signal?: AbortSignal,
  ) => {
    try {
      const res = await fetch(buildUrl(), { cache: "no-store", signal });
      if (!res.ok) throw new Error(`Failed to load tracks (${res.status})`);
      const data = await res.json();
      if (signal?.aborted) return;
      const apiTracks: Track[] = data.tracks || [];
      const playerTracks = apiTracks.map(toPlayerTrack);
      const generation = data.generation as FypGeneration | undefined;
      const tangents = (data.tangents || []) as FypTangent[];
      const lastGeneration = lastFypGenerationRef.current;

      if (generation && generation.generation < lastGeneration) return;
      if (
        mode === "live"
          && generation
          && !shouldApplyFypGeneration(lastGeneration, generation.generation)
      ) return;
      if (generation) {
        lastFypGenerationRef.current = Math.max(
          lastFypGenerationRef.current,
          generation.generation,
        );
      }

      setTotal(data.total || 0);
      setRecentTangents(tangents);
      setError(null);
      setAdvancingEpisode(false);

      // Live 4U reconciliation owns only the queue ordering. setQueue preserves
      // the loaded audio element and finds the playing track's new position.
      if (mode === "live" && !episodeId) {
        const previousQueue = playerQueueRef.current;
        const reconciledQueue = reconcileLiveFypQueue(
          previousQueue,
          playerTracks,
          playerCurrentTrackRef.current?.id,
        );
        globalPlayer.setQueue(reconciledQueue);
        playerQueueRef.current = reconciledQueue;
        setHasEpisodeTracks(false);
        const latestTangent = tangents[0] || null;
        const revealTangent = shouldRevealTangent(
          latestTangent,
          previousQueue.map((track) => track.id),
          reconciledQueue.map((track) => track.id),
          lastSeenTangentRef.current,
        );
        if (revealTangent && latestTangent) {
          setActiveTangent(latestTangent);
          setTangentExpanded(false);
          setLiveMutationIds(new Set(latestTangent.tracks.map((track) => track.id)));
          lastSeenTangentRef.current = latestTangent.id;
          localStorage.setItem("stacks-last-tangent", latestTangent.id);
        } else {
          // Routine ranking/readiness maintenance is intentionally silent.
          setLiveMutationIds(new Set());
        }
        return;
      }

      // Hand tracks to the provider — it owns the queue. Preserve order only
      // when returning to the same view; never append a seed/genre queue into
      // the FYP (or vice versa).
      const playingTrack = playerCurrentTrackRef.current;
      const sameQueueView = activeQueueViewRef.current === queueViewKey;

      if (episodeId && playerTracks.length > 0) {
        const firstPlayablePending = playerTracks.findIndex((t) => t.status === "pending" && isPlayable(t, spotifyConnected));
        const startIndex = firstPlayablePending >= 0 ? firstPlayablePending : 0;
        setHasEpisodeTracks(true);

        if (playingTrack) {
          const playingIdx = playerTracks.findIndex(t => t.id === playingTrack.id);
          if (playingIdx >= 0) {
            globalPlayer.setQueue(playerTracks, playingIdx);
          } else {
            globalPlayer.setQueue(playerTracks, startIndex);
            globalPlayer.loadTrack(playerTracks[startIndex]);
          }
        } else {
          globalPlayer.setQueue(playerTracks, startIndex);
          globalPlayer.loadTrack(playerTracks[startIndex]);
        }
      } else if (playerTracks.length > 0) {
        const existingQueue = globalPlayer.queue;
        if (sameQueueView && existingQueue.length > 0) {
          // Ordinary navigation back to the same view must not mutate its
          // active sequence. Low-queue replenishment happens after voting.
        } else {
          const startIndex = destinationQueueStartIndex(playerTracks, playingTrack?.id);
          // Preserve the audio element, not a foreign queue row. -1 represents
          // playback outside this destination so next enters its first track.
          globalPlayer.setQueue(playerTracks, startIndex);
          if (!playingTrack) globalPlayer.loadTrack(playerTracks[0]);
        }
        setHasEpisodeTracks(false);
      }

      activeQueueViewRef.current = queueViewKey;
      sessionStorage.setItem("stacks-active-queue-view", queueViewKey);
    } catch (err) {
      if (signal?.aborted || (err instanceof DOMException && err.name === "AbortError")) return;
      setError(err instanceof Error ? err.message : "Failed to load tracks");
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [buildUrl, episodeId, queueViewKey, spotifyConnected]);

  useEffect(() => {
    fetchTracks();
  }, [fetchTracks]);

  useEffect(() => {
    if (!isHomeFyp) return;
    const supabase = createBrowserClient();
    let mounted = true;
    let channel: ReturnType<typeof supabase.channel> | null = null;
    const controller = new AbortController();

    const reconcile = () => {
      if (!mounted) return;
      liveRefreshChainRef.current = liveRefreshChainRef.current
        .catch(() => {})
        .then(() => mounted ? fetchTracks("live", controller.signal) : undefined);
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") reconcile();
    };

    void supabase.auth.getUser().then(({ data }) => {
      if (!mounted || !data.user) return;
      channel = supabase
        .channel(`live-fyp-${data.user.id}`)
        .on(
          "postgres_changes",
          {
            event: "*",
            schema: "public",
            table: "user_fyp_generations",
            filter: `user_id=eq.${data.user.id}`,
          },
          (payload) => {
            const next = payload.new as Partial<FypGeneration>;
            if (
              typeof next.generation === "number"
                && shouldApplyFypGeneration(lastFypGenerationRef.current, next.generation)
            ) reconcile();
          },
        )
        .subscribe((status) => {
          if (status === "SUBSCRIBED") reconcile();
        });
    });
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      mounted = false;
      controller.abort();
      liveRefreshChainRef.current = Promise.resolve();
      document.removeEventListener("visibilitychange", onVisible);
      if (channel) void supabase.removeChannel(channel);
    };
  }, [fetchTracks, isHomeFyp]);

  const advanceToNextEpisode = useCallback(async () => {
    setAdvancingEpisode(true);
    try {
      const res = await fetch("/api/tracks?status=pending&limit=20");
      if (!res.ok) throw new Error("Failed to fetch next episode");
      const data = await res.json();
      const curEpId = episodeId || currentTrack?.episodeId;
      const nextTrack = (data.tracks || []).find(
        (t: Track) => t.episode_id && t.episode_id !== curEpId
      ) || data.tracks?.[0];

      if (nextTrack?.episode_id) {
        const params = new URLSearchParams();
        params.set("episode_id", nextTrack.episode_id);
        if (nextTrack.episode?.title) params.set("episode_title", nextTrack.episode.title);
        router.push(`/?${params.toString()}`);
      } else {
        setAdvancingEpisode(false);
        router.push("/");
      }
    } catch {
      setAdvancingEpisode(false);
      router.push("/");
    }
  }, [router, episodeId, currentTrack?.episodeId]);

  const handleSuperLike = async (id: string) => {
    userHasInteracted.current = true;
    const actionTrackId = playerTrackActionId(id, currentTrack, globalPlayer.queue);
    if (!actionTrackId) return;
    try {
      const res = await fetch(`/api/tracks/${actionTrackId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ super_liked: true }),
      });
      if (!res.ok) throw new Error(`Super like failed (${res.status})`);

      if (spotifyConnected) {
        fetch("/api/spotify/sync-seeds", { method: "POST" }).catch(() => {});
      }

      // Update vote in provider — single source of truth
      globalPlayer.updateTrackVote(actionTrackId, "approved", true);
      setVoteCount((c) => c + 1);
    } catch (err) {
      console.error("Super like error:", err);
      setError("Failed to super like. Please try again.");
    }
  };

  const handleReseed = async (track: PlayerTrack) => {
    if (track.seed_id || track.is_re_seed) return;
    const actionTrackId = canonicalPlayerTrackId(track);
    if (!actionTrackId) return;
    try {
      const res = await fetch("/api/seeds/toggle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          track_id: actionTrackId,
          artist: track.artist,
          title: track.title,
          action: "ensure",
        }),
      });
      if (!res.ok) throw new Error(`Re-seed failed (${res.status})`);
      const data = await res.json();
      globalPlayer.markTrackSeeded(actionTrackId, data.seed_id);
    } catch (err) {
      console.error("Re-seed error:", err);
      setError("Failed to re-seed. Please try again.");
    }
  };

  const handleVote = async (id: string, status: "approved" | "rejected" | "skipped" | "bad_source", advance: boolean = true) => {
    userHasInteracted.current = true;
    const actionTrackId = playerTrackActionId(id, currentTrack, globalPlayer.queue);
    if (!actionTrackId) return;
    try {
      const res = await fetch(`/api/tracks/${actionTrackId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      if (!res.ok) throw new Error(`Vote failed (${res.status})`);

      if (status === "approved" && spotifyConnected) {
        fetch("/api/spotify/sync-seeds", { method: "POST" }).catch(() => {});
      }

      // Update vote in provider — single source of truth
      globalPlayer.updateTrackVote(actionTrackId, status);
      setVoteCount((c) => c + 1);

      if (!advance) return;

      const queue = globalPlayer.queue;

      if (hasEpisodeTracks) {
        // Episode mode: check if any playable pending tracks remain
        const remainingPending = queue.filter((t) => t.id !== id && (t.vote_status === "pending" || t.status === "pending") && isPlayable(t, spotifyConnected));
        if (remainingPending.length === 0) {
          advanceToNextEpisode();
          return;
        }
        // Advance to next pending + playable track
        const curPos = globalPlayer.currentIndex;
        let nextPos = -1;
        for (let i = curPos + 1; i < queue.length; i++) {
          if (queue[i].id !== id && (queue[i].vote_status === "pending" || queue[i].status === "pending") && isPlayable(queue[i], spotifyConnected)) { nextPos = i; break; }
        }
        if (nextPos >= 0) {
          globalPlayer.playFromQueue(nextPos);
        } else {
          advanceToNextEpisode();
        }
      } else {
        // Taste/ranked mode: advance to next pending track in queue
        const curPos = globalPlayer.currentIndex;
        let nextPos = -1;
        for (let i = curPos + 1; i < queue.length; i++) {
          if (queue[i].id !== id && (queue[i].vote_status === "pending" || queue[i].status === "pending") && isPlayable(queue[i], spotifyConnected)) { nextPos = i; break; }
        }
        if (nextPos >= 0) {
          globalPlayer.playFromQueue(nextPos);
        }

        // Batch loading: if running low on pending tracks, fetch more
        const pendingAhead = queue.slice(curPos + 1).filter((t) => (t.vote_status === "pending" || t.status === "pending") && isPlayable(t, spotifyConnected));
        if (pendingAhead.length <= 3) {
          fetch(buildUrl())
            .then((r) => r.ok ? r.json() : null)
            .then((data) => {
              if (!data) return;
              const newTracks = (data.tracks || []) as Track[];
              if (newTracks.length > 0) {
                globalPlayer.appendToQueue(newTracks.map(toPlayerTrack));
              }
              setTotal(data.total || 0);
            });
        }

        setTotal((prev) => Math.max(0, prev - 1));
      }
    } catch (err) {
      console.error("Vote error:", err);
      setError("Failed to vote. Please try again.");
    }
  };

  // Episode identity — URL-driven or derived from current track
  const derivedEpisodeRef = useRef<{ id: string | null; title: string | null }>({ id: null, title: null });

  if (episodeId) {
    derivedEpisodeRef.current = { id: episodeId, title: episodeTitle };
  } else if (!isTasteMode && currentTrack) {
    const topEpisodeId = currentTrack.episodeId || currentTrack.episode_id || null;
    const topEpisodeTitle = currentTrack.episodeTitle || currentTrack.episode_title || currentTrack.episode?.title || null;
    if (topEpisodeId && !derivedEpisodeRef.current.id) {
      derivedEpisodeRef.current = { id: topEpisodeId, title: topEpisodeTitle };
    } else if (topEpisodeId && derivedEpisodeRef.current.id) {
      const hasLockedEpisodeTracks = globalPlayer.queue.some((t) => (t.episodeId || t.episode_id) === derivedEpisodeRef.current.id);
      if (!hasLockedEpisodeTracks) {
        derivedEpisodeRef.current = { id: topEpisodeId, title: topEpisodeTitle };
      }
    }
  }

  const currentEpisodeId = isTasteMode ? null : derivedEpisodeRef.current.id;
  const currentEpisodeTitle = isTasteMode ? null : derivedEpisodeRef.current.title;

  // When a derived episode is detected in legacy all-pending mode, re-fetch ALL tracks
  const derivedFetchedRef = useRef<string | null>(null);
  useEffect(() => {
    if (episodeId) return;
    if (isTasteMode) return;
    if (!currentEpisodeId) return;
    if (derivedFetchedRef.current === currentEpisodeId) return;
    derivedFetchedRef.current = currentEpisodeId;

    fetch(`/api/tracks?episode_id=${encodeURIComponent(currentEpisodeId)}&limit=100`)
      .then((r) => r.ok ? r.json() : null)
      .then((data) => {
        if (!data?.tracks?.length) return;
        const playerTracks = (data.tracks as Track[]).map(toPlayerTrack);
        setTotal(data.total || 0);
        setHasEpisodeTracks(true);
        const firstPlayable = playerTracks.findIndex((t) => t.status === "pending" && isPlayable(t, spotifyConnected));
        const startIdx = firstPlayable >= 0 ? firstPlayable : 0;
        globalPlayer.setQueue(playerTracks, startIdx);
        if (playerTracks[startIdx]) {
          globalPlayer.loadTrack(playerTracks[startIdx]);
        }
      });
  }, [currentEpisodeId, episodeId, isTasteMode, spotifyConnected]);

  // Sidebar/tracklist click → jump to that track via global player
  const handleTrackSelect = useCallback((trackId: string) => {
    userHasInteracted.current = true;
    const idx = globalPlayer.queue.findIndex((t) => t.id === trackId);
    if (idx >= 0) {
      const origin = typeof window !== "undefined" ? window.location.pathname + window.location.search : "/";
      globalPlayer.playFromQueue(idx, origin);
    }
  }, [globalPlayer]);

  const handleSkipEpisode = async () => {
    userHasInteracted.current = true;
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
        if (fromEpisodes) {
          router.push("/episodes");
        } else {
          router.push("/stacks");
        }
      } else {
        derivedEpisodeRef.current = { id: null, title: null };
        derivedFetchedRef.current = null;
        setHasEpisodeTracks(false);
        fetchTracks();
        setSkippingEpisode(false);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to skip episode");
      setSkippingEpisode(false);
    }
  };

  const handleGoToStacks = useCallback(() => {
    router.push("/stacks");
  }, [router]);

  const handleGoBack = useCallback(() => {
    if (fromEpisodes) {
      router.push("/episodes");
    } else {
      handleGoToStacks();
    }
  }, [fromEpisodes, handleGoToStacks]);

  // Auto-advance on song end — move to next track in order
  const lastEndedCount = useRef(globalPlayer.trackEndedCount);
  useEffect(() => {
    if (globalPlayer.trackEndedCount === lastEndedCount.current) return;
    lastEndedCount.current = globalPlayer.trackEndedCount;

    const queue = globalPlayer.queue;

    if (hasEpisodeTracks) {
      // Episode mode: advance to next playable track via the global player queue
      const curPos = globalPlayer.currentIndex;
      let nextPos = -1;
      for (let i = curPos + 1; i < queue.length; i++) {
        if (isPlayable(queue[i], spotifyConnected)) {
          nextPos = i;
          break;
        }
      }
      if (nextPos >= 0) {
        globalPlayer.playFromQueue(nextPos);
      } else {
        advanceToNextEpisode();
      }
      return;
    }

    // Taste/ranked mode: advance to next pending + playable track
    const curPos = globalPlayer.currentIndex;
    let nextPos = -1;
    for (let i = curPos + 1; i < queue.length; i++) {
      if ((queue[i].vote_status === "pending" || queue[i].status === "pending") && isPlayable(queue[i], spotifyConnected)) {
        nextPos = i;
        break;
      }
    }
    if (nextPos >= 0) {
      globalPlayer.playFromQueue(nextPos);
    }

    // Batch loading when running low on pending tracks
    const pendingAhead = queue.slice(curPos + 1).filter((t) => (t.vote_status === "pending" || t.status === "pending") && isPlayable(t, spotifyConnected));
    if (pendingAhead.length <= 3) {
      fetch(buildUrl())
        .then((r) => r.ok ? r.json() : null)
        .then((data) => {
          if (!data) return;
          const newTracks = (data.tracks || []) as Track[];
          if (newTracks.length > 0) {
            globalPlayer.appendToQueue(newTracks.map(toPlayerTrack));
          }
          setTotal(data.total || 0);
        });
    }
  }, [globalPlayer.trackEndedCount, globalPlayer.currentIndex, globalPlayer.queue, buildUrl, hasEpisodeTracks, globalPlayer, advanceToNextEpisode, spotifyConnected]);

  // Preload next track's audio when current track reaches 75% completion
  const preloadTriggeredRef = useRef<string | null>(null);
  useEffect(() => {
    if (!globalPlayer.currentTrack || globalPlayer.duration <= 0 || globalPlayer.progress <= 0) return;
    if (globalPlayer.progress / globalPlayer.duration < 0.75) return;
    if (preloadTriggeredRef.current === globalPlayer.currentTrack.id) return;
    preloadTriggeredRef.current = globalPlayer.currentTrack.id;

    const queue = globalPlayer.queue;
    const curIdx = globalPlayer.currentIndex;
    let nextTrack: PlayerTrack | undefined;
    if (hasEpisodeTracks) {
      for (let i = curIdx + 1; i < queue.length; i++) {
        if (queue[i].status === "pending") { nextTrack = queue[i]; break; }
      }
    } else if (curIdx + 1 < queue.length) {
      nextTrack = queue[curIdx + 1];
    }

    if (nextTrack && (nextTrack.audioUrl || nextTrack.preview_url)) {
      globalPlayer.preloadTrack(nextTrack);
    }
  }, [globalPlayer.progress, globalPlayer.duration, globalPlayer.currentTrack?.id, globalPlayer.currentIndex, globalPlayer.queue, hasEpisodeTracks]);

  // FYP keyboard shortcuts. Space is handled once by GlobalPlayerProvider so a
  // focused play button keeps its native space-to-click behavior.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (contextOpen) {
          setContextOpen(false);
        } else if (tracklistOpen) {
          setTracklistOpen(false);
        }
        return;
      }
      if (!currentTrack) return;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target?.isContentEditable) return;

      const action = getFypKeyboardAction(e);
      if (!action) return;
      e.preventDefault();

      switch (action) {
        case "seek-backward":
          globalPlayer.seek(globalPlayer.progress - 30);
          break;
        case "seek-forward":
          globalPlayer.seek(globalPlayer.progress + 30);
          break;
        case "next-track":
          globalPlayer.next();
          break;
        case "previous-track":
          if (globalPlayer.progress > 3) globalPlayer.seek(0);
          else globalPlayer.prev();
          break;
        case "reject":
          void handleVote(currentTrack.id, "rejected");
          break;
        case "like":
          void handleVote(currentTrack.id, "approved");
          break;
        case "star":
          void handleSuperLike(currentTrack.id);
          break;
        case "skip":
          void handleVote(currentTrack.id, "skipped");
          break;
        case "reseed":
          void handleReseed(currentTrack);
          break;
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
    // Handler intentionally refreshes with the active track/player state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tracklistOpen, contextOpen, currentTrack, globalPlayer.progress]);

  // ── Advancing to next episode ──
  if (advancingEpisode) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[80vh] px-6 text-center gap-4">
        <div className="w-8 h-8 border-2 border-accent/30 border-t-accent rounded-full animate-spin" />
        <div>
          <h2 className="text-lg font-medium text-foreground/80">Episode complete</h2>
          <p className="text-sm text-muted mt-1">Loading next episode...</p>
        </div>
      </div>
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
          className="px-5 py-2 text-sm bg-surface-2 hover:bg-surface-3 rounded-lg text-muted hover:text-foreground transition-colors"
        >
          Retry
        </button>
      </div>
    );
  }

  // ── Empty ──
  const queue = globalPlayer.queue;
  const hasTracksButNonePlayable = queue.length > 0 && !currentTrack;

  if (!currentTrack) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[80vh] px-6 text-center">
        {hasTracksButNonePlayable ? (
          <>
            <h2 className="text-xl font-medium text-foreground/80 mb-2">
              No playable tracks yet — processing
            </h2>
            <p className="text-sm text-muted max-w-xs">
              {queue.length} track{queue.length !== 1 ? "s" : ""} found but audio is still being processed. Check back soon.
            </p>
            <button
              onClick={() => { void fetchTracks(); }}
              className="mt-6 px-5 py-2 text-sm bg-surface-2 hover:bg-surface-3 rounded-lg text-muted hover:text-foreground transition-colors"
            >
              Refresh
            </button>
          </>
        ) : episodeId ? (
          <>
            <h2 className="text-xl font-medium text-foreground/80 mb-2">All done!</h2>
            <p className="text-sm text-muted max-w-xs">
              No pending tracks left{episodeTitle ? ` in "${episodeTitle}"` : " in this episode"}.
            </p>
            <div className="flex gap-3 mt-6">
              <button
                onClick={() => router.push("/stacks")}
                className="px-5 py-2 text-sm bg-accent/20 hover:bg-accent/30 text-accent rounded-lg transition-colors"
              >
                Browse Stacks
              </button>
              {fromEpisodes && (
                <a
                  href="/episodes"
                  className="px-5 py-2 text-sm bg-surface-2 hover:bg-surface-3 rounded-lg text-muted hover:text-foreground transition-colors"
                >
                  Back to Episodes
                </a>
              )}
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
            <h2 className="text-xl font-medium text-foreground/80 mb-2">
              Pico&apos;s digging...
            </h2>
            <p className="text-sm text-muted max-w-xs">
              No tracks waiting right now. New discoveries will appear here when the agent finds something.
            </p>
            <button
              onClick={() => { void fetchTracks(); }}
              className="mt-6 px-5 py-2 text-sm bg-surface-2 hover:bg-surface-3 rounded-lg text-muted hover:text-foreground transition-colors"
            >
              Refresh
            </button>
          </>
        )}
      </div>
    );
  }

  // Convert current PlayerTrack to Track-like for TrackCard + context modal
  const currentTrackLike = toTrackLike(currentTrack);

  // Convert queue to TrackListItem-like for EpisodeTracklist directTracks mode
  const queueAsTracklistItems = queue.map((t) => ({
    id: t.id,
    artist: t.artist,
    title: t.title,
    status: t.vote_status || t.status || "pending",
    spotify_url: t.spotifyUrl,
    youtube_url: t.youtubeUrl || t.youtube_url || null,
    cover_art_url: t.coverArtUrl,
    preview_url: t.preview_url || t.audioUrl || null,
    audio_url: t.audioUrl,
    storage_path: t.storage_path || null,
    is_seed: t.is_seed,
    is_re_seed: t.is_re_seed,
    is_artist_seed: t.is_artist_seed,
    super_liked: t.super_liked,
    vote_status: t.vote_status || t.status || "pending",
    _match_type: t._match_type,
    _ranked_score: t._ranked_score,
    _live_mutation: liveMutationIds.has(t.id),
  }));

  // When viewing a specific seed's stack, derive seed context from URL params
  const parsedSeedContext = (() => {
    if (!seedName) return null;
    const parts = seedName.split(" — ");
    if (parts.length >= 2) return { artist: parts[0], title: parts.slice(1).join(" — ") };
    return { artist: seedName, title: "" };
  })();

  // ── Main stack view ──
  return (
    <div className={`relative px-4 pt-2 pb-0 ${mobileHeightClass} flex flex-col overflow-hidden ${desktopPlayerFrameClass}`}>
      {/* Top bar — stack identity always visible */}
      <div className="relative flex items-center justify-between mb-3 md:mb-2 md:max-w-6xl md:mx-auto md:w-full md:flex-shrink-0 min-h-[40px]">
        {/* Left: filtered views can return to their collection. Home is the FYP. */}
        {isHomeFyp ? (
          <div className="w-8 flex-shrink-0" aria-hidden="true" />
        ) : (
          <button
            onClick={handleGoBack}
            className="flex items-center gap-1.5 text-muted hover:text-foreground transition-colors flex-shrink-0 z-10"
            title={fromEpisodes ? "Back to episodes" : "All stacks"}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="15 18 9 12 15 6" />
            </svg>
            <span className="text-xs hidden md:inline">
              {fromEpisodes ? "Episodes" : "Stacks"}
            </span>
          </button>
        )}

        {/* Center: identity only; navigation lives in the app nav. */}
        <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
          <span className="text-sm font-semibold text-foreground truncate max-w-[200px] md:max-w-[400px]">
            {hasEpisodeTracks && currentEpisodeTitle
              ? currentEpisodeTitle
              : seedName
                ? seedName
                : genreFilter
                  ? genreFilter
                  : "For You"}
          </span>
          <span className="text-[10px] font-mono text-muted/60">
            {hasEpisodeTracks
              ? `${currentDisplayIndex + 1} / ${total}`
              : `${globalPlayer.queue.length} track${globalPlayer.queue.length === 1 ? "" : "s"} in queue`}
          </span>
        </div>

        {/* Right: tangent history and tracklist. */}
        <div className="z-10 flex flex-shrink-0 items-center gap-1">
          {isHomeFyp && recentTangents.length > 0 && (
            <button
              onClick={() => {
                setActiveTangent(recentTangents[0]);
                setTangentExpanded(true);
              }}
              className="relative flex h-9 w-9 items-center justify-center rounded-full text-muted transition-colors hover:bg-white/5 hover:text-foreground"
              aria-label={`Open tangent history, ${recentTangents.length} recent`}
              title="Tangent history"
            >
              <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M5 19c5-2 6-7 6-14" />
                <path d="M10 12c4 0 6-2 8-5" />
                <path d="M10 15c4 1 7 1 10-2" />
                <circle cx="18" cy="7" r="1.5" fill="currentColor" stroke="none" />
                <circle cx="20" cy="13" r="1.5" fill="currentColor" stroke="none" />
              </svg>
            </button>
          )}
          <button
            onClick={() => setTracklistOpen(!tracklistOpen)}
            className="flex h-9 w-9 items-center justify-center rounded-full text-muted transition-colors hover:bg-white/5 hover:text-foreground xl:hidden"
            title="Show tracklist"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="8" y1="6" x2="21" y2="6" />
              <line x1="8" y1="12" x2="21" y2="12" />
              <line x1="8" y1="18" x2="21" y2="18" />
              <line x1="3" y1="6" x2="3.01" y2="6" />
              <line x1="3" y1="12" x2="3.01" y2="12" />
              <line x1="3" y1="18" x2="3.01" y2="18" />
            </svg>
          </button>
        </div>
      </div>

      {isHomeFyp && activeTangent && (
        <section
          role="status"
          aria-live="polite"
          className="fyp-growth-toast absolute left-1/2 top-12 z-30 w-[min(31rem,calc(100vw-2rem))] -translate-x-1/2 rounded-2xl border border-emerald-300/20 bg-surface-1/95 p-3 shadow-[0_18px_60px_rgba(16,185,129,0.18)] backdrop-blur-md"
        >
          <div className="flex items-start gap-3">
            <svg aria-hidden="true" width="30" height="26" viewBox="0 0 30 26" fill="none" className="fyp-growth-tree mt-0.5 shrink-0 text-emerald-300">
              <path d="M4 23c6-3 7-9 8-19" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              <path d="M11 14c5 0 8-3 10-7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              <path d="M10 18c6 1 10 1 16-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              <circle cx="12" cy="4" r="2" fill="currentColor" />
              <circle cx="21" cy="7" r="2" fill="currentColor" />
              <circle cx="26" cy="14" r="2" fill="currentColor" />
            </svg>
            <div className="min-w-0 flex-1">
              <p className="text-xs font-semibold leading-snug text-foreground">{tangentHeadline(activeTangent)}</p>
              <p className="mt-1 text-[10px] leading-relaxed text-muted">{tangentDetail(activeTangent)}</p>
              {tangentExpanded && (
                <div className="mt-3 space-y-1.5 border-t border-white/10 pt-2">
                  {activeTangent.tracks.map((track, index) => (
                    <div key={track.id} className="flex items-baseline gap-2 text-[11px]">
                      <span className="font-mono text-emerald-300">{activeTangent.start_rank ? activeTangent.start_rank + index : "•"}</span>
                      <span className="truncate text-foreground">{track.artist} — {track.title}</span>
                    </div>
                  ))}
                  {activeTangent.removed_tracks.length > 0 && (
                    <p className="pt-1 text-[10px] text-muted">Left the buffer: {activeTangent.removed_tracks.map((track) => `${track.artist} — ${track.title}`).join(", ")}</p>
                  )}
                  {recentTangents.length > 1 && (
                    <div className="mt-2 border-t border-white/10 pt-2">
                      <p className="mb-1 text-[9px] font-semibold uppercase tracking-wider text-muted">Recent tangents</p>
                      <div className="flex max-h-24 flex-col gap-1 overflow-y-auto">
                        {recentTangents.slice(0, 10).map((tangent) => (
                          <button
                            key={tangent.id}
                            type="button"
                            onClick={() => setActiveTangent(tangent)}
                            className={`flex min-h-8 items-center justify-between gap-3 rounded-lg px-2 text-left text-[10px] transition-colors ${
                              tangent.id === activeTangent.id
                                ? "bg-emerald-400/10 text-emerald-200"
                                : "text-muted hover:bg-white/5 hover:text-foreground"
                            }`}
                          >
                            <span className="truncate">{tangent.seed_name}</span>
                            <time className="shrink-0 font-mono text-[9px]" dateTime={tangent.created_at}>
                              {new Date(tangent.created_at).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                            </time>
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
              <div className="mt-2 flex gap-2">
                <button onClick={() => setTangentExpanded((value) => !value)} className="text-[10px] font-semibold text-emerald-300 hover:text-emerald-200">
                  {tangentExpanded ? "Hide tracks" : "View tracks"}
                </button>
                <button
                  onClick={() => {
                    setActiveTangent(null);
                    setLiveMutationIds(new Set());
                  }}
                  className="text-[10px] text-muted hover:text-foreground"
                >
                  Dismiss
                </button>
              </div>
            </div>
          </div>
        </section>
      )}

      {/* Desktop: tracklist always visible on left, card on right */}
      <div className="flex min-h-0 flex-1 flex-col xl:mx-auto xl:w-full xl:max-w-7xl xl:flex-row xl:gap-6">
        {/* Desktop tracklist sidebar — always visible */}
        <div className="hidden xl:block xl:w-80 xl:min-w-[20rem] xl:max-w-[20rem] xl:flex-shrink-0 xl:self-stretch">
          {currentEpisodeId ? (
            <EpisodeTracklist
              episodeId={currentEpisodeId}
              episodeTitle={currentEpisodeTitle}
              listTitle={currentEpisodeTitle}
              refreshKey={voteCount}
              seedId={fromSeedId}
              onTrackSelect={handleTrackSelect}
            />
          ) : (
            <EpisodeTracklist
              directTracks={queueAsTracklistItems as any}
              listTitle={seedName || genreFilter || "For You"}
              onTrackSelect={handleTrackSelect}
            />
          )}
        </div>

        {/* Track card — fills remaining space on mobile, centered on desktop */}
        <div className={`min-h-0 flex-1 xl:flex xl:items-center xl:justify-center ${
          liveMutationIds.has(currentTrack.id) ? "fyp-card-mutation" : ""
        }`}>
          <TrackCard
            key={currentTrack.id}
            track={currentTrackLike}
            canonicalTrackId={canonicalPlayerTrackId(currentTrack)}
            onVote={handleVote}
            onSuperLike={handleSuperLike}
            onSkipEpisode={currentEpisodeId ? handleSkipEpisode : undefined}
            skippingEpisode={skippingEpisode}
            onShowContext={() => setContextOpen(true)}
            seedContext={parsedSeedContext}
          />
        </div>
      </div>

      {/* Mobile tracklist sheet — works for all views */}
      <TracklistSheet
        episodeId={currentEpisodeId || undefined}
        episodeTitle={currentEpisodeTitle}
        listTitle={currentEpisodeId ? currentEpisodeTitle : (seedName || genreFilter || "For You")}
        directTracks={currentEpisodeId ? undefined : (queueAsTracklistItems as any)}
        refreshKey={voteCount}
        seedId={fromSeedId}
        open={tracklistOpen}
        onClose={() => setTracklistOpen(false)}
        onTrackSelect={handleTrackSelect}
      />

      {/* Keyboard hint (desktop only) */}
      <div className="hidden flex-wrap justify-center gap-x-5 gap-y-1 py-3 text-xs text-muted xl:flex xl:flex-shrink-0">
        <span>← −30s</span>
        <span>→ +30s</span>
        <span>⇧→ next</span>
        <span>⇧← restart / previous</span>
        <span>x reject</span>
        <span>l like</span>
        <span>s star</span>
        <span>n no opinion</span>
        <span>r re-seed</span>
        <span>space play/pause</span>
        <span>esc close</span>
      </div>

      {/* Track context modal */}
      {contextOpen && currentTrack && (
        <TrackContextModal
          track={currentTrackLike}
          stackSource={stackSource}
          genreFilter={genreFilter}
          seedName={seedName}
          seedContext={parsedSeedContext}
          episodeTitle={hasEpisodeTracks ? currentEpisodeTitle : null}
          episodePos={hasEpisodeTracks ? currentDisplayIndex + 1 : null}
          episodeTotal={hasEpisodeTracks ? total : null}
          onClose={() => setContextOpen(false)}
        />
      )}
    </div>
  );
}

// ── Track Context Modal ──────────────────────────────────────────────────────

function discoverySourceLabel(source: string | null | undefined): string {
  if (!source) return "Unknown source";
  const labels: Record<string, string> = {
    nts: "NTS Radio",
    lotradio: "The Lot Radio",
    "1001tracklists": "1001Tracklists",
    soulection: "Soulection",
    spotify: "Spotify",
    bandcamp: "Bandcamp",
    manual: "Manual",
  };
  return labels[source.toLowerCase()] || source;
}

function TrackContextModal({
  track,
  stackSource,
  genreFilter,
  seedName,
  seedContext,
  episodeTitle,
  episodePos,
  episodeTotal,
  onClose,
}: {
  track: Track;
  stackSource: string | null;
  genreFilter: string | null;
  seedName: string | null;
  seedContext?: { artist: string; title: string } | null;
  episodeTitle: string | null;
  episodePos: number | null;
  episodeTotal: number | null;
  onClose: () => void;
}) {
  const meta = (track.metadata ?? {}) as Record<string, unknown>;
  const seedArtist = (seedContext?.artist || (track as any)._seed_artist || track.seed_track?.artist || meta.seed_artist) as string | undefined;
  const seedTitle = (seedContext?.title || (track as any)._seed_title || track.seed_track?.title || meta.seed_title) as string | undefined;
  const coOccurrence = meta.co_occurrence as number | undefined;
  const genre = meta.genre as string | undefined;
  const discoveryMethod = meta.discovery_method as string | undefined;
  const curatorSlug = meta.curator_slug as string | undefined;
  const matchType = (track as any)._match_type as string | undefined;
  const rankedSeedName = (track as any)._seed_name as string | undefined;
  const rankedScore = (track as any)._ranked_score as number | undefined;
  const scoreComponents = (track as any)._score_components as Record<string, number> | undefined;
  const displayedScoreComponents = rankingContributions(scoreComponents);
  const sourceName = discoverySourceLabel(track.episode?.source || track.source);
  const sourceUrl = track.source_url || track.episode?.url || null;
  const episodeLabel = track.episode?.title || track.source_context || episodeTitle || null;
  const seedLineage = seedArtist
    ? `${seedArtist}${seedTitle ? ` — ${seedTitle}` : ""}`
    : rankedSeedName || null;
  const explanation = explainTrackSelection({
    seriesExploration: Boolean((track as any)._series_exploration),
    seedName: seedLineage,
    tangentSeedName: (track as any)._tangent_seed_name || null,
    sonicSeedName: (track as any)._sonic_seed_name || (meta._sonic_seed_name as string | undefined) || null,
    matchType,
    episodeLabel,
    sourceName,
    curatorName: curatorSlug,
    coOccurrence,
    scoreComponents,
  });

  const modeLabel = () => {
    if (episodeTitle) return `Episode: ${episodeTitle}${episodePos && episodeTotal ? ` — track ${episodePos} of ${episodeTotal}` : ""}`;
    if (stackSource === "seed" && seedName) return `Seed stack: ${seedName}`;
    if (stackSource === "genre" && genreFilter) return `Genre filter: ${genreFilter}`;
    return "For You — ranked by taste profile";
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end md:items-center justify-center"
      onClick={onClose}
    >
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div
        className="relative w-full md:max-w-sm mx-auto bg-surface-1 border border-foreground/10 rounded-t-2xl md:rounded-2xl shadow-2xl p-5 space-y-4 md:mx-4"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-foreground">Why this track?</h3>
          <button
            onClick={onClose}
            className="w-6 h-6 flex items-center justify-center rounded-full hover:bg-foreground/10 text-foreground/40 hover:text-foreground transition-colors"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div className="rounded-xl border border-accent/20 bg-accent/[0.07] p-3">
          <p className="text-sm font-medium leading-relaxed text-foreground">{explanation.headline}</p>
          <p className="mt-1 text-xs leading-relaxed text-muted">{explanation.evidence}</p>
        </div>

        {/* Actual discovery source and episode/show context */}
        <div>
          <p className="text-[10px] text-muted uppercase tracking-wider mb-1">Source</p>
          <p className="text-sm text-foreground/80">{sourceName}</p>
        </div>
        <div>
          <p className="text-[10px] text-muted uppercase tracking-wider mb-1">Episode / Show</p>
          {episodeLabel && sourceUrl ? (
            <a
              href={sourceUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-sm text-accent hover:text-accent-bright focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 rounded underline underline-offset-2 decoration-accent/30"
            >
              {episodeLabel}
              <span aria-hidden="true">↗</span>
            </a>
          ) : episodeLabel ? (
            <p className="text-sm text-foreground/80">{episodeLabel}</p>
          ) : (
            <p className="text-sm text-muted">Episode context unavailable</p>
          )}
        </div>

        {/* Discovery Method */}
        <div>
          <p className="text-[10px] text-muted uppercase tracking-wider mb-1">Discovery Method</p>
          {discoveryMethod === "radar:curator" ? (
            <p className="text-sm text-foreground/80">
              📡 Curator Radar{curatorSlug && <span className="text-foreground/50"> · {curatorSlug}</span>}
            </p>
          ) : matchType === "artist" ? (
            <p className="text-sm text-foreground/80">
              🌿 Re-seed Discovery
              {seedArtist && (
                <span className="text-foreground/50"> · via {seedArtist}{seedTitle ? ` — ${seedTitle}` : ""}</span>
              )}
            </p>
          ) : matchType === "full" || seedLineage ? (
            <p className="text-sm text-foreground/80">🌱 Seed Discovery</p>
          ) : (
            <p className="text-sm text-muted">Discovery method unavailable</p>
          )}
        </div>

        {/* Seed lineage */}
        <div>
          <p className="text-[10px] text-muted uppercase tracking-wider mb-1">Seed Lineage</p>
          {seedLineage ? (
            <p className="text-sm text-foreground/80">{seedLineage}</p>
          ) : (
            <p className="text-sm text-muted">No seed lineage available</p>
          )}
        </div>

        {/* Mode context */}
        <div>
          <p className="text-[10px] text-muted uppercase tracking-wider mb-1">Context</p>
          <p className="text-sm text-foreground/80">{modeLabel()}</p>
        </div>

        {/* Secondary diagnostics: useful for auditing, not the explanation. */}
        {(typeof track.taste_score === "number" || genre || typeof rankedScore === "number") && (
          <details className="rounded-lg border border-foreground/10 bg-surface-2/40 px-3 py-2">
            <summary className="cursor-pointer text-xs font-medium text-muted hover:text-foreground">
              Ranking diagnostics
            </summary>
            <p className="mt-2 text-[10px] leading-relaxed text-muted">
              Relative comparison only — not a percentage or predicted chance that you will like it.
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              {typeof rankedScore === "number" && (
                <span
                  title="Relative ranking score, not a percentage"
                  className={`text-xs font-mono px-2 py-0.5 rounded ${rankedScore >= 0.25 ? "bg-green-500/15 text-green-400" : rankedScore >= 0 ? "bg-amber-500/15 text-amber-400" : "bg-red-500/15 text-red-400"}`}
                >
                  {formatRankingScore(rankedScore)}
                </span>
              )}
              {typeof rankedScore !== "number" && typeof track.taste_score === "number" && track.taste_score !== 0 && (
                <span className={`text-xs font-mono px-2 py-0.5 rounded ${track.taste_score > 0 ? "bg-green-500/15 text-green-400" : "bg-red-500/15 text-red-400"}`}>
                  taste {track.taste_score > 0 ? "+" : ""}{track.taste_score.toFixed(2)}
                </span>
              )}
              {genre && (
                <span className="text-xs px-2 py-0.5 rounded bg-surface-2 text-muted">{genre}</span>
              )}
            </div>
            {displayedScoreComponents && (
              <div className="flex flex-wrap gap-1.5 mt-1.5">
                {Object.entries(displayedScoreComponents).map(([key, val]) => (
                  val !== 0 && (
                    <span key={key} className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-surface-2 text-muted">
                      {key.replace(/_/g, " ")} {val > 0 ? "+" : ""}{val.toFixed(3)}
                    </span>
                  )
                ))}
              </div>
            )}
          </details>
        )}

        {/* Co-occurrence */}
        {coOccurrence && coOccurrence > 1 && (
          <div>
            <p className="text-[10px] text-muted uppercase tracking-wider mb-1">Co-occurrence</p>
            <p className="text-sm text-foreground/80">Appears in {coOccurrence} DJ sets with your seeds</p>
          </div>
        )}
      </div>
    </div>
  );
}
