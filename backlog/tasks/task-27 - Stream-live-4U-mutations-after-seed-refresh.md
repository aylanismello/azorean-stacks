---
id: TASK-27
title: Stream live 4U mutations after seed refresh
status: In Progress
assignee:
  - '@pico'
created_date: '2026-09-11 23:20'
updated_date: '2026-09-11 23:46'
labels:
  - realtime
  - ux
  - 4u
dependencies: []
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Publish a user-scoped recommendation generation after queue materialization and let the 4U client subscribe, refetch, and smoothly merge the changed lane without a page reload or disrupting playback/protected tracks.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Successful queue materialization publishes a durable user-scoped generation event
- [x] #2 Authenticated clients receive only their own 4U events
- [x] #3 4U refetches and merges the changed queue without interrupting the current player
- [x] #4 Inserted and moved cards animate without wholesale slate replacement
- [x] #5 Reconnects and missed realtime events recover from the durable generation
- [ ] #6 Tests, typecheck, build, mobile visual verification, and production readback pass
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Add a durable per-user 4U generation record that advances only after successful queue materialization.
2. Publish it through Supabase Realtime with owner-only RLS.
3. Subscribe from the 4U client and reconcile missed/live generations through the authenticated API.
4. Animate inserted/moved cards while preserving the current player and protected prefix.
5. Add tests, run full gates, deploy, and verify on mobile production.
<!-- SECTION:PLAN:END -->
