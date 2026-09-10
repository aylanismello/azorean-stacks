"use client";

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { useGlobalPlayer, type PlayerTrack } from "@/components/GlobalPlayerProvider";
import { getFypKeyboardAction } from "@/lib/fyp-keyboard";

interface EpisodeSummary {
  id: string;
  episode_number: number;
  title: string;
  theme: string | null;
  status: "draft" | "assembling" | "ready" | "published";
  artwork_url: string | null;
  updated_at: string;
  track_count: number;
  inspiration_count: number;
}

interface EpisodeTrack {
  id: string;
  track_id: string | null;
  position: number;
  artist: string;
  title: string;
  source_origin: "stacks_like" | "stacks_super_like" | "manual";
  source_type: string;
  source_url: string | null;
  artwork_url: string | null;
  role: string | null;
  notes: string | null;
  audio_status: "not_requested" | "pending" | "processing" | "downloaded" | "reused" | "failed";
  audio_storage_path: string | null;
  audio_error: string | null;
  playable: boolean;
  metadata: Record<string, unknown>;
}

interface Inspiration {
  id: string;
  position: number;
  title: string;
  creator: string | null;
  source_type: string;
  source_url: string;
  artwork_url: string | null;
  notes: string | null;
}

interface EpisodeDetail extends EpisodeSummary {
  notes: string | null;
  artwork_storage_path: string | null;
  tracks: EpisodeTrack[];
  inspirations: Inspiration[];
}

type EpisodeTrackPatch = Partial<Omit<EpisodeTrack, "metadata">> & { bpm?: number | null };

interface LibraryTrack {
  id: string;
  artist: string;
  title: string;
  artwork_url: string | null;
  source_url: string | null;
  source_origin: "stacks_like" | "stacks_super_like";
  super_liked: boolean;
  playable: boolean;
  audio_status: "not_requested" | "ranked" | "preparing" | "ready" | "failed" | "consumed";
  audio_error: string | null;
  metadata: {
    spotify_url?: string | null;
    youtube_url?: string | null;
  };
}

interface EnrichedLink {
  url: string;
  source_type: string;
  title: string;
  creator: string;
  artwork_url: string | null;
  metadata: Record<string, unknown>;
}

interface ImportJob {
  id: string;
  source_url: string;
  source_type: "spotify" | "soundcloud" | "bandcamp" | "youtube";
  status: "pending" | "processing" | "completed" | "failed";
  total_count: number;
  imported_count: number;
  error: string | null;
}

const STATUS_LABELS: Record<EpisodeSummary["status"], string> = {
  draft: "Draft",
  assembling: "Assembling",
  ready: "Ready",
  published: "Published",
};

async function requestJson<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body as T;
}

function Artwork({ src, alt, className }: { src: string | null; alt: string; className: string }) {
  if (!src) {
    return (
      <div className={`${className} bg-gradient-to-br from-amber-300/20 via-orange-500/10 to-sky-500/20 flex items-center justify-center text-xl`}>
        ☀
      </div>
    );
  }
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={src} alt={alt} className={`${className} object-cover`} />;
}

function getTrackBpm(track: EpisodeTrack): number | null {
  const bpm = Number(track.metadata?.bpm);
  return Number.isFinite(bpm) && bpm >= 30 && bpm <= 300 ? Math.round(bpm * 10) / 10 : null;
}

function TwinSunMark({ compact = false }: { compact?: boolean }) {
  return (
    <div className={`relative shrink-0 ${compact ? "h-10 w-16" : "h-16 w-24"}`} aria-hidden="true">
      <span className="absolute left-0 top-0 h-full aspect-square rounded-full bg-[radial-gradient(circle_at_28%_25%,#ffd166_0%,#ff8a3d_48%,#f04472_100%)] shadow-[0_0_38px_rgba(255,108,76,0.24)]" />
      <span className="absolute right-0 top-0 h-full aspect-square rounded-full bg-[radial-gradient(circle_at_30%_25%,#ff7a65_0%,#ed3f85_54%,#a92b79_100%)] mix-blend-screen opacity-95" />
    </div>
  );
}

export default function SegundoSolPage() {
  const globalPlayer = useGlobalPlayer();
  const [episodes, setEpisodes] = useState<EpisodeSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [episode, setEpisode] = useState<EpisodeDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [builderTab, setBuilderTab] = useState<"library" | "import" | "link" | "inspiration">("library");
  const [libraryKind, setLibraryKind] = useState<"all" | "super_liked" | "approved">("all");
  const [librarySearch, setLibrarySearch] = useState("");
  const [library, setLibrary] = useState<LibraryTrack[]>([]);
  const [libraryLoading, setLibraryLoading] = useState(false);
  const [addingIds, setAddingIds] = useState<Set<string>>(new Set());
  const [manualUrl, setManualUrl] = useState("");
  const [manualLink, setManualLink] = useState<EnrichedLink | null>(null);
  const [inspirationUrl, setInspirationUrl] = useState("");
  const [inspirationLink, setInspirationLink] = useState<EnrichedLink | null>(null);
  const [enriching, setEnriching] = useState<"track" | "inspiration" | null>(null);
  const [uploading, setUploading] = useState(false);
  const [importUrl, setImportUrl] = useState("");
  const [importJob, setImportJob] = useState<ImportJob | null>(null);
  const [importing, setImporting] = useState(false);
  const [draggedTrackId, setDraggedTrackId] = useState<string | null>(null);
  const [dragOverTrackId, setDragOverTrackId] = useState<string | null>(null);
  const [reordering, setReordering] = useState(false);
  const [loadingAudioIdentity, setLoadingAudioIdentity] = useState<string | null>(null);
  const [bpmDrafts, setBpmDrafts] = useState<Record<string, string>>({});

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (!globalPlayer.currentTrack) return;

      const target = event.target as HTMLElement | null;
      const tag = target?.tagName;
      if (
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        target?.isContentEditable
      ) return;

      const action = getFypKeyboardAction(event);
      if (action === "seek-backward") {
        event.preventDefault();
        globalPlayer.seek(globalPlayer.progress - 30);
      } else if (action === "seek-forward") {
        event.preventDefault();
        globalPlayer.seek(globalPlayer.progress + 30);
      } else if (action === "next-track") {
        event.preventDefault();
        globalPlayer.next();
      } else if (action === "previous-track") {
        event.preventDefault();
        if (globalPlayer.progress > 3) globalPlayer.seek(0);
        else globalPlayer.prev();
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [globalPlayer]);

  const loadEpisodes = useCallback(async () => {
    try {
      const data = await requestJson<{ episodes: EpisodeSummary[] }>("/api/segundo-sol/episodes");
      setEpisodes(data.episodes);
      setSelectedId((current) => current || data.episodes[0]?.id || null);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load episodes");
    } finally {
      setLoading(false);
    }
  }, []);

  const loadEpisode = useCallback(async (id: string) => {
    setDetailLoading(true);
    try {
      const data = await requestJson<{ episode: EpisodeDetail }>(`/api/segundo-sol/episodes/${id}`);
      setEpisode({
        ...data.episode,
        track_count: data.episode.tracks.length,
        inspiration_count: data.episode.inspirations.length,
      });
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load episode");
    } finally {
      setDetailLoading(false);
    }
  }, []);

  useEffect(() => {
    loadEpisodes();
  }, [loadEpisodes]);

  useEffect(() => {
    if (selectedId) loadEpisode(selectedId);
    else setEpisode(null);
    setImportJob(null);
    setImportUrl("");
  }, [selectedId, loadEpisode]);

  useEffect(() => {
    if (!episode || !importJob || !["pending", "processing"].includes(importJob.status)) return;
    const poll = window.setInterval(async () => {
      try {
        const data = await requestJson<{ job: ImportJob }>(`/api/segundo-sol/episodes/${episode.id}/imports/${importJob.id}`);
        setImportJob(data.job);
        if (data.job.status === "completed") {
          setImporting(false);
          await loadEpisode(episode.id);
        } else if (data.job.status === "failed") {
          setImporting(false);
          setError(data.job.error || "Source import failed");
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not read import status");
      }
    }, 3000);
    return () => window.clearInterval(poll);
  }, [episode?.id, importJob?.id, importJob?.status, loadEpisode]);

  const loadLibrary = useCallback(async () => {
    setLibraryLoading(true);
    try {
      const params = new URLSearchParams({ kind: libraryKind, limit: "80" });
      if (librarySearch.trim()) params.set("search", librarySearch.trim());
      const data = await requestJson<{ tracks: LibraryTrack[] }>(`/api/segundo-sol/library?${params}`);
      setLibrary(data.tracks);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load library");
    } finally {
      setLibraryLoading(false);
    }
  }, [libraryKind, librarySearch]);

  useEffect(() => {
    if (builderTab !== "library") return;
    const timeout = setTimeout(loadLibrary, 250);
    return () => clearTimeout(timeout);
  }, [builderTab, loadLibrary]);

  const updateSummary = useCallback((current: EpisodeDetail) => {
    setEpisodes((items) => items.map((item) => item.id === current.id
      ? {
          ...item,
          episode_number: current.episode_number,
          title: current.title,
          theme: current.theme,
          status: current.status,
          artwork_url: current.artwork_url,
          track_count: current.tracks.length,
          inspiration_count: current.inspirations.length,
        }
      : item));
  }, []);

  const createEpisode = async () => {
    setCreating(true);
    try {
      const data = await requestJson<{ episode: EpisodeSummary }>("/api/segundo-sol/episodes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      setEpisodes((items) => [data.episode, ...items]);
      setSelectedId(data.episode.id);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create episode");
    } finally {
      setCreating(false);
    }
  };

  const patchEpisode = async (patch: Partial<EpisodeDetail>) => {
    if (!episode) return;
    const optimistic = { ...episode, ...patch };
    setEpisode(optimistic);
    updateSummary(optimistic);
    setSaveState("saving");
    try {
      const data = await requestJson<{ episode: EpisodeDetail }>(`/api/segundo-sol/episodes/${episode.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const merged = { ...optimistic, ...data.episode };
      setEpisode(merged);
      updateSummary(merged);
      setSaveState("saved");
      setTimeout(() => setSaveState("idle"), 1400);
    } catch (err) {
      setSaveState("error");
      setError(err instanceof Error ? err.message : "Failed to save episode");
      loadEpisode(episode.id);
    }
  };

  const deleteEpisode = async () => {
    if (!episode || !window.confirm(`Delete Episode ${episode.episode_number}: ${episode.title}?`)) return;
    try {
      await requestJson(`/api/segundo-sol/episodes/${episode.id}`, { method: "DELETE" });
      const remaining = episodes.filter((item) => item.id !== episode.id);
      setEpisodes(remaining);
      setSelectedId(remaining[0]?.id || null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete episode");
    }
  };

  const uploadArtwork = async (file: File) => {
    if (!episode) return;
    setUploading(true);
    try {
      const form = new FormData();
      form.append("file", file);
      const uploaded = await requestJson<{ artwork_url: string; storage_path: string }>("/api/segundo-sol/artwork", {
        method: "POST",
        body: form,
      });
      await patchEpisode({ artwork_url: uploaded.artwork_url, artwork_storage_path: uploaded.storage_path });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Artwork upload failed");
    } finally {
      setUploading(false);
    }
  };

  const startImport = async () => {
    if (!episode || !importUrl.trim() || importing) return;
    setImporting(true);
    setError(null);
    try {
      const data = await requestJson<{ job: ImportJob }>(`/api/segundo-sol/episodes/${episode.id}/imports`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source_url: importUrl }),
      });
      setImportJob(data.job);
    } catch (err) {
      setImporting(false);
      setError(err instanceof Error ? err.message : "Could not queue that source");
    }
  };

  const isEpisodeTrackActive = (track: EpisodeTrack) => {
    const current = globalPlayer.currentTrack;
    return Boolean(current && (
      current.id === `segundo-sol:${track.id}` ||
      (track.track_id && current.catalogTrackId === track.track_id) ||
      (track.track_id && current.id === track.track_id)
    ));
  };

  const isLibraryTrackActive = (track: LibraryTrack) => {
    const current = globalPlayer.currentTrack;
    return Boolean(current && (current.id === track.id || current.catalogTrackId === track.id));
  };

  const activeTrackIsLoading = (active: boolean, identity: string) =>
    loadingAudioIdentity === identity || (active && (globalPlayer.loading || globalPlayer.buffering));

  const playerTrackForEpisode = useCallback((track: EpisodeTrack, audioUrl: string | null = null): PlayerTrack => ({
    id: `segundo-sol:${track.id}`,
    catalogTrackId: track.track_id,
    artist: track.artist,
    title: track.title,
    coverArtUrl: track.artwork_url,
    spotifyUrl: null,
    audioUrl,
    youtubeUrl: null,
    audioRefreshUrl: episode
      ? `/api/segundo-sol/episodes/${episode.id}/tracks/${track.id}/audio`
      : null,
    episodeTitle: episode?.title || null,
  }), [episode?.id, episode?.title]);

  const episodeQueue = useMemo(
    () => (episode?.tracks || []).filter((track) => track.playable).map((track) => playerTrackForEpisode(track)),
    [episode?.tracks, playerTrackForEpisode],
  );

  useEffect(() => {
    if (!episode) return;
    globalPlayer.setQueue(episodeQueue);
  }, [episode?.id, episodeQueue, globalPlayer.setQueue]);

  const waitForPreparedAudio = async (
    endpoint: string,
    onStatus: (status: string, message: string | null) => void,
  ): Promise<string> => {
    for (let attempt = 0; attempt < 160; attempt += 1) {
      const response = await fetch(endpoint, { cache: "no-store" });
      const body = await response.json().catch(() => ({})) as {
        url?: string;
        status?: string;
        error?: string | null;
      };
      if (response.ok && response.status !== 202 && body.url) return body.url;
      if (response.status === 202) {
        onStatus(body.status || "pending", body.error || null);
        if (body.status === "failed") throw new Error(body.error || "Audio preparation failed");
        await new Promise((resolve) => window.setTimeout(resolve, 2_500));
        continue;
      }
      throw new Error(body.error || `Could not prepare audio (${response.status})`);
    }
    throw new Error("Audio is still preparing. You can leave this page and try again shortly.");
  };

  const openAudio = async (track: EpisodeTrack) => {
    if (!episode) return;
    const playerId = `segundo-sol:${track.id}`;
    if (isEpisodeTrackActive(track)) {
      globalPlayer.togglePlayPause();
      return;
    }

    if (track.playable) {
      const queueIndex = episodeQueue.findIndex((item) => item.id === playerId);
      if (queueIndex >= 0) {
        globalPlayer.setQueue(episodeQueue, queueIndex);
        globalPlayer.playFromQueue(queueIndex, "/segundo-sol");
        return;
      }
    }

    if (!track.source_url) {
      setError("This track does not have a downloadable source yet.");
      return;
    }

    const audioIdentity = track.track_id || playerId;
    setLoadingAudioIdentity(audioIdentity);
    setError(null);
    try {
      const endpoint = `/api/segundo-sol/episodes/${episode.id}/tracks/${track.id}/audio`;
      const queued = await requestJson<{ status: EpisodeTrack["audio_status"] }>(endpoint, { method: "POST" });
      setEpisode((current) => current ? {
        ...current,
        tracks: current.tracks.map((item) => item.id === track.id
          ? { ...item, audio_status: queued.status || "pending", audio_error: null }
          : item),
      } : current);
      const audioUrl = await waitForPreparedAudio(endpoint, (status, message) => {
        setEpisode((current) => current ? {
          ...current,
          tracks: current.tracks.map((item) => item.id === track.id
            ? {
                ...item,
                audio_status: (status === "preparing" || status === "processing" ? "processing" : status) as EpisodeTrack["audio_status"],
                audio_error: message,
              }
            : item),
        } : current);
      });
      setEpisode((current) => current ? {
        ...current,
        tracks: current.tracks.map((item) => item.id === track.id
          ? { ...item, playable: true, audio_status: "downloaded", audio_error: null }
          : item),
      } : current);
      globalPlayer.play(playerTrackForEpisode({ ...track, playable: true, audio_status: "downloaded" }, audioUrl), "/segundo-sol");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not play audio");
    } finally {
      setLoadingAudioIdentity(null);
    }
  };

  const previewLibraryTrack = async (track: LibraryTrack) => {
    if (isLibraryTrackActive(track)) {
      globalPlayer.togglePlayPause();
      return;
    }
    setLoadingAudioIdentity(track.id);
    setError(null);
    try {
      const endpoint = `/api/segundo-sol/library/${track.id}/audio`;
      if (!track.playable) {
        const queued = await requestJson<{ status: string }>(endpoint, { method: "POST" });
        setLibrary((items) => items.map((item) => item.id === track.id
          ? { ...item, audio_status: queued.status === "resolving" ? "ranked" : queued.status as LibraryTrack["audio_status"], audio_error: null }
          : item));
      }
      const audioUrl = await waitForPreparedAudio(endpoint, (status, message) => {
        setLibrary((items) => items.map((item) => item.id === track.id
          ? { ...item, audio_status: status as LibraryTrack["audio_status"], audio_error: message }
          : item));
      });
      setLibrary((items) => items.map((item) => item.id === track.id
        ? { ...item, playable: true, audio_status: "ready", audio_error: null }
        : item));
      globalPlayer.play({
        id: track.id,
        catalogTrackId: track.id,
        artist: track.artist,
        title: track.title,
        coverArtUrl: track.artwork_url,
        spotifyUrl: null,
        audioUrl,
        youtubeUrl: null,
        audioRefreshUrl: endpoint,
      }, "/segundo-sol");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not preview track");
    } finally {
      setLoadingAudioIdentity(null);
    }
  };

  const addedTrackIds = useMemo(
    () => new Set((episode?.tracks || []).map((track) => track.track_id).filter(Boolean)),
    [episode?.tracks]
  );

  const addLibraryTrack = async (track: LibraryTrack) => {
    if (!episode || addingIds.has(track.id) || addedTrackIds.has(track.id)) return;
    setAddingIds((ids) => new Set(ids).add(track.id));
    try {
      const data = await requestJson<{ track: EpisodeTrack }>(`/api/segundo-sol/episodes/${episode.id}/tracks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ track_id: track.id }),
      });
      const addedTrack = { ...data.track, playable: track.playable };
      const next = { ...episode, tracks: [...episode.tracks, addedTrack] };
      setEpisode(next);
      updateSummary(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add track");
    } finally {
      setAddingIds((ids) => {
        const next = new Set(ids);
        next.delete(track.id);
        return next;
      });
    }
  };

  const enrichLink = async (kind: "track" | "inspiration") => {
    const url = kind === "track" ? manualUrl : inspirationUrl;
    if (!url.trim()) return;
    setEnriching(kind);
    try {
      const data = await requestJson<{ link: EnrichedLink }>("/api/segundo-sol/enrich", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      if (kind === "track") setManualLink(data.link);
      else setInspirationLink(data.link);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not read that link");
    } finally {
      setEnriching(null);
    }
  };

  const addManualTrack = async () => {
    if (!episode || !manualLink) return;
    try {
      const data = await requestJson<{ track: EpisodeTrack }>(`/api/segundo-sol/episodes/${episode.id}/tracks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source_url: manualLink.url,
          artist: manualLink.creator,
          title: manualLink.title,
          artwork_url: manualLink.artwork_url,
          metadata: manualLink.metadata,
        }),
      });
      const next = { ...episode, tracks: [...episode.tracks, data.track] };
      setEpisode(next);
      updateSummary(next);
      setManualUrl("");
      setManualLink(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add track");
    }
  };

  const addInspiration = async () => {
    if (!episode || !inspirationLink) return;
    try {
      const data = await requestJson<{ inspiration: Inspiration }>(`/api/segundo-sol/episodes/${episode.id}/inspirations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source_url: inspirationLink.url,
          title: inspirationLink.title,
          creator: inspirationLink.creator,
          artwork_url: inspirationLink.artwork_url,
          metadata: inspirationLink.metadata,
        }),
      });
      const next = { ...episode, inspirations: [...episode.inspirations, data.inspiration] };
      setEpisode(next);
      updateSummary(next);
      setInspirationUrl("");
      setInspirationLink(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add inspiration");
    }
  };

  const patchTrack = async (trackId: string, patch: EpisodeTrackPatch) => {
    if (!episode) return;
    const { bpm, ...trackPatch } = patch;
    setEpisode({
      ...episode,
      tracks: episode.tracks.map((track) => track.id === trackId
        ? {
            ...track,
            ...trackPatch,
            metadata: "bpm" in patch ? { ...track.metadata, bpm: bpm ?? null } : track.metadata,
          }
        : track),
    });
    try {
      await requestJson(`/api/segundo-sol/episodes/${episode.id}/tracks/${trackId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update track");
      loadEpisode(episode.id);
    }
  };

  const commitBpm = (track: EpisodeTrack) => {
    const draft = bpmDrafts[track.id];
    if (draft === undefined) return;
    const trimmed = draft.trim();
    const parsed = trimmed === "" ? null : Number(trimmed);
    if (parsed !== null && (!Number.isFinite(parsed) || parsed < 30 || parsed > 300)) {
      setError("BPM must be between 30 and 300.");
      setBpmDrafts((current) => {
        const next = { ...current };
        delete next[track.id];
        return next;
      });
      return;
    }
    const bpm = parsed === null ? null : Math.round(parsed * 10) / 10;
    setBpmDrafts((current) => {
      const next = { ...current };
      delete next[track.id];
      return next;
    });
    void patchTrack(track.id, { bpm });
  };

  const reorderTracks = async (fromIndex: number, targetIndex: number) => {
    if (!episode) return;
    if (fromIndex === targetIndex || fromIndex < 0 || targetIndex < 0 || targetIndex >= episode.tracks.length) return;
    const tracks = [...episode.tracks];
    const [moved] = tracks.splice(fromIndex, 1);
    tracks.splice(targetIndex, 0, moved);
    const normalized = tracks.map((track, position) => ({ ...track, position }));
    setEpisode({ ...episode, tracks: normalized });
    setReordering(true);
    try {
      await requestJson(`/api/segundo-sol/episodes/${episode.id}/tracks/reorder`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ track_ids: normalized.map((track) => track.id) }),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to reorder tracks");
      loadEpisode(episode.id);
    } finally {
      setReordering(false);
    }
  };

  const moveTrack = (index: number, direction: -1 | 1) =>
    reorderTracks(index, index + direction);

  const dropTrack = (targetTrackId: string) => {
    if (!episode || !draggedTrackId) return;
    const fromIndex = episode.tracks.findIndex((track) => track.id === draggedTrackId);
    const targetIndex = episode.tracks.findIndex((track) => track.id === targetTrackId);
    setDraggedTrackId(null);
    setDragOverTrackId(null);
    void reorderTracks(fromIndex, targetIndex);
  };

  const removeTrack = async (trackId: string) => {
    if (!episode) return;
    try {
      await requestJson(`/api/segundo-sol/episodes/${episode.id}/tracks/${trackId}`, { method: "DELETE" });
      setEpisode((current) => current
        ? { ...current, tracks: current.tracks.filter((track) => track.id !== trackId) }
        : current);
      setEpisodes((items) => items.map((item) => item.id === episode.id
        ? { ...item, track_count: Math.max(0, item.track_count - 1) }
        : item));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to remove track");
    }
  };

  const removeInspiration = async (id: string) => {
    if (!episode) return;
    try {
      await requestJson(`/api/segundo-sol/episodes/${episode.id}/inspirations/${id}`, { method: "DELETE" });
      setEpisode((current) => current
        ? { ...current, inspirations: current.inspirations.filter((item) => item.id !== id) }
        : current);
      setEpisodes((items) => items.map((item) => item.id === episode.id
        ? { ...item, inspiration_count: Math.max(0, item.inspiration_count - 1) }
        : item));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to remove inspiration");
    }
  };

  return (
    <main
      className="min-h-screen pb-28 md:pb-16 relative overflow-hidden bg-surface-0 text-foreground"
      style={{
        "--surface-0": "15 7 18",
        "--surface-1": "29 13 29",
        "--surface-2": "45 20 40",
        "--surface-3": "78 33 62",
        "--surface-4": "112 45 78",
        "--accent": "255 112 67",
        "--accent-dim": "224 71 96",
        "--accent-bright": "255 184 88",
        "--muted": "201 166 185",
        "--foreground": "255 248 241",
      } as CSSProperties}
    >
      <div className="pointer-events-none absolute inset-x-0 top-0 h-[600px] bg-[radial-gradient(ellipse_at_15%_0%,rgba(255,153,65,0.30),transparent_48%),radial-gradient(ellipse_at_78%_5%,rgba(236,58,132,0.26),transparent_46%),linear-gradient(180deg,rgba(83,19,65,0.34),transparent_80%)]" />
      <div className="relative max-w-[1500px] mx-auto px-3 sm:px-6 py-3 sm:py-10">
        <header className="mb-4 sm:mb-7 flex flex-row items-center justify-between gap-3 sm:gap-5 rounded-2xl sm:rounded-3xl border border-fuchsia-300/15 bg-[#1d0d1d]/80 p-3 sm:p-7 backdrop-blur-xl shadow-[0_20px_60px_rgba(0,0,0,0.24)]">
          <div className="flex items-center gap-3 sm:gap-5 min-w-0">
            <TwinSunMark compact />
            <div className="min-w-0">
              <div className="text-orange-200 text-[9px] sm:text-xs font-semibold uppercase tracking-[0.2em] sm:tracking-[0.25em] mb-1 sm:mb-2">Private session studio</div>
              <h1 className="text-xl sm:text-5xl font-bold tracking-[-0.045em] leading-[0.95] text-white truncate">
                Segundo Sol <span className="bg-gradient-to-r from-orange-300 via-rose-400 to-fuchsia-400 bg-clip-text text-transparent">Sessions</span>
              </h1>
              <p className="hidden sm:block mt-3 text-sm sm:text-base text-[#e5c9d8] max-w-2xl leading-relaxed">
                Build each session from first spark to final tracklist. Stacks finds it; PicoDrops brings it home.
              </p>
            </div>
          </div>
          <div className="hidden md:flex flex-wrap gap-2 text-xs">
            <a href="https://discord.com/channels/1483358401936363745/1483370489865834517" target="_blank" rel="noreferrer" className="px-3 py-2 rounded-full border border-amber-300/20 bg-amber-300/5 text-amber-200 hover:bg-amber-300/10">Segundo Sol ↗</a>
            <a href="https://discord.com/channels/1483358401936363745/1483370493850423389" target="_blank" rel="noreferrer" className="px-3 py-2 rounded-full border border-sky-300/15 bg-sky-300/5 text-sky-200 hover:bg-sky-300/10">PicoDrops ↗</a>
          </div>
        </header>

        {error && (
          <div className="mb-5 flex items-start justify-between gap-4 rounded-xl border border-red-400/20 bg-red-400/10 px-4 py-3 text-sm text-red-300">
            <span>{error}</span>
            <button onClick={() => setError(null)} className="text-red-200/60 hover:text-red-200">×</button>
          </div>
        )}

        <div className="grid grid-cols-1 2xl:grid-cols-[290px_minmax(0,1fr)] gap-5">
          <aside className="rounded-2xl border border-white/10 bg-surface-1/80 backdrop-blur-xl overflow-hidden self-start 2xl:sticky 2xl:top-5">
            <div className="p-4 border-b border-surface-3 flex items-center justify-between">
              <div>
                <p className="text-xs uppercase tracking-[0.22em] text-muted">Episodes</p>
                <p className="text-xs text-foreground/50 mt-1">{episodes.length} in the archive</p>
              </div>
              <button onClick={createEpisode} disabled={creating} className="px-3 py-2 rounded-lg bg-amber-300 text-black text-xs font-semibold hover:bg-amber-200 disabled:opacity-50">
                {creating ? "Making…" : "+ New"}
              </button>
            </div>
            <div className="2xl:hidden p-2">
              {episodes.length > 0 ? (
                <select value={selectedId || ""} onChange={(event) => setSelectedId(event.target.value)} className="w-full rounded-xl border border-white/10 bg-surface-2 px-3 py-3 text-sm font-medium text-white outline-none focus:border-amber-300/40">
                  {episodes.map((item) => (
                    <option key={item.id} value={item.id}>#{item.episode_number} · {item.title} · {item.track_count} tracks</option>
                  ))}
                </select>
              ) : !loading ? (
                <button onClick={createEpisode} className="w-full rounded-xl border border-dashed border-amber-300/25 p-4 text-left text-sm text-amber-100">Start Segundo Sol Sessions #1 →</button>
              ) : null}
            </div>
            <div className="hidden 2xl:block p-2 max-h-[70vh] overflow-y-auto">
              {loading ? (
                <div className="p-5 text-sm text-muted">Loading the archive…</div>
              ) : episodes.length === 0 ? (
                <button onClick={createEpisode} className="w-full p-6 text-left rounded-xl border border-dashed border-amber-300/20 text-sm text-muted hover:text-foreground hover:border-amber-300/40">
                  Start Segundo Sol Sessions #1 →
                </button>
              ) : episodes.map((item) => (
                <button key={item.id} onClick={() => setSelectedId(item.id)} className={`min-w-[230px] 2xl:min-w-0 w-full text-left p-3 rounded-xl mb-0 2xl:mb-1 transition-all ${selectedId === item.id ? "bg-amber-300/10 ring-1 ring-amber-300/25" : "hover:bg-surface-2"}`}>
                  <div className="flex gap-3">
                    <Artwork src={item.artwork_url} alt="" className="w-12 h-12 rounded-lg shrink-0" />
                    <div className="min-w-0 flex-1">
                      <div className="flex justify-between gap-2 text-[10px] uppercase tracking-wider text-muted">
                        <span>Episode {item.episode_number}</span>
                        <span>{STATUS_LABELS[item.status]}</span>
                      </div>
                      <p className="mt-1 text-sm font-medium truncate text-foreground/90">{item.title}</p>
                      <p className="mt-1 text-[11px] text-foreground/40">
                        {item.track_count} track{item.track_count === 1 ? "" : "s"} · {item.inspiration_count} reference{item.inspiration_count === 1 ? "" : "s"}
                      </p>
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </aside>

          <section className="min-w-0">
            {!episode || detailLoading ? (
              <div className="rounded-2xl border border-white/10 bg-surface-1/70 min-h-[420px] flex items-center justify-center text-sm text-muted">
                {detailLoading ? "Opening session…" : "Create a Segundo Sol Session to begin."}
              </div>
            ) : (
              <div className="space-y-5">
                <div className="rounded-2xl border border-white/10 bg-surface-1/80 backdrop-blur-xl p-3 sm:p-6">
                  <div className="grid grid-cols-[82px_minmax(0,1fr)] md:grid-cols-[180px_minmax(0,1fr)] gap-3 md:gap-7">
                    <label className="group relative cursor-pointer w-full mx-auto">
                      <Artwork src={episode.artwork_url} alt={`Artwork for ${episode.title}`} className="w-full aspect-square rounded-2xl shadow-2xl" />
                      <span className="absolute inset-x-1 bottom-1 text-center rounded-md bg-black/75 px-1 py-1 text-[9px] sm:inset-x-3 sm:bottom-3 sm:rounded-lg sm:px-3 sm:py-2 sm:text-xs text-white opacity-100 sm:opacity-0 group-hover:opacity-100 transition-opacity">
                        {uploading ? "Uploading…" : "Artwork"}
                      </span>
                      <input type="file" accept="image/jpeg,image/png,image/webp,image/gif" className="hidden" disabled={uploading} onChange={(event) => { const file = event.target.files?.[0]; if (file) uploadArtwork(file); event.target.value = ""; }} />
                    </label>
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-1.5 sm:gap-2 mb-2 sm:mb-4">
                        <label className="flex items-center gap-1.5 rounded-lg bg-surface-2 px-2 sm:px-3 py-1.5 sm:py-2 text-[10px] sm:text-xs text-muted">
                          <span className="hidden sm:inline">Episode</span>#
                          <input type="number" min="1" value={episode.episode_number} onChange={(event) => setEpisode({ ...episode, episode_number: Number(event.target.value) })} onBlur={() => patchEpisode({ episode_number: episode.episode_number })} className="w-14 bg-transparent text-foreground outline-none" />
                        </label>
                        <select value={episode.status} onChange={(event) => patchEpisode({ status: event.target.value as EpisodeSummary["status"] })} className="rounded-lg bg-surface-2 border border-surface-3 px-3 py-2 text-xs text-foreground outline-none">
                          {Object.entries(STATUS_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                        </select>
                        <span className={`text-[11px] ${saveState === "error" ? "text-red-300" : "text-muted"}`}>
                          {saveState === "saving" ? "Saving…" : saveState === "saved" ? "Saved" : saveState === "error" ? "Save failed" : "Auto-saves on blur"}
                        </span>
                        <button onClick={deleteEpisode} className="ml-auto text-[10px] sm:text-xs text-red-300/60 hover:text-red-300"><span className="sm:hidden">Delete</span><span className="hidden sm:inline">Delete episode</span></button>
                      </div>
                      <input value={episode.title} onChange={(event) => setEpisode({ ...episode, title: event.target.value })} onBlur={() => patchEpisode({ title: episode.title })} className="w-full min-w-0 bg-transparent text-lg sm:text-3xl font-semibold tracking-tight text-white outline-none border-b border-transparent focus:border-rose-300/50 pb-1" placeholder={`Segundo Sol Sessions #${episode.episode_number}`} />
                      <input value={episode.theme || ""} onChange={(event) => setEpisode({ ...episode, theme: event.target.value })} onBlur={() => patchEpisode({ theme: episode.theme })} className="mt-1 sm:mt-2 w-full bg-transparent text-sm sm:text-base text-amber-200/80 outline-none border-b border-transparent focus:border-amber-300/20 pb-1" placeholder="Theme / feeling / arc" />
                      <textarea value={episode.notes || ""} onChange={(event) => setEpisode({ ...episode, notes: event.target.value })} onBlur={() => patchEpisode({ notes: episode.notes })} rows={2} className="mt-2 sm:mt-4 w-full rounded-lg sm:rounded-xl bg-surface-2/70 border border-surface-3 px-3 sm:px-4 py-2 sm:py-3 text-xs sm:text-sm text-foreground/80 outline-none focus:border-amber-300/30 resize-y" placeholder="Notes, transitions, texture…" />
                    </div>
                  </div>
                </div>

                <div className="rounded-2xl border border-white/10 bg-surface-1/80 backdrop-blur-xl overflow-hidden">
                  <div className="flex overflow-x-auto border-b border-surface-3 p-2 gap-1 [scrollbar-width:none]">
                    {([
                      ["library", "From Stacks"],
                      ["import", "Import source"],
                      ["link", "Paste one track"],
                      ["inspiration", "Inspiration mix"],
                    ] as const).map(([value, label]) => (
                      <button key={value} onClick={() => setBuilderTab(value)} className={`shrink-0 px-3 py-2.5 rounded-lg text-xs sm:text-sm text-center leading-tight ${builderTab === value ? "bg-amber-300/10 text-amber-200" : "text-muted hover:text-foreground hover:bg-surface-2"}`}>
                        {label}
                      </button>
                    ))}
                  </div>

                  {builderTab === "library" && (
                    <div className="p-4 sm:p-5">
                      <div className="flex flex-col lg:flex-row gap-2 mb-4">
                        <input value={librarySearch} onChange={(event) => setLibrarySearch(event.target.value)} className="flex-1 rounded-xl bg-surface-2 border border-surface-3 px-4 py-2.5 text-sm outline-none focus:border-amber-300/30" placeholder="Search your kept tracks…" />
                        <div className="grid grid-cols-3 w-full lg:w-auto rounded-xl bg-surface-2 p-1">
                          {(["all", "super_liked", "approved"] as const).map((kind) => (
                            <button key={kind} onClick={() => setLibraryKind(kind)} className={`px-3 py-2 rounded-lg text-xs text-center ${libraryKind === kind ? "bg-surface-4 text-foreground" : "text-muted"}`}>
                              {kind === "super_liked" ? "Stars" : kind === "approved" ? "Likes" : "All"}
                            </button>
                          ))}
                        </div>
                      </div>
                      <div className="grid sm:grid-cols-2 2xl:grid-cols-3 gap-2 max-h-[360px] overflow-y-auto pr-1">
                        {libraryLoading ? <p className="p-4 text-sm text-muted">Opening your Stacks crate…</p> : library.map((track) => {
                          const added = addedTrackIds.has(track.id);
                          const active = isLibraryTrackActive(track);
                          const audioLoading = activeTrackIsLoading(active, track.id);
                          const audioLabel = audioLoading
                            ? "preparing audio…"
                            : active
                              ? globalPlayer.playing ? "playing" : "paused"
                              : track.playable
                                ? "ready to play"
                                : track.audio_status === "failed"
                                  ? "preparation failed · tap to retry"
                                  : track.audio_status === "preparing"
                                    ? "preparing audio…"
                                    : track.audio_status === "ranked"
                                      ? "queued for download"
                                      : "tap to prepare audio";
                          return (
                            <div key={track.id} className={`min-w-0 w-full overflow-hidden flex items-center gap-3 rounded-xl p-2.5 border transition-colors ${active ? "bg-orange-300/10 border-orange-300/35" : audioLoading ? "bg-amber-300/[0.07] border-amber-300/20" : "bg-surface-2/70 border-transparent hover:border-surface-4"}`}>
                              <button
                                onClick={() => previewLibraryTrack(track)}
                                aria-label={track.playable ? `${active && globalPlayer.playing ? "Pause" : "Preview"} ${track.title}` : `Prepare ${track.title} audio`}
                                className="relative w-11 h-11 rounded-lg overflow-hidden shrink-0 group/preview ring-1 ring-white/10 active:scale-95 transition-transform"
                              >
                                <Artwork src={track.artwork_url} alt="" className="w-11 h-11 rounded-lg transition-opacity group-hover/preview:opacity-70" />
                                <span className="absolute inset-0 grid place-items-center text-sm text-white bg-black/35 group-hover/preview:bg-black/55 transition-colors">
                                  {audioLoading ? (
                                    <span className="h-5 w-5 rounded-full border-2 border-white/35 border-t-white animate-spin" />
                                  ) : active && globalPlayer.playing ? "Ⅱ" : track.playable ? "▶" : track.audio_status === "failed" ? "↻" : "↓"}
                                </span>
                              </button>
                              <div className="min-w-0 flex-1">
                                <p className={`text-sm font-medium truncate ${active ? "text-orange-100" : ""}`}>{track.title}</p>
                                <p className="text-xs text-muted truncate">{track.artist}</p>
                                <p className={`mt-0.5 text-[9px] uppercase tracking-wider ${track.audio_status === "failed" ? "text-red-300" : active || audioLoading ? "text-orange-300" : track.playable ? "text-emerald-300/70" : "text-amber-200/70"}`}>{audioLabel}</p>
                              </div>
                              <button onClick={() => addLibraryTrack(track)} disabled={added || addingIds.has(track.id)} className={`w-8 h-8 rounded-lg text-sm ${added ? "bg-green-400/10 text-green-300" : "bg-amber-300 text-black hover:bg-amber-200"}`}>
                                {added ? "✓" : addingIds.has(track.id) ? "…" : "+"}
                              </button>
                            </div>
                          );
                        })}
                        {!libraryLoading && library.length === 0 && <p className="p-4 text-sm text-muted">No matching likes or stars.</p>}
                      </div>
                    </div>
                  )}

                  {builderTab === "import" && (
                    <div className="p-4 sm:p-5">
                      <div className="mb-4">
                        <h3 className="text-lg font-semibold text-white">Bring a source into this session</h3>
                        <p className="mt-1 text-sm text-[#d9b8ca]">Paste a playlist, release, or track. The local PicoDrops engine resolves it, reuses clean files when possible, downloads what is missing, and serves private session audio here.</p>
                      </div>
                      <div className="mb-4 flex flex-wrap gap-2 text-xs">
                        {[
                          ["Spotify", "playlist"],
                          ["SoundCloud", "track or playlist"],
                          ["Bandcamp", "track or release"],
                          ["YouTube", "video or playlist"],
                        ].map(([provider, kind]) => (
                          <span key={provider} className="rounded-full border border-rose-300/20 bg-rose-300/10 px-3 py-1.5 text-rose-100">
                            <strong>{provider}</strong> · {kind}
                          </span>
                        ))}
                      </div>
                      <div className="flex flex-col sm:flex-row gap-2">
                        <input value={importUrl} onChange={(event) => { setImportUrl(event.target.value); setImportJob(null); }} className="flex-1 rounded-xl bg-surface-2 border border-surface-3 px-4 py-3 text-sm text-white placeholder:text-[#bd91a8] outline-none focus:border-rose-300/50" placeholder="Paste a Spotify, SoundCloud, Bandcamp, or YouTube URL" />
                        <button onClick={startImport} disabled={importing || !importUrl.trim()} className="px-5 py-3 rounded-xl bg-gradient-to-r from-orange-400 to-fuchsia-500 text-white text-sm font-semibold shadow-lg shadow-fuchsia-950/40 disabled:opacity-40">
                          {importing ? "PicoDrops is working…" : "Import + download"}
                        </button>
                      </div>
                      {importJob && (
                        <div className={`mt-4 rounded-xl border px-4 py-3 text-sm ${importJob.status === "failed" ? "border-red-400/30 bg-red-400/10 text-red-100" : importJob.status === "completed" ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-100" : "border-orange-300/25 bg-orange-300/10 text-orange-100"}`}>
                          {importJob.status === "pending" && "Queued for the PicoDrops engine…"}
                          {importJob.status === "processing" && "Resolving the source, checking PicoDrops, and preparing audio…"}
                          {importJob.status === "completed" && `Imported ${importJob.imported_count} of ${importJob.total_count} tracks into ${episode.title}.`}
                          {importJob.status === "failed" && (importJob.error || "Import failed")}
                        </div>
                      )}
                    </div>
                  )}

                  {builderTab === "link" && (
                    <div className="p-4 sm:p-5">
                      <p className="text-sm text-foreground/70 mb-3">Spotify, SoundCloud, Bandcamp, or YouTube. Metadata stays editable before it enters the tracklist.</p>
                      <div className="flex flex-col sm:flex-row gap-2">
                        <input value={manualUrl} onChange={(event) => { setManualUrl(event.target.value); setManualLink(null); }} className="flex-1 rounded-xl bg-surface-2 border border-surface-3 px-4 py-3 text-sm outline-none focus:border-amber-300/30" placeholder="Paste a track URL" />
                        <button onClick={() => enrichLink("track")} disabled={enriching === "track" || !manualUrl.trim()} className="px-5 py-3 rounded-xl bg-amber-300 text-black text-sm font-semibold disabled:opacity-40">
                          {enriching === "track" ? "Reading…" : "Read link"}
                        </button>
                      </div>
                      {manualLink && (
                        <div className="mt-4 grid sm:grid-cols-[82px_minmax(0,1fr)_auto] gap-3 items-center rounded-xl bg-surface-2/70 p-3">
                          <Artwork src={manualLink.artwork_url} alt="" className="w-[82px] h-[82px] rounded-xl" />
                          <div className="space-y-2">
                            <input value={manualLink.title} onChange={(event) => setManualLink({ ...manualLink, title: event.target.value })} className="w-full bg-transparent font-medium outline-none border-b border-surface-4 focus:border-amber-300/40" placeholder="Track title" />
                            <input value={manualLink.creator} onChange={(event) => setManualLink({ ...manualLink, creator: event.target.value })} className="w-full bg-transparent text-sm text-muted outline-none border-b border-surface-4 focus:border-amber-300/40" placeholder="Artist" />
                            <p className="text-[10px] uppercase tracking-wider text-foreground/35">{manualLink.source_type}</p>
                          </div>
                          <button onClick={addManualTrack} className="px-4 py-2.5 rounded-lg bg-amber-300 text-black text-sm font-semibold">Add track</button>
                        </div>
                      )}
                    </div>
                  )}

                  {builderTab === "inspiration" && (
                    <div className="p-4 sm:p-5">
                      <p className="text-sm text-foreground/70 mb-3">Attach a mix, DJ set, or playlist that defines the episode’s movement.</p>
                      <div className="flex flex-col sm:flex-row gap-2">
                        <input value={inspirationUrl} onChange={(event) => { setInspirationUrl(event.target.value); setInspirationLink(null); }} className="flex-1 rounded-xl bg-surface-2 border border-surface-3 px-4 py-3 text-sm outline-none focus:border-amber-300/30" placeholder="Paste a mix or playlist URL" />
                        <button onClick={() => enrichLink("inspiration")} disabled={enriching === "inspiration" || !inspirationUrl.trim()} className="px-5 py-3 rounded-xl bg-amber-300 text-black text-sm font-semibold disabled:opacity-40">
                          {enriching === "inspiration" ? "Reading…" : "Read mix"}
                        </button>
                      </div>
                      {inspirationLink && (
                        <div className="mt-4 grid sm:grid-cols-[82px_minmax(0,1fr)_auto] gap-3 items-center rounded-xl bg-surface-2/70 p-3">
                          <Artwork src={inspirationLink.artwork_url} alt="" className="w-[82px] h-[82px] rounded-xl" />
                          <div className="space-y-2">
                            <input value={inspirationLink.title} onChange={(event) => setInspirationLink({ ...inspirationLink, title: event.target.value })} className="w-full bg-transparent font-medium outline-none border-b border-surface-4 focus:border-amber-300/40" placeholder="Mix title" />
                            <input value={inspirationLink.creator} onChange={(event) => setInspirationLink({ ...inspirationLink, creator: event.target.value })} className="w-full bg-transparent text-sm text-muted outline-none border-b border-surface-4 focus:border-amber-300/40" placeholder="DJ / creator" />
                          </div>
                          <button onClick={addInspiration} className="px-4 py-2.5 rounded-lg bg-amber-300 text-black text-sm font-semibold">Attach</button>
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {episode.inspirations.length > 0 && (
                  <section className="rounded-2xl border border-white/10 bg-surface-1/80 p-4 sm:p-5">
                    <div className="flex items-center justify-between mb-3">
                      <h2 className="font-medium">Inspiration board</h2>
                      <span className="text-xs text-muted">{episode.inspirations.length} reference{episode.inspirations.length === 1 ? "" : "s"}</span>
                    </div>
                    <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
                      {episode.inspirations.map((item) => (
                        <div key={item.id} className="group flex gap-3 rounded-xl bg-surface-2/70 p-3">
                          <Artwork src={item.artwork_url} alt="" className="w-14 h-14 rounded-lg shrink-0" />
                          <div className="min-w-0 flex-1">
                            <a href={item.source_url} target="_blank" rel="noreferrer" className="text-sm font-medium hover:text-amber-200 line-clamp-2">{item.title}</a>
                            <p className="text-xs text-muted truncate mt-1">{item.creator || item.source_type}</p>
                          </div>
                          <button onClick={() => removeInspiration(item.id)} className="self-start text-muted/40 hover:text-red-300 opacity-100 sm:opacity-0 group-hover:opacity-100">×</button>
                        </div>
                      ))}
                    </div>
                  </section>
                )}

                <section className="rounded-2xl border border-white/10 bg-surface-1/80 overflow-hidden">
                  <div className="p-4 sm:p-5 border-b border-surface-3 flex items-center justify-between">
                    <div>
                      <h2 className="font-medium text-lg">Tracklist</h2>
                      <p className="text-xs text-muted mt-1">Drag tracks into place. Titles, artists, BPM, roles, and notes are editable.</p>
                    </div>
                    <span className="text-sm text-amber-200">{episode.tracks.length} track{episode.tracks.length === 1 ? "" : "s"}</span>
                  </div>
                  {episode.tracks.length === 0 ? (
                    <div className="p-10 text-center text-sm text-muted">Build the crate above. Your tracklist will land here.</div>
                  ) : (
                    <div className="divide-y divide-surface-3">
                      {episode.tracks.map((track, index) => {
                        const active = isEpisodeTrackActive(track);
                        const audioLoading = activeTrackIsLoading(active, track.track_id || `segundo-sol:${track.id}`);
                        const bpm = getTrackBpm(track);
                        const audioLabel = audioLoading
                          ? "preparing audio…"
                          : active
                            ? globalPlayer.playing ? "playing here + in Stacks" : "paused"
                            : track.playable
                              ? "ready to play"
                              : track.audio_status === "failed"
                                ? "preparation failed · tap to retry"
                                : track.audio_status === "processing"
                                  ? "preparing audio…"
                                  : track.audio_status === "pending"
                                    ? "queued for download"
                                    : "tap to prepare audio";
                        const dragging = draggedTrackId === track.id;
                        const dragTarget = dragOverTrackId === track.id && !dragging;
                        return (
                          <div
                            key={track.id}
                            onDragOver={(event) => {
                              if (!draggedTrackId) return;
                              event.preventDefault();
                              event.dataTransfer.dropEffect = "move";
                              setDragOverTrackId(track.id);
                            }}
                            onDrop={(event) => { event.preventDefault(); dropTrack(track.id); }}
                            className={`grid grid-cols-[30px_48px_minmax(0,1fr)] sm:grid-cols-[38px_52px_minmax(0,1fr)] 2xl:grid-cols-[38px_52px_minmax(0,1fr)_150px_190px_auto] gap-2 sm:gap-3 items-center p-2.5 sm:p-4 group transition-all ${active ? "bg-orange-300/[0.08]" : audioLoading ? "bg-amber-300/[0.05]" : ""} ${dragTarget ? "bg-fuchsia-400/10 ring-1 ring-inset ring-fuchsia-300/50" : ""} ${dragging ? "opacity-40" : ""}`}
                          >
                            <div className="text-center">
                              <button
                                type="button"
                                draggable={!reordering}
                                onDragStart={(event) => {
                                  event.dataTransfer.effectAllowed = "move";
                                  event.dataTransfer.setData("text/plain", track.id);
                                  setDraggedTrackId(track.id);
                                }}
                                onDragEnd={() => { setDraggedTrackId(null); setDragOverTrackId(null); }}
                                className="mx-auto flex h-7 w-7 cursor-grab items-center justify-center rounded-md text-base text-muted hover:bg-white/10 hover:text-white active:cursor-grabbing"
                                aria-label={`Drag ${track.title} to reorder`}
                                title="Drag to reorder"
                              >
                                ⠿
                              </button>
                              <span className="block text-[10px] text-muted">{index + 1}</span>
                              <div className="mt-0.5 flex justify-center gap-1">
                                <button onClick={() => moveTrack(index, -1)} disabled={index === 0 || reordering} className="text-[11px] text-muted hover:text-amber-200 disabled:opacity-20" aria-label={`Move ${track.title} up`}>↑</button>
                                <button onClick={() => moveTrack(index, 1)} disabled={index === episode.tracks.length - 1 || reordering} className="text-[11px] text-muted hover:text-amber-200 disabled:opacity-20" aria-label={`Move ${track.title} down`}>↓</button>
                              </div>
                            </div>
                            <button
                              onClick={() => openAudio(track)}
                              disabled={!track.source_url && !track.playable}
                              aria-label={track.playable ? `${active && globalPlayer.playing ? "Pause" : "Play"} ${track.title}` : `Prepare ${track.title} audio`}
                              className={`relative w-12 h-12 max-sm:w-11 max-sm:h-11 rounded-lg overflow-hidden disabled:cursor-not-allowed disabled:opacity-45 group/play ring-2 transition-all active:scale-95 ${active ? "ring-orange-300/70" : audioLoading ? "ring-amber-300/40" : "ring-transparent"}`}
                            >
                              <Artwork src={track.artwork_url} alt="" className="w-12 h-12 max-sm:w-11 max-sm:h-11 rounded-lg transition-opacity group-hover/play:opacity-70" />
                              <span className="absolute inset-0 grid place-items-center text-lg text-white bg-black/30 group-hover/play:bg-black/50 transition-colors">
                                {audioLoading ? (
                                  <span className="h-6 w-6 rounded-full border-2 border-white/35 border-t-white animate-spin" />
                                ) : active && globalPlayer.playing ? "Ⅱ" : track.playable ? "▶" : track.audio_status === "failed" ? "↻" : "↓"}
                              </span>
                            </button>
                            <div className="min-w-0">
                              <input
                                value={track.title}
                                onChange={(event) => setEpisode({ ...episode, tracks: episode.tracks.map((item) => item.id === track.id ? { ...item, title: event.target.value } : item) })}
                                onBlur={() => patchTrack(track.id, { title: track.title })}
                                onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
                                className={`w-full rounded-md border px-2 py-1 text-sm font-medium outline-none transition-colors ${active ? "border-orange-300/25 bg-orange-300/[0.06] text-orange-100" : "border-white/10 bg-white/[0.025] hover:border-white/20 focus:border-amber-300/40 focus:bg-white/[0.05]"}`}
                                aria-label="Track title"
                                title="Edit track title"
                              />
                              <div className="mt-1 flex items-center gap-2">
                                <input
                                  value={track.artist}
                                  onChange={(event) => setEpisode({ ...episode, tracks: episode.tracks.map((item) => item.id === track.id ? { ...item, artist: event.target.value } : item) })}
                                  onBlur={() => patchTrack(track.id, { artist: track.artist })}
                                  onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
                                  className="min-w-0 flex-1 rounded-md border border-white/10 bg-white/[0.025] px-2 py-1 text-xs text-muted outline-none hover:border-white/20 focus:border-amber-300/30 focus:bg-white/[0.05]"
                                  aria-label="Track artist"
                                  title="Edit track artist"
                                />
                                <label className="flex shrink-0 items-center gap-1 rounded-md border border-white/10 bg-white/[0.025] px-2 py-1 text-[10px] uppercase tracking-wide text-muted hover:border-white/20 focus-within:border-amber-300/30" title="Edit BPM">
                                  <input
                                    type="number"
                                    min="30"
                                    max="300"
                                    step="0.1"
                                    value={bpmDrafts[track.id] ?? (bpm ?? "")}
                                    onFocus={() => setBpmDrafts((current) => ({
                                      ...current,
                                      [track.id]: bpm === null ? "" : String(bpm),
                                    }))}
                                    onChange={(event) => setBpmDrafts((current) => ({
                                      ...current,
                                      [track.id]: event.target.value,
                                    }))}
                                    onBlur={() => commitBpm(track)}
                                    onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
                                    className="w-12 bg-transparent text-right text-xs text-amber-100 outline-none"
                                    aria-label="Track BPM"
                                    placeholder="—"
                                  />
                                  BPM
                                </label>
                              </div>
                              <p className={`mt-1 text-[9px] uppercase tracking-wider ${track.audio_status === "failed" ? "text-red-300" : active || audioLoading ? "text-orange-300" : track.playable ? "text-emerald-300/70" : "text-amber-200/70"}`}>{audioLabel}</p>
                              <div className="2xl:hidden mt-2 flex flex-wrap items-center gap-2">
                                <span className="text-[10px] uppercase tracking-wide text-foreground/60">{track.source_origin.replace("stacks_", "")}</span>
                                {track.source_url && <a href={track.source_url} target="_blank" rel="noreferrer" className="text-[11px] text-sky-300">source ↗</a>}
                                <button onClick={() => openAudio(track)} disabled={!track.source_url && !track.playable} className={`text-[11px] font-semibold disabled:opacity-35 ${track.audio_status === "failed" ? "text-red-300" : "text-orange-200"}`}>{audioLoading ? "preparing…" : active && globalPlayer.playing ? "Ⅱ pause" : track.playable ? "▶ play" : track.audio_status === "failed" ? "↻ retry" : "↓ prepare"}</button>
                              </div>
                            </div>
                            <input value={track.role || ""} onChange={(event) => setEpisode({ ...episode, tracks: episode.tracks.map((item) => item.id === track.id ? { ...item, role: event.target.value } : item) })} onBlur={() => patchTrack(track.id, { role: track.role })} className="hidden 2xl:block rounded-lg bg-surface-2 border border-surface-3 px-3 py-2 text-xs outline-none focus:border-amber-300/30" placeholder="opener / bridge…" />
                            <div className="hidden 2xl:block min-w-0">
                              <p className="text-[10px] uppercase tracking-wider text-foreground/60">{track.source_origin.replace("stacks_", "")} · {track.source_type}</p>
                              <div className="mt-1 flex items-center gap-3">
                                {track.source_url ? <a href={track.source_url} target="_blank" rel="noreferrer" className="text-xs text-sky-300 hover:text-sky-200 truncate">source ↗</a> : <span className="text-xs text-muted">snapshot only</span>}
                                <button onClick={() => openAudio(track)} disabled={!track.source_url && !track.playable} className={`text-xs font-semibold disabled:opacity-35 ${track.audio_status === "failed" ? "text-red-300" : "text-orange-200 hover:text-orange-100"}`}>{audioLoading ? "preparing…" : active && globalPlayer.playing ? "Ⅱ pause" : track.playable ? "▶ play" : track.audio_status === "failed" ? "↻ retry" : "↓ prepare"}</button>
                              </div>
                            </div>
                            <button onClick={() => removeTrack(track.id)} className="hidden 2xl:block text-muted/30 hover:text-red-300 px-2">×</button>
                            <div className="col-start-2 col-span-2 sm:col-start-3 sm:col-span-1 2xl:col-start-3 2xl:col-span-3">
                              <input value={track.notes || ""} onChange={(event) => setEpisode({ ...episode, tracks: episode.tracks.map((item) => item.id === track.id ? { ...item, notes: event.target.value } : item) })} onBlur={() => patchTrack(track.id, { notes: track.notes })} className="w-full rounded-md border border-white/[0.06] bg-white/[0.015] px-2 py-1 text-xs text-foreground/55 outline-none hover:border-white/15 focus:border-amber-300/20" placeholder="transition / energy / mix note" />
                            </div>
                            <button onClick={() => removeTrack(track.id)} className="2xl:hidden col-start-3 justify-self-end text-[10px] uppercase tracking-wide text-red-300/60">remove</button>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </section>
              </div>
            )}
          </section>
        </div>
      </div>
    </main>
  );
}
