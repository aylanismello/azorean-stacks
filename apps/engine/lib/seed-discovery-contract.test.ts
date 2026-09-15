import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const watcher = readFileSync(new URL("../scripts/watcher.ts", import.meta.url), "utf8");
const discover = readFileSync(new URL("../scripts/discover.ts", import.meta.url), "utf8");

describe("verified seed discovery contract", () => {
  test("priority discovery verifies candidates before ranking and persistence", () => {
    const priority = watcher.slice(
      watcher.indexOf("async function processPrioritySeed"),
      watcher.indexOf("async function processPriorityQueue"),
    );
    expect(priority).toContain("classifySeedTracklist(rawTracklist");
    expect(priority).toContain("rejected unverified candidate");
    expect(priority).toContain("seedMatchStrength(b.matchType) - seedMatchStrength(a.matchType)");
    expect(priority).toContain("match_type: best.matchType");
    expect(priority).not.toContain('match_type: "unknown"');
  });

  test("batch discovery refuses unrelated existing and fresh episodes", () => {
    expect(discover).toContain("Already crawled but unrelated to seed");
    expect(discover).toContain("No match found for seed");
    expect(discover).not.toContain('verifiedMatchType = hasFullMatch ? "full" : hasArtistMatch ? "artist" : "unknown"');
  });
});
