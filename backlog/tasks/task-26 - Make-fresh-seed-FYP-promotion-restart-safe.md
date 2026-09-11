---
id: TASK-26
title: Make fresh-seed FYP promotion restart-safe
status: Done
assignee:
  - '@pico'
created_date: '2026-09-11 22:27'
updated_date: '2026-09-11 23:25'
labels: []
dependencies: []
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Persist and recover the one-time fresh-seed 4U promotion so completed seeds cannot remain scored but invisible after worker downtime, restart, deploy, or refresh failure.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 New user-owned seeds record that a fresh 4U refresh is required
- [x] #2 A successful refresh records a durable completion checkpoint
- [x] #3 Worker startup and polling recover completed seeds missing the checkpoint
- [x] #4 Recovery remains user-scoped, serialized, bounded to three candidates, and retry-safe
- [x] #5 Regression tests, typechecks, builds, worker restart, and production readback pass
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Persist a refresh-required marker when a user-owned seed is queued.
2. Checkpoint only after the bounded fresh-lane queue refresh succeeds.
3. Recover completed-but-uncheckpointed seeds at worker startup and on a bounded interval.
4. Add retry/user-isolation tests, run full verification, deploy, restart the worker, and read back production state.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
- Root cause: fresh-seed queue insertion was a one-shot worker event with no durable completion checkpoint.
- Implementation uses dedicated seed refresh-required/completed timestamps to avoid pipeline_status JSON races.
- New/manual/playlist/re-seed/auto-approved seeds are marked; DB trigger covers alternate insertion paths.
- Worker retries completed-but-uncheckpointed seeds at startup and every 60 seconds.

- Production migration seed_fyp_refresh_recovery applied and read back: both timestamp columns, trigger, and partial pending-refresh index exist.
- Transactional trigger probe confirmed a new user-owned active seed is automatically marked required and queued; the QA row was deleted and zero remain.
- Client 137/137 and engine 69/69 tests passed; both TypeScript checks, client production build, runner syntax, diff check, and both bun audits passed.

- Added database-level per-user claims and latest-completed-seed backfill in migration 031.
- Added owner/active/generation-conditional checkpointing and claim release.
- Applied migration 032 to force a new queued discovery generation on reactivation or owner reassignment; production readback matches and claim RPC remains service-role only.
- Corrected the ranking UI: removed bogus /100 and duplicate taste score, labeled the raw value as a relative ranking score, and converted raw signals to actual weighted contributions.
- Final local gates: client 139/139, engine 69/69, both TypeScript checks, production build, runner syntax, diff check, and both bun audits passed.

- Independent review found a duplicate-pipeline race: realtime processSeed and processPriorityQueue could process the same stateful seed. Added one-owner routing: stateful seeds are exclusively handled by the priority processor; realtime, startup backlog, and processSeed itself all guard against duplicate handling. Engine suite now 70/70 plus TypeScript, runner syntax, and audit.

- Hardened the full priority pipeline with an owner/active/required-generation fence from claim through status writes and final FYP checkpoint; stale generations abort instead of overwriting new activation state.
- Routed all user-owned seeds through the priority processor only. Legacy stateless rows are CAS-adopted into durable queued work; shared seeds retain the legacy path.
- Startup now deterministically paginates all active seeds and recovers only the latest stateless seed per user, avoiding the 1,000-row cap.

- Final startup recovery fix paginates both active seeds and each episode/run link result set independently; no PostgREST row cap can hide the newest legacy seed or misclassify processed seeds.
- Final gates: engine 71/71, client 139/139, both TypeScript checks, client production build, runner syntax, diff check, and both audits passed.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Made fresh-seed 4U promotion durable and restart-safe.

Changes:
- Added required/claimed/refreshed generation markers, trigger enrollment, bounded backfill, and service-role-only atomic claims.
- Fenced processing and checkpoint writes by seed, owner, active state, and exact generation.
- Routed user-owned seeds through one priority pipeline, CAS-adopting legacy stateless seeds and paginating every startup scan.
- Recovered missed refreshes at startup and periodically without disturbing the protected queue prefix.

Verification:
- Engine 71/71 and client 139/139 tests passed.
- TypeScript, client production build, runner syntax, diff check, and both audits passed.
- Vercel deployed commit 59353d9 successfully.
- Restarted worker drained 3 pending generations to 0 pending/0 claimed with 3 durable checkpoints.
<!-- SECTION:FINAL_SUMMARY:END -->
