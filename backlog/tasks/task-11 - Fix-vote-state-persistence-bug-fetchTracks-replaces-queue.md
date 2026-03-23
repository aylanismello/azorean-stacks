---
id: TASK-11
title: 'Fix vote state persistence bug: fetchTracks replaces queue'
status: In Progress
assignee:
  - '@claude'
created_date: '2026-03-21 06:21'
updated_date: '2026-03-21 06:21'
labels:
  - bug
  - frontend
dependencies: []
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
When batch loading triggers, fetchTracks calls setQueue(freshData) which replaces the entire queue, wiping in-memory vote statuses. Fix: only use setQueue on initial load; use appendToQueue for subsequent fetches.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Initial load (empty queue) still uses setQueue
- [ ] #2 Subsequent fetchTracks calls use appendToQueue with only new tracks
- [ ] #3 Super-like persists when navigating away and back via tracklist
- [ ] #4 Build passes
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. In fetchTracks non-episode path, check if queue already has tracks
2. If queue is populated, filter to only new tracks and appendToQueue
3. If queue is empty (initial load), use setQueue as before
4. Build and test
<!-- SECTION:PLAN:END -->
