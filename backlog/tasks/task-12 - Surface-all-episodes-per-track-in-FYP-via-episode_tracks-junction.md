---
id: TASK-12
title: Surface all episodes per track in FYP via episode_tracks junction
status: Done
assignee:
  - '@claude'
created_date: '2026-03-24 04:37'
updated_date: '2026-03-24 04:37'
labels:
  - enhancement
dependencies: []
priority: medium
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Wire up the existing episode_tracks junction table (migration 009) to the FYP pipeline and TrackCard UI so tracks appearing across multiple episodes show all their episode links.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Migration 020 SQL stub created for updating get_fyp_tracks RPC with episode_ids array
- [x] #2 /api/fyp queries episode_tracks junction and attaches episodes[] to each track
- [x] #3 TrackCard shows clickable episode pills when track appears in multiple sets
- [x] #4 Track type updated with episodes[] field
- [x] #5 tracks.episode_id column preserved for backward compat
- [x] #6 Build passes
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Wired up episode_tracks junction table to FYP pipeline and TrackCard UI.

Changes:
- Migration 020: SQL stub for updating get_fyp_tracks RPC with episode_ids uuid[] array
- /api/fyp/route.ts: queries episode_tracks to build track→episodes[] map, attaches to each track
- TrackCard.tsx: renders episode pill links when track appears in multiple sets, falls back to co_occurrence count
- types.ts: added episodes[] to Track interface
- No breaking changes: tracks.episode_id and track.episode preserved

PR: https://github.com/aylanismello/azorean-stacks/pull/146
<!-- SECTION:FINAL_SUMMARY:END -->
