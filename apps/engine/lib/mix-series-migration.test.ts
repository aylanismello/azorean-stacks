import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const migration = readFileSync(new URL("../../client/supabase/migrations/025_mix_series.sql", import.meta.url), "utf8");
const crawler = readFileSync(new URL("../scripts/crawl-soulection.ts", import.meta.url), "utf8");
const sessionRoute = readFileSync(new URL("../../client/src/app/api/episodes/[id]/session/route.ts", import.meta.url), "utf8");

describe("mix series migration contract", () => {
  test("is additive and replay-safe for newly introduced objects", () => {
    expect(migration).toContain("create table if not exists mix_series");
    expect(migration).toContain("create table if not exists user_series_seeds");
    expect(migration).toContain("create table if not exists user_episode_sessions");
    expect(migration).toContain("create table if not exists episode_track_entries");
    expect(migration).toContain("add column if not exists series_id");
    expect(migration).not.toContain("drop constraint if exists episode_tracks_pkey");
  });

  test("keys appearance identity by episode position and permits unresolved rows", () => {
    expect(migration).toContain("unique (episode_id, position)");
    expect(migration).toContain("track_id uuid references tracks(id) on delete set null");
    expect(migration).toContain("resolution_state in ('canonical', 'unresolved', 'unavailable')");
  });

  test("keeps catalog writes worker-only and user seeds owner-scoped", () => {
    expect(migration).toContain('drop policy if exists "episodes_insert"');
    expect(migration).toContain('create policy "mix_series_select"');
    expect(migration).toContain('create policy "episode_track_entries_select"');
    expect(migration).toContain("auth.uid() = user_id");
  });

  test("keeps episode selection separate from track opinions", () => {
    expect(migration).toContain("unique (user_id, episode_id)");
    expect(migration).toContain("last_position integer not null");
    expect(migration).toContain("alter table user_episode_sessions force row level security");
    expect(migration).toContain('create policy "user_episode_sessions_select"');
    expect(migration).not.toContain('create policy "user_episode_sessions_delete"');
    expect(crawler).not.toContain('.from("user_tracks")');
    expect(sessionRoute).not.toContain('.from("user_tracks")');
  });
});
