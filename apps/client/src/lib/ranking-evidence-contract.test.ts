import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const clientRoot = join(import.meta.dir, "..");
const fypRoute = readFileSync(join(clientRoot, "app/api/fyp/route.ts"), "utf8");
const exposureHelper = readFileSync(join(clientRoot, "lib/ranking-exposure.ts"), "utf8");
const trackRoute = readFileSync(join(clientRoot, "app/api/tracks/[id]/route.ts"), "utf8");
const page = readFileSync(join(clientRoot, "app/page.tsx"), "utf8");
const outcomePrecedenceMigration = readFileSync(
  join(clientRoot, "../supabase/migrations/039_explicit_ranking_outcome_precedence.sql"),
  "utf8",
);
const outcomePromotionMigration = readFileSync(
  join(clientRoot, "../supabase/migrations/040_allow_explicit_ranking_outcome_promotion.sql"),
  "utf8",
);
const restoredCascadeGuardMigration = readFileSync(
  join(clientRoot, "../supabase/migrations/045_restore_ranking_evidence_cascade_guards.sql"),
  "utf8",
);

describe("empirical ranking evidence wiring", () => {
  test("logs each home generation once without making the queue depend on telemetry", () => {
    expect(fypRoute).toContain("buildRankingExposureRows");
    expect(exposureHelper).toContain('const requestId = `fyp:');
    expect(fypRoute).toContain("ignoreDuplicates: true");
    expect(fypRoute).toContain("Ranking measurement must never take the listening queue down");
  });

  test("carries displayed rank, exploration lane, and sonic evidence into the client contract", () => {
    expect(fypRoute).toContain("_display_rank: index + 1");
    expect(exposureHelper).toContain('"series_exploration_v1"');
    expect(fypRoute).toContain("meta._sonic_seed_name");
    expect(page).toContain("meta._sonic_seed_name");
    expect(page).toContain("seriesExploration: Boolean");
  });

  test("labels explicit votes, super-likes, and qualified listens", () => {
    expect(trackRoute).toContain('if (super_liked === true)');
    expect(trackRoute).toContain('p_outcome: "approved"');
    expect(trackRoute).toContain('p_outcome: "listened"');
    expect(trackRoute).toContain('p_outcome: status');
    expect(trackRoute.match(/p_user_id: user\.id/g)?.length).toBeGreaterThanOrEqual(3);
    expect(trackRoute.match(/supabase\.rpc\("record_ranking_outcome"/g)?.length).toBe(3);
    expect(trackRoute).not.toContain('authClient.rpc("record_ranking_outcome"');
    expect(trackRoute).toContain('["approved", "rejected", "skipped"].includes(status)');
  });

  test("lets explicit outcomes supersede neutral evidence without the reverse", () => {
    expect(outcomePrecedenceMigration).toContain("on conflict (exposure_id) do update");
    expect(outcomePrecedenceMigration).toContain("ranking_outcomes.outcome in ('skipped', 'listened')");
    expect(outcomePrecedenceMigration).toContain("excluded.outcome in ('approved', 'rejected')");
    expect(outcomePromotionMigration).toContain("old.outcome in ('skipped', 'listened')");
    expect(outcomePromotionMigration).toContain("new.outcome in ('approved', 'rejected')");
    expect(outcomePromotionMigration).toContain("new.exposure_id = old.exposure_id");
    expect(outcomePromotionMigration).toContain("new.outcome_at >= old.outcome_at");
    expect(restoredCascadeGuardMigration).toContain("select 1 from auth.users");
    expect(restoredCascadeGuardMigration).toContain("select 1 from public.ranking_exposures");
    expect(restoredCascadeGuardMigration).not.toContain("ranking_exposure_cleanup_log");
  });
});
