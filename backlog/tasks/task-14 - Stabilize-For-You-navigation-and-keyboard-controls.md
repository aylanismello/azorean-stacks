---
id: TASK-14
title: Stabilize For You navigation and keyboard controls
status: Done
assignee:
  - '@pico'
created_date: '2026-09-09 22:00'
updated_date: '2026-09-09 22:01'
labels:
  - frontend
  - bug
dependencies: []
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Correct misleading For You queue UI, preserve the active FYP sequence across Stacks navigation, and implement the requested playback and voting shortcuts.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Home shows the personalized queue size rather than a global pending count
- [x] #2 Home has no redundant back-to-Stacks button
- [x] #3 Stacks to For You navigation preserves the active FYP order and size
- [x] #4 Focused and unfocused spacebar toggles playback without duplicate handlers
- [x] #5 Arrow, shifted-arrow, vote, no-opinion, and re-seed shortcuts match the displayed legend
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Correct FYP count and home navigation chrome
2. Isolate and preserve queues by discovery view
3. Centralize keyboard shortcut mapping and make re-seed idempotent
4. Add focused tests and browser-verify the complete interaction flow
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
- Replaced the global pending count with the active personalized queue size.
- Removed the redundant home back button and made the centered title non-navigational.
- Preserved the exact FYP queue across Stacks navigation while keeping low-queue replenishment vote-driven.
- Added centralized shortcut mapping, idempotent re-seeding, and matching legend copy.
- Verified typecheck, tests, production build, focused spacebar behavior, seeks, track navigation, and stable Stacks → For You return.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Fixed the For You experience so the header reports the actual personalized queue instead of a global legacy pending count, home no longer shows a redundant Stacks back button, and navigating through Stacks does not reshuffle or grow the active FYP.

Added the requested keyboard controls through a tested centralized key map: space play/pause, intentionally reversed arrow seeks, shifted-arrow track navigation, x/l/s/n voting actions, and idempotent r re-seeding. Updated the on-page legend to match.

Validation: client TypeScript, focused Bun tests, production build, and authenticated Playwright interaction/navigation checks.
<!-- SECTION:FINAL_SUMMARY:END -->
