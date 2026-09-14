---
id: TASK-33
title: Treat undecided next-track advances as neutral skips
status: Done
assignee:
  - '@pico'
created_date: '2026-09-14 03:13'
updated_date: '2026-09-14 15:35'
labels:
  - player
  - taste
  - ux
dependencies: []
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
When a listener advances away from a pending 4U track without making any explicit decision, persist the same taste-neutral skipped outcome as the Skip action. Never overwrite likes, super-likes, rejects, bad-source reports, seeds, or other explicit decisions; do not apply this behavior to previous-track/history replay navigation.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Pressing any next-track control on an undecided pending 4U track persists status skipped before advancing
- [x] #2 Shift+Right next-track keyboard navigation has the same behavior
- [x] #3 Natural track completion does not create an implicit skip
- [x] #4 Explicitly decided, seeded, episode-session, and history-replay tracks are not overwritten
- [x] #5 Implicit skip uses the existing taste-neutral skip pipeline and bounded novelty pressure
- [x] #6 Tests, typecheck, production build, authenticated browser QA, and deployment pass
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Trace manual next-track entry points and current per-user decision state.
2. Add one testable eligibility helper: only an undecided pending ordinary 4U track qualifies.
3. Route eligible manual next advances through the existing neutral skip API before navigation; fail closed on persistence errors so an advance never silently loses the neutral decision.
4. Serialize explicit decisions against manual next, preserve replay/episode semantics, and give explicit ranking outcomes precedence over neutral evidence.
5. Run tests/typecheck/build, authenticated race QA, release review, push main, and verify production.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
- Added a discovery-only manual-next flag carried by 4U/swipe queue tracks. Manual next now conditionally persists the existing skipped outcome before advancing, emits the same Keep digging mutation, and serializes repeated next presses. Natural completion calls an explicit ended path and remains untouched.
- Added server-side race protection: implicit skips conditionally update only pending rows or insert absent exploration rows; a concurrent explicit decision wins and is returned to the player instead of being overwritten. Episode queues, seeds/re-seeds, explicit decisions, and history replay are excluded.

- Focused gate passed 31 tests plus TypeScript. Full client gate passed 192 tests, TypeScript, production build, and dependency audit. Existing ranking-evidence contract was updated for the intentional fourth outcome path used only when an implicit skip is actually applied.

- Real authenticated mobile QA at 390x844 passed: manual Next sent PATCH {status: skipped, implicit_skip: true}, returned HTTP 200 with implicit_skip_applied=true, emitted the neutral skip event, showed Keep digging, advanced to the next track, and had no horizontal overflow. The two temporary test decisions were deleted and the temporary auth session was globally revoked.
- Final client gate after the natural-completion helper test: 193 tests passed; TypeScript, production build, dependency audit, and diff check passed.

- Adversarial review found replay, stale-response, seed-ref, and ranking-evidence races. Fixed replay through Previous, History, earlier queue rows, and tangent branches by disabling implicit skip on replay loads.
- All explicit 4U/swipe/tracklist vote and seed paths now mark decision requests before their first await; manual Next cancels if one is pending or began during its request, preventing stale local state, false Keep digging feedback, and double navigation. Seed state now updates currentTrackRef synchronously.
- The implicit API checks active seeds, rereads final per-user status after evidence recording, and only reports an applied skip when skipped remains authoritative. Production migrations 039/040 let approved or rejected evidence supersede skipped/listened while preserving append-only constraints for every other mutation. Live test-account verification promoted skipped to approved and proved a later neutral write could not reverse it.
- Authenticated delayed-response browser QA on mobile and desktop returned HTTP 200 for both racing requests, emitted no false skip event/copy, did not double-advance, and allowed the next deliberate Next after the explicit decision. Temporary decisions and session were removed/revoked.
- Migrations 041-044 serialize implicit skips with re-seeds, align the exact evidence timestamp, and retract only the neutral label created by a winning race. Migration 045 restores the original user/exposure cascade cleanup guards. A live rollback-only assertion passed implicit skip/evidence creation, re-seed restoration to pending with exact evidence retraction, and active-seed exclusion.
- Manual Next now snapshots a playback-selection revision before persistence. Direct queue/history/replay selection increments that revision, so a delayed response cannot advance from a newly selected track. Final local gate after this fix: 196 tests, TypeScript, production build, dependency audit, and diff check passed.
- Light-mode discovery-panel copy and contrast were simplified before release: technical tangent/branch/buffer language was replaced with plain queue language, and mint text now meets readable light-theme contrast. Focused tests, TypeScript, and the production build passed. Commit `ec5b9e8` deployed successfully through Vercel.
<!-- SECTION:NOTES:END -->
