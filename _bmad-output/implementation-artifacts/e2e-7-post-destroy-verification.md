# Story E2E.7: Fix 25 Post-Destroy WARN (list_after_destroy)

Status: ready-for-dev

## Problem

All 25 `list_after_destroy` checks report WARN because the E2E harness checks if ANY managed resources exist (`count === 0`), not whether the specific destroyed resource is gone. Since the E2E runs 25 tests sequentially with shared infrastructure, the list always has resources from other tests.

## Root Cause

`e2e-test.mjs` line 542-548: `list_after_destroy` calls `list_managed_resources()` and checks `count === 0`. With 25 tests sharing a Tagging API namespace, count is never 0 during the run.

## Fix

Change `list_after_destroy` to verify that the specific destroyed resource ARN(s) are no longer in the list, rather than checking for zero total count. Allow a retry with delay for Tagging API propagation.

## Tasks / Subtasks

- [ ] Task 1: Track destroyed ARN(s) per test
  - [ ] 1.1 Store the identifier(s) passed to destroy_resource in a `destroyedArns` array
  - [ ] 1.2 For compound patterns, collect all successfully destroyed ARNs

- [ ] Task 2: Change list_after_destroy to check specific ARN absence
  - [ ] 2.1 After destroy, call list_managed_resources and check that none of the destroyedArns appear
  - [ ] 2.2 Add 10s retry (2 attempts × 5s) for Tagging API de-index lag
  - [ ] 2.3 PASS if destroyed resource is absent from list, WARN only if still visible after retry

- [ ] Task 3: Verify all 25 list_after_destroy become PASS
  - [ ] 3.1 Run E2E and confirm 150/150

## Dev Notes

### Key File

- `apps/mcp-server/e2e-test.mjs` lines 533-554

### How to Run

```bash
npx turbo build --force && node apps/mcp-server/e2e-test.mjs 2>&1 | tee /tmp/mcp-e2e.log
```
