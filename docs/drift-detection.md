# Drift Detection

Detect and reconcile configuration drift between your desired state and live AWS resources.

## How It Works

assignee.ai tracks every resource it provisions in `~/.assignee/memory/`. Drift detection compares that **desired state** against the **actual state** fetched live from the AWS CloudControl `GetResource` API.

The comparison uses a deep-diff algorithm with AWS-specific normalization (stringified booleans, stringified numbers, null/undefined equivalence) and automatically excludes auto-populated fields that AWS sets on your behalf.

Each resource gets one of five statuses:

| Status             | Meaning                                                  |
| ------------------ | -------------------------------------------------------- |
| `IN_SYNC`          | Actual state matches desired state                       |
| `DRIFTED`          | One or more fields differ                                |
| `DELETED`          | Resource no longer exists in AWS                         |
| `BASELINE_MISSING` | No desired-state baseline found in provision logs        |
| `ERROR`            | CloudControl call failed (permissions, throttling, etc.) |

## `assignee drift` -- Table View

Scan all managed resources and display drift status in a table.

```bash
assignee drift
```

Output:

```
Resource Type                  Resource ID                              Region          Status               Drifted
──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
AWS::S3::Bucket                my-app-logs                              us-east-1       IN_SYNC              0
AWS::Lambda::Function          my-handler                               us-east-1       DRIFTED              3
AWS::DynamoDB::Table           sessions                                 us-west-2       IN_SYNC              0

3 resources checked: 2 in-sync, 1 drifted, 0 deleted, 0 errors
```

### Filters

Narrow the scan to a subset of resources:

```bash
# Only S3 buckets
assignee drift --resource AWS::S3::Bucket

# Only us-west-2
assignee drift --region us-west-2

# Only drifted resources
assignee drift --status DRIFTED

# Exclude unadopted resources (CI mode)
assignee drift --exclude BASELINE_MISSING

# Adopt a pre-existing resource into drift tracking
assignee drift --baseline arn:aws:s3:::adopted-bucket
```

`--resource` and `--region` filter before the CloudControl calls (fewer API calls). `--status` and `--exclude` filter after (all resources are still checked).

### JSON Output

```bash
# Print JSON report to stdout
assignee drift --json

# Write JSON report to a file
assignee drift --json --output drift-report.json
```

The JSON report includes a summary object with counts, check duration, and an array of per-resource results with full field-level detail.

### Concurrency

By default, drift checks run 10 resources in parallel. Adjust with `--concurrency`:

```bash
# Faster checks for large inventories
assignee drift --concurrency 30

# Conservative for accounts with low API limits
assignee drift --concurrency 3
```

Maximum concurrency is 50. Throttled requests are automatically retried with exponential backoff (up to 3 retries).

## `assignee drift <id>` -- Field-Level Detail

Inspect a single resource to see exactly which fields drifted, with color-coded output:

```bash
assignee drift my-handler
```

Output:

```
AWS::Lambda::Function  my-handler
Status: DRIFTED
Last provisioned: 2026-03-20T14:30:00Z

  Runtime        desired: nodejs20.x   actual: nodejs18.x    MODIFIED
  Timeout        desired: 30           actual: 60            MODIFIED
  MemorySize     desired: 256          actual: 512           MODIFIED
```

- **Green** fields are in sync (shown with `--verbose`)
- **Red** fields are modified
- **Yellow** fields were added externally or removed

Pass `--json` for machine-readable output:

```bash
assignee drift my-handler --json
```

## `assignee reconcile` -- Fix Drift

Reconcile walks through every drifted resource and presents three choices for each:

| Action        | What It Does                                                                    |
| ------------- | ------------------------------------------------------------------------------- |
| **Reconcile** | Patch the live resource back to desired state via CloudControl `UpdateResource` |
| **Accept**    | Update the desired-state baseline to match the current live state               |
| **Skip**      | Leave the resource as-is for now                                                |

```bash
assignee reconcile
```

Interactive session:

```
AWS::Lambda::Function my-handler — 3 drifted field(s)
  Runtime: "nodejs20.x" → "nodejs18.x"
  Timeout: 30 → 60
  MemorySize: 256 → 512

? Action for AWS::Lambda::Function my-handler?
  ● Reconcile
  ○ Accept
  ○ Skip
```

After a reconcile action, you are asked to confirm before any changes are applied. Immutable (create-only) properties are automatically detected and skipped with a warning.

### Dry Run

Preview what would happen without making any changes:

```bash
assignee reconcile --dry-run
```

Each drifted resource is listed with its field differences, but no prompts are shown and no changes are made.

### Auto-Reconcile

Reconcile all drifted resources without interactive prompts:

```bash
assignee reconcile --yes
```

A warning is displayed before proceeding. Press Enter to continue or Ctrl+C to abort.

### Filter by Resource Type

```bash
assignee reconcile --resource AWS::Lambda::Function
```

## CI Integration

Drift detection is designed to run in CI pipelines as a scheduled check.

### Exit Codes

| Code | Meaning                                                                                             |
| ---- | --------------------------------------------------------------------------------------------------- |
| `0`  | No resources have `DRIFTED` status (includes `IN_SYNC`, `DELETED`, `ERROR`, and `BASELINE_MISSING`) |
| `1`  | One or more resources have `DRIFTED` status                                                         |

> **Note:** Only `DRIFTED` triggers exit code 1. Resources with `DELETED`, `ERROR`, or `BASELINE_MISSING` status do **not** cause a non-zero exit. Use `--status DELETED` or `--exclude BASELINE_MISSING` filters to build CI checks for those states.

### Example: GitHub Actions

```yaml
name: Drift Check
on:
  schedule:
    - cron: "0 8 * * *" # Daily at 8am UTC

jobs:
  drift:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Install assignee
        # Pre-v0.2: build from source and link into PATH.
        # Available after v0.2 publish — replace with:  run: npm i -g assignee
        run: |
          git clone https://github.com/assignee-ai/assignee.ai.git /tmp/assignee.ai
          cd /tmp/assignee.ai
          pnpm install
          pnpm build
          pnpm link --global

      - name: Check for drift
        env:
          ASSIGNEE_OPERATOR_ACCESS_KEY_ID: ${{ secrets.AWS_ACCESS_KEY_ID }}
          ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
        run: assignee drift --json --output drift-report.json --concurrency 20

      - name: Upload report
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: drift-report
          path: drift-report.json
```

The step fails (exit code 1) if any drift is detected, which marks the workflow as failed and can trigger notifications.

### Example: Shell Script

```bash
#!/usr/bin/env bash
set -euo pipefail

assignee drift --json --output /tmp/drift-report.json --concurrency 20

if [ $? -eq 1 ]; then
  echo "Drift detected — see /tmp/drift-report.json"
  # Send to Slack, PagerDuty, etc.
fi
```

## All Options Reference

### `assignee drift`

| Flag                 | Description                                                                                            | Default |
| -------------------- | ------------------------------------------------------------------------------------------------------ | ------- |
| `[resource-id]`      | Show field-level detail for one resource                                                               | --      |
| `--resource <type>`  | Filter by CloudFormation resource type                                                                 | all     |
| `--region <region>`  | Filter by AWS region                                                                                   | all     |
| `--status <status>`  | Filter output by drift status                                                                          | all     |
| `--exclude <status>` | Exclude a drift status from output (e.g. `--exclude BASELINE_MISSING` for CI)                          | none    |
| `--baseline`         | Adopt the given `[resource-id]` into drift tracking by snapshotting its live CCAPI state as a baseline | false   |
| `--json`             | Output as JSON                                                                                         | false   |
| `--output <file>`    | Write JSON report to file (requires `--json`)                                                          | stdout  |
| `--concurrency <n>`  | Max parallel drift checks (1-50)                                                                       | 10      |
| `--verbose`          | Show all fields including matching ones                                                                | false   |
| `--no-color`         | Disable color output                                                                                   | false   |

### `assignee reconcile`

| Flag                | Description                            | Default |
| ------------------- | -------------------------------------- | ------- |
| `--resource <type>` | Filter by CloudFormation resource type | all     |
| `--dry-run`         | Preview without making changes         | false   |
| `--yes`             | Reconcile all without prompting        | false   |
