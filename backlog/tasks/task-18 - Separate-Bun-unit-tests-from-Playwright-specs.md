---
id: TASK-18
title: Separate Bun unit tests from Playwright specs
status: To Do
assignee: []
created_date: '2026-09-09 23:13'
labels:
  - testing
  - tooling
dependencies: []
priority: medium
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Running plain bun test in apps/client currently discovers tests/app-flows.spec.ts and fails because Playwright test.describe cannot execute under Bun's test runner. Add explicit scripts/globs so unit and E2E suites run through their intended runners.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A documented unit-test command runs src/lib tests without collecting Playwright specs
- [ ] #2 A documented E2E command runs tests/app-flows.spec.ts through Playwright
- [ ] #3 The default project test command no longer reports the runner mismatch
<!-- AC:END -->
