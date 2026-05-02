# CODEOWNERS and Branch Protection Policy

<!-- W9-02 (P020 + P065 → L4-S07 + L1-F14 + L6-F19) -->
<!-- SOC 2 CC8.1 / ISO 27001 A.6.3 control baseline -->

This document describes the code-ownership policy for the `assignee.ai`
repository and the GitHub branch-protection settings required to enforce it.

## Overview

The `CODEOWNERS` file at the repository root assigns review requirements per
path. GitHub enforces these requirements when branch protection is enabled on
`main`. Every pull request must receive at least one approved review from the
code owner for the files it touches before merging.

## Ownership model

### Pre-KT (current state)

All files are owned by `@founder`. This is the `* @founder` catch-all at the
top of `CODEOWNERS`. One approved review from `@founder` is required for every
PR.

### Post-KT (knowledge transfer to acquiring team, out of scope for W9)

After knowledge transfer, per-area ownership lines in `CODEOWNERS` should be
uncommented and updated with the acquiring team's GitHub handles. The
recommended minimum is:

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

**Target post-KT**: ≥ 2 required reviewers on `main` for high-sensitivity
paths (workflows, audit scripts, release manifest, CODEOWNERS itself).

## Required status checks

The following CI checks must be configured as **required status checks** in
branch protection before any merge to `main` is allowed:

| Check               | Workflow / script                         |
| ------------------- | ----------------------------------------- |
| `build`             | `ci.yml` → turbo build                    |
| `test`              | `ci.yml` → turbo test                     |
| `coverage`          | `ci-core.yml` → test:coverage             |
| `lint`              | `ci.yml` → turbo lint                     |
| `citation-lint`     | `ci.yml` → `pnpm citation-lint`           |
| `audit-action-pins` | `ci.yml` → `scripts/audit-action-pins.ts` |
| `audit-no-suppress` | `ci.yml` → `scripts/audit-no-suppress.ts` |

## Branch protection settings

The following settings must be enabled on the `main` branch via the GitHub
repository settings UI (Settings → Branches → Branch protection rules):

```
Branch name pattern: main
  [x] Require a pull request before merging
      [x] Require approvals: 1 (pre-KT) / 2 (post-KT)
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
admin access to the GitHub org. Perform these steps once after the repo
is transferred to the acquiring org:

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
gh api repos/SergSlon/assignee-ai/branches/main/protection \
  --jq '{required_reviewers: .required_pull_request_reviews.required_approving_review_count, required_checks: [.required_status_checks.contexts[]]}'
```

Expected output pre-KT:

```json
{
  "required_reviewers": 1,
  "required_checks": [
    "build",
    "test",
    "coverage",
    "lint",
    "citation-lint",
    "audit-action-pins",
    "audit-no-suppress"
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
hold). The branch-protection setup is an acquirer-side ops task documented in
the section above.

## Compliance references

- **SOC 2 CC8.1** — Change management: all production changes require peer
  review before deployment.
- **ISO 27001 A.6.3** — Awareness, education and training: code owners are
  responsible parties for their areas.
