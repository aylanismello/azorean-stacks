import { describe, expect, test } from "bun:test";
import { formatRankingScore, rankingContributions } from "./ranking-display";

describe("ranking display", () => {
  test("labels a raw ranking value without pretending it is a percentage", () => {
    expect(formatRankingScore(0.366)).toBe("ranking +0.366");
    expect(formatRankingScore(-0.05)).toBe("ranking -0.050");
  });

  test("shows actual weighted contributions instead of raw signal strengths", () => {
    expect(rankingContributions({
      curator: 0.161,
      seed_freshness: 0.298,
      source_context: 0.268,
      sonic_similarity: 1,
    })).toEqual({
      curator: 0.019,
      seed_freshness: 0.298,
      source_context: 0.048,
      sonic_similarity: 0.1,
    });
  });
});
