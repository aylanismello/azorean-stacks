---
id: TASK-25
title: Keep 4U stable and exclude prior listens
status: Done
assignee:
  - '@pico'
created_date: '2026-09-11 21:33'
updated_date: '2026-09-11 22:17'
labels: []
dependencies: []
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Prevent queue rematerialization from replacing the active listening slate, keep shared catalog status from rendering as a personal like, and exclude qualified prior playback from 4U.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Ordinary refresh preserves active pending queue order and only backfills gaps
- [x] #2 Seed refresh moves at most three newest-seed candidates after a protected five-track prefix
- [x] #3 Shared tracks.status never renders as the user's opinion
- [x] #4 Qualified played tracks are excluded from ranking and API responses
- [x] #5 Regression tests pass
- [x] #6 Active seeds and re-seeds are excluded from ordinary and exploration 4U lanes
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Neutralize shared catalog state in personalized responses
2. Exclude qualified playback totals
3. Preserve active queue order; only bounded seed injection may change it
4. Verify against production data and deploy
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
- Found active manual seed Strings of Eden at rank 4 because pending eligibility did not subtract active seeds.
- Added user-scoped active-seed exclusion in client and engine ordinary/exploration paths; production-data probe against local code returns zero active seed tracks.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Fixed 4U queue continuity and eligibility so routine refreshes preserve the active slate while removing user-actioned, qualified-played, and active seed/re-seed tracks. Personalized response state no longer inherits shared catalog opinions; fresh-seed insertion remains bounded behind the protected prefix; queue mutations remain serialized; and client/engine Soulection exploration applies the same user-scoped exclusions.

Verification:
- Client: 137 tests, TypeScript, production build
- Engine: 66 tests, TypeScript, runner syntax
- Production data: zero active seed tracks returned by corrected selection; Strings of Eden excluded
- Deployed FYP endpoint: 200 with zero seed-badged rows
<!-- SECTION:FINAL_SUMMARY:END -->
