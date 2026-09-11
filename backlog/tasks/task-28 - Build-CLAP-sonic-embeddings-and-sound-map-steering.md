---
id: TASK-28
title: Build CLAP sonic embeddings and sound-map steering
status: To Do
assignee: []
created_date: '2026-09-11 23:29'
labels:
  - audio
  - ml
  - recommendations
dependencies: []
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Analyze track audio locally with segment-level CLAP embeddings so Azorean Stacks can group songs by sonic style, find cross-genre neighbors, zero-shot tag sounds, and use seed/re-seed actions to steer 4U through audio space alongside curator and behavior signals.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Track audio is embedded in bounded 15-30 second segments with a deterministic track-level representation
- [ ] #2 Embeddings and model/version metadata are stored without exposing private audio
- [ ] #3 Nearest-neighbor search returns sonically coherent candidates across artist and genre boundaries
- [ ] #4 Library clustering produces inspectable sound groups and supports zero-shot text labels
- [ ] #5 CLAP similarity is a bounded explainable ranking component, not the sole recommender
- [ ] #6 Seed, re-seed, like, and reject actions can steer toward or away from regions of sonic space
- [ ] #7 Local batch performance, retrieval quality, tests, and rollback behavior are verified
<!-- AC:END -->
