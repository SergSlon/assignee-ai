# Contributing to Assignee.ai

Thanks for your interest in contributing. This document describes how to
land a change, the conventions we follow, and the workflow the project
expects from both human contributors and AI coding agents.

Assignee.ai is pre-1.0 and under active development. The contribution
bar is "make it green on CI and explain the change." We prefer small,
focused commits over large rewrites.

## Quick Start

```bash
git clone https://github.com/assignee-ai/assignee.ai.git
cd assignee.ai
pnpm install           # pnpm >= 9, Node >= 20.11
pnpm build             # compile all 4 packages
pnpm test              # full unit test suite
pnpm -r test:coverage  # CI-parity gate (coverage thresholds enforced)
```

Optional live-integration testing requires AWS credentials — see
[`docs/aws-bootstrap.md`](docs/aws-bootstrap.md) to provision the three
IAM users (`AssigneeOperator`, `AssigneeReader`, `AssigneeAuditor`).

## Repository Layout

```
apps/
  cli/                 — the `assignee` CLI (Commander + LangGraph)
  mcp-server/          — MCP server exposing the pipeline to AI agents
packages/
  core/                — shared ports, schemas, pricing, destroy
                         strategies, checkpoint, testing utilities
  best-practices/      — YAML best-practice rules + manifest hashing
docs/                  — Diátaxis-structured documentation
```

Behavioural rules (the "why this repo does X") live in
[`docs/explanation/invariants.md`](docs/explanation/invariants.md). Read
it before touching ARN handling, destroy paths, credential plumbing, or
the redaction pipeline.

## Branches

- `main` — the only long-lived branch. All work branches from here.
- Feature branches: `feat/<short-kebab-description>` or
  `fix/<short-kebab-description>`.
- Story-driven branches (used by the BMAD workflow below):
  `story/<epic>-<story-id>-<slug>`, e.g. `story/50-8-docs-hygiene`.

## Pull Requests

Open a PR against `main` when the work is green locally:

- **Scope** — one logical change per PR. Splitting cosmetic churn from
  behaviour change makes review faster.
- **Title** — imperative, `<verb> <subject>`. Example: `fix: treat CCAPI
NotFound as destroy success`.
- **Description** — include:
  - What the change does and why (link the driving story / issue).
  - Test plan: which `pnpm test` / `pnpm -r test:coverage` selectors you
    ran and their result.
  - Any cross-package impact (CLI fix that needs mirroring in MCP
    server, or vice versa — see the "Verify across packages" rule in
    `CLAUDE.md`).
  - Screenshots / terminal captures for UX-visible changes.
- **CI must be green** before review — build, full test suite, and
  coverage thresholds.
- **No force-pushes after review starts** unless the reviewer asks for
  one. Prefer fixup commits that reviewers can track.

## Commits

- Prefer the [Conventional Commits](https://www.conventionalcommits.org/)
  prefix for new work (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`,
  `chore:`). Historical commits do not — stay consistent within a PR.
- Keep subject ≤ 72 chars, imperative mood (`add`, not `added`).
- Body explains **why**, not **what** — reviewers can read the diff for
  "what".
- The project does **not** require a DCO sign-off. If that changes, this
  section will be updated and the requirement will gate CI.

## Pre-commit Hooks

`husky` + `lint-staged` run Prettier on staged `*.ts` / `*.tsx` /
`*.json` / `*.md` files. Skipping hooks (`--no-verify`) is discouraged —
if a hook fails, fix the underlying issue and re-stage. Do not bypass
signing or hook enforcement without a maintainer's sign-off.

## Testing

- Every new public function or CLI behaviour needs a test. Prefer
  colocated tests: `foo.ts` ↔ `foo.test.ts`.
- **Never weaken tests** to make them pass. If a test fails, fix the
  underlying code — mocked tests that mask real bugs are worse than no
  tests. See [`docs/testing-guide.md`](docs/testing-guide.md).
- Use real data in mocks — hand-written fixtures that don't match AWS
  responses hide bugs. Check
  `packages/core/src/testing/mock-llm-adapter.ts` for the shared pattern.
- CI runs `pnpm -r test:coverage`. Run it locally before pushing; some
  consistency checks (e.g. `TYPE_TO_KEYWORD` ↔ `SUPPORTED_TYPES_ARRAY`
  in `@assignee/mcp-server`) only fire under coverage.

## Continuous integration

The repo has three workflow files under `.github/workflows/`:

| File                    | Trigger                         | Matrix                                       |
| ----------------------- | ------------------------------- | -------------------------------------------- |
| `ci.yml`                | every push to `main` + every PR | ubuntu-latest × node 22 only                 |
| `ci-cross-platform.yml` | manual (button in Actions UI)   | ubuntu + macOS + windows × configurable node |
| `ci-core.yml`           | reusable (`workflow_call` only) | whatever the caller passes in                |

The split exists for a billing reason: on GitHub's Free plan for
private repos, macOS minutes are billed **10×** Linux and Windows
**2×**. A full 6-cell matrix burns ~390 minutes per push — about 5
pushes exhaust the 2 000 min/month budget. `ci.yml` runs only
ubuntu-latest + node 22 (~15 billed minutes per push, ~130 pushes per
month) and is the authoritative gate. `ci-cross-platform.yml` is for
on-demand sweeps before a release or when a PR touches
cross-platform-sensitive code.

### Running the cross-platform matrix

Use this before releases or when you've touched anything path- /
signal- / shell-dependent (e.g. `s3-upload` backslash handling,
`price-cache` `HOME` vs `USERPROFILE`, `index.ts` signal handlers).

**From the GitHub UI (recommended)**:

1. Navigate to **Actions → CI — cross-platform (manual)**.
2. Click **Run workflow**.
3. Pick the branch (usually `main` or your PR branch).
4. Leave `node-versions` at its default `"22"` for a 3-cell sweep
   (ubuntu + macOS + windows × node 22 — the standard check, ~180
   billed minutes). Change it to `"20,22"` for a full 6-cell sweep
   (~390 billed minutes) when you specifically need to test both
   Node majors.
5. Click **Run workflow**.

**From the CLI**:

```bash
# 3-cell default (node 22)
gh workflow run ci-cross-platform.yml --ref main

# 6-cell sweep (node 20 + 22)
gh workflow run ci-cross-platform.yml --ref main -f node-versions=20,22

# Same on a PR branch
gh workflow run ci-cross-platform.yml --ref your/branch
```

Check status and logs:

```bash
gh run list --workflow ci-cross-platform.yml --limit 5
gh run view <run-id>
gh run watch <run-id>
```

**Cost estimate per run**:

- 3-cell default (node 22): ubuntu 15 min + macOS 15 × 10 = 150 min +
  windows 15 × 2 = 30 min → **~195 billed minutes**.
- 6-cell (node 20 + 22): double that → **~390 billed minutes**.

Check remaining budget: **Settings → Billing → Actions usage** on
your GitHub account page (the API endpoint
`/user/settings/billing/actions` also returns it if your token has
the `read:billing` scope).

### Adjusting the default gate

If you need the default `ci.yml` to include another permutation —
e.g. `node 20` for downstream-consumer parity — bump its `jobs`
section to call `ci-core.yml` twice. Do NOT re-add the full matrix
to the default gate; keep the billing discipline.

## Documentation

- User-facing docs live under `docs/` and follow the
  [Diátaxis](https://diataxis.fr/) framework (Tutorial / How-to /
  Reference / Explanation). See
  [`docs/index.md`](docs/index.md) for the taxonomy.
- When changing CLI behaviour, update `docs/commands.md` and
  `docs/troubleshooting.md` in the same PR.
- Invariants (load-bearing rules with a single canonical enforcer) go in
  `docs/explanation/invariants.md`. Cite the enforcing code path.

## Security

See [`SECURITY.md`](SECURITY.md). Do not open public issues for
vulnerabilities.

## BMAD Workflow (AI Agent Contributions)

This project uses the BMAD workflow for AI-assisted development. The
rules live in the repo root `CLAUDE.md` and must be followed when an AI
coding agent (Claude Code, Cursor, Windsurf, etc.) lands changes here.

TL;DR for agents:

1. **Never work ad-hoc.** Invoke the correct BMAD skill via the Skill
   tool — `bmad-create-story`, `bmad-dev-story`, `bmad-code-review`. Do
   not spawn generic role-named subagents ("Winston analyses…").
2. **Dev cycle per story**: `bmad-create-story` → `bmad-dev-story` →
   `bmad-code-review`. Loop on review findings.
3. **Parallel subagents** must own non-overlapping file sets AND not run
   simultaneous full-coverage suites. See the "Parallel subagent
   execution" section of `CLAUDE.md` for the two hard constraints.
4. **Sprint management** goes through `bmad-sprint-planning` /
   `bmad-sprint-status` / `bmad-correct-course`, not ad-hoc todo lists.
5. **Research** uses `bmad-technical-research`, `bmad-market-research`,
   `bmad-domain-research` — not ad-hoc subagents with role names.

Human contributors can ignore the BMAD workflow and open standard PRs.

## Contributing a Best-Practice Rule

The 185 shipped BP rules ([`packages/best-practices/`](packages/best-practices))
are YAML files, not TypeScript. That means you can add a new rule with no
build step and no schema class — drop a file in the right directory, the
CI gate validates it.

### Where rules live

Each rule is one YAML file under `packages/best-practices/<service>/`.
Service directories match AWS service names (`s3/`, `ec2/`, `iam/`,
`rds/`, `efs/`, etc.). The full list is visible in the [package
README](packages/best-practices/README.md).

A minimal rule file:

```yaml
id: BP-EFS-010
title: "EFS file system should enforce KMS encryption at rest"
severity: CRITICAL
resource_type: "AWS::EFS::FileSystem"
property_path: "KmsKeyId"
check_type: "exists"
expected_value: true
source: "AWS Well-Architected Security Pillar"
category: security
lastVerified: "2026-04-16"
description: "Encrypted EFS file systems keep data at rest protected by a customer-managed KMS key."
remediation: "Set KmsKeyId to the ARN of a customer-managed KMS key before creating the file system."
consequence: "Unencrypted EFS allows an attacker with file-system-level access to read all stored data."
autoFixable: false
```

### Rule schema

Every rule is validated against [`packages/best-practices/src/schema.ts`](packages/best-practices/src/schema.ts)
(Zod schema `bestPracticeSchema`). Required fields:

| Field            | Type       | Rule                                                                                                                       |
| ---------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------- |
| `id`             | string     | Must match `^BP-[A-Z0-9]+-\d{3}$` — e.g. `BP-S3-007`. Unique across the library.                                           |
| `title`          | string     | Short human-readable summary.                                                                                              |
| `severity`       | enum       | `CRITICAL`, `HIGH`, `MEDIUM`, or `INFO` (see `BP_SEVERITY` in [`types.ts`](packages/best-practices/src/types.ts)).         |
| `resource_type`  | string     | CloudFormation type (`AWS::<Service>::<Resource>`). Used as the trigger filter.                                            |
| `property_path`  | string     | Dotted path into the resource's CFN properties (e.g. `Encryption.ServerSideEncryptionConfiguration`).                      |
| `check_type`     | enum       | `equals`, `not_equals`, `exists`, `not_exists`, `contains`, `not_contains`, `policy_antipattern`, … (see `BP_CHECK_TYPE`). |
| `expected_value` | any        | The value/pattern the check expects. Semantics depend on `check_type`.                                                     |
| `source`         | string     | Where the rule came from — "AWS Security Hub FSBP", "Well-Architected", "AWS Config", internal runbook, etc.               |
| `category`       | enum       | `security`, `cost`, `cost_optimization`, `reliability`, `performance`, `compliance` (see `BP_CATEGORY`).                   |
| `lastVerified`   | YYYY-MM-DD | Date the rule was last reviewed against current AWS behavior. Bump whenever you touch the rule.                            |

Optional fields that unlock auto-fix and interactive remediation:

- `autoFixable: true` + `desiredStatePatch: { … }` — the pre-apply BP
  engine silently merges the patch before the typed-name confirm.
- `fixType: "auto" | "interactive"` — explicit fix UX. `interactive`
  requires a populated `interactiveOptions` array (see the schema for
  `PROMPT_VALUE` / `SET_VALUE` / `REMOVE_PROPERTY` / `SKIP`).
- `triggers`, `excludePatterns`, `condition` — advanced filters. Read
  the existing `ec2/` and `s3/` rules for real examples.

### ID naming convention

`BP-<SERVICE>-<NNN>`:

- `<SERVICE>` — uppercase short AWS service code (`EC2`, `S3`, `IAM`,
  `RDS`, `EFS`, `SQS`, …). Use the same short code as the directory
  name.
- `<NNN>` — three-digit zero-padded sequence, monotonically increasing
  per service. Pick the next free number by listing the directory:

  ```bash
  ls packages/best-practices/efs/ | sort
  ```

Compound-pattern rules (checks that span multiple resources) use a
service-prefix-plus variant — e.g. `BP-S3BP-001` for S3 BucketPolicy
patterns. Match existing neighbours when in doubt.

### Workflow

1. **Pick the service directory** that matches the resource type. Create
   it if it doesn't exist (and add the directory to the
   [package README's service table](packages/best-practices/README.md)).
2. **Add the YAML file** — one rule per file, filename matches the `id`.
3. **Regenerate the manifest**:

   ```bash
   pnpm --filter=@assignee/best-practices run generate-manifest
   ```

   This updates `packages/best-practices/manifest.json` (SHA-256 hashes
   of every rule file, used for release-time drift detection).

4. **Run the validator** locally before pushing:

   ```bash
   pnpm --filter=@assignee/best-practices build
   npx tsx packages/best-practices/scripts/validate.ts
   ```

   Exit 0 means schema conformance, unique IDs, and manifest freshness
   all pass. Diagnostics print to stderr with `<file>:<rule-id>: <reason>`.
   The same checks run under `pnpm test` via
   `__tests__/validate-bp-rules.test.ts` and
   `__tests__/manifest-freshness.test.ts`, so CI will catch anything
   you miss locally.

5. **Add an evaluation fixture** if your rule's logic is non-trivial —
   see the `__tests__/fixtures/` directory and
   [`__tests__/evaluate.test.ts`](packages/best-practices/__tests__/evaluate.test.ts)
   for the pattern. Fixtures prove the trigger fires on known-bad
   state and stays silent on known-good state.
6. **Open a PR** using [`.github/PULL_REQUEST_TEMPLATE.md`](.github/PULL_REQUEST_TEMPLATE.md).
   Include the rule ID, severity rationale, and a link to the AWS
   documentation or Security Hub control the rule implements.

### CI gates

Two automated checks run on every PR that touches `packages/best-practices/`:

- `__tests__/validate-bp-rules.test.ts` — schema conformance + ID
  uniqueness (synthetic fixtures).
- `__tests__/manifest-freshness.test.ts` — `manifest.json` hash matches
  the live tree. If it fails, you forgot step 3 above.

### Worked example

For an end-to-end walkthrough — from "I want to enforce KMS on EFS" to
a merged rule — see [docs/explanation/contributing-a-bp-rule.md](docs/explanation/contributing-a-bp-rule.md).

## Code of Conduct

Participation in this project is governed by the
[`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md) based on the Contributor
Covenant. By participating, you agree to uphold it.

## License

By contributing, you agree that your contributions will be licensed
under the [MIT License](LICENSE) that covers the project.
