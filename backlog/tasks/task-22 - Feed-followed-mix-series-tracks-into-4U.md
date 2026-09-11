---
id: TASK-22
title: Feed curated mix-series tracks into 4U
status: In Progress
assignee:
  - '@pico'
created_date: '2026-09-11 02:47'
updated_date: '2026-09-11 03:33'
labels:
  - feature
  - music-discovery
dependencies: []
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Introduce a small, clearly attributed exploration lane from recent curated Soulection episodes, preferring followed series when available, without creating user_tracks eligibility or implicit taste evidence; score episodes for fishing potential.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Series exploration uses tracks from at most two recent episodes and never creates user_tracks rows before an explicit action
- [ ] #2 Injected tracks are clearly labeled Soulection and show their source episode with a canonical link
- [ ] #3 Ordinary FYP high-confidence ordering remains protected and series exploration is deterministic, deduplicated, and user-scoped
- [ ] #4 A bounded additional Soulection refresh is indexed and production counts are read back
- [ ] #5 Focused tests, full client and engine tests, typechecks, production build, migration replay if needed, deployment, and production probes pass
- [ ] #6 The active curated Soulection series can contribute at most three playable unexplored tracks to an unfiltered 4U page, with followed series preferred when available
- [ ] #7 Soulection’s maintained archive depth is 22 and the series page initially shows eight recent episodes.
- [ ] #8 Fishing labels measure honest acquisition readiness (including non-empty YouTube sources) and never call source-only tracks playable.
- [ ] #9 Background audio preparation reserves at most three positions at the tail of the 20-track warm window for non-empty YouTube-backed Soulection candidates from the newest two effective-date episodes, preserves the ordinary prefix and existing 50-track materialized depth, and never writes user_tracks or user_series_seeds.
- [ ] #10 Optional Soulection read, signing, or preparation-candidate failures fail open without breaking ordinary 4U or the ordinary predictive queue.
- [ ] #11 Already-ready Soulection exploration tracks remain in the bounded queue slice across repeated materializations, preventing private-audio churn or eviction until user opinion or eligibility changes.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Add pure deterministic fishability and bounded series-exploration selection helpers with tests.
2. Integrate user-scoped followed-series exploration into the unfiltered 4U API without creating eligibility rows.
3. Add Soulection and episode attribution plus fishing labels to the client surfaces.
4. Refresh two additional Soulection episodes, verify live data, run release gates, push main, and verify production.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
- Production archive refresh: 22 episodes, 1,250 appearances, 1,194 resolved.
- Corrected URL audit: 1,149 appearances have non-empty YouTube acquisition sources, only 5 have non-empty Spotify URLs, and none initially had private/preview audio.
- No user has followed the series yet, so Soulection acts as the bounded default curated exploration source; background materialization prewarms a tiny slice without creating taste state.

- Production prewarm verification: materialized 50 queue rows for 1 user and reserved Soulection candidates at ranks 18–20.
- Worker downloaded all 3 selected tracks to private storage and marked all 3 queue rows ready.
- Live authenticated-user data probe returned 3 Soulection candidates across episodes #744 and #743, all private-audio-backed and neutral pending state.

- Stability probe: two consecutive production queue materializations retained the same three ready Soulection tracks at ranks 18–20 while keeping 50 materialized rows; no audio churn occurred.
<!-- SECTION:NOTES:END -->
