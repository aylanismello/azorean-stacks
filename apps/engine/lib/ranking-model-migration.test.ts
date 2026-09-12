import { describe, expect, test } from "bun:test";

const migrationPath = new URL("../../client/supabase/migrations/036_empirical_ranking_models.sql", import.meta.url);
const sql = await Bun.file(migrationPath).text();

const FEATURES = [
  "artist",
  "genre",
  "seed",
  "curator",
  "source_context",
  "episode_density",
  "co_occurrence",
  "sonic_similarity",
];

describe("empirical ranking migration contract", () => {
  test("stores gated candidates using the exact production scorer feature contract", () => {
    expect(sql).toContain("create table if not exists user_ranking_model_config");
    expect(sql).toContain("user_id uuid primary key references auth.users(id)");
    expect(sql).toContain("production_ranking_features_v1");
    expect(sql).toContain("between 0.02 and 0.30");
    expect(sql).toContain("- 1.10");
    for (const feature of FEATURES) expect(sql).toContain(`'${feature}'`);
  });

  test("makes exposure and outcome evidence append-only and exactly attributable", () => {
    expect(sql).toContain("create table if not exists ranking_exposures");
    expect(sql).toContain("create table if not exists ranking_outcomes");
    expect(sql).toContain("exposure_id uuid not null unique");
    expect(sql).toContain("foreign key (exposure_id, user_id, track_id)");
    expect(sql).toContain("before update or delete on ranking_exposures");
    expect(sql).toContain("before update or delete on ranking_outcomes");
    expect(sql).toContain("raise exception '% is append-only', tg_table_name");
    expect(sql).toContain("unique (user_id, request_id, track_id)");
  });

  test("uses database time and a strictly earlier exposure for causal recording", () => {
    expect(sql).toContain("recorded_at timestamptz := clock_timestamp()");
    expect(sql).toContain("and exposed_at < recorded_at");
    expect(sql).toContain("order by exposed_at desc, id desc");
    expect(sql).not.toContain("row->>'exposed_at'");
    expect(sql).toContain("on conflict (exposure_id) do nothing");
  });

  test("prevents direct authenticated evidence mutation and keeps reads user-scoped", () => {
    expect(sql).toContain("alter table user_ranking_model_config enable row level security");
    expect(sql).toContain("alter table ranking_exposures enable row level security");
    expect(sql).toContain("alter table ranking_outcomes enable row level security");
    expect(sql.match(/auth\.uid\(\) = user_id/g)?.length).toBeGreaterThanOrEqual(3);
    expect(sql).toContain("revoke insert, update, delete on ranking_exposures from anon, authenticated");
    expect(sql).toContain("revoke insert, update, delete on ranking_outcomes from anon, authenticated");
    expect(sql).toContain("security definer set search_path = public, pg_temp");
  });

  test("accepts signed production inputs and does not label raw scores probabilities", () => {
    expect(sql.match(/between -1 and 1/g)?.length).toBeGreaterThanOrEqual(8);
    expect(sql).toContain("predicted_score double precision not null check (predicted_score between -4 and 4)");
    expect(sql).toContain("Raw relative production score");
  });
});
