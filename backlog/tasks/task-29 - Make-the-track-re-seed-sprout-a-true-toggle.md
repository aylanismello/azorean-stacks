---
id: TASK-29
title: Make re-seeding toggleable and expose playback history
status: Done
assignee:
  - '@pico'
created_date: '2026-09-12 03:47'
updated_date: '2026-09-12 04:02'
labels:
  - ux
  - seeds
dependencies: []
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Make the re-seed sprout add/remove the user-owned re-seed on repeated clicks. Add a discoverable history view so recently passed tracks remain available for replay even after the queue changes.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Clicking an inactive sprout creates the re-seed and renders it active
- [x] #2 Clicking an active sprout removes the re-seed and renders it inactive
- [x] #3 The control remains keyboard accessible, exposes pressed state, and cannot double-submit
- [x] #4 Client tests, typecheck, build, and rendered interaction verification pass
- [x] #5 The For You tracklist can switch between the live queue and recent playback history
- [x] #6 History survives page navigation/reload within the browser tab, can replay a track, and can be cleared
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Change the card sprout from ensure-only to the existing add/remove toggle API.
2. Synchronize the changed seed state into the global player queue/current track.
3. Keep the active control clickable with aria-pressed and clear add/remove labels.
4. Add regression coverage, run client validation, render the interaction, then deploy.
<!-- SECTION:PLAN:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Made the sprout a true add/remove re-seed toggle on mobile and desktop, including the r keyboard shortcut. The active control remains clickable, exposes aria-pressed, blocks duplicate submissions, and synchronizes its state into the global player queue.

Added a For You History view that retains the 50 most recent passed tracks for the browser tab, deduplicates them newest-first, avoids storing refreshable signed URLs, supports replay, and can be cleared.

Verified with 170 client tests, TypeScript, production build, dependency audit, live add/remove API interaction, desktop replay, and a 390x844 mobile render with zero overflow.
<!-- SECTION:FINAL_SUMMARY:END -->
