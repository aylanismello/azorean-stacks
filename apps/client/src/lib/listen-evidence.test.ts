import { describe, expect, test } from "bun:test";
import { buildQualifiedListenEvidence, parseQualifiedListenEvidence } from "./listen-evidence";

describe("qualified listen evidence", () => {
  test("does not emit evidence before 80 percent", () => {
    expect(buildQualifiedListenEvidence(79.99, 100)).toBeNull();
  });

  test("includes measured percentage and duration in one listened payload", () => {
    expect(buildQualifiedListenEvidence(80, 100)).toEqual({
      status: "listened",
      listen_pct: 80,
      listen_duration_ms: 80_000,
    });
    expect(buildQualifiedListenEvidence(101, 100)).toEqual({
      status: "listened",
      listen_pct: 100,
      listen_duration_ms: 101_000,
    });
  });

  test("accepts only qualified, integer, database-safe evidence", () => {
    expect(parseQualifiedListenEvidence({ listen_pct: 87, listen_duration_ms: 12_345 })).toEqual({
      listen_pct: 87,
      listen_duration_ms: 12_345,
    });
    expect(parseQualifiedListenEvidence({ listen_pct: 79, listen_duration_ms: 12_345 })).toBeNull();
    expect(parseQualifiedListenEvidence({ listen_pct: 87.5, listen_duration_ms: 12_345 })).toBeNull();
    expect(parseQualifiedListenEvidence({ listen_pct: 87, listen_duration_ms: -1 })).toBeNull();
    expect(parseQualifiedListenEvidence({ listen_pct: 87 })).toBeNull();
  });
});
