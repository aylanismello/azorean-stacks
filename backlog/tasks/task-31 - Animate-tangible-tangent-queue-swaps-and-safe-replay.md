---
id: TASK-31
title: Make every discovery action visibly reshape the live queue
status: In Progress
assignee:
  - '@pico'
created_date: '2026-09-12 04:42'
updated_date: '2026-09-12 07:09'
labels:
  - ux
  - tangents
  - player
dependencies: []
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Turn skip, like, super-like, reject, seed, unseed, and tangent refreshes into one restrained living-tree UX. Show immediate causality, then exact outgoing-to-incoming queue swaps when a new generation lands. Animate rows on desktop, show the same compact non-blocking chip on mobile, retain tangent lineage, and support safe replay without replacing the active queue.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 A material tangent publishes an exact removed-to-added swap event using durable tangent evidence
- [x] #2 Desktop visibly animates the outgoing queue row and its incoming replacement in the affected area
- [x] #3 Mobile shows the same mutation as a compact non-blocking chip
- [x] #4 Tangent tracks explain which seed branched them into the feed
- [x] #5 Tangent and history tracks can be replayed without replacing or corrupting the active queue
- [x] #6 Animations are restrained, accessible, and disabled under reduced motion
- [ ] #7 Tests, typecheck, build, browser QA, and production deployment pass
- [x] #8 Skip, like, super-like, reject, seed, and unseed each produce a restrained action-specific mutation event
- [x] #9 A subsequent material queue generation upgrades that event with exact outgoing-to-incoming track names
- [x] #10 Desktop queue rows visibly show the replacement; mobile receives the same event as a compact non-blocking chip
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Unify immediate discovery-action feedback and durable queue-generation deltas.
2. Render restrained mutation chips, exact queue swaps, and incoming-row motion across desktop and mobile.
3. Make tangent/history replay queue-preserving.
4. Validate accessibility, reduced motion, mobile layout, playback continuity, tests, build, and production.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Implemented one living-tree mutation event model across skip, like, super-like, reject, seed, unseed, tangent, and live refreshes. Added compact mobile/desktop status chip, exact out-to-in queue swap row, incoming-row/card animation, reduced-motion support, and safe tangent/history replay through GlobalPlayerProvider.play without replacing the queue. Desktop and 390x844 browser QA verified interaction feedback, exact queue replacement, open tracklist swap, no horizontal overflow, and preserved playback queue semantics. Client tests, TypeScript, production build, and audit pass.

- Late adversarial review reproduced and fixed protected-prefix reordering, secondary episode/show blindness, false positional swap pairing, rapid-action misattribution, filtered-view feedback gating, and generic readiness events overwriting action feedback.
- Authenticated test-account browser QA verified action chips on home and genre-filtered mobile views, exact position-tagged multi-change queue rows on mobile and desktop, and no horizontal overflow. Temporary test session was revoked.

- Final review fixes: pure reorder events now carry exact old/new positions; all queue changes remain inspectable in a bounded scroll region; ranking refreshes cannot inherit like/skip copy; seed attribution requires the exact durable seed row ID; generic queue details no longer replace the immediate action chip.
- Final release gate: client 184 tests, engine 133 tests, TypeScript, production build, and audit all passed after stopping the dev server that had raced .next.

- Second adversarial pass fixed multi-pending seed matching and preserved exact seed events across unrelated readiness deltas. Seed causality now uses the durable seed row ID returned by every seed surface, never the track ID.
<!-- SECTION:NOTES:END -->
