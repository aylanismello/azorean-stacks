---
id: TASK-17
title: 'Build Segundo Sol: The CMS-ening'
status: In Progress
assignee:
  - '@pico'
created_date: '2026-09-09 22:23'
updated_date: '2026-09-09 23:13'
labels:
  - frontend
  - backend
  - database
  - feature
dependencies: []
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Add a private authenticated Segundo Sol CMS inside Azorean Stacks for creating episode drafts, assembling ordered tracklists from likes/super-likes or enriched manual music links, attaching artwork and inspiration mixes, and preserving source provenance for the PicoDrops release workflow.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A visible ☀☀ navigation tab opens the authenticated /segundo-sol CMS
- [ ] #2 User can create, select, edit, and delete private episode drafts with number, title, theme, status, notes, and artwork
- [ ] #3 User can add deduplicated tracks from their own Stacks likes and super-likes
- [ ] #4 User can paste Spotify, SoundCloud, Bandcamp, or YouTube links and receive editable enriched metadata before adding
- [ ] #5 User can reorder, edit, and remove episode tracks while preserving source provenance
- [ ] #6 User can add and remove inspiration-mix links with enriched labels and artwork
- [ ] #7 All CMS data is isolated per authenticated user with verified RLS and explicit API ownership checks
- [ ] #8 Responsive authenticated browser flow, focused tests, typecheck, and production build pass
- [ ] #9 Migration is validated, applied, and read back before deployment
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Add private per-user episode, tracklist, inspiration, and artwork-storage schema with RLS
2. Add authenticated CMS APIs for episodes, library selection, manual-link enrichment, tracklist operations, inspirations, and uploads
3. Build /segundo-sol responsive editor and add ☀☀ desktop/mobile navigation
4. Add focused tests for URL enrichment and snapshot/dedupe rules
5. Validate migration, apply and read back production schema, run typecheck/tests/build/browser QA, then push main
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
- Implemented private episode, ordered track snapshot, inspiration, and artwork-storage schema with per-user RLS and composite ownership constraints.
- Added authenticated server APIs with explicit user_id scopes, supported-provider URL validation, metadata enrichment, strict approved-track sourcing, duplicate protection, and artwork cleanup on replace/delete.
- Added responsive /segundo-sol editor plus visible desktop and mobile ☀☀ navigation.
- Validated migration in rollback, applied it to project zifjbbhgeydgccjolmji, and read back 3 tables, 12 policies, source validation trigger/constraint, and artwork bucket.
- Authenticated browser QA covered create/edit/status, Stacks add, YouTube manual enrichment, Spotify metadata/art, inspiration attach/remove, reorder/remove, artwork upload, cascade delete, mobile layout/nav, and exact QA cleanup.
- Anonymous CMS APIs return 401; anonymous direct writes fail RLS with 42501.
- Client typecheck, 17 focused unit tests, production build, diff check, and credential scan pass.
<!-- SECTION:NOTES:END -->
