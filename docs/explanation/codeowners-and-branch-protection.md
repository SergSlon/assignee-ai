# CODEOWNERS and Branch Protection Policy

This document describes the code-ownership pattern used by the `assignee.ai`
repository and the GitHub branch-protection settings that would enforce it
once the project has multiple maintainers.

> **Status for this build.** This is a single-engineer course-submission
> repository. Branch protection is **not** configured on the GitHub side
> today — there is one maintainer and no review pool. The settings and
> tables below document the design intent for future productisation; the
> CODEOWNERS lint check (`scripts/audit-codeowners.ts`) still runs in CI
> so the file stays well-formed.

## Overview

The `CODEOWNERS` file at the repository root assigns review requirements per
path. Once branch protection is enabled on `main`, GitHub enforces these
requirements: every pull request must receive at least one approved review
from the code owner for the files it touches before merging.

## Ownership model

All files are currently owned by the single maintainer via the
`* @<maintainer>` catch-all at the top of `CODEOWNERS`. One approved review
from the maintainer is required for every PR (subject to the build-status
caveat above — branch protection is unenforced today).

If the project grows to multiple maintainers, the recommended per-area
ownership baseline is:

| Area                        | Minimum reviewers |
| --------------------------- | ----------------- |
| `packages/best-practices/*` | 1 domain expert   |
| `packages/core/*`           | 1 senior engineer |
| `apps/cli/*`                | 1 senior engineer |
| `apps/mcp-server/*`         | 1 senior engineer |
| `.github/workflows/*`       | 1 security owner  |
| `scripts/audit-*.ts`        | 1 security owner  |
| `homebrew/assignee.rb`      | 1 security owner  |
| `CODEOWNERS`                | 1 security owner  |

## Required status checks

The following CI **jobs** would be configured as required status checks in
branch protection before any merge to `main` is allowed. GitHub
branch-protection's required-status-checks API operates on **job names**
(not step names): a single failed step inside a job marks the job red,
and the job-name is what is configured as the required check. Step
names are not enforceable identifiers in GitHub branch protection.

| Required job (status-check name) | Workflow file     | Notable steps inside the job                                                                 |
| -------------------------------- | ----------------- | -------------------------------------------------------------------------------------------- |
| `ci (ubuntu-latest / node 20)`   | `ci.yml`          | Delegates to `ci-core.yml` (lint, format, type-check, build, tests with coverage, doc lints) |
| `ci (ubuntu-latest / node 22)`   | `ci.yml`          | Same as above on Node 22                                                                     |
| `audit-scripts (security lints)` | `ci-security.yml` | All eight audit scripts (see "Audit scripts inventory" below)                                |

The `ci` jobs in `ci.yml` reuse the `ci-core.yml` workflow, so all
`ci-core.yml` steps (lint, format, type-check, build, citation-lint,
doc-lint, action-pin audit, secrets-inherit audit, overrides
rationale audit, `pnpm audit`, NOTICE freshness, build, BP-rule
validation, tests with coverage, coverage merge) run inside the `ci`
job. Failure of any step turns the parent job red and blocks the
merge.

### Audit scripts inventory (inside `audit-scripts` job)

The `audit-scripts (security lints)` job in `ci-security.yml:35-105`
runs the following steps in sequence; any one of them failing turns
the whole job red:

1. `audit-codeowners` — lints repo-root `CODEOWNERS` for syntactic
   validity and a global catch-all (`scripts/audit-codeowners.ts`).
2. `audit-homebrew-pin (--check-template)` — validates
   `homebrew/assignee.rb` uses `${SHA_*}` envsubst placeholders and
   contains no hardcoded SHA256 values.
3. `audit-iam-policies` — cross-checks generated operator/reader/
   auditor policies against `getRequiredIamActions()` for every
   supported resource type.
4. `audit-no-suppress` — scans `.github/actions/*/action.yml` for
   `|| true` masking immediately after `assignee` invocations.
5. `audit-placeholder-account-ids` — scans
   `packages/core/src/resource-plugins/plugins/**/*.ts` for the
   AWS-docs denylisted placeholder account ID `123456789012` so
   wizard hints stay aligned with the placeholder-ARN preflight
   guard.
6. `audit-patterns-cleartext` — scans
   `~/.assignee/memory/patterns.json` (when present) for
   credential-like strings using the `SENSITIVE_KEY_NAMES`
   allowlist.

Two further audit lints run inside the parallel `ci-core.yml`
workflow rather than inside `audit-scripts` itself:

7. `audit-action-pins` — verifies every `uses:` line in
   `.github/workflows/*.yml` is pinned to a 40-character commit SHA
   (`scripts/audit-action-pins.ts`).
8. `audit-secrets-inherit` — verifies reusable workflows that need
   `secrets:` declare them via `secrets: inherit` rather than
   leaking the parent context implicitly.

In aggregate the `audit-scripts (security lints)` job + the audit
steps in `ci (ubuntu-latest / node 22)` cover the eight repository-
hardening lints listed above.

## Branch protection settings

Once the project has multiple maintainers, the following settings should be
enabled on the `main` branch via the GitHub repository settings UI
(Settings → Branches → Branch protection rules):

```
Branch name pattern: main
  [x] Require a pull request before merging
      [x] Require approvals: 1 (single-maintainer) / 2 (multi-maintainer)
      [x] Dismiss stale pull request approvals when new commits are pushed
      [x] Require review from Code Owners
  [x] Require status checks to pass before merging
      [x] Require branches to be up to date before merging
      Required checks: (see table above)
  [x] Require conversation resolution before merging
  [x] Do not allow bypassing the above settings
  [ ] Allow force pushes  ← MUST remain OFF
  [ ] Allow deletions     ← MUST remain OFF
```

## Manual enable steps

Branch protection cannot be set by code in this repository — it requires
admin access to the GitHub org. Once a multi-maintainer setup is in place:

1. Go to `Settings → Branches` in the GitHub repository.
2. Click **Add rule** (or edit the existing rule for `main`).
3. Enter `main` as the branch name pattern.
4. Enable all settings from the table above.
5. Add the required status checks by name (they must have run at least once
   for GitHub to recognise them).
6. Click **Save changes**.

To verify via the GitHub API (requires a personal access token with
`repo` scope):

```sh
gh api repos/<owner>/<repo>/branches/main/protection \
  --jq '{required_reviewers: .required_pull_request_reviews.required_approving_review_count, required_checks: [.required_status_checks.contexts[]]}'
```

Expected output once configured for a single-maintainer project
(the `required_checks` strings are GitHub job names, not step names):

```json
{
  "required_reviewers": 1,
  "required_checks": [
    "ci (ubuntu-latest / node 20)",
    "ci (ubuntu-latest / node 22)",
    "audit-scripts (security lints)"
  ]
}
```

## CI lint: CODEOWNERS integrity

`scripts/audit-codeowners.ts` is run in CI to assert:

1. `CODEOWNERS` exists at the repository root.
2. Every line is valid (either a comment, blank, or a `<pattern> @<handle>` entry).
3. The global catch-all (`* @<handle>`) is present.

This check fires in CI but does NOT verify the GitHub-side branch-protection
configuration (that requires API access with admin tokens, which CI does not
hold). The branch-protection setup is an ops task documented in the section
above and is not active for this course-submission build.

## Industry context

Required-review and required-status-checks are an industry-standard practice
for production codebases. They are documented here as design intent for any
future productisation; they are not active controls in the current
course-submission build.
