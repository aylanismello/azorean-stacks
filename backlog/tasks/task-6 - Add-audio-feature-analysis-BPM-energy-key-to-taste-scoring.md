---
id: TASK-6
title: 'Add audio feature analysis (BPM, energy, key) to taste scoring'
status: To Do
assignee: []
created_date: '2026-03-21 04:38'
updated_date: '2026-09-11 21:33'
labels:
  - feature
dependencies: []
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Production audit found 0/8,538 user-visible catalog tracks with BPM, energy, or key metadata. Build a local audio analyzer and use calibrated feature-distance signals only after coverage and offline evaluation are sufficient.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Backfill BPM, energy, and key locally for playable tracks
- [ ] #2 Report feature coverage and extraction failures
- [ ] #3 Evaluate feature-distance ranking offline against the founder's 778 explicit outcomes before enabling
- [ ] #4 Add audio similarity as an explainable bounded component, not a replacement for lineage and outcome signals
<!-- AC:END -->
