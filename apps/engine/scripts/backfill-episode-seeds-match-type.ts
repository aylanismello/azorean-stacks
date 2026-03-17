#!/usr/bin/env bun
/**
 * Backfill: Fix episode_seeds rows with match_type = 'unknown'
 *
 * The watcher was inserting episode_seeds rows without verifying whether the
 * seed track actually appeared in the episode's tracklist. This produced rows
 * with match_type = 'unknown' (the DB default) and co-occurrence tracks with
 * no real relationship to the seed.
 *
 * This script:
 *  1. Finds all episode_seeds rows where match_type = 'unknown'
 *  2. Re-fetches the tracklist for each episode from the source
 *  3. Checks if the seed track appears (full match) or the seed artist appears (artist match)
 *  4. Updates the row to the correct match_type — or deletes the row (and its
 *     orphaned tracks) if there is no valid match
 *
 * Usage: bun run backfill-episode-seeds-match-type
 */
import { getSupabase } from "../lib/supabase";
import { log, isSameTrack } from "../lib/pipeline";
import { SOURCES } from "../lib/sources/index";

const db = getSupabase();

async function main() {
  // 1. Fetch all episode_seeds rows with unknown match_type, joining seed + episode data
  const { data: rows, error } = await db
    .from("episode_seeds")
    .select(`
      episode_id,
      seed_id,
      match_type,
      episodes ( url, title, source ),
      seeds ( artist, title, track_id )
    `)
    .eq("match_type", "unknown");

  if (error || !rows) {
    log("fail", `Failed to fetch episode_seeds: ${error?.message}`);
    process.exit(1);
  }

  log("info", `Found ${rows.length} episode_seeds rows with match_type = 'unknown'`);

  let fixed = 0;
  let deleted = 0;
  let failed = 0;

  for (const row of rows) {
    const ep = row.episodes as any;
    const seed = row.seeds as any;

    if (!ep || !seed) {
      log("skip", `Missing episode or seed data for episode_id=${row.episode_id}`);
      failed++;
      continue;
    }

    const episodeUrl: string = ep.url;
    const episodeSource: string = ep.source;
    const seedArtist: string = seed.artist;
    const seedTitle: string = seed.title;
    const context = ep.title || episodeUrl;

    // Find the matching source
    const source = SOURCES.find((s) => s.name === episodeSource);
    if (!source) {
      log("skip", `No source handler for '${episodeSource}' — ${context}`);
      failed++;
      continue;
    }

    let rawTracks: { artist: string; title: string }[] = [];
    try {
      rawTracks = await source.getTracklist(episodeUrl);
    } catch (err: any) {
      log("fail", `Tracklist fetch failed for ${context}: ${err.message}`);
      failed++;
      continue;
    }

    if (rawTracks.length === 0) {
      log("skip", `Empty tracklist for ${context} — treating as no-match`);
    }

    const hasFullMatch = rawTracks.some((t) => isSameTrack(t, { artist: seedArtist, title: seedTitle }));
    const hasArtistMatch = !hasFullMatch && rawTracks.some(
      (t) => t.artist.toLowerCase().trim() === seedArtist.toLowerCase().trim()
    );
    const matchType = hasFullMatch ? "full" : hasArtistMatch ? "artist" : null;

    if (matchType) {
      // Update to verified match_type
      const { error: updateErr } = await db
        .from("episode_seeds")
        .update({ match_type: matchType })
        .eq("episode_id", row.episode_id)
        .eq("seed_id", row.seed_id);

      if (updateErr) {
        log("fail", `Update failed for ${context}: ${updateErr.message}`);
        failed++;
      } else {
        log("ok", `[${matchType}] ${context} — seed "${seedArtist} - ${seedTitle}"`);
        fixed++;
      }
    } else {
      // No valid match — delete the episode_seeds row and any orphaned tracks
      log("info", `No match for seed "${seedArtist} - ${seedTitle}" in ${context} — deleting`);

      // Delete tracks that were ingested from this invalid episode_seeds association
      // (tracks whose seed_track_id points to this seed and episode_id matches)
      const { error: tracksErr } = await db
        .from("tracks")
        .delete()
        .eq("episode_id", row.episode_id)
        .eq("seed_track_id", seed.track_id || "00000000-0000-0000-0000-000000000000");

      if (tracksErr) {
        log("fail", `Track delete failed for ${context}: ${tracksErr.message}`);
      }

      // Delete the episode_seeds row
      const { error: deleteErr } = await db
        .from("episode_seeds")
        .delete()
        .eq("episode_id", row.episode_id)
        .eq("seed_id", row.seed_id);

      if (deleteErr) {
        log("fail", `Delete failed for ${context}: ${deleteErr.message}`);
        failed++;
      } else {
        deleted++;
      }
    }
  }

  log("info", `Done — ${fixed} fixed, ${deleted} deleted (invalid), ${failed} failed`);
}

main().catch((err) => {
  log("fail", `Backfill crashed: ${err.message}`);
  process.exit(1);
});
