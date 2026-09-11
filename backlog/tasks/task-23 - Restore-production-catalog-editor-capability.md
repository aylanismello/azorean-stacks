---
id: TASK-23
title: Restore production catalog-editor capability
status: In Progress
assignee:
  - '@pico'
created_date: '2026-09-11 21:02'
updated_date: '2026-09-11 21:03'
labels: []
dependencies: []
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Make shared catalog corrections honor an explicit server-owned user capability even when the deployment allowlist is missing or stale.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Environment allowlist remains supported
- [ ] #2 Supabase app metadata can grant catalog-editor access
- [ ] #3 Main production account can submit source corrections while normal test accounts remain denied
- [ ] #4 Authorization tests pass
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Add app-metadata catalog-editor capability while preserving the environment allowlist
2. Grant the capability to the existing main production user
3. Test authorization and verify the live account metadata
<!-- SECTION:PLAN:END -->
