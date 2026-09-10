/** Soulection Radio's public tracklist source. */
import { load } from "cheerio";
import type { DiscoverySource, SourceEpisode, SourceTrack } from "../sources";

const BASE_URL = "https://radio.soulection.com";
const UUID_PATH = /\/(?:episodes|artists|songs|djs)\/([0-9a-f-]{36})(?:$|[?#/])/i;

export interface SoulectionTrackRow {
  position: number;
  timestamp: string;
  timestampSeconds: number;
  artist: string | null;
  title: string | null;
  artistId: string | null;
  songId: string | null;
}

export interface SoulectionEpisodeDetail {
  id: string;
  url: string;
  title: string;
  description: string | null;
  artworkUrl: string | null;
  soundcloudUrl: string | null;
  appleMusicUrl: string | null;
  dj: { id: string; name: string } | null;
  rows: SoulectionTrackRow[];
}

export interface SoulectionEpisodeSummary {
  id: string;
  url: string;
  title: string;
  description: string | null;
  releaseDate?: string | null;
  djId?: string | null;
  djName: string | null;
  artworkUrl: string | null;
  soundcloudUrl?: string | null;
  appleMusicUrl?: string | null;
}

function sourceId(href: string | undefined): string | null {
  if (!href) return null;
  return href.match(UUID_PATH)?.[1] || null;
}

function timestampSeconds(timestamp: string): number {
  const parts = timestamp.split(":").map(Number);
  if (parts.length !== 3 || parts.some((part) => !Number.isFinite(part))) return 0;
  return parts[0] * 3600 + parts[1] * 60 + parts[2];
}

export function parseSoulectionEpisode(html: string, id: string): SoulectionEpisodeDetail {
  const $ = load(html);
  const header = $("#episode-card-header").first();
  const title = header.find("h1").first().text().trim();
  if (!title) throw new Error("Soulection episode did not contain a title");
  const djLink = header.find('a[href^="/djs/"]').first();
  const soundcloudUrl = header.find('a[href*="soundcloud.com/"]').attr("href") || null;
  const appleMusicUrl = header.find('a[href*="music.apple.com/"]').attr("href") || null;
  const rows: SoulectionTrackRow[] = [];

  $("div.col-span-full").each((_, element) => {
    const row = $(element);
    const timestamp = row.find("span").first().text().trim();
    if (!/^\d{2}:\d{2}:\d{2}$/.test(timestamp)) return;
    const artistLink = row.find('a[href^="/artists/"]').first();
    const songLink = row.find('a[href^="/songs/"]').first();
    rows.push({
      position: rows.length,
      timestamp,
      timestampSeconds: timestampSeconds(timestamp),
      artist: artistLink.text().trim() || null,
      title: songLink.text().trim() || null,
      artistId: sourceId(artistLink.attr("href")),
      songId: sourceId(songLink.attr("href")),
    });
  });
  if (!rows.length) throw new Error("Soulection episode did not contain a tracklist");

  const description = header.find("h1").first().next("p").text().trim() || null;
  const artworkUrl = header.find('img[alt="Episode cover"]').attr("src")
    || $('meta[property="og:image"]').attr("content") || null;
  return {
    id,
    url: `${BASE_URL}/episodes/${id}`,
    title,
    description,
    artworkUrl,
    soundcloudUrl,
    appleMusicUrl,
    dj: sourceId(djLink.attr("href")) && djLink.text().trim()
      ? { id: sourceId(djLink.attr("href"))!, name: djLink.text().trim() }
      : null,
    rows,
  };
}

export function parseSoulectionIndex(html: string): SoulectionEpisodeSummary[] {
  const $ = load(html);
  const results: SoulectionEpisodeSummary[] = [];
  const seen = new Set<string>();
  $('li a[href^="/episodes/"]').each((_, element) => {
    const anchor = $(element);
    const id = sourceId(anchor.attr("href"));
    const title = anchor.find("h2").first().text().trim();
    if (!id || !title || seen.has(id)) return;
    seen.add(id);
    const descriptionNode = anchor.find("p").first().clone();
    const djName = descriptionNode.find("span").first().text().trim() || null;
    descriptionNode.find("span").remove();
    results.push({
      id,
      url: `${BASE_URL}/episodes/${id}`,
      title,
      description: descriptionNode.text().trim() || null,
      djName,
      artworkUrl: anchor.find("img").first().attr("src") || null,
    });
  });
  return results;
}

export function extractPublicCatalogConfig(bundle: string): { url: string; key: string } | null {
  const url = bundle.match(/https:\/\/[a-z0-9-]+\.supabase\.co/i)?.[0];
  const key = bundle.match(/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{8,}/)?.[0];
  return url && key ? { url, key } : null;
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(20_000),
    headers: { Accept: "text/html,application/xhtml+xml", "User-Agent": "Mozilla/5.0 (compatible; AzoreanStacks/1.0)" },
  });
  if (!response.ok) throw new Error(`Soulection fetch failed (${response.status})`);
  return response.text();
}

async function catalogConfig(): Promise<{ url: string; key: string }> {
  const envUrl = process.env.SOULECTION_PUBLIC_SUPABASE_URL;
  const envKey = process.env.SOULECTION_PUBLIC_SUPABASE_ANON_KEY;
  if (envUrl && envKey) return { url: envUrl.replace(/\/$/, ""), key: envKey };
  const indexHtml = await fetchText(BASE_URL);
  const $ = load(indexHtml);
  const bundleUrls = $("script[src]").map((_, element) => new URL($(element).attr("src")!, BASE_URL).href).get();
  for (const bundleUrl of bundleUrls) {
    const bundle = await fetchText(bundleUrl).catch(() => "");
    const config = extractPublicCatalogConfig(bundle);
    if (config) {
      return {
        url: (envUrl || config.url).replace(/\/$/, ""),
        key: envKey || config.key,
      };
    }
  }
  throw new Error("Soulection public catalog endpoint was not discoverable; set SOULECTION_PUBLIC_SUPABASE_URL and SOULECTION_PUBLIC_SUPABASE_ANON_KEY");
}

export async function getRecentSoulectionEpisodes(limit = 20): Promise<SoulectionEpisodeSummary[]> {
  const boundedLimit = Math.max(1, Math.min(100, Math.floor(limit)));
  const config = await catalogConfig();
  const endpoint = new URL(`${config.url}/rest/v1/episodes`);
  endpoint.searchParams.set("select", "*,djs(name)");
  endpoint.searchParams.set("order", "release_date.desc");
  endpoint.searchParams.set("limit", String(boundedLimit));
  const headers = new Headers({ Accept: "application/json" });
  headers.set("apikey", config.key);
  headers.set("Authorization", ["Bearer", config.key].join(" "));
  const response = await fetch(endpoint, {
    signal: AbortSignal.timeout(20_000),
    headers,
  });
  if (!response.ok) throw new Error(`Soulection catalog request failed (${response.status})`);
  const rows = await response.json() as any[];
  if (!Array.isArray(rows)) throw new Error("Soulection catalog response had an unexpected shape");
  return rows.flatMap((row) => {
    const summary = soulectionSummaryFromRow(row);
    return summary ? [summary] : [];
  });
}

export function soulectionSummaryFromRow(row: any): SoulectionEpisodeSummary | null {
  if (!row?.id || !row?.title) return null;
  const dj = Array.isArray(row.djs) ? row.djs[0] : row.djs;
  return {
      id: String(row.id),
      url: `${BASE_URL}/episodes/${row.id}`,
      title: String(row.title),
      description: row.description || null,
      releaseDate: row.release_date || null,
      djId: row.dj_id || null,
      djName: dj?.name || null,
      artworkUrl: row.soundcloud_artwork_url || null,
      soundcloudUrl: row.soundcloud_url || null,
      appleMusicUrl: row.apple_music_url || null,
  };
}

export async function fetchSoulectionEpisode(summary: SoulectionEpisodeSummary): Promise<SoulectionEpisodeDetail> {
  return parseSoulectionEpisode(await fetchText(summary.url), summary.id);
}

export const soulectionSource: DiscoverySource = {
  name: "soulection",
  async searchForSeed(_artist: string, _title: string): Promise<SourceEpisode[]> { return []; },
  async getTracklist(episodeUrl: string): Promise<SourceTrack[]> {
    const id = sourceId(new URL(episodeUrl).pathname);
    if (!id) return [];
    const episode = parseSoulectionEpisode(await fetchText(episodeUrl), id);
    return episode.rows.flatMap((row) => row.artist && row.title
      ? [{ artist: row.artist, title: row.title, timestamp: row.timestamp }]
      : []);
  },
  async getArtwork(episodeUrl: string): Promise<string | null> {
    const id = sourceId(new URL(episodeUrl).pathname);
    return id ? parseSoulectionEpisode(await fetchText(episodeUrl), id).artworkUrl : null;
  },
};
