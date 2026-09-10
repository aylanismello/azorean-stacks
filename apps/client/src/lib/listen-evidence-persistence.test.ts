import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const migration = readFileSync(
  new URL("../../supabase/migrations/026_qualified_listen_evidence.sql", import.meta.url),
  "utf8",
);
const trackRoute = readFileSync(
  new URL("../app/api/tracks/[id]/route.ts", import.meta.url),
  "utf8",
);
const player = readFileSync(
  new URL("../components/GlobalPlayerProvider.tsx", import.meta.url),
  "utf8",
);

describe("qualified listen persistence contract", () => {
  test("persists status and evidence in one conflict-safe database operation", () => {
    expect(migration).toContain("insert into user_tracks");
    expect(migration).toContain("on conflict (user_id, track_id) do update");
    expect(migration).toContain("listen_pct = greatest");
    expect(migration).toContain("listen_duration_ms = greatest");
    expect(migration).toContain("when user_tracks.status in ('pending', 'listened') then 'listened'");
    expect(migration).toContain("else user_tracks.status");
  });

  test("the listened route uses the atomic RPC instead of a read-then-write", () => {
    const listenedBranch = trackRoute.slice(
      trackRoute.indexOf('if (status === "listened")'),
      trackRoute.indexOf("// All other votes"),
    );
    expect(listenedBranch).toContain('"record_qualified_track_listen"');
    expect(listenedBranch).not.toContain('.from("user_tracks")');
    expect(listenedBranch).not.toContain("maybeSingle");
  });

  test("the player sends measured evidence in the same listened request", () => {
    expect(player).toContain("buildQualifiedListenEvidence(progress, duration)");
    expect(player).toContain("body: JSON.stringify(evidence)");
    expect(player).not.toContain('body: JSON.stringify({ status: "listened" })');
  });
});
