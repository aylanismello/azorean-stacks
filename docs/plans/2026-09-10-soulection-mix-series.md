# Soulection Mix Series Beta Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Ship a first-class, recent-first Soulection Mix Series experience and improve the ordinary FYP’s balance using explainable user-scoped evidence.

**Architecture:** Keep shared series, episodes, and ordered appearances separate from user-owned series seeds and track opinions. Soulection ingestion indexes recent structured episodes and their timestamped tracklists; selecting an episode plays a dedicated queue and prepares only a bounded look-ahead. Ordinary FYP continues to require user-scoped eligibility and uses explicit super-like/like/skip/reject/listen evidence, but its materialized slate is diversified across episode/show/source before audio preparation.

**Tech Stack:** Next.js 15, TypeScript, Bun, Supabase/Postgres/RLS, existing Bun engine watcher, private Supabase Storage.

---

### Task 1: Add the Mix Series and ordered-appearance schema

**Objective:** Represent a shared mix series, its recent episodes, user-owned series seeds, user episode sessions, and repeated/unresolved tracklist positions without leaking user state.

**Files:**
- Create: `apps/client/supabase/migrations/025_mix_series.sql`
- Modify only if migration replay requires compatibility: `apps/client/supabase/migrations/replay.test.sql` or the repository’s existing replay harness

**Steps:**
1. Add migration assertions/failing replay checks for the new relations and RLS.
2. Create `mix_series`, `user_series_seeds`, and minimal episode-session/event state required by the UI.
3. Link `episodes.series_id` to `mix_series`.
4. Give `episode_tracks` an appearance UUID and make `(episode_id, position)` its idempotency identity so repeated canonical tracks remain representable.
5. Preserve unresolved source rows honestly, either in an appearance table with nullable canonical ID or a dedicated raw appearance table; do not fabricate catalog tracks.
6. Restrict user-owned rows with RLS and keep shared catalog writes worker/server-owned.
7. Run the migration replay harness and inspect its assertions.

### Task 2: Implement recent Soulection ingestion

**Objective:** Reliably index the newest Soulection Radio episodes and exact timestamped tracklists from the structured public site.

**Files:**
- Create: `apps/engine/lib/sources/soulection.ts`
- Create: `apps/engine/scripts/crawl-soulection.ts`
- Create: `apps/engine/scripts/crawl-soulection.test.ts`
- Modify: `apps/engine/lib/sources/index.ts`
- Modify: `apps/engine/runner.sh`
- Modify as needed to share canonicalization instead of copying it: `apps/engine/scripts/discover.ts`, `apps/engine/scripts/watcher.ts`

**Steps:**
1. Write parser fixtures/tests for episode UUID/title/DJ/artwork/source links and timestamped rows, including voiceovers, repeated songs, and missing titles.
2. Enumerate a bounded recent window from `https://radio.soulection.com/` in newest-first order.
3. Persist one `mix_series` row for Soulection Radio and upsert recent episodes by stable URL/external ID.
4. Persist every source position and timestamp; resolve valid artist/title entries to canonical tracks while leaving unresolved entries visible.
5. Schedule incremental refresh without deleting prior successful data on transient failure.
6. Run focused crawler tests and a bounded live probe.

### Task 3: Add authenticated series and episode APIs

**Objective:** Let a user seed/unseed Soulection, browse recent episodes, open one ordered tracklist, and request only a small preparation window.

**Files:**
- Create: `apps/client/src/app/api/mix-series/route.ts`
- Create: `apps/client/src/app/api/mix-series/[id]/route.ts`
- Create: `apps/client/src/app/api/mix-series/[id]/seed/route.ts`
- Create or adapt: `apps/client/src/app/api/episode-seeds/[episodeId]/route.ts`
- Create: `apps/client/src/app/api/episode-seeds/[episodeId]/prepare/route.ts`
- Modify: `apps/client/src/lib/types.ts`

**Steps:**
1. Add focused pure/API tests for authentication, ownership, recent-first ordering, and FYP isolation.
2. Derive every `user_id` from the authenticated session; never trust request payload identity.
3. Return shared series metadata plus only the current user’s seed/progress state.
4. Return episode rows in `(episode_id, position)` order with separate appearance and canonical IDs.
5. Seed/unseed only the user-owned relationship; never bulk-create positive track opinions.
6. Authorize preparation through the series/episode relationship and enqueue current plus at most the next five resolvable tracks.
7. Keep unavailable/unresolved rows in responses with honest state.

### Task 4: Improve explainable FYP balance

**Objective:** Use explicit user evidence more effectively and stop the warm queue from being dominated by one or two episodes.

**Files:**
- Modify: `apps/engine/lib/taste-scoring.ts`
- Modify: `apps/engine/scripts/update-signals.ts`
- Modify: `apps/engine/lib/predictive-queue.ts`
- Create/modify tests beside those modules
- Modify: `apps/client/src/lib/diversify.ts`
- Create: `apps/client/src/lib/diversify.test.ts`
- Modify if needed: `apps/client/src/app/api/fyp/route.ts`

**Steps:**
1. Add regression fixtures matching the live failure: a 50-track queue dominated by two episodes despite many distinct candidates.
2. Keep super-like `+3`, approve `+1`, skip `-0.3` (qualified by listen depth where present), and reject `-1` as explicit evidence.
3. Keep series selection as curator/source intent, not a synthetic approval for constituent tracks.
4. Over-fetch ranked candidates and construct a diversified materialized slate with caps/penalties across episode, show/source context, artist, and recently exposed clusters; preserve the strongest high-confidence items.
5. Keep a small controlled exploration share selected by uncertainty near neutral, never from known-negative clusters.
6. Persist score components and a bumped scoring version for explainability.
7. Verify user isolation and that no catalog/global score fallback exists.

### Task 5: Build the recent-first Mix Series UX

**Objective:** Give Soulection a clear first-class home and make recent qualified episodes playable as dedicated ordered Stacks.

**Files:**
- Modify: `apps/client/src/app/stacks/page.tsx`
- Create: `apps/client/src/app/mixes/[id]/page.tsx`
- Create: `apps/client/src/components/MixSeriesCard.tsx`
- Create: `apps/client/src/components/MixEpisodeCard.tsx`
- Modify: `apps/client/src/components/EpisodeTracklist.tsx`
- Modify: `apps/client/src/components/GlobalPlayerProvider.tsx` only if the existing dual queue/catalog identity is insufficient
- Modify: `apps/client/src/app/page.tsx`

**Steps:**
1. Add a visible Mix Series section separate from the ordinary track FYP.
2. Show Soulection artwork, seed state, newest qualified episode, and a small recent list; do not infinite-scroll by default.
3. Open a series detail view with latest-first episodes and explicit readiness/coverage.
4. Open/play an episode in exact source order with progress and unavailable rows visible.
5. Ensure track votes target canonical IDs while queue highlighting uses appearance IDs.
6. Render and inspect desktop, intermediate, and phone widths.

### Task 6: Verify and ship the coherent beta

**Objective:** Prove the feature and ranking change work locally and in production without leaking data or damaging the existing FYP.

**Files:**
- Modify through Backlog.md CLI: `TASK-21`
- Update relevant source-of-truth/backlog documentation only for verified behavior

**Steps:**
1. Run engine focused tests and `bunx tsc --noEmit`.
2. Run client focused tests, `bunx tsc --noEmit`, and `bun run build` with no dev server racing `.next`.
3. Replay all migrations from clean state and inspect migration 025 assertions.
4. Run changed-file secret scan and `git diff --check`.
5. Run a bounded live Soulection crawl and verify one real episode plus ordered entries.
6. Browser-test authenticated series seeding, recent-first display, episode opening, queue playback/preparation states, exiting back to FYP, and mobile layout.
7. Apply the migration only after triangulating the production Supabase project, read it back, restart the worker, then push `main` through GitHub.
8. Verify remote SHA, Vercel success, protected API `401`, authenticated feature behavior, and one real playable prepared track before marking TASK-21 done.
