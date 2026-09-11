---
id: TASK-27
title: Stream live 4U mutations after seed refresh
status: To Do
assignee: []
created_date: '2026-09-11 23:20'
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
- [ ] #1 Successful queue materialization publishes a durable user-scoped generation event
- [ ] #2 Authenticated clients receive only their own 4U events
- [ ] #3 4U refetches and merges the changed queue without interrupting the current player
- [ ] #4 Inserted and moved cards animate without wholesale slate replacement
- [ ] #5 Reconnects and missed realtime events recover from the durable generation
- [ ] #6 Tests, typecheck, build, mobile visual verification, and production readback pass
<!-- AC:END -->
