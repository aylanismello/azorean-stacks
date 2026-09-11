#!/usr/bin/env bun
/** Bounded, recent-first Soulection Radio indexer. */
import { parseArgs } from "node:util";
import type { SupabaseClient } from "@supabase/supabase-js";
import { canonicalTrackKey, escapeLike } from "../lib/canonical-track";
import {
  boundedSoulectionEpisodeLimit,
  fetchSoulectionEpisode,
  getRecentSoulectionEpisodes,
  SOULECTION_RECENT_EPISODE_LIMIT,
  type SoulectionEpisodeSummary,
} from "../lib/sources/soulection";
import { getSupabase } from "../lib/supabase";

interface CrawlOptions { limit?: number; db?: SupabaseClient }

export function soulectionCrawlLimit(limit?: number): number {
  return boundedSoulectionEpisodeLimit(limit);
}

export interface SoulectionAppearanceUpsert {
  episode_id: string;
  track_id: string | null;
  position: number;
  timestamp_text: string | null;
  timestamp_seconds: number | null;
  source_artist: string | null;
  source_title: string | null;
  source_artist_id: string | null;
  source_song_id: string | null;
  resolution_state: "canonical" | "unresolved";
  source_metadata: Record<string, never>;
  updated_at: string;
}

/** Update only appearances present in this refresh; omitted positions remain known-good. */
export async function upsertSoulectionAppearances(
  db: SupabaseClient,
  appearances: SoulectionAppearanceUpsert[],
): Promise<void> {
  if (!appearances.length) return;
  const { error } = await db.from("episode_track_entries")
    .upsert(appearances, { onConflict: "episode_id,position" });
  if (error) throw new Error(`Appearance upsert failed: ${error.message}`);
}

async function canonicalTrackId(db: SupabaseClient, episodeUrl: string, row: { artist: string | null; title: string | null; artistId: string | null; songId: string | null }): Promise<string | null> {
  if (!row.artist?.trim() || !row.title?.trim()) return null;
  const artist = row.artist.normalize("NFKC").trim();
  const title = row.title.normalize("NFKC").trim();
  const { data: existing, error: findError } = await db.from("tracks")
    .select("id,artist,title")
    .ilike("artist", escapeLike(artist))
    .ilike("title", escapeLike(title))
    .limit(10);
  if (findError) throw new Error(`Canonical lookup failed: ${findError.message}`);
  const match = (existing || []).find((track: any) => canonicalTrackKey(track) === canonicalTrackKey({ artist, title }));
  if (match) return match.id;
  const { data: inserted, error } = await db.from("tracks").insert({
    artist,
    title,
    source: "soulection",
    source_url: row.songId ? `https://radio.soulection.com/songs/${row.songId}` : episodeUrl,
    source_context: episodeUrl,
    metadata: { soulection_artist_id: row.artistId, soulection_song_id: row.songId },
    status: "pending",
  }).select("id").single();
  if (error || !inserted) throw new Error(`Canonical insert failed: ${error?.message || "no row returned"}`);
  return inserted.id;
}

async function indexEpisode(db: SupabaseClient, seriesId: string, summary: SoulectionEpisodeSummary): Promise<number> {
  // Parse first. A source failure must not replace known-good episode/appearance data.
  const detail = await fetchSoulectionEpisode(summary);
  const { data: episode, error: episodeError } = await db.from("episodes").upsert({
    url: summary.url,
    title: detail.title,
    source: "soulection",
    aired_date: summary.releaseDate?.slice(0, 10) || null,
    artwork_url: detail.artworkUrl || summary.artworkUrl,
    metadata: { source: "soulection", source_tracklist_count: detail.rows.length, indexed_at: new Date().toISOString() },
    series_id: seriesId,
    source_id: summary.id,
    release_date: summary.releaseDate?.slice(0, 10) || null,
    description: detail.description || summary.description,
    dj_id: detail.dj?.id || summary.djId || null,
    dj_name: detail.dj?.name || summary.djName,
    soundcloud_url: detail.soundcloudUrl || summary.soundcloudUrl,
    apple_music_url: detail.appleMusicUrl || summary.appleMusicUrl,
    crawled_at: new Date().toISOString(),
  }, { onConflict: "url" }).select("id").single();
  if (episodeError || !episode) throw new Error(`Episode upsert failed: ${episodeError?.message || "no row returned"}`);

  const appearances: SoulectionAppearanceUpsert[] = [];
  const legacyLinks = new Map<string, { episode_id: string; track_id: string; position: number }>();
  for (const row of detail.rows) {
    const trackId = await canonicalTrackId(db, summary.url, row);
    appearances.push({
      episode_id: episode.id,
      track_id: trackId,
      position: row.position,
      timestamp_text: row.timestamp,
      timestamp_seconds: row.timestampSeconds,
      source_artist: row.artist,
      source_title: row.title,
      source_artist_id: row.artistId,
      source_song_id: row.songId,
      resolution_state: trackId ? "canonical" : "unresolved",
      source_metadata: {},
      updated_at: new Date().toISOString(),
    });
    if (trackId && !legacyLinks.has(trackId)) {
      legacyLinks.set(trackId, { episode_id: episode.id, track_id: trackId, position: row.position });
    }
  }
  await upsertSoulectionAppearances(db, appearances);
  if (legacyLinks.size) {
    const { error: legacyError } = await db.from("episode_tracks")
      .upsert([...legacyLinks.values()], { onConflict: "episode_id,track_id" });
    if (legacyError) throw new Error(`Legacy episode link failed: ${legacyError.message}`);
  }
  return appearances.length;
}

export async function crawlSoulection(options: CrawlOptions = {}): Promise<{ episodes: number; appearances: number; failures: string[] }> {
  const limit = soulectionCrawlLimit(options.limit);
  const db = options.db || getSupabase();
  const recent = await getRecentSoulectionEpisodes(limit);
  if (!recent.length) throw new Error("Soulection catalog returned no recent episodes");
  const { data: series, error } = await db.from("mix_series").upsert({
    slug: "soulection-radio",
    title: "Soulection Radio",
    description: "Worldwide sounds and future-facing selections from Soulection.",
    source: "soulection",
    source_url: "https://radio.soulection.com/",
    artwork_url: recent[0]?.artworkUrl || null,
    metadata: { recent_limit: limit, indexed_at: new Date().toISOString() },
  }, { onConflict: "slug" }).select("id").single();
  if (error || !series) throw new Error(`Series upsert failed: ${error?.message || "no row returned"}`);

  let appearances = 0;
  const failures: string[] = [];
  for (const summary of recent) {
    try {
      appearances += await indexEpisode(db, series.id, summary);
    } catch (caught) {
      failures.push(`${summary.id}: ${caught instanceof Error ? caught.message : String(caught)}`);
    }
  }
  return { episodes: recent.length - failures.length, appearances, failures };
}

if (import.meta.main) {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: { limit: { type: "string", default: String(SOULECTION_RECENT_EPISODE_LIMIT) } },
    strict: true,
  });
  const result = await crawlSoulection({ limit: Number(values.limit) });
  console.log(`Soulection: ${result.episodes} episodes, ${result.appearances} appearances`);
  if (result.failures.length) {
    for (const failure of result.failures) console.error(`  failed: ${failure}`);
    process.exitCode = 1;
  }
}
