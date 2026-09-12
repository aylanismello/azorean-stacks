import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const clientRoot = join(import.meta.dir, "..");
const fypRoute = readFileSync(join(clientRoot, "app/api/fyp/route.ts"), "utf8");
const exposureHelper = readFileSync(join(clientRoot, "lib/ranking-exposure.ts"), "utf8");
const trackRoute = readFileSync(join(clientRoot, "app/api/tracks/[id]/route.ts"), "utf8");

describe("empirical ranking evidence wiring", () => {
  test("logs each home generation once without making the queue depend on telemetry", () => {
    expect(fypRoute).toContain("buildRankingExposureRows");
    expect(exposureHelper).toContain('const requestId = `fyp:');
    expect(fypRoute).toContain("ignoreDuplicates: true");
    expect(fypRoute).toContain("Ranking measurement must never take the listening queue down");
  });

  test("labels explicit votes, super-likes, and qualified listens", () => {
    expect(trackRoute).toContain('if (super_liked === true)');
    expect(trackRoute).toContain('p_outcome: "approved"');
    expect(trackRoute).toContain('p_outcome: "listened"');
    expect(trackRoute).toContain('p_outcome: status');
    expect(trackRoute).toContain('["approved", "rejected", "skipped"].includes(status)');
  });
});
