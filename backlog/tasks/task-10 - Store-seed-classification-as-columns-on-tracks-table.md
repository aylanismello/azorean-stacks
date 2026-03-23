---
id: TASK-10
title: Store seed classification as columns on tracks table
status: Done
assignee:
  - '@claude'
created_date: '2026-03-21 05:11'
updated_date: '2026-03-21 05:11'
labels:
  - backend
  - database
dependencies: []
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Move is_seed/is_re_seed/is_artist_seed from runtime computation to persisted boolean columns on the tracks table
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Add is_seed, is_re_seed, is_artist_seed columns to tracks table
- [x] #2 Backfill existing tracks from seeds table
- [x] #3 Update get_fyp_tracks RPC to return new columns
- [x] #4 Update toggle route to maintain is_re_seed on create/remove
- [x] #5 Pass through seed columns in /api/fyp response
- [x] #6 Remove manual seed classification from episode tracks endpoint
- [x] #7 Build passes
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Added is_seed, is_re_seed, is_artist_seed boolean columns to tracks table with backfill from seeds.

Changes:
- Migration: ADD COLUMN IF NOT EXISTS for all three booleans (default false)
- Backfill: UPDATE tracks from seeds matching on artist/title
- RPC: DROP + recreate get_fyp_tracks with new columns in RETURNS TABLE and SELECT
- /api/seeds/toggle: sets/clears is_re_seed on track row
- /api/fyp: passes through columns from RPC
- /api/episodes/[id]/tracks: removed ~60 lines of manual classification, reads columns directly

PR: https://github.com/aylanismello/azorean-stacks/pull/136
<!-- SECTION:FINAL_SUMMARY:END -->
