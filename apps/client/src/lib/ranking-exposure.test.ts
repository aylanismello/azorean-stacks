import { describe, expect, test } from "bun:test";
import { buildRankingExposureRows, rankingFeatureSnapshot } from "./ranking-exposure";

describe("ranking exposure snapshots", () => {
  test("freezes every feature explicitly and clamps invalid values", () => {
    expect(rankingFeatureSnapshot({
      id: "track-1",
      _score_components: { artist: 0.7, seed: 4, curator: "bad", sonic_similarity: -2 },
    })).toEqual({
      artist: 0.7,
      genre: 0,
      seed: 1,
      curator: 0,
      source_context: 0,
      episode_density: 0,
      co_occurrence: 0,
      sonic_similarity: -1,
    });
  });

  test("uses a generation-stable request id instead of duplicating poll exposures", () => {
    expect(buildRankingExposureRows("user-1", 42, [
      { id: "a", _ranked_score: -5 },
      { id: "b", _ranked_score: 8 },
    ])).toMatchObject([
      { request_id: "fyp:42", track_id: "a", rank: 1, predicted_score: -4 },
      { request_id: "fyp:42", track_id: "b", rank: 2, predicted_score: 4 },
    ]);
  });

  test("records exact displayed ranks and separates exploration from production ranking", () => {
    expect(buildRankingExposureRows("user-1", 43, [
      { id: "ordinary", _display_rank: 6, _ranked_score: 0.5 },
      { id: "exploration", _display_rank: 7, _series_exploration: true, _ranked_score: 0 },
    ])).toMatchObject([
      { track_id: "ordinary", rank: 6, model_version: "production_ranking_v1" },
      { track_id: "exploration", rank: 7, model_version: "series_exploration_v1" },
    ]);
  });
});
