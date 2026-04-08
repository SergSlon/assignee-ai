# GitHub Actions workflows

This directory holds the CI and E2E pipelines for Assignee.ai.

## Active workflows

### `ci.yml` — Pull request + main branch CI

Runs on every pull request and every push to `main`. Executes:

1. `pnpm install --frozen-lockfile`
2. `pnpm lint` (all 4 packages at `--max-warnings 0`)
3. `pnpm check-types`
4. `pnpm turbo build`
5. `pnpm turbo test:coverage`
6. Merges coverage summaries and updates the coverage badge on `main`
7. Uploads coverage HTML reports as an artifact

All tests run in **hermetic mode** — the `RUN_E2E` gate is not set, so
the 22 real-AWS specs in `apps/cli/src/e2e/e2e-plan.test.ts` are
skipped. The rest of the monorepo test suite (~5,500 tests) runs in
full and does not touch AWS.

### `nightly-e2e.yml` — Nightly real-AWS E2E

Closes NFR concern T-2.3 from
[`docs/nfr-assessment-2026-04-08.md`](../../docs/nfr-assessment-2026-04-08.md)
— "RUN_E2E only re-runs on operator demand".

**Schedule:** daily at 03:00 UTC. Also supports `workflow_dispatch`
for manual runs from the Actions UI.

**Required secrets** (set via repo Settings → Secrets and variables →
Actions). These credentials **must** come from a dedicated test AWS
account, not the production or day-to-day account — the suite creates
and destroys real resources, and a misconfigured run could leak a few
dollars of EIP or NAT Gateway cost.

| Secret name                                   | Purpose                                                                 |
| --------------------------------------------- | ----------------------------------------------------------------------- |
| `ASSIGNEE_NIGHTLY_OPERATOR_ACCESS_KEY_ID`     | Operator IAM user access key (Bedrock + CCAPI provisioning).            |
| `ASSIGNEE_NIGHTLY_OPERATOR_SECRET_ACCESS_KEY` | Operator IAM user secret.                                               |
| `ASSIGNEE_NIGHTLY_READER_ACCESS_KEY_ID`       | Reader IAM user access key (MCP read-only: CFN schemas, pricing).       |
| `ASSIGNEE_NIGHTLY_READER_SECRET_ACCESS_KEY`   | Reader IAM user secret.                                                 |
| `ASSIGNEE_NIGHTLY_AUDITOR_ACCESS_KEY_ID`      | Auditor IAM user access key (MCP read-only: IAM simulate, SecurityHub). |
| `ASSIGNEE_NIGHTLY_AUDITOR_SECRET_ACCESS_KEY`  | Auditor IAM user secret.                                                |

**How to provision the secrets:**

1. In the nightly test AWS account, run `assignee setup` from a trusted
   workstation. This creates the 3 IAM users (operator/reader/auditor)
   and writes their access keys to `.env`.
2. Copy each of the 6 `ASSIGNEE_*_ACCESS_KEY_ID` and
   `ASSIGNEE_*_SECRET_ACCESS_KEY` values from `.env` into the
   corresponding `ASSIGNEE_NIGHTLY_*` secret in GitHub.
3. Verify by triggering a manual `workflow_dispatch` run and confirming
   the "Verify nightly secrets are configured" step passes.

**Fail-fast on missing secrets:** the first step of the job asserts
that all 6 credentials are present and exits with a clear error
pointing at this README if any are missing. A silent skip would mean
the gate passes every night without actually running anything — the
exact failure mode T-2.3 is trying to prevent.

**Leak detection:** after the test suite finishes, the workflow runs
`assignee list --all --json` against the nightly account and fails
the job if any Assignee-managed resources are still present. The
`feedback_assignee_infra_safety_allowlist` protected infra (the 3
Assignee\* IAM policies and the `AssigneeAiBedrockLoggingRole`) is
intentionally excluded from `list` output, so a non-empty result
means genuine leakage.

**Logs on failure:** the workflow uploads `~/.assignee/logs/` and any
vitest test-results output as an artifact named
`nightly-e2e-logs-<run-number>` with 30-day retention. Use these for
post-mortem on failed nights.

## Disabled workflows

These `.disabled` files are kept in-repo as templates. To enable them,
rename the file to drop the `.disabled` suffix.

### `release.yml.disabled`

Gated on the "tool approved for public artifacts" decision
(`feedback_no_public_artifacts` memory). Not active until the project
owner authorises public npm publishes.

### `test-actions.yml.disabled`

Legacy manual test harness predating `ci.yml`. Kept for historical
reference; will be deleted once no one remembers what it was for.
