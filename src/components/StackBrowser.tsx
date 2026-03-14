"use client";

import { useState, useEffect } from "react";

interface StackEpisode {
  id: string;
  title: string | null;
  source: string;
  aired_date: string | null;
  match_type: string;
  pending: number;
  approved: number;
  rejected: number;
  total: number;
  cover_art_url: string | null;
  sample_tracks: { artist: string; title: string }[];
}

interface StackSeed {
  id: string;
  artist: string;
  title: string;
  active: boolean;
  episodes: StackEpisode[];
  total_pending: number;
  total_approved: number;
  total_rejected: number;
  total: number;
}

function hueFromString(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  return Math.abs(hash % 360);
}

function ProgressBar({ episode }: { episode: StackEpisode }) {
  if (episode.total === 0) return null;
  const approvedPct = (episode.approved / episode.total) * 100;
  const rejectedPct = (episode.rejected / episode.total) * 100;

  return (
    <div className="w-16 h-[3px] rounded-full bg-surface-3 overflow-hidden flex flex-shrink-0">
      {approvedPct > 0 && (
        <div className="h-full bg-green-500/70" style={{ width: `${approvedPct}%` }} />
      )}
      {rejectedPct > 0 && (
        <div className="h-full bg-red-500/30" style={{ width: `${rejectedPct}%` }} />
      )}
    </div>
  );
}

function SeedCard({
  seed,
  onSelectStack,
}: {
  seed: StackSeed;
  onSelectStack: (episodeId: string | null, episodeTitle: string | null) => void;
}) {
  const [expanded, setExpanded] = useState(seed.total_pending > 0);
  const seedHue = hueFromString(`${seed.artist}-${seed.title}`);

  const pendingEpisodes = seed.episodes.filter((ep) => ep.pending > 0);
  const doneEpisodes = seed.episodes.filter((ep) => ep.pending === 0);

  return (
    <div className="rounded-xl bg-surface-1">
      {/* Seed header row */}
      <div className="flex items-center gap-4 p-4">
        {/* Seed color dot */}
        <div
          className="w-3 h-3 rounded-full flex-shrink-0"
          style={{ backgroundColor: `hsl(${seedHue}, 50%, 55%)` }}
        />

        {/* Info — clickable to expand */}
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex-1 min-w-0 text-left"
        >
          <p className="text-sm font-medium text-white truncate">{seed.artist}</p>
          <p className="text-xs text-white/60 truncate">{seed.title}</p>
          <p className="text-[10px] text-muted mt-0.5">
            {seed.episodes.length} episode{seed.episodes.length !== 1 ? "s" : ""}
            {" "}{expanded ? "▾" : "▸"}
          </p>
        </button>

        {/* Stats */}
        <div className="text-right flex-shrink-0 flex items-center gap-4">
          {seed.total_pending > 0 && (
            <span className="text-xs font-mono text-white/50">{seed.total_pending} waiting</span>
          )}
          {seed.total_approved > 0 && (
            <span className="text-xs font-mono text-green-400/60">{seed.total_approved} kept</span>
          )}
        </div>
      </div>

      {/* Expanded: episode list */}
      {expanded && (
        <div className="border-t border-surface-3 px-4 py-3 space-y-1">
          {/* Pending episodes first */}
          {pendingEpisodes.length > 0 && (
            <>
              {pendingEpisodes.map((ep) => (
                <EpisodeRow
                  key={ep.id}
                  episode={ep}
                  onSelect={() => onSelectStack(ep.id, ep.title)}
                />
              ))}
            </>
          )}

          {/* Done episodes — dimmed */}
          {doneEpisodes.length > 0 && (
            <>
              {pendingEpisodes.length > 0 && doneEpisodes.length > 0 && (
                <div className="border-t border-surface-3/50 my-2" />
              )}
              {doneEpisodes.map((ep) => (
                <EpisodeRow
                  key={ep.id}
                  episode={ep}
                  done
                  onSelect={() => onSelectStack(ep.id, ep.title)}
                />
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function EpisodeRow({
  episode,
  done,
  onSelect,
}: {
  episode: StackEpisode;
  done?: boolean;
  onSelect: () => void;
}) {
  return (
    <div
      className={`py-2.5 ${done ? "opacity-40" : ""}`}
    >
      {/* Top line: title + dig button */}
      <div className="flex items-center gap-2 mb-1">
        <span className="text-white/80 truncate flex-1 min-w-0 text-sm">
          {episode.title || "Untitled"}
        </span>
        {episode.pending > 0 ? (
          <button
            onClick={onSelect}
            className="text-[11px] px-3 py-1 rounded-full bg-accent/10 text-accent hover:bg-accent/20 transition-colors flex-shrink-0 active:scale-95"
          >
            Dig →
          </button>
        ) : (
          <span className="text-[10px] text-green-400/40 flex-shrink-0">done</span>
        )}
      </div>

      {/* Bottom line: badges + stats */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-surface-2 text-muted uppercase tracking-wider flex-shrink-0">
          {episode.source}
        </span>
        <span className={`text-[9px] px-1 py-0.5 rounded flex-shrink-0 ${
          episode.match_type === "full"
            ? "bg-accent/15 text-accent"
            : "bg-amber-500/15 text-amber-400"
        }`}>
          {episode.match_type === "full" ? "exact" : "artist only"}
        </span>
        {episode.aired_date && (
          <span className="text-[10px] text-muted flex-shrink-0">
            {new Date(episode.aired_date).toLocaleDateString("en-US", { day: "2-digit", month: "short" })}
          </span>
        )}
        <ProgressBar episode={episode} />
        <div className="flex items-center gap-1.5 flex-shrink-0 text-[9px] font-mono">
          {episode.approved > 0 && (
            <span className="text-green-400/70">{episode.approved}</span>
          )}
          {episode.rejected > 0 && (
            <span className="text-red-400/40">{episode.rejected}</span>
          )}
          {episode.pending > 0 && (
            <span className="text-white/40">{episode.pending}</span>
          )}
        </div>
      </div>
    </div>
  );
}

export function StackBrowser({
  onSelectStack,
  onClose,
}: {
  onSelectStack: (episodeId: string | null, episodeTitle: string | null) => void;
  onClose: () => void;
}) {
  const [stacks, setStacks] = useState<StackSeed[]>([]);
  const [totalPending, setTotalPending] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/stacks")
      .then((r) => r.json())
      .then((data) => {
        setStacks(data.stacks || []);
        setTotalPending(data.total_pending || 0);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="w-8 h-8 border-2 border-accent/30 border-t-accent rounded-full animate-spin" />
      </div>
    );
  }

  if (stacks.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] text-center px-6">
        <p className="text-muted text-sm">No stacks yet — add seeds to start discovering.</p>
        <button
          onClick={onClose}
          className="mt-4 text-xs text-accent hover:text-accent-bright transition-colors"
        >
          Back
        </button>
      </div>
    );
  }

  return (
    <div className="px-4 md:px-6 pt-4 md:pt-8 max-w-2xl mx-auto pb-24 md:pb-8 stack-browser-enter">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-semibold flex items-center gap-2">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-accent">
              <rect x="3" y="3" width="7" height="7" rx="1" />
              <rect x="14" y="3" width="7" height="7" rx="1" />
              <rect x="3" y="14" width="7" height="7" rx="1" />
              <rect x="14" y="14" width="7" height="7" rx="1" />
            </svg>
            All Stacks
          </h1>
          <p className="text-xs text-muted font-mono mt-0.5">
            {totalPending} tracks waiting across {stacks.length} seed{stacks.length !== 1 ? "s" : ""}
          </p>
        </div>
        <button
          onClick={onClose}
          className="text-xs text-muted hover:text-white px-3 py-1.5 rounded-lg bg-surface-2 hover:bg-surface-3 transition-colors flex items-center gap-1.5"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
            <line x1="8" y1="11" x2="14" y2="11" />
            <line x1="11" y1="8" x2="11" y2="14" />
          </svg>
          zoom in
        </button>
      </div>

      {/* "Everything" shortcut */}
      <button
        onClick={() => onSelectStack(null, null)}
        className="w-full text-left px-4 py-3 rounded-xl bg-surface-1 hover:bg-surface-2 transition-all group mb-4"
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="text-accent text-base">◉</span>
            <div>
              <p className="text-sm text-white/80 group-hover:text-white transition-colors">
                Everything
              </p>
              <p className="text-[10px] text-muted">all seeds, all episodes, shuffled</p>
            </div>
          </div>
          <span className="text-xs font-mono text-muted">{totalPending}</span>
        </div>
      </button>

      {/* Seed cards */}
      <div className="space-y-2">
        {stacks.map((seed) => (
          <SeedCard
            key={seed.id}
            seed={seed}
            onSelectStack={onSelectStack}
          />
        ))}
      </div>
    </div>
  );
}
