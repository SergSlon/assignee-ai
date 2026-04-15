# Commands Reference

All commands follow the pattern: `assignee <command> [args] [options]`

Global options: `--version`, `--help`, `--verbose`

The `--verbose` flag is registered on the root program and must appear **before** the subcommand name (the same rule as `--version` and `--help`):

```bash
assignee --verbose plan "Create an SSM parameter named test"
assignee --verbose apply --yes "Create an S3 bucket named audit-logs"
```

When set, structured JSON diagnostic logs are written to stderr. Without it, info-level logs are suppressed so they never pollute terminal output (`warn`/`error` events are still persisted to `~/.assignee/logs/cli-YYYY-MM-DD.jsonl` regardless). You can also enable verbose output via `ASSIGNEE_LOG_LEVEL=debug` or `ASSIGNEE_VERBOSITY=verbose` environment variables — the CLI flag has the highest priority. See [configuration.md](./configuration.md#--verbose-flag) for the full precedence rules.

> **Note:** `assignee drift` has a local `--verbose` option that controls drift-table verbosity (showing all fields including matching ones). To get JSON diagnostic logs during a drift run, pass the global flag first: `assignee --verbose drift`. Both can be combined: `assignee --verbose drift --verbose`.

## Exit Codes

| Code | Meaning                                                         |
| ---- | --------------------------------------------------------------- |
| 0    | Success                                                         |
| 1    | General error (plan failure, provision failure, drift detected) |
| 10   | MCP server startup failure                                      |

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

| Flag                    | Description                                     | Default |
| ----------------------- | ----------------------------------------------- | ------- |
| `-o, --output <format>` | Output format (`json` or `text`)                | `text`  |
| `--no-apply`            | Skip the "Apply now?" prompt after plan display | false   |
| `--set <key=value...>`  | Pre-set wizard field values (repeatable)        | -       |
| `--source <path>`       | Source directory for static website S3 upload   | -       |

**Behavior:**

- Runs the 13-node pipeline in plan mode (stops before provisioning)
- Saves a checkpoint to `.assignee/checkpoint-<runId>.json` (valid 72h)
- `-o json` outputs structured JSON to stdout (suppresses spinners, prompts, and the "Apply now?" prompt)
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
| `-c, --checkpoint <path>` | Use a saved plan checkpoint instead of re-planning                                                    | -       |
| `--set <key=value...>`    | Pre-set wizard field values (repeatable)                                                              | -       |
| `--source <path>`         | Source directory for static website S3 upload                                                         | -       |

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

| Flag                | Description                                                                               | Default     |
| ------------------- | ----------------------------------------------------------------------------------------- | ----------- |
| `--json`            | Output as JSON array                                                                      | false       |
| `--region <region>` | Filter to a specific AWS region                                                           | all regions |
| `--total-cost`      | Print an estimated monthly total after the table (skips Free / N/A / unparseable entries) | false       |

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

| Flag                | Description                                                                                     | Default     |
| ------------------- | ----------------------------------------------------------------------------------------------- | ----------- |
| `--json`            | Output status data as JSON                                                                      | false       |
| `--region <region>` | Filter to a specific AWS region                                                                 | all regions |
| `--bp-coverage`     | Show BP rule coverage dashboard                                                                 | false       |
| `--gaps-only`       | With `--bp-coverage`: print only the list of resource types with zero rules, exit 1 if any gaps | false       |

**Behavior:**

Fetches all managed resources and aggregates by type and region with cost totals. The `--bp-coverage` flag scans the best-practices rule directory and displays rules per resource type, auto-fix percentages, and coverage gaps.

When `--gaps-only` is set alongside `--bp-coverage`, the full dashboard is replaced with a short "N BP coverage gaps" header followed by the list of resource types that have zero rules, and the command exits with code 1 if any gaps exist. The JSON mode returns only the `{ gaps: [...] }` array for easy CI consumption (`jq 'length'`).

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

Safely destroy a managed AWS resource.

```
assignee destroy <resource> [options]
assignee destroy --all [options]
```

**Arguments:**

| Argument   | Description                                                                            |
| ---------- | -------------------------------------------------------------------------------------- |
| `resource` | Resource ARN or name (must be tagged `managed-by=assignee-ai`). Optional with `--all`. |

**Options:**

| Flag            | Description                                             | Default |
| --------------- | ------------------------------------------------------- | ------- |
| `-y, --yes`     | Auto-confirm without interactive prompt (CI/CD mode)    | false   |
| `--all`         | Destroy all managed resources (bulk destroy)            | false   |
| `--include-iam` | Include IAM roles in bulk destroy (excluded by default) | false   |
| `--dry-run`     | Preview what would be destroyed without making changes  | false   |

**Behavior:**

- **Single resource**: Resolves the resource via the Resource Groups Tagging API, displays resource details (type, ARN, region, estimated cost savings), requires typing "yes" for confirmation (strict confirmation, not Y/n), deletes via CloudControl API and polls for completion
- **Bulk destroy (`--all`)**: Lists all managed resources, orders by tier (compute/storage first, networking/IAM last), destroys in reverse-dependency order. IAM roles are excluded by default (use `--include-iam` to include them). `--dry-run` previews the destruction plan without executing it
- Uses SDK fallback for types with known CloudControl gaps (EventSourceMapping, SNS Subscription)

**Examples:**

```bash
assignee destroy arn:aws:s3:::my-bucket
assignee destroy my-bucket
assignee destroy --yes arn:aws:lambda:us-east-1:123456789012:function:my-fn
assignee destroy --all --dry-run
assignee destroy --all --include-iam --yes
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

| Flag                 | Description                                                                 | Default     |
| -------------------- | --------------------------------------------------------------------------- | ----------- |
| `--resource <type>`  | Filter by resource type                                                     | all types   |
| `--region <region>`  | Filter by AWS region                                                        | all regions |
| `--status <status>`  | Filter by drift status (IN_SYNC, DRIFTED, DELETED, ERROR, BASELINE_MISSING) | all         |
| `--exclude <status>` | Exclude a drift status (e.g. `--exclude BASELINE_MISSING` for CI)           | none        |
| `--baseline`         | Adopt `[resource-id]` into tracking by snapshotting its live CCAPI state    | false       |
| `--json`             | Output as JSON                                                              | false       |
| `--output <file>`    | Write JSON report to file (requires `--json`)                               | stdout      |
| `--concurrency <n>`  | Max parallel drift checks (1-50)                                            | 10          |
| `--no-color`         | Disable color output                                                        | false       |
| `--verbose`          | Show all fields including matching ones                                     | false       |

**Behavior:**

Compares the desired state (from checkpoint files) against the actual state (from CloudControl GetResource). Shows a table with drift status per resource. Exit code 1 if any resource has drifted.

After the drift scan, the provision log is deduped by ARN keeping the newest entry per resource (A3 follow-up fix). This avoids spamming the operator with hundreds of identical `BASELINE_MISSING` rows from past test fixtures.

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
3. Writes a baseline payload to `.assignee/baselines/<slugified-arn>.json` containing the live state, resource type, and an ISO timestamp.
4. Future `assignee drift` runs will find the baseline via the checkpoint fallback in `resolve-desired-state.ts` and compare against it instead of reporting `BASELINE_MISSING`.

Checkpoints still win over baselines — the baseline is a last-resort fallback for resources adopted AFTER they were provisioned. Run `assignee clean --baselines --confirm` to drop adopted baselines.

**Examples:**

```bash
assignee drift
assignee drift arn:aws:s3:::my-bucket
assignee drift --resource AWS::S3::Bucket
assignee drift --status DRIFTED
assignee drift --exclude BASELINE_MISSING  # CI mode: ignore unadopted rows
assignee drift --baseline arn:aws:s3:::adopted-bucket
assignee drift --json --output drift-report.json
assignee drift --concurrency 20
```

### reconcile

Reconcile drifted resources back to desired state.

```
assignee reconcile [options]
```

**Options:**

| Flag                | Description                                          | Default   |
| ------------------- | ---------------------------------------------------- | --------- |
| `--resource <type>` | Filter by resource type                              | all types |
| `--dry-run`         | Show what would be reconciled without making changes | false     |
| `--auto-reconcile`  | Reconcile all drifted resources without prompting    | false     |

**Behavior:**

Runs drift detection, then for each drifted resource presents three choices:

1. **Reconcile** -- update the live resource to match desired state (via CloudControl UpdateResource with JSON Patch)
2. **Accept** -- accept the current live state as the new desired state
3. **Skip** -- leave the resource as-is

**Examples:**

```bash
assignee reconcile
assignee reconcile --dry-run
assignee reconcile --auto-reconcile
assignee reconcile --resource AWS::S3::Bucket
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

| Flag                | Description                                                           | Default      |
| ------------------- | --------------------------------------------------------------------- | ------------ |
| `--region <region>` | AWS region to scan                                                    | `AWS_REGION` |
| `--json`            | Emit recommendations as JSON instead of a table                       | false        |
| `--reconcile`       | Also print suggested `assignee plan` commands for each recommendation | false        |
| `--no-color`        | Disable color output                                                  | false        |

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

**--reconcile output:**

When `--reconcile` is set, the command prints a suggested
reconciliation playbook after the table: one `assignee plan
"Change <resource> from X to Y"` line per recommendation. This does
**not** auto-execute anything — Graviton swaps require AMI rebuild
(for EC2) or RDS snapshot restore on the new instance class, both
mutation-heavy interactive flows that should go through the normal
`plan` → HITL → `apply` pipeline.

In `--json` mode, the playbook surfaces as a `reconcilePlaybook:
string[]` field on the JSON payload so CI pipelines can consume the
machine-readable recommendations and the human-readable action list
from a single invocation.

**Examples:**

```bash
assignee optimize
assignee optimize --json
assignee optimize --reconcile
assignee optimize i-0123456789abcdef0
assignee optimize --json --reconcile --no-color
```

**Sample output:**

```
╭─ Cost Optimization Recommendations ─────────────────────────────────╮
│                                                                     │
│  Resource ID                          Type                  Current       Recommended       Savings            Confidence │
│  ────────────────────────────────────────────────────────────────── │
│  i-0abc...                            AWS::EC2::Instance   t3.large     t4g.large         $11.68/mo (19%)    high       │
│  prod-primary                         AWS::RDS::DBInstance db.r5.large  db.r6g.large      $17.52/mo (10%)    medium     │
│  prod-handler                         AWS::Lambda::Function x86_64      arm64             $33.33/mo* (20%)   medium     │
│                                                                     │
╰─────────────────────────────────────────────────────────────────────╯

3 of 3 resources analyzed, 3 recommendations. Est. total monthly savings: $62.53/mo

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

| Flag       | Description                                         | Default |
| ---------- | --------------------------------------------------- | ------- |
| `--global` | Create global user config instead of project config | false   |

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
- Output format (table/json)
- Verbosity (quiet/normal/verbose)

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
policy. See `packages/core/src/config/iam-policies.ts` for the split
algorithm.

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

### clean

Remove stale checkpoints, expired cache, and rotate memory files.

```
assignee clean [options]
```

**Options:**

| Flag            | Description                                                                      | Default                 |
| --------------- | -------------------------------------------------------------------------------- | ----------------------- |
| `--dry-run`     | Preview cleanup without making changes                                           | true (default behavior) |
| `--confirm`     | Execute cleanup                                                                  | false                   |
| `--yes`         | Alias for `--confirm` (CI-friendly)                                              | false                   |
| `--checkpoints` | Only clean checkpoint files                                                      | false                   |
| `--cache`       | Only clean price cache                                                           | false                   |
| `--memory`      | Only rotate memory files                                                         | false                   |
| `--resources`   | Clean orphaned resource records                                                  | false                   |
| `--logs`        | Prune persistent warn/error logs older than `ASSIGNEE_LOG_RETENTION_DAYS`        | false                   |
| `--baselines`   | Remove all baseline files adopted via `assignee drift --baseline` (A3 follow-up) | false                   |
| `--json`        | Output results as JSON                                                           | false                   |

**Behavior:**

Default is a safe dry-run preview. Cleanup categories:

- **Checkpoints**: removes expired checkpoint files (>72h)
- **Cache**: removes stale price cache entries
- **Memory**: rotates oversized provision/failure/pattern logs
- **Logs**: prunes persistent warn/error logs older than the retention window
- **Baselines**: removes files under `.assignee/baselines/` adopted via `assignee drift --baseline`

The `--baselines` scope runs as a self-contained branch independent of the main cleanup report — it only touches the `.assignee/baselines/` directory under the current project cwd, never walks up to the user home, and never touches checkpoints or the provision log. Missing directory or empty listing prints "No baseline files found (nothing to clean)." and exits cleanly.

**Examples:**

```bash
assignee clean                          # dry-run preview
assignee clean --confirm                # execute cleanup
assignee clean --checkpoints --confirm
assignee clean --baselines --confirm    # drop adopted drift baselines
assignee clean --json --yes             # CI-friendly JSON output
```

### cache

Manage the CloudFormation schema cache.

```
assignee cache <subcommand>
```

**Subcommands:**

| Subcommand | Description                                                 |
| ---------- | ----------------------------------------------------------- |
| `clear`    | Delete all cached schemas                                   |
| `refresh`  | Clear and re-fetch all schemas for supported resource types |

**Examples:**

```bash
assignee cache clear
assignee cache refresh
```

### patterns

Discover the compound architecture patterns assignee can auto-route natural-language intents to. Lists every registered pattern with its display name, resource count, and keyword preview; or shows the full resource list, dependency order, and all keywords for a single pattern.

```
assignee patterns [list|show <patternId>] [options]
```

**Subcommands:**

| Subcommand           | Description                                                                           |
| -------------------- | ------------------------------------------------------------------------------------- |
| `list` (default)     | Print all registered compound patterns in precedence order                            |
| `show <patternId>`   | Print the full resource list + dependency groups + every keyword for a single pattern |
| `detect <intent...>` | Run the same keyword classifier the CLI uses and print which pattern would match      |

**Options:**

| Flag     | Description    | Default |
| -------- | -------------- | ------- |
| `--json` | Output as JSON | false   |

**Behavior:**

Pattern detection is first-keyword-match-wins in registration order, so the `list` output reflects the precedence — earlier-listed patterns get first crack at matching user intents. Use `assignee patterns show <patternId>` to see why a particular pattern matched or to understand the full resource footprint before running `plan`.

**Examples:**

```bash
assignee patterns                               # list all patterns
assignee patterns show scheduled-lambda         # show one pattern's details
assignee patterns show efs-with-vpc --json      # JSON for CI consumers
assignee patterns list --json | jq '.[].patternId'
assignee patterns list --search lambda          # grep-like filter
assignee patterns detect "create a nightly cleanup lambda"
# → Matched: scheduled-lambda — Scheduled Lambda (EventBridge cron)
#   Winning keyword: "nightly cleanup"
```

### types

Discover the CloudFormation resource types assignee can provision directly (companion to `assignee patterns` which covers the compound routing layer).

```
assignee types [list|show <type>] [options]
```

**Subcommands:**

| Subcommand       | Description                                                                       |
| ---------------- | --------------------------------------------------------------------------------- |
| `list` (default) | Print every supported type with short name, plugin field count, and BP rule count |
| `show <type>`    | Print the full plugin field list, BP rules, and pricing info for a single type    |

**Options:**

| Flag                 | Description                                                                             | Default |
| -------------------- | --------------------------------------------------------------------------------------- | ------- |
| `--json`             | Output as JSON                                                                          | false   |
| `--search <keyword>` | Filter types whose resourceType or short name contains the substring (case-insensitive) | -       |
| `--with-bp`          | Only show types that have at least one BP rule                                          | false   |
| `--without-bp`       | Only show types that have zero BP rules                                                 | false   |

**Examples:**

```bash
assignee types                               # list all 28 supported types
assignee types show AWS::Events::Rule        # full detail for one type
assignee types list --json | jq '.[].resourceType'
assignee types show AWS::Lambda::Function --json
assignee types list --search lambda           # filter by keyword
assignee types list --with-bp                 # only types with BP rules
assignee types list --without-bp              # only types missing BP rules
```

### whoami

A fast, single-purpose pre-flight check: prints the operator-role STS identity, AWS region, and whether a project config file is loaded in the cwd. Designed to answer the most common debugging question: "which AWS identity am I about to use?" before running `plan`/`apply`.

```
assignee whoami
```

**Behavior:**

- Reads `ASSIGNEE_OPERATOR_ACCESS_KEY_ID` / `ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY` and calls `sts:GetCallerIdentity` (5 s timeout).
- Resolves the active region from `AWS_REGION` → `AWS_DEFAULT_REGION` → SDK default (`us-east-1`).
- Checks for `./assignee.yaml`, `./assignee.yml`, or `./.assignee/config.yaml` and reports whether one was loaded.
- **Exits non-zero** when credentials are missing or STS fails — safe to chain in shell pipelines (`assignee whoami && assignee plan ...`).
- For deeper diagnostics, use `assignee doctor`.

**Examples:**

```bash
assignee whoami
# Account:  123456789012
# User ARN: arn:aws:iam::123456789012:user/assignee-operator
# Region:   us-east-1
# Role:     operator (ASSIGNEE_OPERATOR_ACCESS_KEY_ID)
# Config:   ./assignee.yaml (loaded)
#
# For full diagnostics, run `assignee doctor`.
```

### doctor

A non-destructive end-to-end health check (think `flutter doctor` / `brew doctor`). Runs every check, prints results in column form, and exits non-zero if anything failed. Doctor never mutates state — every check is read-only.

```
assignee doctor [options]
```

**Options:**

| Flag                       | Description                                              | Default |
| -------------------------- | -------------------------------------------------------- | ------- |
| `--json`                   | Emit the report as JSON instead of formatted text        | false   |
| `--skip-bedrock`           | Skip the LLM invoke check (offline / hermetic CI)        | false   |
| `--skip-mcp`               | Skip the MCP server launch probe (offline / hermetic CI) | false   |
| `--skip-mcp-version-check` | Skip the PyPI version drift check (offline / fast path)  | false   |

**Checks (each capped at 5 s):**

1. **Credentials** — for each of `operator` / `reader` / `auditor`: env-var presence, access-key shape (`AKIA…` or `ASIA…`), live `sts:GetCallerIdentity`. Reports the resolved Account + ARN per role.
2. **Bedrock / LLM** — invokes the configured LLM (`ASSIGNEE_MODEL`, defaults to `bedrock/amazon.nova-lite-v1:0`) with the prompt `"hello"`. If `BEDROCK_GUARDRAIL_ID` is set, the guardrail is reported in the section header.
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
    • ✓ awslabs.aws-pricing-mcp-server@1.0.6     → launched (uvx)
    • ✓ awslabs.aws-documentation-mcp-server@1.1.1 → launched (uvx)
    • ✓ awslabs.iam-mcp-server@1.0.2             → launched (uvx)
    • ✗ awslabs.well-architected-security-mcp-server@0.1.7 → uvx exited with code 127
    • ✓ awslabs.cost-management-mcp-server@1.0.2 → launched (uvx)
[✓] Cache
    • ✓ /home/u/.assignee → 3.4 MB, 0 stale checkpoints, 14 log files
[✓] Config
    • ✓ ./assignee.yaml → valid YAML
[✓] Best practices
    • ✓ manifest → 185 rules, hash 636a1827cc85… matches

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
