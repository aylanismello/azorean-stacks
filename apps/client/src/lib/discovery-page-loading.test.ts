import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const seedsRoute = readFileSync(new URL("../app/api/seeds/route.ts", import.meta.url), "utf8");
const stacksRoute = readFileSync(new URL("../app/api/stacks/route.ts", import.meta.url), "utf8");
const seedsPage = readFileSync(new URL("../app/seeds/page.tsx", import.meta.url), "utf8");
const stacksPage = readFileSync(new URL("../app/stacks/page.tsx", import.meta.url), "utf8");

describe("discovery page progressive loading", () => {
  test("seeds render their base cards before expensive counts finish", () => {
    expect(seedsRoute).toContain('searchParams.get("view") === "base"');
    expect(seedsRoute).toContain("details_loading: true");
    expect(seedsRoute.indexOf('searchParams.get("view") === "base"')).toBeLessThan(
      seedsRoute.indexOf("feedCandidates = await getPersonalizedCandidateTrackSummaries"),
    );
    expect(seedsPage).toContain('fetch("/api/seeds?view=base")');
    expect(seedsPage).toContain("fullApplied");
    expect(seedsPage).toContain("setLoading(false)");
    expect(seedsPage).toContain("Loading match details…");
    expect(seedsPage).toContain("seedRequestRef.current += 1");
    expect(seedsPage).toContain("details_loading: false");
  });

  test("stacks render their base grid without waiting for counts or genres", () => {
    expect(stacksRoute).toContain('searchParams.get("view") === "base"');
    expect(stacksRoute).toContain("counts_loading: true");
    expect(stacksPage).toContain('json("/api/stacks?view=base", "Stacks")');
    expect(stacksPage).toContain("Promise.any");
    expect(stacksPage).toContain("Loading counts…");
    expect(stacksPage).not.toContain("Promise.all([");
    expect(stacksPage).not.toContain("/api/genres");
    expect(stacksRoute).toContain("genreFeedCounts(candidates)");
    expect(stacksPage).toContain("counts_unavailable: true");
    expect(stacksPage).toContain("Exact counts could not load.");
    expect(stacksPage).toContain("setGenres([])");
  });
});