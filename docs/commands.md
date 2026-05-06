---
diataxis: reference
canonical: true
---

> **Diátaxis: Reference** — This is the canonical root page for this topic. Lookup-style reference for every CLI command, flag, and exit code.

# Commands Reference

All commands follow the pattern: `assignee <command> [args] [options]`

Global options: `--version`, `--help`, `--verbose`

## Contents

Jump to a command by name. The CLI's full command surface is registered
in [`apps/cli/src/index.ts`](../apps/cli/src/index.ts); the rows below
are the user-facing subset.

| Command                                     | Purpose                                                                  |
| ------------------------------------------- | ------------------------------------------------------------------------ |
| [`plan`](#plan)                             | Generate an infrastructure plan from a natural-language intent           |
| [`apply`](#apply)                           | Provision a previously generated plan via CloudControl                   |
| [`list`](#list)                             | List all resources tagged `managed-by=assignee-ai`                       |
| [`status`](#status)                         | Aggregated metrics + BP coverage dashboard                               |
| [`destroy`](#destroy)                       | Delete a single managed resource (typed-confirmation gate)               |
| [`drift`](#drift)                           | Compare desired vs live state for managed resources                      |
| [`reconcile`](#reconcile)                   | Reconcile drifted resources back to desired state                        |
| [`optimize`](#optimize)                     | Cost-rightsizing recommendations from the Pricing MCP                    |
| [`init`](#init)                             | Initialize project or global configuration                               |
| [`setup`](#setup)                           | Create the three IAM users and policies for least-privilege provisioning |
| [`doctor`](#doctor)                         | Non-destructive end-to-end health check                                  |
| [`completions`](#completions)               | Output shell completion scripts                                          |
| [`audit-verify`](#audit-verify)             | Verify the integrity of the on-disk audit log chain                      |
| [`restore-provisions`](#restore-provisions) | Restore the provision registry from a backup snapshot                    |
| [`version`](#version)                       | Print the CLI's version string                                           |
| [`describe`](#describe)                     | Self-describe blob suitable for bug reports                              |

The `--verbose` flag is registered on the root program and must appear **before** the subcommand name (the same rule as `--version` and `--help`):

```bash
assignee --verbose plan "Create an SSM parameter named test"
assignee --verbose apply --yes "Create an S3 bucket named audit-logs"
```

When set, structured JSON diagnostic logs are written to stderr. Without it, info-level logs are suppressed so they never pollute terminal output (`warn`/`error` events are still persisted to `~/.assignee/logs/cli-YYYY-MM-DD.jsonl` regardless). You can also enable verbose output via `ASSIGNEE_LOG_LEVEL=debug` or `ASSIGNEE_VERBOSITY=verbose` environment variables — the CLI flag has the highest priority. See [configuration.md](./configuration.md#--verbose-flag) for the full precedence rules.

> **Note:** `assignee drift` has a local `--detailed` option that controls drift-table verbosity (showing all fields including matching ones). To get JSON diagnostic logs during a drift run, pass the global flag first: `assignee --verbose drift`. Both can be combined: `assignee --verbose drift --detailed`.

## Exit Codes

| Code  | Meaning                                                                                                                                                                                                                                      |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`   | Success                                                                                                                                                                                                                                      |
| `1`   | General error¹                                                                                                                                                                                                                               |
| `2`   | `assignee doctor` returned warnings only (no hard failures, see `--short`)                                                                                                                                                                   |
| `10`  | Policy / safety abort (typed-confirm mismatch, state guard, preflight rejection, BP block, etc.) — includes `BP_BLOCKED` envelope when a blocking best-practice finding blocks the apply path (see `packages/core/src/constants/errors.ts`)  |
| `11`  | MCP server startup failure                                                                                                                                                                                                                   |
| `12`  | Not implemented — `--target-account` was passed but cross-account provisioning is not yet available. Scripts can detect this code to fall back gracefully without treating it as a general error.                                            |
| `73`  | Usage error — invalid CLI flags / arguments (e.g. unrecognised option, mutually exclusive flags). Surfaces as `USAGE_ERROR` from `packages/core/src/constants/errors.ts:27`. Distinct from exit `1` so scripts can branch on parse failures. |
| `130` | Interrupted via SIGINT (Ctrl-C)                                                                                                                                                                                                              |
| `143` | Terminated via SIGTERM                                                                                                                                                                                                                       |

¹ Plan failure, provision failure, or — from `assignee drift` — drift
detected. The drift case is the **designed outcome** of the `drift`
command, not a bug: exit 1 simply signals that at least one managed
resource diverged from state. Scripts branching on exit codes should
treat drift as a first-class signal, not an error. See
[troubleshooting.md](./troubleshooting.md#symptom-assignee-drift-exits-1)
for the full discussion.

`docs/troubleshooting.md` is the canonical playbook for each exit
code, including the recovery steps. Scripts MAY branch on these codes;
the contract is stable.

---

## Provision Workflow

### plan

Generate an infrastructure plan from natural language intent.

```
assignee plan [intent] [options]
```

**Arguments:**

| Argument | Description                                            |
| -------- | ------------------------------------------------------ |
| `intent` | Natural language description of desired infrastructure |

**Options:**

| Flag                    | Description                                                                                           | Default |
| ----------------------- | ----------------------------------------------------------------------------------------------------- | ------- |
| `-o, --output <format>` | Output format (`json` or `text`)                                                                      | `text`  |
| `--json`                | Shortcut for `-o json` (mutually exclusive with `-o`)                                                 | false   |
| `--no-apply`            | Skip the "Apply now?" prompt after plan display                                                       | false   |
| `--no-advice`           | Skip the cost-advice / advisory MCP enrichment phase                                                  | false   |
| `-y, --yes`             | Auto-accept the "Apply now?" prompt (CI/CD mode)                                                      | false   |
| `-q, --quick`           | Quick mode — skip optional MCP enrichment for a faster pipeline                                       | false   |
| `--wizard`              | Force the interactive configuration wizard even when defaults could be auto-selected from intent      | false   |
| `--set <key=value...>`  | Pre-set wizard field values (repeatable)                                                              | -       |
| `--source <path>`       | Source directory for static website S3 upload                                                         | -       |
| `--target-account <ID>` | **Not yet implemented** — reserved for future cross-account provisioning. Exits with code `12` today. | -       |

**Behavior:**

- Runs the LangGraph pipeline (see [`packages/core/src/graph/create-graph.ts`](../packages/core/src/graph/create-graph.ts)) in plan mode (stops before provisioning)
- Saves a checkpoint to `.assignee/checkpoint-<runId>.json` (valid 72h)
- `-o json` (or `--json`) outputs structured JSON to stdout (suppresses spinners, prompts, and the "Apply now?" prompt)
- If preflight passes and `--no-apply` is not set, prompts "Apply now?"
- Accepting the prompt transitions directly to provisioning without re-running the plan or re-confirming (auto-approved on checkpoint resume)
- `--set` pre-fills wizard fields, skipping their interactive prompts (e.g., `--set BucketName=my-bucket --set Tags=env:prod`)

**Examples:**

```bash
assignee plan "Create an S3 bucket named my-bucket"
assignee plan "Create an EC2 t3.micro instance"
assignee plan "Create a Lambda function for image processing"
assignee plan --no-apply "Create a VPC with public and private subnets"
assignee plan -o json "Create a DynamoDB table named users" | jq .
assignee plan --set BucketName=my-logs "Create an S3 bucket"
# Compound patterns — auto-detected from the intent
assignee plan "Create an EFS file system for shared Lambda storage"
assignee plan "Create a scheduled lambda that runs every 5 minutes"
assignee plan --set ScheduleExpression="cron(0 12 * * ? *)" "Create a nightly cleanup lambda"
```

### apply

Execute an infrastructure plan -- provisions real AWS resources.

```
assignee apply [intent] [options]
```

**Arguments:**

| Argument | Description                                                        |
| -------- | ------------------------------------------------------------------ |
| `intent` | Natural language description (optional if checkpoint is available) |

**Options:**

| Flag                      | Description                                                                                           | Default |
| ------------------------- | ----------------------------------------------------------------------------------------------------- | ------- |
| `--wizard`                | Run interactive configuration wizard (without this flag, defaults are auto-selected from your intent) | false   |
| `-y, --yes`               | Auto-confirm without interactive prompt (CI/CD mode)                                                  | false   |
| `-q, --quick`             | Quick mode — skip optional MCP enrichment for a faster pipeline                                       | false   |
| `--no-advice`             | Skip the cost-advice / advisory MCP enrichment phase                                                  | false   |
| `-o, --output <format>`   | Output format (`json` or `text`)                                                                      | `text`  |
| `--json`                  | Shortcut for `-o json` (mutually exclusive with `-o`)                                                 | false   |
| `-c, --checkpoint <path>` | Use a saved plan checkpoint instead of re-planning                                                    | -       |
| `--set <key=value...>`    | Pre-set wizard field values (repeatable)                                                              | -       |
| `--source <path>`         | Source directory for static website S3 upload                                                         | -       |
| `--target-account <ID>`   | **Not yet implemented** — reserved for future cross-account provisioning. Exits with code `12` today. | -       |

**Behavior:**

- **Phase 1**: Runs the plan pipeline (or loads a checkpoint). Shows the plan, estimates cost, evaluates best practices. Prompts for human confirmation unless `--yes` is set.
- **Phase 2**: Provisioning loop. For single resources, one iteration. For compound patterns, N iterations in dependency order.
- **Auto-detection**: If no intent and no `--checkpoint`, looks for the newest valid checkpoint in `.assignee/` and prompts to reuse it.

**Examples:**

```bash
assignee apply "Create an S3 bucket named my-bucket"
assignee apply --checkpoint .assignee/checkpoint-abc123.json
assignee apply --yes "Create an S3 bucket named logs-prod"
assignee apply --wizard "Create an EC2 t3.micro instance"
assignee apply --set InstanceType=t3.small "Create an EC2 instance"
assignee apply  # auto-detects latest checkpoint
```

---

## Manage Workflow

### list

List all resources managed by assignee.ai.

```
assignee list [options]
```

**Options:**

| Flag                     | Description                                                                               | Default     |
| ------------------------ | ----------------------------------------------------------------------------------------- | ----------- |
| `--json`                 | Output as JSON array                                                                      | false       |
| `--region <region>`      | Filter to a specific AWS region                                                           | all regions |
| `--total-cost`           | Print an estimated monthly total after the table (skips Free / N/A / unparseable entries) | false       |
| `-o, --output <format>`  | Output format (`json` or `text`) — equivalent to `--json` when `json`                     | `text`      |
| `--resource-type <type>` | Filter to a specific CloudFormation type (e.g. `AWS::S3::Bucket`)                         | all types   |

**Behavior:**

Queries the AWS Resource Groups Tagging API for resources tagged with `managed-by=assignee-ai`. Displays a formatted table with resource type, ARN, region, creation date, and estimated monthly cost.

When `--total-cost` is set, the command sums the parseable monthly costs into a footer line. `$X.XX/mo` values are taken as-is; `$X.XXXX/hr` values are multiplied by 730 (the AWS monthly billing convention). Rows with `Free`, `N/A`, `Pay per use`, or `Unavailable` contribute 0. Any other unparseable string is counted separately and the footer shows a "(N resources with non-numeric cost not included)" caveat so the operator knows the total is incomplete.

**Examples:**

```bash
assignee list
assignee list --json
assignee list --region us-west-2
assignee list --total-cost
assignee list --json | jq '.[].ResourceARN'
```

### status

Show summary of managed infrastructure with aggregated metrics.

```
assignee status [options]
```

**Options:**

| Flag                        | Description                                                                                                                    | Default     |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ----------- |
| `--json`                    | Output status data as JSON                                                                                                     | false       |
| `--region <region>`         | Filter to a specific AWS region                                                                                                | all regions |
| `--bp-coverage`             | Show BP rule coverage dashboard                                                                                                | false       |
| `--gaps-only`               | Only meaningful with `--bp-coverage`. Prints just the list of resource types with zero rules, exits 1 if any gaps              | false       |
| `--include-structural-gaps` | Only meaningful with `--bp-coverage --gaps-only`. Includes structural/cross-reference types (RouteTable, etc.) in the gap list | false       |
| `-o, --output <format>`     | Output format (`json` or `text`) — equivalent to `--json` when `json`                                                          | `text`      |
| `--resource-type <type>`    | Filter to a specific CloudFormation type (e.g. `AWS::Lambda::Function`)                                                        | all types   |

**Behavior:**

Fetches all managed resources and aggregates by type and region with cost totals. The `--bp-coverage` flag scans the best-practices rule directory and displays rules per resource type, auto-fix percentages, and coverage gaps.

When `--gaps-only` is set alongside `--bp-coverage`, the full dashboard is replaced with a short "N BP coverage gaps" header followed by the list of resource types that have zero rules, and the command exits with code 1 if any gaps exist. The JSON mode returns only the `{ gaps: [...] }` array for easy CI consumption (`jq 'length'`). Structural/cross-reference types (RouteTable, VPCGatewayAttachment, SubnetRouteTableAssociation, EFS::MountTarget) are excluded from the gap list by default because their BP content lives on child resources — pass `--include-structural-gaps` to surface them.

**Examples:**

```bash
assignee status
assignee status --json
assignee status --region us-east-1
assignee status --bp-coverage
assignee status --bp-coverage --json
assignee status --bp-coverage --gaps-only          # CI gate: fails if any type has 0 rules
assignee status --bp-coverage --gaps-only --json   # machine-readable gap list
```

### destroy

Safely destroy a single managed AWS resource.

```
assignee destroy <resource> [options]
```

**Arguments:**

| Argument   | Description                                                               |
| ---------- | ------------------------------------------------------------------------- |
| `resource` | Resource ARN or name (must be tagged `managed-by=assignee-ai`). Required. |

**Options:**

| Flag                              | Description                                                                                                                   | Default |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------- |
| `-y, --yes`                       | Auto-confirm without interactive prompt (CI/CD mode)                                                                          | false   |
| `--target-account <ID>`           | **Not yet implemented** — reserved for future cross-account provisioning. Exits with code `12` today.                         | -       |
| `--pending-window-in-days <n>`    | KMS key only — soft-delete window before AWS finalises deletion (`AWS::KMS::Key`). Range 7–30                                 | -       |
| `--recovery-window-in-days <n>`   | Secrets Manager only — recovery window before final delete (`AWS::SecretsManager::Secret`). Range 7–30                        | -       |
| `--force-delete-without-recovery` | Secrets Manager only — bypass the recovery window and delete immediately. Mutually exclusive with `--recovery-window-in-days` | false   |
| `-o, --output <format>`           | Output format (`json` or `text`)                                                                                              | `text`  |
| `--json`                          | Shortcut for `-o json`                                                                                                        | false   |

**Behavior:**

- Resolves the resource via the Resource Groups Tagging API, displays resource details (type, ARN, region, estimated cost savings), requires typing the identifier for confirmation (strict typed-name confirmation, not Y/n), deletes via CloudControl API and polls for completion.
- Uses SDK fallback for types that CloudControl cannot model (see [resource-types.md](./resource-types.md#ccapi-fallback-types) for the current redirect list).
- Bulk destroy (`--all` / `--include-iam`) is no longer supported. Delete resources one at a time, or pipe `assignee list --json` through `jq` + a `destroy` loop for scripted sweeps.

**Examples:**

```bash
assignee destroy arn:aws:s3:::my-bucket
assignee destroy my-bucket
assignee destroy --yes arn:aws:lambda:us-east-1:123456789012:function:my-fn
```

---

## Detect Workflow

### drift

Check managed resources for configuration drift.

```
assignee drift [resource-id] [options]
```

**Arguments:**

| Argument      | Description                                          |
| ------------- | ---------------------------------------------------- |
| `resource-id` | Optional. Show detailed drift for a single resource. |

**Options:**

| Flag                    | Description                                                                 | Default     |
| ----------------------- | --------------------------------------------------------------------------- | ----------- |
| `--resource <type>`     | Filter by resource type                                                     | all types   |
| `--region <region>`     | Filter by AWS region                                                        | all regions |
| `--status <status>`     | Filter by drift status (IN_SYNC, DRIFTED, DELETED, ERROR, BASELINE_MISSING) | all         |
| `--exclude <status>`    | Exclude a drift status (e.g. `--exclude BASELINE_MISSING` for CI)           | none        |
| `--baseline`            | Adopt `[resource-id]` into tracking by snapshotting its live CCAPI state    | false       |
| `--json`                | Output as JSON                                                              | false       |
| `-o, --output <format>` | Output format (`json` or `text`)                                            | `text`      |
| `--output-file <file>`  | Write JSON report to file (requires `--json` or `-o json`)                  | stdout      |
| `--concurrency <n>`     | Max parallel drift checks (1-50)                                            | 10          |
| `--detailed`            | Show all fields in the drift table, including matching ones                 | false       |

**Behavior:**

Compares the desired state (from checkpoint files) against the actual state (from CloudControl GetResource). Shows a table with drift status per resource. Exit code 1 if any resource has drifted.

After the drift scan, the provision log is deduped by ARN keeping the newest entry per resource. This avoids spamming the operator with hundreds of identical `BASELINE_MISSING` rows from past test fixtures.

**Drift statuses:**

| Status             | Meaning                                  |
| ------------------ | ---------------------------------------- |
| `IN_SYNC`          | Actual state matches desired state       |
| `DRIFTED`          | One or more fields differ                |
| `DELETED`          | Resource no longer exists in AWS         |
| `ERROR`            | Could not check (permissions, API error) |
| `BASELINE_MISSING` | No checkpoint found for comparison       |

The summary line renders `BASELINE_MISSING` as its own `no-baseline` bucket rather than collapsing it into `errors` — a missing checkpoint is an actionable operator state (run `assignee reconcile` or `drift --baseline`), not a failure.

**`--baseline` adoption flow:**

When `--baseline` is set alongside a positional `<resource-id>` ARN, the command:

1. Infers the CloudFormation resource type from the ARN.
2. Calls CCAPI `GetResource` for the live state.
3. Writes a baseline payload to `~/.assignee/baselines/<slugified-arn>.json` containing the live state, resource type, and an ISO timestamp.
4. Future `assignee drift` runs will find the baseline via the checkpoint fallback in `resolve-desired-state.ts` and compare against it instead of reporting `BASELINE_MISSING`.

Checkpoints still win over baselines — the baseline is a last-resort fallback for resources adopted AFTER they were provisioned. To drop an adopted baseline, delete its file directly from `~/.assignee/baselines/` (there is no dedicated CLI command for this — baselines are plain JSON files keyed by slugified ARN).

**Examples:**

```bash
assignee drift
assignee drift arn:aws:s3:::my-bucket
assignee drift --resource AWS::S3::Bucket
assignee drift --status DRIFTED
assignee drift --exclude BASELINE_MISSING  # CI mode: ignore unadopted rows
assignee drift --baseline arn:aws:s3:::adopted-bucket
assignee drift --json --output-file drift-report.json
assignee drift --concurrency 20
assignee drift --detailed
```

### reconcile

Reconcile drifted resources back to desired state.

```
assignee reconcile [options]
```

**Options:**

| Flag                | Description                                                                                                    | Default   |
| ------------------- | -------------------------------------------------------------------------------------------------------------- | --------- |
| `--resource <type>` | Filter by resource type                                                                                        | all types |
| `--dry-run`         | Show what would be reconciled without making changes                                                           | false     |
| `-y, --yes`         | Non-interactive mode — reconcile every drifted resource without prompting (canonical CI flag)                  | false     |
| `--auto-reconcile`  | _(deprecated alias for `--yes`)_ Retained for backward compatibility; may be removed in a future major version | false     |

**Behavior:**

Runs drift detection, then for each drifted resource presents three choices:

1. **Reconcile** -- update the live resource to match desired state (via CloudControl UpdateResource with JSON Patch)
2. **Accept** -- accept the current live state as the new desired state
3. **Skip** -- leave the resource as-is

Pass `-y` / `--yes` for CI/CD usage to reconcile every drifted resource without prompts. The legacy `--auto-reconcile` flag still works but is deprecated — prefer `--yes`, which matches the idiom used by `assignee apply` and `assignee destroy`.

**Examples:**

```bash
assignee reconcile
assignee reconcile --dry-run
assignee reconcile --yes
assignee reconcile --resource AWS::S3::Bucket --yes
```

### optimize

Scan managed resources for cost-rightsizing opportunities. Read-only —
the command never mutates AWS state. Queries the Pricing MCP server in
parallel for the current instance configuration and a cheaper
alternative, then ranks recommendations by estimated monthly savings.

```
assignee optimize [resource-id] [options]
```

**Arguments:**

| Argument      | Description                                                 |
| ------------- | ----------------------------------------------------------- |
| `resource-id` | Optional ARN or trailing-name to optimize a single resource |

**Options:**

| Flag                    | Description                                                                  | Default      |
| ----------------------- | ---------------------------------------------------------------------------- | ------------ |
| `--region <region>`     | AWS region to scan                                                           | `AWS_REGION` |
| `--json`                | Emit recommendations as JSON instead of a table                              | false        |
| `-o, --output <format>` | Output format (`json` or `text`) — equivalent to `--json` when `json`        | `text`       |
| `--min-savings <usd>`   | Suppress recommendations whose monthly savings fall below this USD threshold | `0`          |
| `--apply`               | Reserved — print the suggested `assignee plan` commands without running them | false        |
| `--resource <type>`     | Restrict the scan to a single CloudFormation type                            | all types    |

**Supported resource types:**

| Type                    | Recommendation                                         | Data source                           |
| ----------------------- | ------------------------------------------------------ | ------------------------------------- |
| `AWS::EC2::Instance`    | Graviton (ARM) family swap — t3/m5/c5 → t4g/m6g/c6g    | Pricing MCP: compute instance hourly  |
| `AWS::RDS::DBInstance`  | Graviton equivalent — db.{r5,m5,c5} → db.{r6g,m6g,c6g} | Pricing MCP: database instance hourly |
| `AWS::Lambda::Function` | x86_64 → arm64 architecture migration                  | Pricing MCP: Lambda-GB-Second + ARM   |

Resources of other types return "no recommendation" (graceful no-op).
Rightsizing for types that need runtime CPU/memory metrics (e.g.
idle load balancers, oversized CloudWatch alarms) is intentionally
out of scope — assignee.ai is plan-time and does not consume
CloudWatch Metrics.

**Behavior:**

1. Enumerates managed resources via the Resource Groups Tagging API
   (scoped by `managed-by=assignee-ai`).
2. For each resource, loads the checkpointed desiredState via the
   same scanner `assignee drift` uses. Resources without a checkpoint
   are silently skipped — the optimizer cannot recommend changes
   without knowing the user's original intent.
3. For EC2/RDS/Lambda resources, queries the Pricing MCP for the
   current configuration and a cheaper alternative in a single
   parallel round-trip.
4. Computes monthly savings at the AWS 730-hours/month billing
   convention (EC2/RDS) or against a canonical 10M GB-second/month
   reference workload (Lambda — percent delta is
   workload-independent, absolute dollar amount scales linearly).
5. Drops recommendations where the savings round to zero.
6. Sorts highest-saving first and renders either a table or JSON.

**All prices come from the Pricing MCP at runtime.** Zero hardcoded
dollar amounts — when the server is unavailable, the recommendation
for that resource is silently skipped and the operator sees "no
recommendation" instead of a stale price.

**Examples:**

```bash
assignee optimize
assignee optimize --json
assignee optimize i-0123456789abcdef0
assignee optimize --json --min-savings 5
```

**Sample output:**

```
╭─ Cost Optimization Recommendations ─────────────────────────────────╮
│                                                                     │
│  Resource ID                          Type                  Current       Recommended       Savings            Confidence │
│  ────────────────────────────────────────────────────────────────── │
│  i-0abc...                            AWS::EC2::Instance   t3.large     t4g.large         <live savings from Pricing MCP> (19%)    high       │
│  prod-primary                         AWS::RDS::DBInstance db.r5.large  db.r6g.large      <live savings from Pricing MCP> (10%)    medium     │
│  prod-handler                         AWS::Lambda::Function x86_64      arm64             <live savings from Pricing MCP>* (20%)   medium     │
│                                                                     │
╰─────────────────────────────────────────────────────────────────────╯

3 of 3 resources analyzed, 3 recommendations. Est. total monthly savings: <sum of live Pricing MCP savings — fetched at plan time via `assignee optimize --json`>

Suggested reconcile commands (copy/paste):
  assignee plan "Change AWS::EC2::Instance i-0abc... from t3.large to t4g.large"
  assignee plan "Change AWS::RDS::DBInstance prod-primary from db.r5.large to db.r6g.large"
  assignee plan "Change AWS::Lambda::Function prod-handler from x86_64 to arm64"
```

The trailing asterisk on the Lambda row flags that the savings figure
is projected against a 10M GB-second/month reference workload — the
real dollar amount scales linearly with actual invocation volume.

The "N of M analyzed" phrasing in the summary line separates the
total resources scanned (via RGTA) from the subset that had a
resolvable checkpoint. When every scanned resource lacks a
checkpoint (common for operators testing `assignee optimize` on
an account with pre-existing unmanaged resources), the summary
instead prints an actionable hint pointing at `assignee plan` and
`assignee drift --baseline <arn>` as the two adoption paths.

---

## Configure Workflow

### init

Initialize project or global configuration.

```
assignee init [options]
```

**Options:**

| Flag                | Description                                                                          | Default   |
| ------------------- | ------------------------------------------------------------------------------------ | --------- |
| `--global`          | Create global user config instead of project config                                  | false     |
| `--profile <name>`  | AWS SSO profile name to resolve credentials from. Honored when `AWS_PROFILE` is set. | `default` |
| `-y, --yes`         | Non-interactive mode — accept all defaults and skip the wizard prompts               | false     |
| `--wizard`          | Force the interactive wizard even when `-y/--yes` would normally skip prompts        | false     |
| `--region <region>` | Pre-fill the default AWS region (skips the region prompt)                            | -         |
| `--auto-fix <mode>` | Pre-fill the auto-fix preference (`ask` / `apply` / `skip`) — skips that prompt      | -         |

**Behavior:**

**Project mode** (default): Creates `.assignee/config.yaml` in the current directory. Interactive wizard prompts for:

- AWS region (auto-detected)
- AWS profile
- Environment (development/staging/production)
- Auto-fix best practices (yes/no)

**Global mode** (`--global`): Creates `~/.config/assignee/config.yaml`. Interactive wizard prompts for:

- Default AWS region
- Tags (key=value pairs)
- Resource naming prefix
- Auto-fix mode (ask/apply/skip)

Both modes prompt before overwriting existing config files. `assignee init` does **not** require AWS credentials — it only writes a local config file. Provision credentials separately with `assignee setup` (or by editing `.env`) before running `plan`/`apply`.

**Examples:**

```bash
assignee init
assignee init --global
```

### setup

Create IAM users and policies for least-privilege credential separation.

```
assignee setup [options]
```

**Options:**

| Flag                    | Description                                                                                                                                                                                                                          | Default |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------- |
| `--profile <profile>`   | AWS CLI profile with admin/root credentials                                                                                                                                                                                          | default |
| `-y, --yes`             | Skip confirmation prompts                                                                                                                                                                                                            | false   |
| `--enable-llm-logging`  | PRIVACY: enable Bedrock invocation text logging to CloudWatch (every prompt and response is captured in plaintext). Default OFF.                                                                                                     | false   |
| `--disable-llm-logging` | PRIVACY: explicitly DISABLE Bedrock invocation text logging. Idempotent fast path — only touches Bedrock's `PutModelInvocationLoggingConfiguration`, does NOT re-run the IAM wizard. Mutually exclusive with `--enable-llm-logging`. | false   |
| `--dry-run`             | Print the plan of IAM users, policies, access keys, and Bedrock logging resources that would be created without calling AWS APIs. Also supported in combination with `--disable-llm-logging` to preview the disable action.          | false   |

**Behavior:**

Creates three IAM users with scoped policies:

| User                | Policies attached                                                                                                                                           | Purpose          |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `assignee-operator` | `AssigneeOperatorPolicy` + `AssigneeOperatorServicesAPolicy` + `AssigneeOperatorServicesBPolicy` (union: Bedrock + CloudControl + service-specific actions) | CLI provisioning |
| `assignee-reader`   | `AssigneeReaderPolicy` (Schema + Pricing + Billing read-only)                                                                                               | MCP reader       |
| `assignee-auditor`  | `AssigneeAuditorPolicy` (IAM Simulate + SecurityHub read-only)                                                                                              | MCP auditor      |

The operator user gets **three** managed policies because the
service-specific action surface would exceed AWS's 6144-byte
per-managed-policy limit if bundled into one. The core policy carries
Bedrock + CCAPI + tagging + XRay + SDK fallback; the Services-A and
Services-B policies each hold a byte-balanced half of the service
actions. All three attach to the same IAM user and AWS evaluates the
union, so behavior is identical to a single hypothetical unlimited
policy. See `packages/core/src/config/iam-policies/` (barrel at `index.ts`,
split-algorithm helpers in `action-collector.ts` + `wildcard-collapser.ts`,
role-specific generators in `operator.ts` / `reader.ts` / `auditor.ts`).

Also sets up Bedrock invocation logging (IAM role, CloudWatch log group, Bedrock logging config).

Access keys are written to `.env` in the current directory. Idempotent -- safe to re-run. Prompts before rotating existing keys.

**Examples:**

```bash
assignee setup
assignee setup --profile admin-user
assignee setup --yes
assignee setup --dry-run                # preview the IAM plan, no AWS calls
assignee setup --enable-llm-logging     # opt in to plaintext Bedrock logs
assignee setup --disable-llm-logging    # turn plaintext Bedrock logs back off (idempotent fast path)
assignee setup --disable-llm-logging --dry-run  # preview the disable action, no AWS calls
```

> NOTE: `--disable-llm-logging` only calls Bedrock's `PutModelInvocationLoggingConfiguration` with `textDataDeliveryEnabled=false`. It does NOT re-create IAM users, policies, access keys, or the CloudWatch log group, and it never writes `.env`. Use it whenever you want to turn LLM body capture off after a previous `assignee setup --enable-llm-logging` run.

### doctor

A non-destructive end-to-end health check (think `flutter doctor` / `brew doctor`). Runs every check, prints results in column form, and exits non-zero if anything failed. Doctor never mutates state — every check is read-only.

```
assignee doctor [options]
```

**Options:**

| Flag             | Description                                                                                              | Default |
| ---------------- | -------------------------------------------------------------------------------------------------------- | ------- |
| `--json`         | Emit the report as JSON instead of formatted text                                                        | false   |
| `--skip-bedrock` | Skip the LLM invoke check (offline / hermetic CI)                                                        | false   |
| `--skip-mcp`     | Skip the MCP server launch probe (offline / hermetic CI)                                                 | false   |
| `--short`        | Fast identity-only summary (STS account + ARN + region + Role + Redact + config path); replaces `whoami` | false   |

**Checks (each capped at 5 s):**

1. **Credentials** — for each of `operator` / `reader` / `auditor`: env-var presence, access-key shape (`AKIA…` or `ASIA…`), live `sts:GetCallerIdentity`. Reports the resolved Account + ARN per role.
2. **Bedrock / LLM** — invokes the configured LLM (`ASSIGNEE_LLM_DEFAULT`, defaults to `bedrock/amazon.nova-lite-v1:0`) with the prompt `"hello"`. If `BEDROCK_GUARDRAIL_ID` is set, the guardrail is reported in the section header.
3. **MCP servers** — launches each pinned MCP server with `--help` to confirm `uvx` can resolve it: pricing, documentation, IAM, well-architected-security, cost-management. Servers whose role credentials are unavailable are reported as warnings (skipped) rather than failures.
4. **Cache** — inspects `~/.assignee/`: total size, oldest checkpoint age, stale checkpoint count (>72 h), log file count.
5. **Config** — looks for `assignee.yaml` / `assignee.yml` / `.assignee/config.yaml` in the cwd and confirms it parses as YAML.
6. **Best practices** — verifies the BP library against `packages/best-practices/manifest.json` (SHA-256 hash match), counts rules, and surfaces freshness.

**Exit codes:**

| Code | Meaning                                      |
| ---- | -------------------------------------------- |
| 0    | All sections green                           |
| 1    | At least one section reported a hard failure |
| 2    | At least one section reported only warnings  |

**Example output:**

```text
Doctor summary (assignee.ai 0.1.0):
[✓] Credentials
    • ✓ operator → AKIA…MPLE → arn:aws:iam::123456789012:user/assignee-operator
    • ✓ reader   → AKIA…E001 → arn:aws:iam::123456789012:user/assignee-reader
    • ✓ auditor  → AKIA…E002 → arn:aws:iam::123456789012:user/assignee-auditor
[✓] Bedrock (us-east-1, model us.amazon.nova-lite-v1:0)
    • ✓ LLM (bedrock/amazon.nova-lite-v1:0) → responded (Hello! How can I help…)
[!] MCP servers (4/5 ok)
    • ✓ awslabs.aws-pricing-mcp-server               → launched (uvx)
    • ✓ awslabs.aws-documentation-mcp-server         → launched (uvx)
    • ✓ awslabs.iam-mcp-server                       → launched (uvx)
    • ✗ awslabs.well-architected-security-mcp-server → uvx exited with code 127
    • ✓ awslabs.billing-cost-management-mcp-server   → launched (uvx)
[✓] Cache
    • ✓ /home/u/.assignee → 3.4 MB, 0 stale checkpoints, 14 log files
[✓] Config
    • ✓ ./assignee.yaml → valid YAML
[✓] Best practices
    • ✓ manifest → <N> rules tracked, hash 636a1827cc85… matches

! 1 failures found.
```

### completions

Output shell completion scripts.

```
assignee completions <shell>
```

**Arguments:**

| Argument | Description                          |
| -------- | ------------------------------------ |
| `shell`  | Shell type: `bash`, `zsh`, or `fish` |

**Examples:**

```bash
eval "$(assignee completions zsh)"    # add to ~/.zshrc
eval "$(assignee completions bash)"   # add to ~/.bashrc
assignee completions fish | source    # Fish shell
```

---

## Audit Workflow

### audit-verify

Verify the integrity of the on-disk audit log chain. Each audit event is HMAC-signed with `ASSIGNEE_AUDIT_KEY`; this command re-derives the chain hash from the beginning of the log and reports the first record (if any) where the chain breaks.

```
assignee audit-verify [options]
```

**Options:**

| Flag                | Description                                                                    | Default                       |
| ------------------- | ------------------------------------------------------------------------------ | ----------------------------- |
| `--json`            | Emit the report as JSON                                                        | false                         |
| `--from <date>`     | Verify only records on or after this ISO-8601 date                             | -                             |
| `--to <date>`       | Verify only records on or before this ISO-8601 date                            | -                             |
| `--log-file <path>` | Verify a specific audit-log file path instead of `~/.assignee/audit/audit.log` | `~/.assignee/audit/audit.log` |

**Behavior:**

Reads `~/.assignee/audit/audit.log` in chronological order. Recomputes the HMAC chain and exits 0 if the chain is intact, exits 1 with a diagnostic line pointing to the first corrupt or missing record if not.

When `ASSIGNEE_AUDIT_KEY` is unset (which causes `assignee` to auto-generate a per-process key on start), the chain **cannot** be verified across process restarts. The command prints a warning in that case and exits 2.

**Examples:**

```bash
assignee audit-verify
assignee audit-verify --json
```

---

## Restore Workflow

### restore-provisions

Restore `~/.assignee/memory/provisions.json` from a backup snapshot under `~/.assignee/backups/`. Useful after moving to a new machine or recovering from accidental deletion of the memory directory.

```
assignee restore-provisions [options]
```

**Options:**

| Flag            | Description                                                                                                     | Default                                         |
| --------------- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `--from <date>` | Restore from the backup whose ISO-8601 date matches `<date>` (e.g. `2026-04-01` → `provisions-2026-04-01.json`) | latest backup file under `~/.assignee/backups/` |
| `--json`        | Emit the restore result as JSON instead of formatted text                                                       | false                                           |

**Behavior:**

1. Looks under `~/.assignee/backups/` for `provisions-<date>.json` files. With `--from <date>` it picks the file matching that date; otherwise it picks the most recent.
2. Before overwriting, the existing `~/.assignee/memory/provisions.json` is moved aside as `provisions.json.bak-<timestamp>` (safety copy — never silently destructive).
3. Replaces `~/.assignee/memory/provisions.json` with the chosen backup file (overwrite-with-safety-copy semantics).

The command does **not** read JSONL from stdin and does not accept a positional path argument — the backup location is canonical (`~/.assignee/backups/`). After restoration, run `assignee drift` to verify the restored baseline is consistent with live state.

**Examples:**

```bash
assignee restore-provisions
assignee restore-provisions --from 2026-04-01
assignee restore-provisions --json
```

---

## Self-Describe

### version

Print the CLI's version string. Registered at `apps/cli/src/index.ts:147-150`.

```
assignee version
```

Outputs the package version of the `assignee` CLI on a single line. No flags. Use `assignee doctor --short` for a richer self-describe blob (account, region, role, redact mode, config path).

### describe

Self-describe blob — prints a compact JSON / text snapshot suitable for bug reports (CLI version, Node version, platform, arch, AWS region, audit-key source). Registered at `apps/cli/src/index.ts:147-150` alongside `version`.

```
assignee describe
```

The describe output is the canonical artefact to attach to a bug report — it captures every detail the maintainer needs to reproduce environment-specific issues without having to ask follow-up questions.
