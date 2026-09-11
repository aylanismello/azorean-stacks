---
id: TASK-25
title: Keep 4U stable and exclude prior listens
status: In Progress
assignee:
  - '@pico'
created_date: '2026-09-11 21:33'
updated_date: '2026-09-11 21:33'
labels: []
dependencies: []
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Prevent queue rematerialization from replacing the active listening slate, keep shared catalog status from rendering as a personal like, and exclude qualified prior playback from 4U.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Ordinary refresh preserves active pending queue order and only backfills gaps
- [ ] #2 Seed refresh moves at most three newest-seed candidates after a protected five-track prefix
- [ ] #3 Shared tracks.status never renders as the user's opinion
- [ ] #4 Qualified played tracks are excluded from ranking and API responses
- [ ] #5 Regression tests pass
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Neutralize shared catalog state in personalized responses
2. Exclude qualified playback totals
3. Preserve active queue order; only bounded seed injection may change it
4. Verify against production data and deploy
<!-- SECTION:PLAN:END -->
