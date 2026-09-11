# Curated Mix Exploration and Fishing Signals Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Surface a small number of recent Soulection tracks on the unfiltered 4U page with clear episode attribution, without converting exposure into taste evidence, and label which episodes are strongest to mine.

**Architecture:** Keep ordinary `user_tracks` eligibility and personalized ranking untouched. Build a separate read-only curated-series exploration lane that queries active/followed series, excludes every track already known to the authenticated user, selects at most three playable canonical tracks from at most two recent episodes, and merges them after the protected five-track FYP prefix. Compute episode fishing potential from persisted episode/appearance/catalog data at read time rather than adding derived schema.

**Tech Stack:** Next.js 15, TypeScript, Bun tests, Supabase/PostgreSQL, existing Vercel and engine crawler deployment flow.

---

### Task 1: Add deterministic series-exploration selection

**Objective:** Select and merge bounded exploration tracks without creating eligibility or taste records.

**Files:**
- Create: `apps/client/src/lib/series-exploration.ts`
- Create: `apps/client/src/lib/series-exploration.test.ts`
- Modify: `apps/client/src/app/api/fyp/route.ts`
- Modify: `apps/client/src/app/page.tsx`

**Steps:**
1. Write failing tests for maximum track/episode caps, deterministic spacing after the protected prefix, deduplication, and explicit-opinion exclusion.
2. Implement batched user-scoped reads of curated/followed series, recent episodes, appearances, canonical tracks, and the authenticated user's `user_tracks` rows.
3. Accept private audio, preview audio, or Spotify URLs as playable; make queue auto-advance treat Spotify as playable only when the user has an active Spotify device.
4. Add a background engine prewarm lane that reserves at most three tail preparation slots for non-empty YouTube-backed candidates from the newest two effective-date episodes; never prepare from an FYP read.
5. Add explicit source/episode metadata to injected rows and merge at most three after the first five ordinary recommendations.
6. Run focused tests and client typecheck.

### Task 2: Add Soulection attribution and fishing-potential labels

**Objective:** Make source lineage and episode mining quality obvious.

**Files:**
- Create: `apps/client/src/lib/episode-fishing.ts`
- Create: `apps/client/src/lib/episode-fishing.test.ts`
- Modify: `apps/client/src/components/TrackCard.tsx`
- Modify: `apps/client/src/app/api/series/[slug]/route.ts`
- Modify: `apps/client/src/app/mixes/types.ts`
- Modify: `apps/client/src/app/mixes/[slug]/page.tsx`

**Steps:**
1. Write failing tests for source labeling and deterministic fishability score/labels.
2. Compute acquisition-readiness and resolution counts in bounded batched queries; non-empty YouTube sources are fishable even when they are not yet playable.
3. Return score, label, and concise reason for every recent episode.
4. Render accessible `Prime fishing`, `Good fishing`, or `Light fishing` badges and reasons.
5. Ensure 4U cards render `Soulection` and the exact linked episode title.
6. Run focused tests and client typecheck.

### Task 3: Refresh data and release

**Objective:** Put the feature and two additional episodes into production with verified evidence.

**Files:**
- Modify through Backlog CLI: `backlog/tasks/task-22 - Feed-followed-mix-series-tracks-into-4U.md`

**Steps:**
1. Run `bun run crawl-soulection --limit 22` and read back episode, appearance, resolution, and playability counts from the project-scoped production database.
2. Run all client library tests, client typecheck/build, engine tests/typecheck, dependency audit, diff checks, and credential scan.
3. Run authenticated browser QA if the stored test account is available; verify source badges, episode links, fishing labels, and no pre-vote `user_tracks` insertion.
4. Update TASK-22 through Backlog CLI, commit, push `main`, verify the remote SHA and Vercel deployment, and probe production routes.
