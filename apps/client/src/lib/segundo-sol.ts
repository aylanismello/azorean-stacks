import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

export type MusicPlatform =
  | "spotify"
  | "soundcloud"
  | "bandcamp"
  | "youtube"
  | "mixcloud"
  | "other";

export interface EnrichedMusicLink {
  url: string;
  source_type: MusicPlatform;
  title: string;
  creator: string;
  artwork_url: string | null;
  provider_name: string | null;
  metadata: Record<string, unknown>;
}

const PLATFORM_HOSTS: Array<[MusicPlatform, RegExp]> = [
  ["spotify", /(^|\.)spotify\.com$/i],
  ["soundcloud", /(^|\.)soundcloud\.com$/i],
  ["bandcamp", /(^|\.)bandcamp\.com$/i],
  ["youtube", /(^|\.)(youtube\.com|youtu\.be)$/i],
  ["mixcloud", /(^|\.)mixcloud\.com$/i],
];

const MAX_REDIRECTS = 3;
const MAX_METADATA_BYTES = 1_000_000;

type LookupAddress = { address: string; family: number };
type FetchImplementation = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type SafeFetchDependencies = {
  fetchImpl?: FetchImplementation;
  lookupImpl?: (hostname: string) => Promise<LookupAddress[]>;
};

function isPrivateIpv4(address: string): boolean {
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true;
  }
  const [a, b] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 0 || b === 168)) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

export function isPublicIpAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !isPrivateIpv4(address);
  if (family !== 6) return false;

  const normalized = address.toLowerCase().split("%")[0];
  if (normalized === "::" || normalized === "::1") return false;
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return false;
  if (/^fe[89ab]/.test(normalized)) return false;
  if (normalized.startsWith("ff")) return false;
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  return mapped ? !isPrivateIpv4(mapped[1]) : true;
}

async function defaultLookup(hostname: string): Promise<LookupAddress[]> {
  return dnsLookup(hostname, { all: true, verbatim: true });
}

async function validateOutboundMusicUrl(
  rawUrl: string,
  lookupImpl: (hostname: string) => Promise<LookupAddress[]>
): Promise<URL> {
  const parsed = new URL(rawUrl);
  if (parsed.protocol !== "https:" || detectMusicPlatform(parsed.toString()) === "other") {
    throw new Error("Unsafe metadata URL");
  }
  const addresses = await lookupImpl(parsed.hostname);
  if (addresses.length === 0 || addresses.some(({ address }) => !isPublicIpAddress(address))) {
    throw new Error("Metadata host resolved to a non-public address");
  }
  return parsed;
}

export async function fetchWithValidatedRedirects(
  rawUrl: string,
  init: RequestInit = {},
  dependencies: SafeFetchDependencies = {}
): Promise<Response> {
  const fetchImpl = dependencies.fetchImpl || fetch;
  const lookupImpl = dependencies.lookupImpl || defaultLookup;
  let currentUrl = rawUrl;

  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    const parsed = await validateOutboundMusicUrl(currentUrl, lookupImpl);
    const response = await fetchImpl(parsed.toString(), { ...init, redirect: "manual" });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;

    const location = response.headers.get("location");
    if (!location || redirectCount === MAX_REDIRECTS) {
      throw new Error("Unsafe metadata redirect");
    }
    currentUrl = new URL(location, parsed).toString();
  }

  throw new Error("Too many metadata redirects");
}

export function detectMusicPlatform(rawUrl: string): MusicPlatform {
  try {
    const host = new URL(rawUrl).hostname;
    return PLATFORM_HOSTS.find(([, pattern]) => pattern.test(host))?.[0] || "other";
  } catch {
    return "other";
  }
}

export function normalizeMusicUrl(rawUrl: string): string | null {
  try {
    const parsed = new URL(rawUrl.trim());
    if (parsed.protocol !== "https:") return null;
    if (detectMusicPlatform(parsed.toString()) === "other") return null;
    parsed.hash = "";
    for (const key of Array.from(parsed.searchParams.keys())) {
      if (key.startsWith("utm_") || ["si", "feature", "ref"].includes(key)) {
        parsed.searchParams.delete(key);
      }
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

export function normalizeEmbedIdentity(
  platform: MusicPlatform,
  rawTitle: string | null | undefined,
  rawCreator: string | null | undefined,
  rawDescription?: string | null
): { title: string; creator: string } {
  let title = (rawTitle || "Untitled reference").trim();
  let creator = (rawCreator || "").trim();

  title = title
    .replace(/\s*\|\s*(Spotify|SoundCloud|Bandcamp|YouTube).*$/i, "")
    .replace(/\s+on\s+SoundCloud$/i, "")
    .trim();

  const spotifyMatch = title.match(/^(.+?)\s+-\s+(?:song(?: and lyrics)?\s+)?by\s+(.+)$/i);
  if (platform === "spotify" && spotifyMatch) {
    title = spotifyMatch[1].trim();
    creator = spotifyMatch[2].trim();
  } else if (platform === "bandcamp") {
    const bandcampMatch = title.match(/^(.+?),?\s+by\s+(.+)$/i);
    if (bandcampMatch) {
      title = bandcampMatch[1].trim();
      creator = bandcampMatch[2].trim();
    }
  } else if (!creator) {
    const dashMatch = title.match(/^(.+?)\s+[–—-]\s+(.+)$/);
    if (dashMatch) {
      creator = dashMatch[1].trim();
      title = dashMatch[2].trim();
    }
  }

  if (
    platform === "spotify" &&
    (!creator || creator.toLowerCase() === "spotify" || /^https?:\/\//i.test(creator)) &&
    rawDescription
  ) {
    const parts = rawDescription.split("·").map((part) => part.trim()).filter(Boolean);
    const titleIndex = parts.findIndex((part) => part.toLowerCase() === title.toLowerCase());
    if (titleIndex > 0) creator = parts[titleIndex - 1];
  }

  return { title, creator };
}

export function episodeTrackDedupeKey(input: {
  track_id?: string | null;
  source_url?: string | null;
  artist?: string | null;
  title?: string | null;
}): string {
  if (input.track_id) return `track:${input.track_id}`;
  const normalized = input.source_url ? normalizeMusicUrl(input.source_url) : null;
  if (normalized) return `url:${normalized.toLowerCase()}`;
  return `text:${(input.artist || "").trim().toLowerCase()}::${(input.title || "").trim().toLowerCase()}`;
}

function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function metaContent(html: string, key: string): string | null {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(`<meta[^>]+(?:property|name)=["']${escaped}["'][^>]+content=["']([^"']+)["'][^>]*>`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${escaped}["'][^>]*>`, "i"),
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match) return decodeHtml(match[1].trim());
  }
  return null;
}

async function fetchJson(url: string): Promise<Record<string, unknown> | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 7000);
  try {
    const response = await fetchWithValidatedRedirects(url, {
      signal: controller.signal,
      headers: { "User-Agent": "AzoreanStacks/1.0 SegundoSolCMS" },
      cache: "no-store",
    });
    if (!response.ok) return null;
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchOpenGraph(url: string): Promise<Record<string, unknown> | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 7000);
  try {
    const response = await fetchWithValidatedRedirects(url, {
      signal: controller.signal,
      headers: { "User-Agent": "AzoreanStacks/1.0 SegundoSolCMS" },
      cache: "no-store",
    });
    if (!response.ok) return null;
    const html = (await response.text()).slice(0, 1_000_000);
    return {
      title: metaContent(html, "og:title") || metaContent(html, "twitter:title"),
      author_name: metaContent(html, "music:musician") || metaContent(html, "og:site_name"),
      thumbnail_url: metaContent(html, "og:image") || metaContent(html, "twitter:image"),
      description: metaContent(html, "og:description") || metaContent(html, "description"),
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export async function enrichMusicUrl(rawUrl: string): Promise<EnrichedMusicLink | null> {
  const url = normalizeMusicUrl(rawUrl);
  if (!url) return null;
  const platform = detectMusicPlatform(url);
  let data: Record<string, unknown> | null = null;

  if (platform === "spotify") {
    data = await fetchJson(`https://open.spotify.com/oembed?url=${encodeURIComponent(url)}`);
  } else if (platform === "youtube") {
    data = await fetchJson(`https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`);
  } else if (platform === "soundcloud") {
    data = await fetchJson(`https://soundcloud.com/oembed?format=json&url=${encodeURIComponent(url)}`);
  } else if (platform === "mixcloud") {
    data = await fetchJson(`https://www.mixcloud.com/oembed/?format=json&url=${encodeURIComponent(url)}`);
  } else if (platform === "bandcamp") {
    data = await fetchJson(`https://bandcamp.com/oembed?format=json&url=${encodeURIComponent(url)}`);
  }

  // Spotify oEmbed omits the artist. Its Open Graph title normally carries
  // "Track - song by Artist", so merge that richer identity into the oEmbed
  // artwork payload. Bandcamp pages are similarly more complete than oEmbed.
  if (platform === "spotify" || platform === "bandcamp") {
    const pageData = await fetchOpenGraph(url);
    if (pageData) {
      data = {
        ...(data || {}),
        ...pageData,
        thumbnail_url: data?.thumbnail_url || pageData.thumbnail_url,
        provider_name: data?.provider_name || pageData.provider_name,
      };
    }
  }
  if (!data) data = await fetchOpenGraph(url);
  if (!data) {
    return {
      url,
      source_type: platform,
      title: "Untitled reference",
      creator: "",
      artwork_url: null,
      provider_name: null,
      metadata: {},
    };
  }

  const identity = normalizeEmbedIdentity(
    platform,
    typeof data.title === "string" ? data.title : null,
    typeof data.author_name === "string" ? data.author_name : null,
    typeof data.description === "string" ? data.description : null
  );

  return {
    url,
    source_type: platform,
    title: identity.title,
    creator: identity.creator,
    artwork_url:
      typeof data.thumbnail_url === "string"
        ? data.thumbnail_url
        : typeof data.thumbnail_url_with_play_button === "string"
          ? data.thumbnail_url_with_play_button
          : null,
    provider_name: typeof data.provider_name === "string" ? data.provider_name : null,
    metadata: data,
  };
}
