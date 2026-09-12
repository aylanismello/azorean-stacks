import { describe, expect, test } from "bun:test";
import {
  applySonicAffinityRanking,
  applySonicRanking,
  MAX_SONIC_CONTRIBUTION,
  rankWithSonicContext,
  sonicAffinityContribution,
  sonicSimilarityContribution,
} from "./sonic-ranking";

describe("sonic ranking", () => {
  test("bounds every contribution to plus or minus 0.10", () => {
    expect(sonicSimilarityContribution(1)).toBe(MAX_SONIC_CONTRIBUTION);
    expect(sonicSimilarityContribution(-1)).toBe(-MAX_SONIC_CONTRIBUTION);
    expect(sonicSimilarityContribution(99, 99)).toBe(MAX_SONIC_CONTRIBUTION);
    expect(sonicSimilarityContribution(-99, 99)).toBe(-MAX_SONIC_CONTRIBUTION);
  });

  test("treats missing, non-finite, and neutral similarity as no-op", () => {
    const candidate = { taste_score: 0.4, metadata: { source: "test" } };
    expect(applySonicRanking(candidate)).toBe(candidate);
    expect(sonicSimilarityContribution(null)).toBe(0);
    expect(sonicSimilarityContribution(Number.NaN)).toBe(0);
    expect(sonicSimilarityContribution(0.5)).toBe(0);
  });

  test("adds an explainable component without mutating input", () => {
    const candidate = {
      taste_score: 0.4,
      sonic_similarity: 1,
      metadata: { _score_components: { artist: 0.2 } },
    };
    const ranked = applySonicRanking(candidate);
    expect(ranked).not.toBe(candidate);
    expect(ranked.taste_score).toBeCloseTo(0.5);
    expect(ranked.metadata?._score_components as Record<string, number>).toEqual({ artist: 0.2, sonic_similarity: 1 });
    expect((ranked.metadata as Record<string, unknown> | undefined)?._sonic_similarity).toBe(1);
    expect(candidate.metadata._score_components).toEqual({ artist: 0.2 });
  });

  test("uses likes as positive context and close rejected regions as bounded avoidance", () => {
    expect(sonicAffinityContribution(0.9, null)).toBeCloseTo(0.08);
    expect(sonicAffinityContribution(0.9, 0.9)).toBeCloseTo(0);
    expect(sonicAffinityContribution(null, 1)).toBe(-MAX_SONIC_CONTRIBUTION);
    expect(sonicAffinityContribution(null, 0.1)).toBe(0);

    const ranked = applySonicAffinityRanking({ taste_score: 0.4, metadata: {} }, 0.8, 1);
    expect(ranked.taste_score).toBeCloseTo(0.36);
    const metadata = ranked.metadata as Record<string, any>;
    expect(metadata._score_components.sonic_similarity).toBeCloseTo(-0.4);
    expect(metadata._sonic_negative_similarity).toBe(1);
  });

  test("reorders by adjusted score while preserving stable ties", () => {
    const candidates = [
      { id: "similar", taste_score: 0.4, sonic_similarity: 1 },
      { id: "plain-a", taste_score: 0.45 },
      { id: "plain-b", taste_score: 0.45 },
    ];
    expect(rankWithSonicContext(candidates).map(({ id }) => id)).toEqual(["similar", "plain-a", "plain-b"]);
  });
});
