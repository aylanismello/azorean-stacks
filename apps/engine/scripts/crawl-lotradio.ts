#!/usr/bin/env bun
/**
 * Incremental Lot Radio archive indexer.
 *
 * The public index renders its first cursor page into the RSC HTML. The next
 * pages use a deployment-specific Next server action, so this crawler discovers
 * and validates that action from the current JS bundle instead of pinning a hash.
 */
import { parseArgs } from "util";
import { load } from "cheerio";
import { getSupabase } from "../lib/supabase";

const LOT_BASE = "https://www.thelotradio.com";
const INDEX_URL = `${LOT_BASE}/the-index`;
const RATE_LIMIT_MS = 500;

function log(kind: "ok" | "info", message: string): void {
  console.log(`${kind === "ok" ? "  ✓" : "  →"} ${message}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface LotTrack {
  artist: string;
  title: string;
  timestamp?: string | null;
}

interface LotEpisode {
  sys: { id: string };
  title?: string | null;
  slug: string;
  date?: string | null;
  startTimestamp?: string | null;
  show?: { slug?: string | null; photo?: { url?: string | null } | null } | null;
  image?: { url?: string | null } | null;
  tracklist?: LotTrack[] | null;
  transcodedFile?: { hls?: string | null; mp4?: unknown[] } | null;
}

interface IndexPage {
  items: LotEpisode[];
  total: number;
  pages: { next?: string | null; prev?: string | null };
}

function positiveInteger(raw: unknown, fallback: number, name: string): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative integer`);
  return parsed || fallback;
}

function parseBalancedObject(text: string, start: number): string {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index++) {
    const character = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "{") depth++;
    else if (character === "}" && --depth === 0) return text.slice(start, index + 1);
  }
  throw new Error("Unterminated initialData object in Lot Radio response");
}

export function extractInitialPage(html: string): IndexPage {
  const $ = load(html);
  let flight = "";
  $("script").each((_, script) => {
    const body = $(script).html() || "";
    const match = body.match(/^self\.__next_f\.push\((.*)\)$/s);
    if (!match) return;
    try {
      const value = JSON.parse(match[1]);
      if (Array.isArray(value) && typeof value[1] === "string") flight += value[1];
    } catch {
      // Other inline scripts are unrelated to the RSC payload.
    }
  });
  const marker = flight.indexOf('"initialData":');
  if (marker < 0) throw new Error("Lot Radio index did not contain initialData");
  const start = flight.indexOf("{", marker);
  if (start < 0) throw new Error("Lot Radio initialData was malformed");
  const page = JSON.parse(parseBalancedObject(flight, start)) as IndexPage;
  if (!Array.isArray(page.items) || typeof page.total !== "number") {
    throw new Error("Lot Radio initialData had an unexpected shape");
  }
  return page;
}

export function extractEpisodesAction(bundle: string): string | null {
  const match = bundle.match(/createServerReference\)\("([a-f0-9]{32,64})"[^;]{0,300}"getEpisodes"\)/);
  return match?.[1] || null;
}

async function fetchText(url: string, init?: RequestInit): Promise<string> {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(30_000),
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; AzoreanStacks/1.0)",
      ...(init?.headers || {}),
    },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
  return response.text();
}

async function loadIndex(): Promise<{ html: string; page: IndexPage }> {
  const html = await fetchText(INDEX_URL, { headers: { Accept: "text/html,application/xhtml+xml" } });
  return { html, page: extractInitialPage(html) };
}

async function discoverEpisodesAction(html: string): Promise<string> {
  const $ = load(html);
  const urls = $("script[src]").map((_, script) => new URL($(script).attr("src")!, LOT_BASE).href).get();
  const bundles = await Promise.all(urls.map((url) => fetchText(url).catch(() => "")));
  for (const bundle of bundles) {
    const action = extractEpisodesAction(bundle);
    if (action) return action;
  }
  throw new Error("Could not discover the current Lot Radio getEpisodes action");
}

export function parseRscPage(text: string): IndexPage {
  for (const line of text.split("\n")) {
    if (!/^\d+:\{/.test(line)) continue;
    try {
      const page = JSON.parse(line.slice(line.indexOf(":") + 1)) as IndexPage;
      if (Array.isArray(page.items) && typeof page.total === "number") return page;
    } catch {
      // Flight responses may contain unrelated or deferred rows.
    }
  }
  throw new Error("Lot Radio action response had no episode page");
}

async function fetchNextPage(action: string, cursor: string, limit: number): Promise<IndexPage> {
  const text = await fetchText(INDEX_URL, {
    method: "POST",
    headers: {
      Accept: "text/x-component",
      "Content-Type": "text/plain;charset=UTF-8",
      "next-action": action,
    },
    body: JSON.stringify([{ limit, cursor, order: "date:desc", filters: {}, staffChoice: false }]),
  });
  return parseRscPage(text);
}

function timestampOffset(trackTimestamp: string | null | undefined, startTimestamp: string | null | undefined): string | null {
  if (!trackTimestamp) return null;
  if (/^\d{2}:\d{2}:\d{2}$/.test(trackTimestamp)) return trackTimestamp;
  if (!startTimestamp) return null;
  const elapsed = Math.max(0, Date.parse(trackTimestamp) - Date.parse(startTimestamp));
  if (!Number.isFinite(elapsed)) return null;
  const seconds = Math.floor(elapsed / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return [hours, minutes, seconds % 60].map((value) => String(value).padStart(2, "0")).join(":");
}

export function episodeRow(episode: LotEpisode) {
  const showSlug = episode.show?.slug || "special-guests";
  const url = `${LOT_BASE}/shows/${showSlug}/${episode.slug}`;
  const hasTracklistData = Array.isArray(episode.tracklist);
  const tracklist = (episode.tracklist || [])
    .filter((track) => track.artist?.trim() && track.title?.trim())
    .map((track) => ({
      artist: track.artist.trim(),
      title: track.title.trim(),
      timestamp: timestampOffset(track.timestamp, episode.startTimestamp),
    }));
  const dateMatch = episode.slug.match(/^(\d{4}-\d{2}-\d{2})/);
  const base = {
    url,
    title: episode.title?.trim() || null,
    source: "lotradio",
    aired_date: dateMatch?.[1] || episode.date?.slice(0, 10) || null,
    artwork_url: episode.image?.url || episode.show?.photo?.url || null,
  };
  if (!hasTracklistData) return { ...base, hasTracklistData: false as const };
  return {
    ...base,
    hasTracklistData: true as const,
    skipped: tracklist.length === 0,
    metadata: {
      source_episode_id: episode.sys.id,
      tracklist,
      tracklist_count: tracklist.length,
      source_audio_url: episode.transcodedFile?.hls || null,
      crawled_at: new Date().toISOString(),
      no_tracklist: tracklist.length === 0,
    },
  };
}

async function enumerateEpisodes(limit: number, offset: number): Promise<{ episodes: LotEpisode[]; total: number }> {
  const { html, page: firstPage } = await loadIndex();
  const needed = offset + limit;
  const episodes = [...firstPage.items];
  let page = firstPage;
  let action: string | null = null;

  while (episodes.length < needed && page.pages?.next) {
    action ||= await discoverEpisodesAction(html);
    await sleep(RATE_LIMIT_MS);
    page = await fetchNextPage(action, page.pages.next, Math.min(32, needed - episodes.length));
    if (!page.items.length) break;
    episodes.push(...page.items);
  }
  return { episodes: episodes.slice(offset, needed), total: firstPage.total };
}

async function main() {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      limit: { type: "string", default: "64" },
      offset: { type: "string", default: "0" },
    },
    strict: false,
  });
  const limit = positiveInteger(values.limit, 64, "limit");
  const offset = Number(values.offset || 0);
  if (!Number.isInteger(offset) || offset < 0) throw new Error("offset must be a non-negative integer");

  console.log(`\n  The Stacks — Lot Radio Crawler`);
  console.log(`  ${new Date().toISOString()}`);
  console.log(`  Options: limit=${limit}, offset=${offset}\n`);

  const { episodes, total } = await enumerateEpisodes(limit, offset);
  log("ok", `Enumerated ${episodes.length}/${total} archive episodes`);
  const rows = episodes.map(episodeRow);
  let written = 0;
  for (let index = 0; index < rows.length; index += 100) {
    const batch = rows.slice(index, index + 100);
    const completeRows = batch
      .filter((row) => row.hasTracklistData)
      .map(({ hasTracklistData: _hasTracklistData, ...row }) => row);
    const metadataOnlyRows = batch
      .filter((row) => !row.hasTracklistData)
      .map(({ hasTracklistData: _hasTracklistData, ...row }) => row);
    for (const candidateRows of [completeRows, metadataOnlyRows]) {
      if (!candidateRows.length) continue;
      const { error } = await getSupabase().from("episodes").upsert(candidateRows, { onConflict: "url" });
      if (error) throw new Error(`Lot Radio episode upsert failed: ${error.message}`);
      written += candidateRows.length;
    }
  }
  const useful = rows.filter((row) => row.hasTracklistData && !row.skipped).length;
  const confirmedEmpty = rows.filter((row) => row.hasTracklistData && row.skipped).length;
  const missing = rows.length - useful - confirmedEmpty;
  log("ok", `Indexed ${written} episodes (${useful} with tracklists, ${confirmedEmpty} confirmed empty, ${missing} missing tracklist data)`);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(`\n  Lot Radio crawl failed: ${error instanceof Error ? error.stack || error.message : error}`);
    process.exit(1);
  });
}
