---
id: TASK-24
title: Refresh personalized 4U after seed discovery
status: In Progress
assignee:
  - '@pico'
created_date: '2026-09-11 21:03'
updated_date: '2026-09-11 21:03'
labels: []
dependencies: []
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Ensure adding a seed promptly recomputes personalized scores and materializes that user's FYP instead of waiting for a later vote or stale queue cycle.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Seed processing refreshes only the owning user's scores and queue
- [ ] #2 Newly linked pending candidates receive current personalized scores
- [ ] #3 Queue refresh failures do not corrupt seed discovery
- [ ] #4 Watcher tests cover the refresh contract
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Reuse the existing score-then-materialize refresh flow after seed processing
2. Keep the refresh owner-scoped and fail-open relative to discovery
3. Add regression coverage
4. Restart and verify the watcher plus the just-added seed
<!-- SECTION:PLAN:END -->
