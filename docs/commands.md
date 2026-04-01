# Commands Reference

All commands follow the pattern: `assignee <command> [args] [options]`

Global options: `--version`, `--help`, `--verbose`

The `--verbose` flag can be passed to any command. When set, structured JSON logs are written to stderr. Without it, logs are suppressed so they never pollute terminal output. You can also enable verbose output via `ASSIGNEE_VERBOSITY=verbose` or `ASSIGNEE_LOG_LEVEL=debug` environment variables.

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

Both modes prompt before overwriting existing config files.

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

| Flag                  | Description                                 | Default |
| --------------------- | ------------------------------------------- | ------- |
| `--profile <profile>` | AWS CLI profile with admin/root credentials | default |
| `-y, --yes`           | Skip confirmation prompts                   | false   |

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
