import { describe, expect, test } from "bun:test";
import { MIN_EMPIRICAL_APPLY_SAMPLES, RANKING_FEATURE_SCHEMA_VERSION } from "../lib/ranking-model";
import { parseArguments, run } from "./tune-ranking-model";

function fakeDb(tables: Record<string, any[]>, writes: string[]) {
  return {
    from(table: string) {
      let rows = [...(tables[table] || [])];
      const result = () => ({ data: rows, error: null });
      const query: any = {
        select() { return query; },
        eq(column: string, value: unknown) {
          rows = rows.filter((row) => row[column] === value);
          return query;
        },
        in(column: string, values: unknown[]) {
          rows = rows.filter((row) => values.includes(row[column]));
          return query;
        },
        not(column: string, operator: string) {
          if (operator === "is") rows = rows.filter((row) => row[column] !== null);
          return query;
        },
        order(column: string, options: { ascending?: boolean } = {}) {
          rows.sort((left, right) => String(left[column]).localeCompare(String(right[column]))
            * (options.ascending === false ? -1 : 1));
          return query;
        },
        range(from: number, to: number) {
          return Promise.resolve({ data: rows.slice(from, to + 1), error: null });
        },
        limit(count: number) {
          rows = rows.slice(0, count);
          return Promise.resolve(result());
        },
        maybeSingle() {
          return Promise.resolve({ data: rows[0] || null, error: null });
        },
        upsert(payload: Record<string, unknown>) {
          writes.push(table);
          tables[table] = [payload];
          return Promise.resolve({ data: null, error: null });
        },
        single() {
          return Promise.resolve({ data: rows[0] || null, error: null });
        },
        then(resolve: (value: unknown) => unknown) {
          return Promise.resolve(result()).then(resolve);
        },
      };
      return query;
    },
  };
}

const USER_ID = "123e4567-e89b-42d3-a456-426614174000";
const components = (artist: number) => ({
  artist,
  genre: 0,
  seed: 0,
  curator: 0,
  source_context: 0,
  episode_density: 0,
  co_occurrence: 0,
  sonic_similarity: 0,
});

describe("tune-ranking-model CLI", () => {
  test("is dry-run unless --apply is explicit and validates user IDs", () => {
    expect(parseArguments(["--user-id", USER_ID])).toEqual({ apply: false, userId: USER_ID, help: false });
    expect(parseArguments(["--apply", "--user-id", USER_ID]).apply).toBe(true);
    expect(() => parseArguments(["--user-id", "not-a-uuid"])).toThrow("valid UUID");
  });

  test("refuses insufficient prospective evidence, ignores mutable user_tracks, and performs no write", async () => {
    const writes: string[] = [];
    const db = fakeDb({
      ranking_exposures: [{
        id: "exposure-1",
        user_id: USER_ID,
        track_id: "track-1",
        exposed_at: "2026-01-01T00:00:00Z",
        predicted_score: 0,
        score_components: components(0.5),
        model_version: "production_ranking_v1",
        feature_schema_version: RANKING_FEATURE_SCHEMA_VERSION,
      }],
      ranking_outcomes: [{
        id: "outcome-1",
        exposure_id: "exposure-1",
        user_id: USER_ID,
        track_id: "track-1",
        outcome: "approved",
        outcome_at: "2026-01-02T00:00:00Z",
      }],
      user_tracks: Array.from({ length: 811 }, (_, index) => ({
        user_id: USER_ID,
        track_id: `legacy-${index}`,
        status: "approved",
        voted_at: "2025-01-01T00:00:00Z",
      })),
      user_ranking_model_config: [],
    }, writes);

    const { summary, exitCode } = await run(["--apply", "--user-id", USER_ID], db);
    expect(exitCode).toBe(2);
    expect(summary.status).toBe("refused");
    expect(summary.reason).toBe("insufficient_chronology_valid_immutable_evidence");
    expect(summary.productionWeightsMutated).toBe(false);
    expect(summary.evidence).toMatchObject({
      chronologyValid: 1,
      immutableOutcomes: 1,
      minimumApplySamples: MIN_EMPIRICAL_APPLY_SAMPLES,
      sufficient: false,
    });
    expect(writes).toEqual([]);
  });

  test("fails closed with many one-class outcomes", async () => {
    const writes: string[] = [];
    const exposures = Array.from({ length: 240 }, (_, index) => ({
      id: `exposure-${index}`,
      user_id: USER_ID,
      track_id: `track-${index}`,
      exposed_at: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
      predicted_score: 0,
      score_components: components(1),
      model_version: "production_ranking_v1",
      feature_schema_version: RANKING_FEATURE_SCHEMA_VERSION,
    }));
    const outcomes = exposures.map((exposure, index) => ({
      id: `outcome-${index}`,
      exposure_id: exposure.id,
      user_id: USER_ID,
      track_id: exposure.track_id,
      outcome: "approved",
      outcome_at: new Date(Date.UTC(2026, 0, 2, 0, index)).toISOString(),
    }));
    const db = fakeDb({ ranking_exposures: exposures, ranking_outcomes: outcomes, user_ranking_model_config: [] }, writes);

    const { summary, exitCode } = await run(["--apply", "--user-id", USER_ID], db);
    expect(exitCode).toBe(2);
    expect(summary.reason).toBe("insufficient_chronology_valid_immutable_evidence");
    expect(writes).toEqual([]);
  });

  test("help is machine-readable and states that production weights are untouched", async () => {
    const { summary, exitCode } = await run(["--help"]);
    expect(exitCode).toBe(0);
    expect(summary).toMatchObject({
      minimumApplySamples: 200,
      minimumHoldoutSamples: 40,
      featureSchemaVersion: RANKING_FEATURE_SCHEMA_VERSION,
    });
    expect(summary.default).toContain("never changes the production scorer");
  });

  test("records and verifies only a candidate after strict evidence and both holdout gates pass", async () => {
    const writes: string[] = [];
    const exposures = Array.from({ length: 320 }, (_, index) => ({
      id: `exposure-${index}`,
      user_id: USER_ID,
      track_id: `track-${index}`,
      exposed_at: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
      predicted_score: 0,
      score_components: components(index % 2 === 0 ? 1 : -1),
      model_version: "production_ranking_v1",
      feature_schema_version: RANKING_FEATURE_SCHEMA_VERSION,
    }));
    const outcomes = exposures.map((exposure, index) => ({
      id: `outcome-${index}`,
      exposure_id: exposure.id,
      user_id: USER_ID,
      track_id: exposure.track_id,
      outcome: index % 2 === 0 ? "approved" : "rejected",
      outcome_at: new Date(Date.UTC(2026, 0, 2, 0, index)).toISOString(),
    }));
    const tables = {
      ranking_exposures: exposures,
      ranking_outcomes: outcomes,
      // A stored candidate is not live until the production scorer consumes it,
      // so it must never become the evaluator's incumbent implicitly.
      user_ranking_model_config: [{
        user_id: USER_ID,
        model_version: "disconnected_candidate",
        feature_schema_version: RANKING_FEATURE_SCHEMA_VERSION,
        weights: components(0),
        intercept: 4,
      }] as any[],
    };
    const db = fakeDb(tables, writes);

    const { summary, exitCode } = await run(["--apply", "--user-id", USER_ID], db);
    expect(exitCode).toBe(0);
    expect(summary.status).toBe("candidate_recorded");
    expect(summary.verified).toBe(true);
    expect(summary.productionWeightsMutated).toBe(false);
    expect(summary.baseline.version).toBe("production_ranking_v1");
    expect(summary.evidence).toMatchObject({ chronologyValid: 320, uniqueTracks: 320, sufficient: true });
    expect(writes).toEqual(["user_ranking_model_config"]);
    expect(tables.user_ranking_model_config[0].model_version).toBe(summary.recordedCandidateVersion);
    expect(tables.user_ranking_model_config[0].feature_schema_version).toBe(RANKING_FEATURE_SCHEMA_VERSION);
  });
});
