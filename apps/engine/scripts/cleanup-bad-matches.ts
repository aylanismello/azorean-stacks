#!/usr/bin/env bun
/**
 * The Stacks — Cleanup Bad Matches
 *
 * Audits all episode_seeds rows to verify the seed track is actually
 * present in the episode's tracklist. Removes bad links and optionally
 * deletes orphaned episodes (those with no remaining valid seed links).
 *
 * Usage:
 *   bun run cleanup-bad-matches          # DRY RUN (no changes made)
 *   bun run cleanup-bad-matches --execute # Actually perform deletions
 */
import { parseArgs } from "util";
import { getSupabase } from "../lib/supabase";
import { ntsSource } from "../lib/sources/nts";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    execute: { type: "boolean", default: false },
  },
  strict: false,
});

const DRY_RUN = !values.execute;
const db = getSupabase();

// ─── LOGGING ────────────────────────────────────────────────

const LOG_ICONS = { ok: "✓", fail: "✗", skip: "→", warn: "⚠", wait: "…", info: "·" } as const;

function log(icon: keyof typeof LOG_ICONS, msg: string) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`  ${ts} ${LOG_ICONS[icon]} ${msg}`);
}

// ─── MATCHING HELPERS ───────────────────────────────────────

function getPrimaryArtist(artist: string): string {
  return artist
    .split(/,\s*/)[0]
    .split(/\s*[&+x×]\s*/i)[0]
    .trim()
    .toLowerCase();
}

function checkTracklist(
  tracklist: Array<{ artist: string; title: string }>,
  seedArtist: string,
  seedTitle: string,
): { hasFullMatch: boolean; hasArtistMatch: boolean } {
  const seedArtistLower = seedArtist.toLowerCase().trim();
  const seedTitleLower = seedTitle.toLowerCase().trim();
  const seedPrimaryArtist = getPrimaryArtist(seedArtist);

  let hasFullMatch = false;
  let hasArtistMatch = false;

  for (const t of tracklist) {
    const tArtist = (t.artist || "").toLowerCase().trim();
    const tTitle = (t.title || "").toLowerCase().trim();

    // Full match: same artist AND same title
    if (tArtist === seedArtistLower && tTitle === seedTitleLower) {
      hasFullMatch = true;
      break;
    }

    // Artist match: same primary artist (or exact artist)
    if (!hasArtistMatch) {
      const tPrimaryArtist = getPrimaryArtist(t.artist || "");
      if (tArtist === seedArtistLower || tPrimaryArtist === seedPrimaryArtist) {
        hasArtistMatch = true;
      }
    }
  }

  return { hasFullMatch, hasArtistMatch };
}

// ─── MAIN ───────────────────────────────────────────────────

async function main() {
  console.log(`\n  The Stacks — Cleanup Bad Matches`);
  console.log(`  ${new Date().toISOString()}`);
  console.log(`  Mode: ${DRY_RUN ? "DRY RUN (pass --execute to apply changes)" : "EXECUTE — changes will be written"}\n`);

  // Fetch all episode_seeds with joined seed and episode data
  const { data: episodeSeeds, error: esError } = await db
    .from("episode_seeds")
    .select(`
      episode_id,
      seed_id,
      match_type,
      seeds:seed_id ( id, artist, title, active ),
      episodes:episode_id ( id, url, title, source, metadata )
    `);

  if (esError) {
    log("fail", `Failed to fetch episode_seeds: ${esError.message}`);
    process.exit(1);
  }

  if (!episodeSeeds || episodeSeeds.length === 0) {
    log("info", "No episode_seeds rows found — nothing to audit.");
    return;
  }

  log("info", `Auditing ${episodeSeeds.length} episode_seed links...`);

  // Stats
  let badLinksFound = 0;
  let episodesDeleted = 0;
  let tracksDeleted = 0;
  let episodeSeedsDeleted = 0;
  let episodesChecked = 0;

  // Cache NTS tracklists to avoid redundant API calls
  const ntsTracklistCache = new Map<string, Array<{ artist: string; title: string }>>();

  for (const row of episodeSeeds as any[]) {
    const seed = row.seeds;
    const episode = row.episodes;

    if (!seed || !episode) {
      log("warn", `episode_seeds row has missing seed or episode — episode_id=${row.episode_id}, seed_id=${row.seed_id}`);
      continue;
    }

    episodesChecked++;
    const label = `ep="${episode.title || episode.url}" seed="${seed.artist} - ${seed.title}"`;

    // ── Fetch tracklist depending on source ──
    let tracklist: Array<{ artist: string; title: string }> = [];

    if (episode.source === "nts") {
      // Re-fetch from NTS API
      const cacheKey = episode.url;
      if (ntsTracklistCache.has(cacheKey)) {
        tracklist = ntsTracklistCache.get(cacheKey)!;
      } else {
        try {
          tracklist = await ntsSource.getTracklist(episode.url);
          ntsTracklistCache.set(cacheKey, tracklist);
        } catch (err) {
          log("warn", `NTS tracklist fetch failed for ${episode.url}: ${err instanceof Error ? err.message : err}`);
          // Skip this row — can't verify, don't delete
          continue;
        }
      }
    } else if (episode.source === "lotradio") {
      // Use the episode's metadata.tracklist JSONB field
      tracklist = episode.metadata?.tracklist || [];
      if (tracklist.length === 0) {
        log("warn", `Lot Radio episode has no tracklist in metadata: ${episode.url}`);
        // Skip — can't verify
        continue;
      }
    } else {
      log("warn", `Unknown source "${episode.source}" for episode ${episode.id} — skipping`);
      continue;
    }

    // ── Check if seed matches ──
    const { hasFullMatch, hasArtistMatch } = checkTracklist(tracklist, seed.artist, seed.title);

    if (hasFullMatch || hasArtistMatch) {
      // Valid match — keep it
      const matchKind = hasFullMatch ? "full" : "artist";
      log("ok", `VALID (${matchKind}): ${label}`);
      continue;
    }

    // ── Bad match found ──
    badLinksFound++;
    log("warn", `BAD MATCH: ${label} [source=${episode.source}, tracklist=${tracklist.length} tracks]`);

    if (!DRY_RUN) {
      // Delete the episode_seeds row
      const { error: delLinkErr } = await db
        .from("episode_seeds")
        .delete()
        .eq("episode_id", row.episode_id)
        .eq("seed_id", row.seed_id);

      if (delLinkErr) {
        log("fail", `Failed to delete episode_seeds row: ${delLinkErr.message}`);
        continue;
      }
      episodeSeedsDeleted++;
      log("skip", `Deleted episode_seeds link for ${label}`);
    } else {
      episodeSeedsDeleted++; // count for dry run summary
    }

    // ── Check if episode still has other valid seed links ──
    const { data: remainingLinks, error: remErr } = await db
      .from("episode_seeds")
      .select("seed_id")
      .eq("episode_id", row.episode_id)
      .neq("seed_id", row.seed_id);

    if (remErr) {
      log("fail", `Failed to check remaining links for episode ${row.episode_id}: ${remErr.message}`);
      continue;
    }

    const hasOtherLinks = remainingLinks && remainingLinks.length > 0;

    if (hasOtherLinks) {
      log("info", `Episode still has ${remainingLinks!.length} other seed link(s) — keeping episode`);
      continue;
    }

    // ── Orphaned episode — delete tracks and episode ──
    log("warn", `Episode is now orphaned (no remaining seed links): ${episode.title || episode.url}`);

    // Count tracks for summary
    const { count: trackCount } = await db
      .from("tracks")
      .select("*", { count: "exact", head: true })
      .eq("episode_id", row.episode_id);

    const { count: epTrackCount } = await db
      .from("episode_tracks")
      .select("*", { count: "exact", head: true })
      .eq("episode_id", row.episode_id);

    if (!DRY_RUN) {
      // Delete episode_tracks
      if (epTrackCount && epTrackCount > 0) {
        const { error: delEtErr } = await db
          .from("episode_tracks")
          .delete()
          .eq("episode_id", row.episode_id);
        if (delEtErr) {
          log("fail", `Failed to delete episode_tracks for episode ${row.episode_id}: ${delEtErr.message}`);
        } else {
          log("skip", `Deleted ${epTrackCount} episode_tracks rows`);
        }
      }

      // Delete tracks
      if (trackCount && trackCount > 0) {
        const { error: delTrErr } = await db
          .from("tracks")
          .delete()
          .eq("episode_id", row.episode_id);
        if (delTrErr) {
          log("fail", `Failed to delete tracks for episode ${row.episode_id}: ${delTrErr.message}`);
        } else {
          tracksDeleted += trackCount;
          log("skip", `Deleted ${trackCount} tracks for episode ${row.episode_id}`);
        }
      }

      // Delete the episode itself
      const { error: delEpErr } = await db
        .from("episodes")
        .delete()
        .eq("id", row.episode_id);

      if (delEpErr) {
        log("fail", `Failed to delete episode ${row.episode_id}: ${delEpErr.message}`);
      } else {
        episodesDeleted++;
        log("skip", `Deleted orphaned episode: ${episode.title || episode.url}`);
      }
    } else {
      // Dry run — just tally
      episodesDeleted++;
      tracksDeleted += trackCount || 0;
    }
  }

  // ── Summary ──
  console.log(`\n  ── Summary ──`);
  console.log(`  Episodes audited:        ${episodesChecked}`);
  console.log(`  Bad seed links found:    ${badLinksFound}`);
  console.log(`  episode_seeds deleted:   ${episodeSeedsDeleted}${DRY_RUN ? " (dry run)" : ""}`);
  console.log(`  Episodes orphaned/deleted: ${episodesDeleted}${DRY_RUN ? " (dry run)" : ""}`);
  console.log(`  Tracks deleted:          ${tracksDeleted}${DRY_RUN ? " (dry run)" : ""}`);
  if (DRY_RUN) {
    console.log(`\n  This was a DRY RUN. Pass --execute to apply changes.\n`);
  } else {
    console.log(`\n  Done.\n`);
  }
}

main().catch((err) => {
  console.error("\n  !! Cleanup crashed !!");
  console.error(`  ${err instanceof Error ? err.stack || err.message : err}`);
  process.exit(1);
});
