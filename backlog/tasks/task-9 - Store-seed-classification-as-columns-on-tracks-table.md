---
id: TASK-9
title: Store seed classification as columns on tracks table
status: In Progress
assignee:
  - '@claude'
created_date: '2026-03-21 05:06'
updated_date: '2026-03-21 05:08'
labels:
  - backend
  - database
dependencies: []
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
is_seed, is_re_seed, is_artist_seed are computed differently across 5 API endpoints causing inconsistent labeling. The FYP endpoint doesn't compute them at all. Solution: add these as BOOLEAN columns on tracks table, set once at ingestion/update, every endpoint just reads them.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 is_seed, is_re_seed, is_artist_seed columns added to tracks table
- [ ] #2 Existing tracks backfilled correctly from seeds table
- [ ] #3 Re-seed toggle API updates is_re_seed on tracks table
- [ ] #4 Engine discover script sets seed columns on new track ingestion
- [ ] #5 get_fyp_tracks RPC returns is_seed, is_re_seed, is_artist_seed
- [ ] #6 /api/fyp route passes seed columns through
- [ ] #7 All other endpoints read columns instead of computing classification
- [ ] #8 Build passes: cd apps/client && npx next build
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Add columns via Supabase MCP
2. Backfill existing tracks from seeds table
3. Update re-seed toggle API to set is_re_seed on tracks
4. Update engine discover script to set seed columns on ingestion
5. Update get_fyp_tracks RPC to return seed columns
6. Update /api/fyp to pass through seed columns
7. Remove manual seed classification from episodes, stacks/queue, and tracks endpoints
8. Verify build passes
<!-- SECTION:PLAN:END -->
