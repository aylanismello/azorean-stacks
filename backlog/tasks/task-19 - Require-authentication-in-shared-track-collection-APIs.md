---
id: TASK-19
title: Require authentication in shared track collection APIs
status: To Do
assignee: []
created_date: '2026-09-09 23:13'
labels:
  - security
  - backend
dependencies: []
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The existing /api/tracks super-liked branch only scopes by user_id when a user exists, and unauthenticated approved requests can fall through to deprecated global tracks.status while using the service-role client. Harden these branches before exposing them to any new consumer.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Unauthenticated approved and super-liked track requests return 401
- [ ] #2 Every service-role user_tracks query is explicitly scoped to the authenticated user
- [ ] #3 Regression tests prove one account cannot read another account's curated states
<!-- AC:END -->
