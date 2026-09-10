---
id: TASK-20
title: Import source playlists into Segundo Sol Sessions
status: In Progress
assignee:
  - '@pico'
created_date: '2026-09-09 23:29'
updated_date: '2026-09-09 23:30'
labels:
  - frontend
  - backend
  - picodrops
  - feature
dependencies: []
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Let an authenticated Segundo Sol Sessions episode import tracks from Spotify playlists, SoundCloud tracks/playlists, Bandcamp links, and YouTube sources, then hand selected tracks to the established PicoDrops acquisition pipeline and expose download/serve status inside the episode.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Episode editor presents clear source import options for Spotify, SoundCloud, Bandcamp, and YouTube
- [ ] #2 A supported source can be resolved into editable track candidates without polluting the global catalog
- [ ] #3 Selected candidates are attached to the authenticated user's episode with source provenance
- [ ] #4 Episode tracks can request PicoDrops acquisition through an authenticated, auditable backend boundary
- [ ] #5 The episode shows pending, downloaded, reusable-existing, and failed acquisition states
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Reuse the existing local PicoDrops watcher as the acquisition worker instead of downloading inside Vercel.
2. Add private per-user import/acquisition records and episode-track audio state.
3. Add authenticated source-resolution, bulk attach, acquisition request, and signed-audio APIs.
4. Add Spotify/SoundCloud/Bandcamp/YouTube import UI and per-track download state.
5. Extend and restart the existing watcher, validate migration with rollback, apply/read back, run browser QA, then push main.
<!-- SECTION:PLAN:END -->
