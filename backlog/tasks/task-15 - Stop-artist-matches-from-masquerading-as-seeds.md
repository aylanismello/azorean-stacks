---
id: TASK-15
title: Stop artist matches from masquerading as seeds
status: Done
assignee:
  - '@pico'
created_date: '2026-09-09 22:13'
updated_date: '2026-09-09 22:21'
labels:
  - frontend
  - bug
dependencies: []
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The FYP currently renders the broad legacy is_artist_seed discovery flag with the same sprout and green styling as an actual user seed, making seed-heavy ranked batches look like the user's seed set changed.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Only is_seed tracks display the seed sprout and seed styling
- [x] #2 Only is_re_seed tracks display the re-seed badge
- [x] #3 is_artist_seed alone does not display either seed badge
- [x] #4 FYP ranking and score data are unchanged
- [x] #5 Client typecheck, focused tests, and production build pass
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Centralize explicit seed/re-seed badge classification
2. Remove is_artist_seed from seed badge and styling conditions
3. Add regression tests proving artist-match flags do not masquerade as seeds
4. Typecheck, build, and verify the diff does not touch ranking logic
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
- Centralized explicit seed badge classification.
- Removed is_artist_seed from FYP/track-card seed badges and green seed styling.
- Preserved is_artist_seed as ranking/discovery metadata; no scoring or API logic changed.
- Verified with focused tests and authenticated browser rendering: only one genuine re-seed badge remained in the test FYP.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Corrected seed badge semantics so broad artist-match discovery metadata no longer masquerades as user seed intent. Actual seeds display 🌱, explicit re-seeds display 🌿, and is_artist_seed alone has no seed badge or seed styling. Ranking data and score behavior are unchanged.

Validation: seed classification tests, client TypeScript, production build, and authenticated browser rendering.
<!-- SECTION:FINAL_SUMMARY:END -->
