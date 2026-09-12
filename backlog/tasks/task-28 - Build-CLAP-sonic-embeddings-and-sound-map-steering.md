---
id: TASK-28
title: Build CLAP sonic embeddings and sound-map steering
status: Done
assignee:
  - '@pico'
created_date: '2026-09-11 23:29'
updated_date: '2026-09-12 01:49'
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
- [x] #1 Track audio is embedded in bounded 15-30 second segments with a deterministic track-level representation
- [x] #2 Embeddings and model/version metadata are stored without exposing private audio
- [x] #3 Nearest-neighbor search returns sonically coherent candidates across artist and genre boundaries
- [x] #4 Library clustering produces inspectable sound groups and supports zero-shot text labels
- [x] #5 CLAP similarity is a bounded explainable ranking component, not the sole recommender
- [x] #6 Seed, re-seed, like, and reject actions can steer toward or away from regions of sonic space
- [x] #7 Local batch performance, retrieval quality, tests, and rollback behavior are verified
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Add isolated versioned CLAP storage and durable worker queue
2. Generate deterministic local embeddings and labels
3. Integrate bounded user-scoped sonic affinity into 4U
4. Verify live inference, retrieval, tests, and rollback fences
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
- Implemented pinned local CLAP inference, 512-d pgvector storage, fenced jobs, clustering, and zero-shot labels.
- Integrated active seeds and recent likes as positive context plus rejects as bounded avoidance; exact seed refreshes remain attributable.
- Live canary produced normalized embeddings, coherent labels, one user-scoped neighbor at 0.677 similarity, and six live queue rows with bounded sonic features.
- Added vector search_path repair migration after live canary found an unqualified type cast.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Implemented a complete local CLAP sonic map for Azorean Stacks. Audio is embedded with a pinned model and deterministic windows into isolated service-only vectors; durable fenced workers backfill and maintain embeddings, clustering, and text labels. 4U now uses user-scoped sonic affinity as a bounded supporting signal: active seeds and likes pull toward coherent regions while rejects add bounded avoidance, without bypassing candidate eligibility or interrupting playback. Verified with full tests, live model inference, live pgvector retrieval, and production queue materialization.
<!-- SECTION:FINAL_SUMMARY:END -->
