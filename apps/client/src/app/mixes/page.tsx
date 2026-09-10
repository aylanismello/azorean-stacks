"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { episodeDate, formatEpisodeDate, type MixSeries } from "./types";

function Artwork({ series }: { series: MixSeries }) {
  const artwork = series.latest_episode?.artwork_url || series.artwork_url;
  return artwork ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={artwork} alt="" className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.03]" />
  ) : (
    <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-accent/25 via-surface-2 to-surface-3 text-4xl text-foreground/25">♫</div>
  );
}

export default function MixesPage() {
  const [series, setSeries] = useState<MixSeries[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/series", { cache: "no-store" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || `Could not load mixes (${response.status})`);
      setSeries(Array.isArray(body.series) ? body.series : []);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load mixes");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const recentFirst = useMemo(() => [...series].sort((a, b) => {
    const left = episodeDate(a.latest_episode);
    const right = episodeDate(b.latest_episode);
    return (right ? new Date(right).getTime() : 0) - (left ? new Date(left).getTime() : 0);
  }), [series]);

  const toggleSeed = async (item: MixSeries) => {
    if (saving.has(item.id)) return;
    setSaving((current) => new Set(current).add(item.id));
    setError(null);
    try {
      const response = await fetch(`/api/series/${encodeURIComponent(item.slug)}/seed`, { method: item.seeded ? "DELETE" : "POST" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "Could not update seed");
      setSeries((current) => current.map((value) => value.id === item.id ? { ...value, seeded: Boolean(body.seeded) } : value));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not update seed");
    } finally {
      setSaving((current) => { const next = new Set(current); next.delete(item.id); return next; });
    }
  };

  return (
    <main className="mx-auto max-w-6xl px-4 pb-32 pt-8 md:px-6 md:pb-12 md:pt-12">
      <header className="mb-8 max-w-2xl">
        <p className="mb-2 text-xs font-semibold uppercase tracking-[0.24em] text-accent">Recent first</p>
        <h1 className="text-4xl font-semibold tracking-tight md:text-5xl">Mixes</h1>
        <p className="mt-3 text-sm leading-6 text-muted md:text-base">Fresh episodes from the series you trust, ordered by their newest resolved tracklists.</p>
      </header>

      {error && <div role="alert" className="mb-5 flex items-center justify-between gap-4 rounded-xl border border-red-400/20 bg-red-400/10 px-4 py-3 text-sm text-red-300"><span>{error}</span><button onClick={() => void load()} className="font-semibold hover:text-red-200">Retry</button></div>}

      {loading ? (
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3" aria-label="Loading mixes">
          {[0, 1, 2, 3, 4, 5].map((value) => <div key={value} className="aspect-[4/5] animate-pulse rounded-2xl bg-surface-2" />)}
        </div>
      ) : recentFirst.length === 0 ? (
        <div className="rounded-2xl border border-surface-3 bg-surface-1 px-6 py-14 text-center"><p className="text-lg font-medium">No qualified mixes yet</p><p className="mt-2 text-sm text-muted">Series appear here after an episode has a tracklist.</p></div>
      ) : (
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {recentFirst.map((item, index) => (
            <article key={item.id} className="group overflow-hidden rounded-2xl border border-surface-3 bg-surface-1 shadow-sm transition hover:-translate-y-0.5 hover:border-accent/30">
              <Link href={`/mixes/${encodeURIComponent(item.slug)}`} className="block">
                <div className="relative aspect-square overflow-hidden">
                  <Artwork series={item} />
                  <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent px-4 pb-4 pt-14 text-white">
                    <div className="mb-2 flex items-center gap-2">
                      {index === 0 && <span className="rounded-full bg-accent px-2 py-1 text-[10px] font-bold tracking-wider text-black">NEW</span>}
                      <span className="rounded-full bg-white/15 px-2 py-1 text-[10px] font-bold tracking-wider backdrop-blur">LATEST</span>
                    </div>
                    <h2 className="text-xl font-semibold leading-tight">{item.title}</h2>
                  </div>
                </div>
              </Link>
              <div className="p-4">
                <Link href={`/mixes/${encodeURIComponent(item.slug)}`} className="block min-w-0">
                  <p className="truncate text-sm font-medium">{item.latest_episode?.title || "Latest episode"}</p>
                  <p className="mt-1 truncate text-xs text-muted">{formatEpisodeDate(item.latest_episode)}{item.latest_episode?.dj_name ? ` · DJ ${item.latest_episode.dj_name}` : " · DJ unavailable"}</p>
                  <p className="mt-3 text-xs text-muted">{item.episode_count || 0} qualified {(item.episode_count || 0) === 1 ? "episode" : "episodes"}</p>
                </Link>
                <div className="mt-4 flex items-center gap-2">
                  <button onClick={() => void toggleSeed(item)} disabled={saving.has(item.id)} className={`rounded-lg px-3 py-2 text-xs font-semibold transition disabled:opacity-50 ${item.seeded ? "bg-accent/15 text-accent hover:bg-accent/25" : "bg-surface-2 text-foreground/80 hover:bg-surface-3"}`}>{saving.has(item.id) ? "Saving…" : item.seeded ? "Unseed" : "Seed"}</button>
                  <Link href={`/mixes/${encodeURIComponent(item.slug)}`} className="ml-auto text-xs font-semibold text-accent hover:underline">Open series →</Link>
                </div>
              </div>
            </article>
          ))}
        </div>
      )}
    </main>
  );
}
