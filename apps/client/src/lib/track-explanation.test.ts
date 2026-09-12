import { describe, expect, test } from "bun:test";
import { explainTrackSelection } from "./track-explanation";

describe("track explanation", () => {
  test("names an explicit tangent seed and explains queue continuity", () => {
    const result = explainTrackSelection({ tangentSeedName: "Chancha Via Circuito — Jardines" });
    expect(result.headline).toContain("Chancha Via Circuito — Jardines");
    expect(result.headline).toContain("tangent");
    expect(result.evidence).toContain("playing");
  });

  test("prefers direct seed lineage over raw diagnostics", () => {
    const result = explainTrackSelection({
      seedName: "A — Seed",
      matchType: "full",
      episodeLabel: "NTS Show",
      scoreComponents: { curator: 0.9 },
    });
    expect(result.headline).toBe("Found in a DJ set that also played A — Seed.");
    expect(result.evidence).toContain("NTS Show");
  });

  test("explains CLAP similarity as bounded supporting evidence", () => {
    const result = explainTrackSelection({
      sonicSeedName: "B — Seed",
      scoreComponents: { sonic_similarity: 0.7 },
    });
    expect(result.headline).toContain("B — Seed");
    expect(result.evidence).toContain("bounded");
  });

  test("uses a concrete source context when that is strongest", () => {
    const result = explainTrackSelection({
      episodeLabel: "Floating Points on NTS",
      scoreComponents: { source_context: 0.8, artist: 0.2 },
    });
    expect(result.headline).toContain("Floating Points on NTS");
    expect(result.headline).not.toContain("0.8");
  });

  test("falls back without pretending missing evidence exists", () => {
    const result = explainTrackSelection({});
    expect(result.headline).toContain("personal taste history");
    expect(result.evidence).toContain("missing signals stay neutral");
  });
});
