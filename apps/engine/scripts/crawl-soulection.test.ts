import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { SupabaseClient } from "@supabase/supabase-js";
import { SOULECTION_RECENT_EPISODE_LIMIT } from "../lib/sources/soulection";
import {
  soulectionCrawlLimit,
  upsertSoulectionAppearances,
  type SoulectionAppearanceUpsert,
} from "./crawl-soulection";

const appearance = (
  position: number,
  overrides: Partial<SoulectionAppearanceUpsert> = {},
): SoulectionAppearanceUpsert => ({
  episode_id: "episode-1",
  track_id: `track-${position}`,
  position,
  timestamp_text: `00:0${position}:00`,
  timestamp_seconds: position * 60,
  source_artist: `Artist ${position}`,
  source_title: `Title ${position}`,
  source_artist_id: null,
  source_song_id: `song-${position}`,
  resolution_state: "canonical",
  source_metadata: {},
  updated_at: "2026-09-10T00:00:00.000Z",
  ...overrides,
});

describe("Soulection appearance refresh", () => {
  test("keeps source, CLI, runner, and watcher archive depths aligned", () => {
    const crawler = readFileSync(new URL("./crawl-soulection.ts", import.meta.url), "utf8");
    const runner = readFileSync(new URL("../runner.sh", import.meta.url), "utf8");
    const watcher = readFileSync(new URL("./watcher.ts", import.meta.url), "utf8");
    const scheduledLimit = runner.match(/crawl-soulection --limit (\d+)/)?.[1];

    expect(soulectionCrawlLimit()).toBe(SOULECTION_RECENT_EPISODE_LIMIT);
    expect(crawler).toContain("default: String(SOULECTION_RECENT_EPISODE_LIMIT)");
    expect(scheduledLimit).toBe(String(SOULECTION_RECENT_EPISODE_LIMIT));
    expect(watcher).toMatch(
      /crawlSoulection\(\{\s*limit: SOULECTION_RECENT_EPISODE_LIMIT,\s*db\s*\}\)/,
    );
  });

  test("uses the maintained 22-episode archive default", () => {
    expect(soulectionCrawlLimit()).toBe(22);
    expect(soulectionCrawlLimit(101)).toBe(100);
  });

  test("partial and empty refreshes retain omitted ordered and unresolved appearances", async () => {
    const stored = new Map<number, SoulectionAppearanceUpsert>([
      [0, appearance(0)],
      [1, appearance(1, {
        track_id: null,
        source_title: null,
        source_song_id: null,
        resolution_state: "unresolved",
      })],
      [2, appearance(2, { source_song_id: "song-0" })],
    ]);
    const conflicts: string[] = [];
    const db = {
      from(table: string) {
        expect(table).toBe("episode_track_entries");
        return {
          async upsert(rows: SoulectionAppearanceUpsert[], options: { onConflict: string }) {
            conflicts.push(options.onConflict);
            for (const row of rows) stored.set(row.position, row);
            return { error: null };
          },
        };
      },
    } as unknown as SupabaseClient;

    await upsertSoulectionAppearances(db, [appearance(0, { source_title: "Updated title" })]);
    await upsertSoulectionAppearances(db, []);

    expect([...stored.keys()]).toEqual([0, 1, 2]);
    expect(stored.get(0)?.source_title).toBe("Updated title");
    expect(stored.get(1)).toMatchObject({
      position: 1,
      track_id: null,
      source_artist: "Artist 1",
      resolution_state: "unresolved",
    });
    expect(stored.get(2)).toMatchObject({ position: 2, source_song_id: "song-0" });
    expect(conflicts).toEqual(["episode_id,position"]);
  });
});