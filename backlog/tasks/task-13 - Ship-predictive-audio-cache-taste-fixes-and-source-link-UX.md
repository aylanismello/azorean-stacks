---
id: TASK-13
title: 'Ship predictive audio cache, taste fixes, and source-link UX'
status: In Progress
assignee:
  - '@pico'
created_date: '2026-09-08 23:22'
updated_date: '2026-09-09 20:48'
labels: []
dependencies: []
documentation:
  - >-
    backlog/docs/architecture/predictive-queue-audio-cache/doc-1 -
    Predictive-Queue-Audio-Cache-and-Taste-Algorithm-Report.md
priority: high
type: feature
---

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Autonomous discovery and reseeding continue while only ranked upcoming/permanent tracks are downloaded
- [ ] #2 Cleanup tool protects all likes, super-likes, seeds, PicoDrops, and upcoming queue tracks and supports verified dry-run before deletion
- [ ] #3 Taste scoring is fully per-user, learns canonical seed/show yield, and handles approval UPDATE reseeds
- [ ] #4 Spotify and YouTube links prefer native apps on supported Apple platforms with safe web fallback
- [ ] #5 Copy controls remain visible on white backgrounds and Why this track shows actual source/episode/seed lineage
- [ ] #6 Build, tests, browser checks, and post-write production verification pass
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Add queue/cache schema and server-side preparation worker
2. Fix taste/reseed correctness and ranking exploration
3. Add safe production cleanup dry-run and execution
4. Fix native-link and source-context UI
5. Review, test, deploy, and verify
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
- Created implementation branch and linked architecture doc.
- Verified live service key targets project zifjbbhgeydgccjolmji.
- Live preflight: 11,564 track rows reference 11,546 distinct audio paths. Current dynamic protection union fluctuated from 362 to 383 track IDs because /api/fyp is not materialized; therefore deletion is blocked until the stable queue is implemented. Latest conservative candidate estimate: 11,205 paths, but nothing deleted.
- Supabase MCP is connected to a different project (qujifwhwntqxziymqdwu); do not use it for Azorean Stacks.

- Production cleanup completed: 10,892 storage paths deleted and 10,896 track storage references cleared; 668 protected stored rows remain. Database reference verification passed; exhaustive storage probing is being retried after a transient Supabase 504.
- Migration 020 applied to production. Taste refresh upserted 260 signals and scored 12,397 pending tracks with zero errors.
- Client production build, client/engine TypeScript checks, and 3 focused link/diversification tests pass.
- GitHub main push requested explicitly. Local engine LaunchAgent path is repaired but runtime activation remains separate because protected environment setup was not authorized by the terminal safety gate.
<!-- SECTION:NOTES:END -->
