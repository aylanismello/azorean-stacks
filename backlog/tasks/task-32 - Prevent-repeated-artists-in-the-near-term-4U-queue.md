---
id: TASK-32
title: Prevent repeated artists in the near-term 4U queue
status: In Progress
assignee:
  - '@pico'
created_date: '2026-09-12 04:44'
updated_date: '2026-09-12 05:19'
labels:
  - ranking
  - ux
  - diversity
dependencies: []
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Likes, tangents, and source affinity may raise a neighborhood, but 4U is crate digging—not artist radio or one-show playback. Enforce artist, episode, and show pacing after ranking and after tangent/exploration insertion while preserving eligibility, protected playback, and bounded branch placement.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 No canonical artist appears back-to-back when another eligible artist is available
- [x] #2 A canonical artist appears at most twice in any ten-track near-term window when alternatives exist
- [x] #3 Artist normalization catches case, whitespace, featuring, and multi-artist variants without collapsing unrelated artists
- [x] #4 Tangent and exploration insertion cannot bypass artist pacing
- [ ] #5 The live main-account queue is audited before and after without exposing account identifiers
- [ ] #6 Tests, typecheck, build, worker restart, and production readback pass
- [x] #7 No episode or show appears back-to-back when another eligible context is available
- [x] #8 No episode appears more than twice or show more than three times in any ten-track near-term window when alternatives exist
- [x] #9 A skip retires the track and adds temporary artist/show/episode novelty pressure without becoming sonic rejection
- [x] #10 Repeated skips in familiar territory widen source selection while preserving prior positive taste evidence
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Audit the current main queue for artist, episode, and show runs without exposing account identifiers.
2. Build shared canonical context keys and a deterministic rolling-window pacing pass.
3. Apply pacing at engine ranking and after stable/tangent/series merge; align the client response pass.
4. Add adversarial tests for Flying Lotus/featured variants and one-show concentration.
5. Rematerialize the live queue, compare before/after, restart the worker if needed, then build, deploy, and verify.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Implemented artist alias-aware, exact episode, and originating-show pacing in both engine materialization and final client FYP assembly after optional exploration. No repeated context is allowed back-to-back when alternatives exist; near-term windows cap artists/episodes at two and shows at three, with graceful relaxation only when necessary to retain eligible tracks. Skips are now taste-neutral, excluded from empirical taste labels by default, and create only bounded 14-day novelty cooldown pressure; rejects remain explicit sonic negatives. Full engine and client suites, TypeScript, build, and audit pass.
<!-- SECTION:NOTES:END -->
