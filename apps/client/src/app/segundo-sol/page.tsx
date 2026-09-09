"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

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

interface LibraryTrack {
  id: string;
  artist: string;
  title: string;
  artwork_url: string | null;
  source_url: string | null;
  source_origin: "stacks_like" | "stacks_super_like";
  super_liked: boolean;
}

interface EnrichedLink {
  url: string;
  source_type: string;
  title: string;
  creator: string;
  artwork_url: string | null;
  metadata: Record<string, unknown>;
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

export default function SegundoSolPage() {
  const [episodes, setEpisodes] = useState<EpisodeSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [episode, setEpisode] = useState<EpisodeDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [builderTab, setBuilderTab] = useState<"library" | "link" | "inspiration">("library");
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
  }, [selectedId, loadEpisode]);

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
      const next = { ...episode, tracks: [...episode.tracks, data.track] };
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

  const patchTrack = async (trackId: string, patch: Partial<EpisodeTrack>) => {
    if (!episode) return;
    setEpisode({ ...episode, tracks: episode.tracks.map((track) => track.id === trackId ? { ...track, ...patch } : track) });
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

  const moveTrack = async (index: number, direction: -1 | 1) => {
    if (!episode) return;
    const target = index + direction;
    if (target < 0 || target >= episode.tracks.length) return;
    const tracks = [...episode.tracks];
    [tracks[index], tracks[target]] = [tracks[target], tracks[index]];
    const normalized = tracks.map((track, position) => ({ ...track, position }));
    setEpisode({ ...episode, tracks: normalized });
    try {
      await Promise.all([
        requestJson(`/api/segundo-sol/episodes/${episode.id}/tracks/${normalized[index].id}`, {
          method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ position: index }),
        }),
        requestJson(`/api/segundo-sol/episodes/${episode.id}/tracks/${normalized[target].id}`, {
          method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ position: target }),
        }),
      ]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to reorder tracks");
      loadEpisode(episode.id);
    }
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
    <main className="min-h-screen pb-28 md:pb-16 relative overflow-hidden">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-[520px] bg-[radial-gradient(ellipse_at_20%_0%,rgba(251,191,36,0.15),transparent_52%),radial-gradient(ellipse_at_90%_20%,rgba(249,115,22,0.10),transparent_46%),radial-gradient(ellipse_at_50%_0%,rgba(56,189,248,0.06),transparent_55%)]" />
      <div className="relative max-w-[1500px] mx-auto px-4 sm:px-6 py-6 sm:py-10">
        <header className="mb-7 flex flex-col lg:flex-row lg:items-end lg:justify-between gap-4">
          <div>
            <div className="flex items-center gap-3 text-amber-300 text-xs font-semibold uppercase tracking-[0.28em] mb-2">
              <span>☀☀</span><span>Private studio</span>
            </div>
            <h1 className="text-3xl sm:text-5xl font-semibold tracking-[-0.04em] text-foreground">
              Segundo Sol: <span className="text-amber-300">The CMS-ening</span>
            </h1>
            <p className="mt-3 text-sm sm:text-base text-muted max-w-2xl">
              Shape each episode from inspiration to final running order. Stacks feeds the crate; PicoDrops handles the masters.
            </p>
          </div>
          <div className="flex flex-wrap gap-2 text-xs">
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

        <div className="grid grid-cols-1 xl:grid-cols-[290px_minmax(0,1fr)] gap-5">
          <aside className="rounded-2xl border border-white/10 bg-surface-1/80 backdrop-blur-xl overflow-hidden self-start xl:sticky xl:top-5">
            <div className="p-4 border-b border-surface-3 flex items-center justify-between">
              <div>
                <p className="text-xs uppercase tracking-[0.22em] text-muted">Episodes</p>
                <p className="text-xs text-foreground/50 mt-1">{episodes.length} in the archive</p>
              </div>
              <button onClick={createEpisode} disabled={creating} className="px-3 py-2 rounded-lg bg-amber-300 text-black text-xs font-semibold hover:bg-amber-200 disabled:opacity-50">
                {creating ? "Making…" : "+ New"}
              </button>
            </div>
            <div className="p-2 flex xl:block gap-2 overflow-x-auto max-h-none xl:max-h-[70vh] xl:overflow-y-auto">
              {loading ? (
                <div className="p-5 text-sm text-muted">Loading the archive…</div>
              ) : episodes.length === 0 ? (
                <button onClick={createEpisode} className="w-full p-6 text-left rounded-xl border border-dashed border-amber-300/20 text-sm text-muted hover:text-foreground hover:border-amber-300/40">
                  Start the first episode →
                </button>
              ) : episodes.map((item) => (
                <button key={item.id} onClick={() => setSelectedId(item.id)} className={`min-w-[230px] xl:min-w-0 w-full text-left p-3 rounded-xl mb-0 xl:mb-1 transition-all ${selectedId === item.id ? "bg-amber-300/10 ring-1 ring-amber-300/25" : "hover:bg-surface-2"}`}>
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
                {detailLoading ? "Opening episode…" : "Create an episode to begin."}
              </div>
            ) : (
              <div className="space-y-5">
                <div className="rounded-2xl border border-white/10 bg-surface-1/80 backdrop-blur-xl p-4 sm:p-6">
                  <div className="grid sm:grid-cols-[180px_minmax(0,1fr)] gap-5 sm:gap-7">
                    <label className="group relative cursor-pointer">
                      <Artwork src={episode.artwork_url} alt={`Artwork for ${episode.title}`} className="w-full aspect-square rounded-2xl shadow-2xl" />
                      <span className="absolute inset-x-3 bottom-3 text-center rounded-lg bg-black/70 px-3 py-2 text-xs text-white opacity-100 sm:opacity-0 group-hover:opacity-100 transition-opacity">
                        {uploading ? "Uploading…" : "Replace artwork"}
                      </span>
                      <input type="file" accept="image/jpeg,image/png,image/webp,image/gif" className="hidden" disabled={uploading} onChange={(event) => { const file = event.target.files?.[0]; if (file) uploadArtwork(file); event.target.value = ""; }} />
                    </label>
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2 mb-4">
                        <label className="flex items-center gap-2 rounded-lg bg-surface-2 px-3 py-2 text-xs text-muted">
                          Episode
                          <input type="number" min="1" value={episode.episode_number} onChange={(event) => setEpisode({ ...episode, episode_number: Number(event.target.value) })} onBlur={() => patchEpisode({ episode_number: episode.episode_number })} className="w-14 bg-transparent text-foreground outline-none" />
                        </label>
                        <select value={episode.status} onChange={(event) => patchEpisode({ status: event.target.value as EpisodeSummary["status"] })} className="rounded-lg bg-surface-2 border border-surface-3 px-3 py-2 text-xs text-foreground outline-none">
                          {Object.entries(STATUS_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                        </select>
                        <span className={`text-[11px] ${saveState === "error" ? "text-red-300" : "text-muted"}`}>
                          {saveState === "saving" ? "Saving…" : saveState === "saved" ? "Saved" : saveState === "error" ? "Save failed" : "Auto-saves on blur"}
                        </span>
                        <button onClick={deleteEpisode} className="ml-auto text-xs text-red-300/60 hover:text-red-300">Delete episode</button>
                      </div>
                      <input value={episode.title} onChange={(event) => setEpisode({ ...episode, title: event.target.value })} onBlur={() => patchEpisode({ title: episode.title })} className="w-full bg-transparent text-2xl sm:text-4xl font-semibold tracking-tight text-foreground outline-none border-b border-transparent focus:border-amber-300/30 pb-1" placeholder="Episode title" />
                      <input value={episode.theme || ""} onChange={(event) => setEpisode({ ...episode, theme: event.target.value })} onBlur={() => patchEpisode({ theme: episode.theme })} className="mt-2 w-full bg-transparent text-base text-amber-200/80 outline-none border-b border-transparent focus:border-amber-300/20 pb-1" placeholder="Theme, place, feeling, or arc" />
                      <textarea value={episode.notes || ""} onChange={(event) => setEpisode({ ...episode, notes: event.target.value })} onBlur={() => patchEpisode({ notes: episode.notes })} rows={4} className="mt-4 w-full rounded-xl bg-surface-2/70 border border-surface-3 px-4 py-3 text-sm text-foreground/80 outline-none focus:border-amber-300/30 resize-y" placeholder="Episode notes, transition ideas, texture, story…" />
                    </div>
                  </div>
                </div>

                <div className="rounded-2xl border border-white/10 bg-surface-1/80 backdrop-blur-xl overflow-hidden">
                  <div className="flex overflow-x-auto border-b border-surface-3 p-2 gap-1">
                    {([
                      ["library", "From Stacks"],
                      ["link", "Paste a track"],
                      ["inspiration", "Inspiration mix"],
                    ] as const).map(([value, label]) => (
                      <button key={value} onClick={() => setBuilderTab(value)} className={`px-4 py-2.5 rounded-lg text-sm whitespace-nowrap ${builderTab === value ? "bg-amber-300/10 text-amber-200" : "text-muted hover:text-foreground hover:bg-surface-2"}`}>
                        {label}
                      </button>
                    ))}
                  </div>

                  {builderTab === "library" && (
                    <div className="p-4 sm:p-5">
                      <div className="flex flex-col sm:flex-row gap-2 mb-4">
                        <input value={librarySearch} onChange={(event) => setLibrarySearch(event.target.value)} className="flex-1 rounded-xl bg-surface-2 border border-surface-3 px-4 py-2.5 text-sm outline-none focus:border-amber-300/30" placeholder="Search your kept tracks…" />
                        <div className="flex rounded-xl bg-surface-2 p-1">
                          {(["all", "super_liked", "approved"] as const).map((kind) => (
                            <button key={kind} onClick={() => setLibraryKind(kind)} className={`px-3 py-1.5 rounded-lg text-xs ${libraryKind === kind ? "bg-surface-4 text-foreground" : "text-muted"}`}>
                              {kind === "super_liked" ? "Stars" : kind === "approved" ? "Likes" : "All"}
                            </button>
                          ))}
                        </div>
                      </div>
                      <div className="grid sm:grid-cols-2 2xl:grid-cols-3 gap-2 max-h-[360px] overflow-y-auto pr-1">
                        {libraryLoading ? <p className="p-4 text-sm text-muted">Opening your Stacks crate…</p> : library.map((track) => {
                          const added = addedTrackIds.has(track.id);
                          return (
                            <div key={track.id} className="flex items-center gap-3 rounded-xl bg-surface-2/70 p-2.5 border border-transparent hover:border-surface-4">
                              <Artwork src={track.artwork_url} alt="" className="w-11 h-11 rounded-lg shrink-0" />
                              <div className="min-w-0 flex-1">
                                <p className="text-sm font-medium truncate">{track.title}</p>
                                <p className="text-xs text-muted truncate">{track.artist}</p>
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

                  {builderTab === "link" && (
                    <div className="p-4 sm:p-5">
                      <p className="text-sm text-foreground/70 mb-3">Spotify, SoundCloud, Bandcamp, or YouTube. Metadata stays editable before it enters the running order.</p>
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
                      <h2 className="font-medium text-lg">Running order</h2>
                      <p className="text-xs text-muted mt-1">Snapshots stay intact even if Stacks metadata changes later.</p>
                    </div>
                    <span className="text-sm text-amber-200">{episode.tracks.length} track{episode.tracks.length === 1 ? "" : "s"}</span>
                  </div>
                  {episode.tracks.length === 0 ? (
                    <div className="p-10 text-center text-sm text-muted">Build the crate above. The running order will land here.</div>
                  ) : (
                    <div className="divide-y divide-surface-3">
                      {episode.tracks.map((track, index) => (
                        <div key={track.id} className="grid grid-cols-[34px_48px_minmax(0,1fr)] lg:grid-cols-[34px_48px_minmax(0,1fr)_150px_190px_auto] gap-3 items-center p-3 sm:p-4 group">
                          <div className="text-center">
                            <span className="block text-xs text-muted">{index + 1}</span>
                            <div className="mt-1 flex flex-col">
                              <button onClick={() => moveTrack(index, -1)} disabled={index === 0} className="text-[11px] text-muted hover:text-amber-200 disabled:opacity-20">↑</button>
                              <button onClick={() => moveTrack(index, 1)} disabled={index === episode.tracks.length - 1} className="text-[11px] text-muted hover:text-amber-200 disabled:opacity-20">↓</button>
                            </div>
                          </div>
                          <Artwork src={track.artwork_url} alt="" className="w-12 h-12 rounded-lg" />
                          <div className="min-w-0">
                            <input value={track.title} onChange={(event) => setEpisode({ ...episode, tracks: episode.tracks.map((item) => item.id === track.id ? { ...item, title: event.target.value } : item) })} onBlur={() => patchTrack(track.id, { title: track.title })} className="w-full bg-transparent text-sm font-medium outline-none border-b border-transparent focus:border-amber-300/30" />
                            <input value={track.artist} onChange={(event) => setEpisode({ ...episode, tracks: episode.tracks.map((item) => item.id === track.id ? { ...item, artist: event.target.value } : item) })} onBlur={() => patchTrack(track.id, { artist: track.artist })} className="w-full bg-transparent text-xs text-muted outline-none border-b border-transparent focus:border-amber-300/20" />
                            <div className="lg:hidden mt-2 flex items-center gap-2">
                              <span className="text-[10px] uppercase tracking-wide text-foreground/35">{track.source_origin.replace("stacks_", "")}</span>
                              {track.source_url && <a href={track.source_url} target="_blank" rel="noreferrer" className="text-[11px] text-sky-300">open ↗</a>}
                            </div>
                          </div>
                          <input value={track.role || ""} onChange={(event) => setEpisode({ ...episode, tracks: episode.tracks.map((item) => item.id === track.id ? { ...item, role: event.target.value } : item) })} onBlur={() => patchTrack(track.id, { role: track.role })} className="hidden lg:block rounded-lg bg-surface-2 border border-surface-3 px-3 py-2 text-xs outline-none focus:border-amber-300/30" placeholder="opener / bridge…" />
                          <div className="hidden lg:block min-w-0">
                            <p className="text-[10px] uppercase tracking-wider text-foreground/35">{track.source_origin.replace("stacks_", "")} · {track.source_type}</p>
                            {track.source_url ? <a href={track.source_url} target="_blank" rel="noreferrer" className="text-xs text-sky-300 hover:text-sky-200 truncate block mt-1">open source ↗</a> : <span className="text-xs text-muted">snapshot only</span>}
                          </div>
                          <button onClick={() => removeTrack(track.id)} className="hidden lg:block text-muted/30 hover:text-red-300 px-2">×</button>
                          <div className="col-start-3 lg:col-start-3 lg:col-span-3">
                            <input value={track.notes || ""} onChange={(event) => setEpisode({ ...episode, tracks: episode.tracks.map((item) => item.id === track.id ? { ...item, notes: event.target.value } : item) })} onBlur={() => patchTrack(track.id, { notes: track.notes })} className="w-full bg-transparent text-xs text-foreground/45 outline-none border-b border-transparent focus:border-amber-300/20" placeholder="transition / energy / mix note" />
                          </div>
                          <button onClick={() => removeTrack(track.id)} className="lg:hidden col-start-3 justify-self-end text-xs text-red-300/60">remove</button>
                        </div>
                      ))}
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
