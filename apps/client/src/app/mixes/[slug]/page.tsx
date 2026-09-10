"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useGlobalPlayer } from "@/components/GlobalPlayerProvider";
import {
  buildEpisodeQueue,
  preparationCount,
  type EpisodePreparationResponse,
} from "@/lib/episode-playback";
import { formatEpisodeDate, type EpisodeAppearance, type MixEpisode, type MixSeries } from "../types";

const INITIAL_EPISODES = 6;

async function responseJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body as T;
}

function isReady(row: EpisodeAppearance): boolean {
  return Boolean(row.track && (row.audio_url || row.preview_url || row.spotify_url));
}

export default function MixSeriesPage() {
  const { slug } = useParams<{ slug: string }>();
  const globalPlayer = useGlobalPlayer();
  const [series, setSeries] = useState<MixSeries | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [visible, setVisible] = useState(INITIAL_EPISODES);
  const [savingSeed, setSavingSeed] = useState(false);
  const [startingId, setStartingId] = useState<string | null>(null);
  const [startMessage, setStartMessage] = useState<Record<string, string>>({});
  const [tracklists, setTracklists] = useState<Record<string, EpisodeAppearance[]>>({});

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const body = await responseJson<{ series: MixSeries }>(`/api/series/${encodeURIComponent(slug)}`, { cache: "no-store" });
      setSeries(body.series);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load this series");
    } finally {
      setLoading(false);
    }
  }, [slug]);

  useEffect(() => { void load(); }, [load]);

  const episodes = useMemo(() => [...(series?.episodes || [])].sort((a, b) => {
    const left = a.release_date || a.aired_date;
    const right = b.release_date || b.aired_date;
    return (right ? new Date(right).getTime() : 0) - (left ? new Date(left).getTime() : 0);
  }), [series?.episodes]);

  const toggleSeed = async () => {
    if (!series || savingSeed) return;
    setSavingSeed(true);
    setError(null);
    try {
      const body = await responseJson<{ seeded: boolean }>(`/api/series/${encodeURIComponent(series.slug)}/seed`, { method: series.seeded ? "DELETE" : "POST" });
      setSeries({ ...series, seeded: body.seeded });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not update seed");
    } finally {
      setSavingSeed(false);
    }
  };

  const startEpisode = async (episode: MixEpisode) => {
    if (!series || startingId) return;
    setStartingId(episode.id);
    setError(null);
    setStartMessage((current) => ({ ...current, [episode.id]: "Opening listening session…" }));
    try {
      const sessionBody = await responseJson<{ session: { id: string } }>(`/api/episodes/${episode.id}/session`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ current_position: 0 }),
      });
      setStartMessage((current) => ({ ...current, [episode.id]: "Preparing the first resolvable tracks…" }));
      const prepared = await responseJson<EpisodePreparationResponse>(`/api/episodes/${episode.id}/prepare`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ session_id: sessionBody.session.id, current_position: 0 }),
      });
      const rows = await responseJson<EpisodeAppearance[]>(`/api/episodes/${episode.id}/tracks?_t=${Date.now()}`, { cache: "no-store" });
      const ordered = [...rows].sort((a, b) => a.position - b.position);
      setTracklists((current) => ({ ...current, [episode.id]: ordered }));

      const queue = buildEpisodeQueue(ordered, {
        episodeId: episode.id,
        sessionId: sessionBody.session.id,
        episodeTitle: episode.title,
        seriesTitle: series.title,
      });
      const firstReady = ordered.findIndex((row) => isReady(row));
      const startIndex = firstReady >= 0 ? firstReady : 0;
      globalPlayer.setEpisodeQueue(queue, {
        sessionId: sessionBody.session.id,
        episodeId: episode.id,
        preparedPosition: 0,
      }, startIndex);
      if (firstReady >= 0) {
        globalPlayer.playFromQueue(firstReady, `/mixes/${series.slug}`);
        setStartMessage((current) => ({ ...current, [episode.id]: `Playing ${queue[firstReady].title}` }));
      } else if (preparationCount(prepared.queued) > 0) {
        const queuedCount = preparationCount(prepared.queued);
        setStartMessage((current) => ({ ...current, [episode.id]: `${queuedCount} tracks queued for audio preparation. None are ready to play yet.` }));
      } else {
        setStartMessage((current) => ({ ...current, [episode.id]: "No playable tracks are available in this episode yet." }));
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not start this episode");
      setStartMessage((current) => ({ ...current, [episode.id]: "Episode could not be queued." }));
    } finally {
      setStartingId(null);
    }
  };

  if (loading) return <main className="mx-auto max-w-5xl px-4 py-12 pb-32 md:px-6"><div className="h-72 animate-pulse rounded-2xl bg-surface-2" aria-label="Loading mix series" /></main>;
  if (!series) return <main className="mx-auto max-w-3xl px-4 py-16 text-center"><h1 className="text-2xl font-semibold">Mix series unavailable</h1><p className="mt-2 text-sm text-muted">{error || "This series could not be found."}</p><Link href="/mixes" className="mt-6 inline-block text-sm font-semibold text-accent">← Back to Mixes</Link></main>;

  const artwork = series.latest_episode?.artwork_url || series.artwork_url;

  return (
    <main className="mx-auto max-w-5xl px-4 pb-32 pt-6 md:px-6 md:pb-12 md:pt-10">
      <Link href="/mixes" className="mb-5 inline-flex text-sm text-muted hover:text-foreground">← All mixes</Link>
      <header className="grid gap-6 rounded-2xl border border-surface-3 bg-surface-1 p-5 sm:grid-cols-[180px_1fr] md:p-7">
        <div className="aspect-square overflow-hidden rounded-xl bg-surface-2">
          {artwork ? <img src={artwork} alt={`${series.title} artwork`} className="h-full w-full object-cover" /> : <div className="flex h-full items-center justify-center text-5xl text-muted">♫</div>}
        </div>
        <div className="min-w-0 self-center">
          <p className="text-xs font-semibold uppercase tracking-[0.22em] text-accent">Mix series · newest first</p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight md:text-4xl">{series.title}</h1>
          {series.description && <p className="mt-3 max-w-2xl text-sm leading-6 text-muted">{series.description}</p>}
          <div className="mt-5 flex flex-wrap items-center gap-3">
            <button onClick={() => void toggleSeed()} disabled={savingSeed} className={`rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-50 ${series.seeded ? "bg-accent/15 text-accent" : "bg-surface-2 text-foreground"}`}>{savingSeed ? "Saving…" : series.seeded ? "Unseed series" : "Seed series"}</button>
            {series.source_url && <a href={series.source_url} target="_blank" rel="noreferrer" className="text-sm font-medium text-muted hover:text-foreground">Visit {series.source || "source"} ↗</a>}
          </div>
        </div>
      </header>

      {error && <div role="alert" className="mt-5 rounded-xl border border-red-400/20 bg-red-400/10 px-4 py-3 text-sm text-red-300">{error}</div>}

      <section className="mt-9">
        <div className="mb-4 flex items-end justify-between"><div><p className="text-xs font-semibold uppercase tracking-[0.2em] text-muted">Archive</p><h2 className="mt-1 text-2xl font-semibold">Latest episodes</h2></div><span className="text-xs text-muted">Showing {Math.min(visible, episodes.length)} of {episodes.length}</span></div>
        {episodes.length === 0 ? <div className="rounded-2xl border border-surface-3 p-10 text-center text-sm text-muted">No episodes with tracklists are available yet.</div> : (
          <div className="space-y-3">
            {episodes.slice(0, visible).map((episode, index) => {
              const rows = tracklists[episode.id];
              return <article key={episode.id} className="rounded-2xl border border-surface-3 bg-surface-1 p-4 md:p-5">
                <div className="flex gap-4">
                  <div className="relative hidden h-20 w-20 flex-none overflow-hidden rounded-lg bg-surface-2 sm:block">{episode.artwork_url ? <img src={episode.artwork_url} alt="" className="h-full w-full object-cover" /> : <span className="flex h-full items-center justify-center text-muted">♫</span>}</div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">{index === 0 && <span className="rounded-full bg-accent px-2 py-1 text-[10px] font-bold text-black">LATEST</span>}<span className="text-xs text-muted">{formatEpisodeDate(episode)}</span></div>
                    <h3 className="mt-1 text-lg font-semibold leading-snug">{episode.title || "Untitled episode"}</h3>
                    <p className="mt-1 text-xs text-muted">{episode.dj_name ? `DJ ${episode.dj_name}` : "DJ unavailable"} · {episode.track_count || 0} tracks · {episode.resolved_count || 0} resolved</p>
                    <div className="mt-3 flex flex-wrap items-center gap-3"><button onClick={() => void startEpisode(episode)} disabled={Boolean(startingId)} className="rounded-lg bg-accent px-3 py-2 text-xs font-bold text-black transition hover:brightness-110 disabled:opacity-50">{startingId === episode.id ? "Starting…" : "▶ Start episode"}</button>{episode.url && <a href={episode.url} target="_blank" rel="noreferrer" className="text-xs font-medium text-muted hover:text-foreground">Episode page ↗</a>}{episode.soundcloud_url && <a href={episode.soundcloud_url} target="_blank" rel="noreferrer" className="text-xs font-medium text-muted hover:text-foreground">SoundCloud ↗</a>}</div>
                  </div>
                </div>
                {startMessage[episode.id] && <p aria-live="polite" className="mt-3 rounded-lg bg-surface-2 px-3 py-2 text-xs text-muted">{startMessage[episode.id]}</p>}
                {rows && <ol className="mt-3 divide-y divide-surface-3 border-t border-surface-3">{rows.map((row) => <li key={row.appearance_id} className="grid grid-cols-[2rem_1fr_auto] items-center gap-2 py-2 text-xs"><span className="font-mono text-muted">{row.position + 1}</span><span className={row.track ? "text-foreground/80" : "text-muted"}>{row.artist || row.source_artist || "Unknown artist"} — {row.title || row.source_title || "Unidentified track"}</span><span className={row.track ? (isReady(row) ? "text-green-400" : "text-amber-300") : "text-muted"}>{row.track ? (isReady(row) ? "ready" : row.audio_status === "failed" ? "unavailable" : "queued") : "unresolved"}</span></li>)}</ol>}
              </article>;
            })}
          </div>
        )}
        {visible < episodes.length ? <button onClick={() => setVisible((value) => Math.min(value + INITIAL_EPISODES, episodes.length))} className="mt-5 w-full rounded-xl border border-surface-3 bg-surface-1 py-3 text-sm font-semibold hover:bg-surface-2">View more from the archive</button> : episodes.length > INITIAL_EPISODES ? <p className="mt-5 text-center text-xs text-muted">End of the available archive</p> : null}
      </section>
    </main>
  );
}
