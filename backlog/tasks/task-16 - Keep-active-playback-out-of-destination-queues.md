---
id: TASK-16
title: Keep active playback out of destination queues
status: Done
assignee:
  - '@pico'
created_date: '2026-09-09 22:15'
updated_date: '2026-09-09 22:21'
labels:
  - frontend
  - bug
dependencies: []
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Navigating to a different stack currently prepends the playing track to that stack to preserve playback, mutating the destination queue and making an unrelated song appear at rank one.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Changing stacks does not insert the currently playing track into the destination queue
- [x] #2 Current audio continues uninterrupted during navigation
- [x] #3 Next advances to the first real destination track when current playback is outside that queue
- [x] #4 Client typecheck, focused tests, and production build pass
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Represent uninterrupted playback as outside the newly loaded queue
2. Replace the destination queue without prepending the foreign playing track
3. Start destination navigation at index -1 so next enters its real first track
4. Add regression coverage and run client verification
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
- Destination queues now replace their rows without prepending foreign playback.
- The current audio element remains uninterrupted with queue index -1 when playback is outside the destination.
- Next advances from index -1 to the first real destination row.
- Authenticated browser verification: Raindrops Part I kept playing while FYP began with Pa Que Retozen; Raindrops was absent from FYP; Shift+Right advanced to Pa Que Retozen.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Decoupled uninterrupted playback from destination queue membership. Navigating between stacks no longer inserts the foreign playing track at rank one. Playback continues outside the new queue, and next enters the destination at its real first track.

Validation: queue navigation tests, client TypeScript, production build, and authenticated cross-stack browser verification.
<!-- SECTION:FINAL_SUMMARY:END -->
