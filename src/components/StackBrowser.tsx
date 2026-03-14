"use client";

import { useState, useEffect, useRef } from "react";

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
  matched_tracks: { artist: string; title: string }[];
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

function decodeEntities(s: string): string {
  if (!s.includes("&")) return s;
  return s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&#x27;/g, "'");
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

// Vinyl disc visual element
function VinylDisc({ hue, size = 48 }: { hue: number; size?: number }) {
  return (
    <div
      className="rounded-full flex-shrink-0 relative overflow-hidden"
      style={{
        width: size,
        height: size,
        background: `radial-gradient(circle at 50% 50%,
          hsl(${hue}, 30%, 8%) 0%,
          hsl(${hue}, 40%, 12%) 20%,
          hsl(${hue}, 35%, 8%) 22%,
          hsl(${hue}, 45%, 15%) 40%,
          hsl(${hue}, 35%, 10%) 42%,
          hsl(${hue}, 50%, 18%) 60%,
          hsl(${hue}, 40%, 10%) 62%,
          hsl(${hue}, 45%, 14%) 80%,
          hsl(${hue}, 30%, 6%) 100%)`,
      }}
    >
      {/* Center label */}
      <div
        className="absolute rounded-full"
        style={{
          width: size * 0.35,
          height: size * 0.35,
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          background: `hsl(${hue}, 50%, 40%)`,
        }}
      />
      {/* Center hole */}
      <div
        className="absolute rounded-full bg-surface-0"
        style={{
          width: size * 0.08,
          height: size * 0.08,
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
        }}
      />
    </div>
  );
}

function SeedCard({
  seed,
  onSelectStack,
  highlightEpisodeId,
}: {
  seed: StackSeed;
  onSelectStack: (episodeId: string | null, episodeTitle: string | null) => void;
  highlightEpisodeId?: string | null;
}) {
  const [expanded, setExpanded] = useState(
    seed.total_pending > 0 || seed.episodes.some((ep) => ep.id === highlightEpisodeId)
  );
  const seedHue = hueFromString(`${seed.artist}-${seed.title}`);

  const sortedEpisodes = [...seed.episodes].sort((a, b) => {
    if (a.match_type === "full" && b.match_type !== "full") return -1;
    if (a.match_type !== "full" && b.match_type === "full") return 1;
    return b.pending - a.pending;
  });
  const pendingEpisodes = sortedEpisodes.filter((ep) => ep.pending > 0);
  const doneEpisodes = sortedEpisodes.filter((ep) => ep.pending === 0);

  return (
    <div
      className="rounded-xl overflow-hidden"
      style={{
        background: `linear-gradient(135deg, hsl(${seedHue}, 15%, 9%) 0%, hsl(${seedHue}, 10%, 7%) 100%)`,
        borderLeft: `3px solid hsl(${seedHue}, 50%, 35%)`,
      }}
    >
      {/* Seed header row */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-4 p-4 hover:bg-white/[0.02] transition-colors"
      >
        {/* Vinyl disc */}
        <VinylDisc hue={seedHue} size={44} />

        {/* Info */}
        <div className="flex-1 min-w-0 text-left">
          <p className="text-sm font-medium text-white truncate">{decodeEntities(seed.artist)}</p>
          <p className="text-xs text-white/50 truncate">{decodeEntities(seed.title)}</p>
          <p className="text-[10px] text-muted mt-0.5">
            {seed.episodes.length} episode{seed.episodes.length !== 1 ? "s" : ""}
            {" "}{expanded ? "▾" : "▸"}
          </p>
        </div>

        {/* Stats */}
        <div className="text-right flex-shrink-0 flex items-center gap-4">
          {seed.total_pending > 0 && (
            <span className="text-xs font-mono text-white/50">{seed.total_pending} waiting</span>
          )}
          {seed.total_approved > 0 && (
            <span className="text-xs font-mono text-green-400/60">{seed.total_approved} kept</span>
          )}
        </div>
      </button>

      {/* Expanded: episode list */}
      {expanded && (
        <div className="border-t border-white/5 px-4 py-3 space-y-1">
          {pendingEpisodes.length > 0 && (
            <>
              {pendingEpisodes.map((ep) => (
                <EpisodeRow
                  key={ep.id}
                  episode={ep}
                  onSelect={() => onSelectStack(ep.id, ep.title)}
                  highlighted={ep.id === highlightEpisodeId}
                />
              ))}
            </>
          )}

          {doneEpisodes.length > 0 && (
            <>
              {pendingEpisodes.length > 0 && doneEpisodes.length > 0 && (
                <div className="border-t border-white/5 my-2" />
              )}
              {doneEpisodes.map((ep) => (
                <EpisodeRow
                  key={ep.id}
                  episode={ep}
                  done
                  onSelect={() => onSelectStack(ep.id, ep.title)}
                  highlighted={ep.id === highlightEpisodeId}
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
  highlighted,
}: {
  episode: StackEpisode;
  done?: boolean;
  onSelect: () => void;
  highlighted?: boolean;
}) {
  const rowRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (highlighted && rowRef.current) {
      rowRef.current.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [highlighted]);

  return (
    <div
      ref={rowRef}
      className={`py-2.5 rounded-lg px-2 transition-colors ${
        done ? "opacity-40" : ""
      } ${highlighted ? "bg-accent/5 ring-1 ring-accent/20" : ""}`}
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
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/5 text-muted uppercase tracking-wider flex-shrink-0">
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
            {new Date(episode.aired_date).toLocaleDateString("en-US", { day: "2-digit", month: "short", year: "numeric" })}
          </span>
        )}
        <ProgressBar episode={episode} />
        <div className="flex items-center gap-1.5 flex-shrink-0 text-[9px] font-mono">
          {episode.approved > 0 && (
            <span className="text-green-400/70">{episode.approved} kept</span>
          )}
          {episode.rejected > 0 && (
            <span className="text-red-400/40">{episode.rejected} skipped</span>
          )}
          {episode.pending > 0 && (
            <span className="text-white/40">{episode.pending} pending</span>
          )}
        </div>
      </div>
      {/* For artist-only matches, show which tracks by this artist are in the episode */}
      {episode.match_type !== "full" && episode.matched_tracks && episode.matched_tracks.length > 0 && (
        <p className="text-[10px] text-amber-400/60 mt-1 truncate">
          found: {episode.matched_tracks.map((t) => t.title).join(", ")}
        </p>
      )}
    </div>
  );
}

export function StackBrowser({
  onSelectStack,
  onClose,
  scrollToEpisodeId,
}: {
  onSelectStack: (episodeId: string | null, episodeTitle: string | null) => void;
  onClose: () => void;
  scrollToEpisodeId?: string | null;
}) {
  const [stacks, setStacks] = useState<StackSeed[]>([]);
  const [totalPending, setTotalPending] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/stacks")
      .then((r) => {
        if (!r.ok) throw new Error(`Failed to load stacks (${r.status})`);
        return r.json();
      })
      .then((data) => {
        setStacks(data.stacks || []);
        setTotalPending(data.total_pending || 0);
        setError(null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load stacks"))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="w-8 h-8 border-2 border-accent/30 border-t-accent rounded-full animate-spin" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] text-center px-6">
        <p className="text-red-400 text-sm mb-3">{error}</p>
        <button
          onClick={() => { setError(null); setLoading(true); window.location.reload(); }}
          className="text-xs text-accent hover:text-accent-bright transition-colors"
        >
          Retry
        </button>
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
    <div className="px-4 md:px-6 pt-4 md:pt-8 max-w-2xl md:max-w-3xl mx-auto pb-24 md:pb-8 stack-browser-enter">
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
          className="text-xs text-muted hover:text-white px-3 py-1.5 rounded-lg bg-surface-2 hover:bg-surface-3 transition-colors"
        >
          Close
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
      <div className="space-y-3">
        {stacks.map((seed) => (
          <SeedCard
            key={seed.id}
            seed={seed}
            onSelectStack={onSelectStack}
            highlightEpisodeId={scrollToEpisodeId}
          />
        ))}
      </div>
    </div>
  );
}
