import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const seedsPage = readFileSync(new URL("../app/seeds/page.tsx", import.meta.url), "utf8");
const discoverRoute = readFileSync(new URL("../app/api/discover/route.ts", import.meta.url), "utf8");

describe("seed discovery ownership", () => {
  test("new seeds rely on the durable worker instead of starting a browser crawl", () => {
    expect(seedsPage).not.toContain('fetch("/api/discover"');
    expect(seedsPage).toContain("Seed queued for discovery");
  });

  test("the compatibility endpoint only queues worker-owned discovery", () => {
    expect(discoverRoute).toContain('state: "queued"');
    expect(discoverRoute).toContain("fyp_refresh_required_at");
    expect(discoverRoute).not.toContain("NTS_API");
    expect(discoverRoute).not.toContain("crawlNTS");
    expect(discoverRoute).not.toContain('from("episode_seeds").upsert');
  });
});
