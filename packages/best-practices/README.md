# @assignee/best-practices

YAML-defined best-practice rules for AWS resources, plus the loader, schema, evaluator, and integrity checker that power Assignee.ai's BP enforcement.

## What this package is

A self-contained rules library with **185 rules** across 22 AWS service directories (`apigateway/`, `autoscaling/`, `cloudfront/`, `cloudwatch/`, `dynamodb/`, `ec2/`, `ecr/`, `ecs/`, `efs/`, `elbv2/`, `events/`, `iam/`, `kms/`, `lambda/`, `logs/`, `rds/`, `s3/`, `secretsmanager/`, `sns/`, `sqs/`, `ssm/`, `vpc/`). Each directory contains YAML files — one per best practice. The `src/` directory ships the tiny TypeScript runtime that loads, validates, and evaluates those files.

## Architectural role

BP rules are declarative data, not code. Keeping them in a dedicated package means:

- The CLI, MCP server, and any future consumer evaluate the same rules against the same plan shape.
- Rule authors edit YAML without touching TypeScript.
- A generated `manifest.json` (built via `pnpm generate-manifest`) lets consumers detect drift, check freshness, and verify integrity of the shipped rule set.

Rules are consumed at plan time by `apps/cli` to flag warnings, suggest auto-fixes, and — at `BPEnforcementLevel.block` — refuse unsafe plans.

## Public API

Exported from `src/index.ts`:

- **`loadBestPractices(dir?)`** — walk the package, parse every YAML rule, and return a typed `BestPractice[]`. Throws `BPSchemaError` on malformed rules. Honors `SKIP_DIRS`.
- **`evaluateTriggers(bp, ctx)`** — evaluate a rule's `triggers` against an `EvalContext` (resource type + properties) and return whether the rule fires.
- **`bestPracticeSchema`** — the Zod schema every rule file must satisfy.
- **Integrity helpers** — `computeManifest`, `verifyManifest`, `computeFreshness`, `DEFAULT_STALE_THRESHOLD_DAYS`, and the `BPManifest` / `BPFreshness` / `ManifestVerifyResult` types.
- **Rule types** — `BestPractice`, `BPFinding`, `BPSeverity`, `BPCategory`, `BPCheckType`, `Trigger`.
- **Enums and constants** — `BP_SEVERITY`, `BP_CATEGORY`, `BP_CHECK_TYPE`, `BP_FIX_TYPE`, `Severity`, `FixType`, `FixAction`.

The `./manifest.json` subpath export exposes the pre-built rule manifest for offline verification.

## Developing

From the repo root:

```bash
pnpm install
pnpm --filter @assignee/best-practices build
pnpm --filter @assignee/best-practices test
pnpm --filter @assignee/best-practices generate-manifest   # refresh manifest.json
```

The full CI gate is `pnpm build && pnpm test` from the repo root. To add a new rule, drop a YAML file under the matching service directory and regenerate the manifest — the test suite will validate the schema automatically.

## Where to read more

- [docs/best-practices.md](../../docs/best-practices.md) — authoring guide, trigger language, severity ladder, enforcement levels
- [AUTOFIX-PATTERNS.md](./AUTOFIX-PATTERNS.md) — conventions for rules that emit auto-fixes
- [docs/architecture.md](../../docs/architecture.md) — where BP evaluation sits in the LangGraph pipeline
