---
id: TASK-30
title: Ship the interactive tangent side feed
status: Done
assignee:
  - '@pico'
created_date: '2026-09-12 04:19'
updated_date: '2026-09-12 04:29'
labels:
  - ux
  - tangents
dependencies: []
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Replace the blocking tangent status card with the actual branch experience: a tree button that opens and closes a side feed, an explicit action to grow a tangent from the current track, and an animated view of how that branch changed the upcoming feed.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Clicking the tree button while the tangent panel is visible dismisses the panel
- [x] #2 Clicking it again reopens the latest tangent
- [x] #3 The button exposes its open state and dynamic accessible label
- [x] #4 Tests, typecheck, build, browser interaction, and production deployment pass
- [x] #5 The tangent tree opens a side feed with a labeled action to branch from the current track
- [x] #6 The side feed visualizes added tracks as animated growing branches and preserves reduced-motion support
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Make the top-right tangent tree button close the active panel before reopening history.
2. Expose pressed state and dynamic open/close labels.
3. Add a regression contract and run client validation.
4. Exercise the exact click interaction in-browser, then commit, deploy, and verify production.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
- Root cause: the top-right tree button only assigned the latest tangent; it never tracked an independent open/closed panel state.
- Replaced the centered status card with a real tangent side feed and explicit current-track branch control.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Replaced the centered tangent status card with an interactive side feed. The top-right tree is now always available on 4U and toggles the panel open and closed; the panel also has its own close control and exposes pressed/open state to assistive technology.

Added an explicit “Grow a tangent from this track” action. It queues the existing durable re-seed pipeline, keeps the current track playing, reflects active/removal state, and explains that resulting branches will enter the upcoming feed.

Rendered each material queue change as an animated growing trunk and branch with staggered leaves, preserved exact insertion ranks and pruned-track details, retained earlier branch history, and disabled motion under prefers-reduced-motion.

Verified with 172 client tests, TypeScript, production build, dependency audit, disposable-account API interaction, desktop and 390x844 browser renders, zero horizontal overflow, three rendered branches, and both tree/X close interactions.

Production verification: commit 1711a7a deployed successfully. A disposable production account rendered the 390x844 tangent side feed with no horizontal overflow, and the same top-right tree button closed it. The disposable account was removed after QA.
<!-- SECTION:FINAL_SUMMARY:END -->
