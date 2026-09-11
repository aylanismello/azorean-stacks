---
id: TASK-21
title: Build Soulection Mix Series beta
status: In Progress
assignee:
  - '@pico'
created_date: '2026-09-10 20:46'
updated_date: '2026-09-11 01:01'
labels: []
dependencies: []
references:
  - 'https://radio.soulection.com/episodes/7892c3b0-1cee-4f7c-bf9e-749d53a37a6a'
priority: high
type: feature
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Make Soulection Radio a first-class, user-seedable mix series with recent-first episode discovery, ordered episode playback, and strict isolation from track FYP eligibility.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Soulection Radio is represented as a first-class Mix Series with recent episodes
- [x] #2 An authenticated user can seed or unseed the series without bulk-liking episodes or tracks
- [x] #3 Opening a recent episode shows its ordered timestamped tracklist and can play it as a dedicated Stack
- [x] #4 Episode tracks do not enter ordinary FYP until the user explicitly votes on a canonical track
- [x] #5 Only a bounded current-plus-look-ahead audio window is prepared
- [x] #6 Missing or unresolved tracklist entries remain visible and honest
- [ ] #7 Typecheck, focused tests, production build, migration replay, and browser QA pass
- [x] #8 Ordinary FYP ranking uses the authenticated user's explicit super-like, like, skip, reject, and qualified-listen evidence with balanced exploration and repetition controls
- [x] #9 Mix-series affinity informs discovery without converting episode exposure into track approval
- [x] #10 Live taste data is audited before tuning and the initial system remains explainable rather than introducing an unnecessary opaque model
- [x] #11 Right-clicking any canonical track row opens playback-neutral actions for like, star, reject, skip, re-seed, and bad source
- [x] #12 The currently playing track can be toggled on repeat without restarting it
- [x] #13 Each playback session records one durable play after 30 seconds and accumulates per-user listen time without overwriting explicit votes
- [x] #14 Media controls expose previous, play/pause, next, and seek backward/forward across supported Chrome and Safari media sessions
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Audit live user taste outcomes, candidate supply, score distribution, repetition, and current ranking behavior.
2. Add minimal Mix Series/user seed and appearance-safe schema.
3. Add a Soulection adapter that indexes recent structured episodes and timestamped tracklists.
4. Add authenticated series/episode APIs and bounded preparation.
5. Improve the explainable FYP scorer and diversified queue using explicit positive/negative evidence plus controlled exploration.
6. Add recent-first Mix Series UI and ordered episode playback entry.
7. Verify end to end, apply the safe migration, push main, and verify Vercel.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
- Implemented recent-first Soulection Mix Series catalog, series following, lossless ordered episode appearances, owner-scoped playback sessions, bounded preparation, and dedicated episode audio refresh.
- Added explainable user-scoped FYP ranking with qualified listen evidence, series context, high-confidence prefix protection, diversification, and controlled exploration.
- Applied production migrations 025 and 026 to the verified Azorean project and indexed 20 recent episodes / 1,140 appearances.
- Full engine tests/typecheck and client tests/typecheck/build pass; migration replay, dependency audit, diff check, and credential scan pass.
- Remaining release step: post-deployment authenticated browser QA.

- Production bug reported: series detail queried nonexistent episodes.featured; repairing query and adding a schema contract regression test.
- Added scope: row context actions, current-track repeat, 30-second play accounting, and browser/OS media controls.

- Added playback-neutral canonical row actions (including unenriched canonical rows), bottom-player repeat-one, previous/play/next transport, Media Session handlers, and release-only seek preview/commit.
- Added authenticated race-safe playback accounting with one play after 30 seconds, cumulative 30-second listen chunks, explicit-vote preservation, server-owned aggregate guards, and production migrations 027/028.
- Verification: 99 client lib tests, client TypeScript, production build, 46 engine tests, engine TypeScript, full pgvector migration replay, production migration readback, dependency audit, and diff checks passed. Authenticated browser QA remains blocked at the login wall.
- Follow-up hardening: server-issued playback session attestations/rate limiting would prevent an authenticated user from forging their own analytics.

- Final hardening isolated behavioral totals from user_tracks/FYP eligibility in migration 029; production migration and RLS/privilege readback passed.
- Final verification after Spotify command serialization and HTTP error handling: 99 client tests, client typecheck/build, 46 engine tests/typecheck, full migration replay, and diff checks passed. Authenticated browser QA remains unavailable at the login wall.
<!-- SECTION:NOTES:END -->
