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

- Runs the 12-node pipeline in plan mode (stops before provisioning)
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

| Flag                      | Description                                          | Default |
| ------------------------- | ---------------------------------------------------- | ------- |
| `--no-wizard`             | Skip interactive option prompts, use plugin defaults | false   |
| `-y, --yes`               | Auto-confirm without interactive prompt (CI/CD mode) | false   |
| `-c, --checkpoint <path>` | Use a saved plan checkpoint instead of re-planning   | -       |
| `--set <key=value...>`    | Pre-set wizard field values (repeatable)             | -       |
| `--source <path>`         | Source directory for static website S3 upload        | -       |

**Behavior:**

- **Phase 1**: Runs the plan pipeline (or loads a checkpoint). Shows the plan, estimates cost, evaluates best practices. Prompts for human confirmation unless `--yes` is set.
- **Phase 2**: Provisioning loop. For single resources, one iteration. For compound patterns, N iterations in dependency order.
- **Auto-detection**: If no intent and no `--checkpoint`, looks for the newest valid checkpoint in `.assignee/` and prompts to reuse it.

**Examples:**

```bash
assignee apply "Create an S3 bucket named my-bucket"
assignee apply --checkpoint .assignee/checkpoint-abc123.json
assignee apply --yes "Create an S3 bucket named logs-prod"
assignee apply --no-wizard "Create an EC2 t3.micro instance"
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

| Flag                | Description                     | Default     |
| ------------------- | ------------------------------- | ----------- |
| `--json`            | Output as JSON array            | false       |
| `--region <region>` | Filter to a specific AWS region | all regions |

**Behavior:**

Queries the AWS Resource Groups Tagging API for resources tagged with `managed-by=assignee-ai`. Displays a formatted table with resource type, ARN, region, and tags.

**Examples:**

```bash
assignee list
assignee list --json
assignee list --region us-west-2
assignee list --json | jq '.[].ResourceARN'
```

### status

Show summary of managed infrastructure with aggregated metrics.

```
assignee status [options]
```

**Options:**

| Flag                | Description                     | Default     |
| ------------------- | ------------------------------- | ----------- |
| `--json`            | Output status data as JSON      | false       |
| `--region <region>` | Filter to a specific AWS region | all regions |
| `--bp-coverage`     | Show BP rule coverage dashboard | false       |

**Behavior:**

Fetches all managed resources and aggregates by type and region with cost totals. The `--bp-coverage` flag scans the best-practices rule directory and displays rules per resource type, auto-fix percentages, and coverage gaps.

**Examples:**

```bash
assignee status
assignee status --json
assignee status --region us-east-1
assignee status --bp-coverage
assignee status --bp-coverage --json
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

| Flag                | Description                                               | Default     |
| ------------------- | --------------------------------------------------------- | ----------- |
| `--resource <type>` | Filter by resource type                                   | all types   |
| `--region <region>` | Filter by AWS region                                      | all regions |
| `--status <status>` | Filter by drift status (IN_SYNC, DRIFTED, DELETED, ERROR) | all         |
| `--json`            | Output as JSON                                            | false       |
| `--output <file>`   | Write JSON report to file (requires `--json`)             | stdout      |
| `--concurrency <n>` | Max parallel drift checks (1-50)                          | 10          |
| `--no-color`        | Disable color output                                      | false       |
| `--verbose`         | Show all fields including matching ones                   | false       |

**Behavior:**

Compares the desired state (from checkpoint files) against the actual state (from CloudControl GetResource). Shows a table with drift status per resource. Exit code 1 if any resource has drifted.

**Drift statuses:**

| Status             | Meaning                                  |
| ------------------ | ---------------------------------------- |
| `IN_SYNC`          | Actual state matches desired state       |
| `DRIFTED`          | One or more fields differ                |
| `DELETED`          | Resource no longer exists in AWS         |
| `ERROR`            | Could not check (permissions, API error) |
| `BASELINE_MISSING` | No checkpoint found for comparison       |

**Examples:**

```bash
assignee drift
assignee drift arn:aws:s3:::my-bucket
assignee drift --resource AWS::S3::Bucket
assignee drift --status DRIFTED
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

| Flag                   | Description                                                                                                                       | Default |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------- |
| `--profile <profile>`  | AWS CLI profile with admin/root credentials                                                                                       | default |
| `-y, --yes`            | Skip confirmation prompts                                                                                                         | false   |
| `--enable-llm-logging` | PRIVACY: enable Bedrock invocation text logging to CloudWatch (every prompt and response is captured in plaintext). Default OFF.  | false   |
| `--dry-run`            | Print the plan of IAM users, policies, access keys, and Bedrock logging resources that would be created without calling AWS APIs. | false   |

**Behavior:**

Creates three IAM users with scoped policies:

| User                   | Policy                                 | Purpose          |
| ---------------------- | -------------------------------------- | ---------------- |
| `assignee-ai-operator` | Bedrock + CloudControl                 | CLI provisioning |
| `assignee-ai-reader`   | Schema + Pricing + Billing (read-only) | MCP reader       |
| `assignee-ai-auditor`  | IAM Simulate + SecurityHub (read-only) | MCP auditor      |

Also sets up Bedrock invocation logging (IAM role, CloudWatch log group, Bedrock logging config).

Access keys are written to `.env` in the current directory. Idempotent -- safe to re-run. Prompts before rotating existing keys.

**Examples:**

```bash
assignee setup
assignee setup --profile admin-user
assignee setup --yes
assignee setup --dry-run                # preview the IAM plan, no AWS calls
assignee setup --enable-llm-logging     # opt in to plaintext Bedrock logs
```

### clean

Remove stale checkpoints, expired cache, and rotate memory files.

```
assignee clean [options]
```

**Options:**

| Flag            | Description                            | Default                 |
| --------------- | -------------------------------------- | ----------------------- |
| `--dry-run`     | Preview cleanup without making changes | true (default behavior) |
| `--confirm`     | Execute cleanup                        | false                   |
| `--yes`         | Alias for `--confirm` (CI-friendly)    | false                   |
| `--checkpoints` | Only clean checkpoint files            | false                   |
| `--cache`       | Only clean price cache                 | false                   |
| `--memory`      | Only rotate memory files               | false                   |
| `--resources`   | Clean orphaned resource records        | false                   |
| `--json`        | Output results as JSON                 | false                   |

**Behavior:**

Default is a safe dry-run preview. Three cleanup categories:

- **Checkpoints**: removes expired checkpoint files (>72h)
- **Cache**: removes stale price cache entries
- **Memory**: rotates oversized provision/failure/pattern logs

**Examples:**

```bash
assignee clean                    # dry-run preview
assignee clean --confirm          # execute cleanup
assignee clean --checkpoints --confirm
assignee clean --json --yes       # CI-friendly JSON output
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

| Flag             | Description                                              | Default |
| ---------------- | -------------------------------------------------------- | ------- |
| `--json`         | Emit the report as JSON instead of formatted text        | false   |
| `--skip-bedrock` | Skip the LLM invoke check (offline / hermetic CI)        | false   |
| `--skip-mcp`     | Skip the MCP server launch probe (offline / hermetic CI) | false   |

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
    • ✗ awslabs.well-architected-security-mcp-server@1.0.2 → uvx exited with code 127
    • ✓ awslabs.cost-management-mcp-server@1.0.2 → launched (uvx)
[✓] Cache
    • ✓ /home/u/.assignee → 3.4 MB, 0 stale checkpoints, 14 log files
[✓] Config
    • ✓ ./assignee.yaml → valid YAML
[✓] Best practices
    • ✓ manifest → 131 rules, hash 3662a3cb766e… matches

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
