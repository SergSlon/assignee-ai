# Quickstart

Get from zero to a provisioned AWS resource in under 60 seconds.

## Install

Both `@assignee/cli` and `@assignee/mcp-server` are currently `private` and not published to npm. Build from source locally:

```bash
git clone https://github.com/SergSlon/assignee-ai.git
cd assignee-ai
pnpm install
pnpm build

# Run the CLI directly from the built output
node apps/cli/dist/index.js plan "create an S3 bucket named my-app-logs"
```

> **Tip:** For convenience, alias the built entrypoint in your shell:
>
> ```bash
> alias assignee="node $(pwd)/apps/cli/dist/index.js"
> ```
>
> The remaining examples in this guide use the bare `assignee` command — substitute `node apps/cli/dist/index.js` if you skip the alias.

## Prerequisites

assignee.ai auto-detects AWS credentials from the standard chain:

1. `ASSIGNEE_OPERATOR_ACCESS_KEY_ID` / `ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY` environment variables (recommended)
2. `AWS_PROFILE` / `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`
3. `~/.aws/credentials` file
4. AWS SSO session (`aws sso login`)

The CLI also needs Amazon Bedrock access in your region (default: `us-east-1`).

## First Run

On first invocation, assignee.ai automatically:

- Creates `~/.assignee/` state directory
- Creates `~/.assignee/memory/` for provision tracking
- Displays a version banner to stderr

No `init` step is required. You can start planning immediately.

> **Note:** Structured logs are suppressed by default. Pass `--verbose` to any command to see JSON logs on stderr, or set `ASSIGNEE_VERBOSITY=verbose`.

## Generate Your First Plan

```bash
assignee plan "create an S3 bucket named my-app-logs"
```

What happens:

1. **Intent Parser** -- Bedrock extracts the resource type (`AWS::S3::Bucket`) and name from your natural language
2. **Schema Fetcher** -- fetches the CloudFormation schema for S3 buckets
3. **Option Elicitor** -- prompts for any required fields not inferred from your intent
4. **Plan Generator** -- Bedrock produces a desired-state JSON with all fields populated
5. **BP Evaluator** -- evaluates 186 best practice rules (security, cost, reliability)
6. **Auto-Fix** -- patches fixable violations (e.g., enables S3 public access blocking, versioning, encryption, lifecycle policies)
7. **Preflight Guard** -- blocks the plan if critical violations remain
8. **Cost Estimator** -- fetches real-time pricing via the Pricing MCP

> **Tip:** Use `--set key=value` to pre-fill wizard fields without interactive prompts:
>
> ```bash
> assignee plan --set BucketName=my-logs --set Tags=env:prod "Create an S3 bucket"
> ```

The output is a plan box showing the desired state, estimated monthly cost, and any best practice findings. A checkpoint file is saved to `.assignee/checkpoint-<runId>.json` (valid for 72 hours).

## Apply the Plan

```bash
# Apply directly from intent (runs plan + provision in one step)
assignee apply "create an S3 bucket named my-app-logs"

# Or apply a saved plan checkpoint
assignee apply --checkpoint .assignee/checkpoint-abc123.json

# Or just run apply with no args -- auto-detects the latest checkpoint
assignee apply
```

The apply flow adds these steps after planning:

8. **Human Approval** -- shows the plan and asks you to confirm (type "yes"). When resuming from a checkpoint (including the plan-to-apply flow), confirmation is auto-approved to avoid double prompting.
9. **Resource Provisioner** -- creates the resource via AWS CloudControl API. State guard is skipped for S3 buckets (globally unique names cause false positives).
10. **Status Poller** -- polls every 2s until CloudControl reports SUCCESS or FAILED (MAX_POLL_ITERATIONS=450 safety guard; extended 15-min timeout for RDS/ELBv2/NatGateway)
11. **Result Formatter** -- displays the created resource ARN, tags, and cost

## What Just Happened

The 13-node LangGraph pipeline processed your intent through these stages:

```
intent_parser -> schema_fetcher -> option_elicitor -> compound_dispatcher
     -> plan_generator -> bp_evaluator -> fix_applicator
     -> preflight_guard -> human_approval -> resource_provisioner
     -> status_poller -> result_formatter
```

Each node is a pure function operating on a shared state object. The graph supports both `plan` mode (stops at preflight_guard) and `apply` mode (runs the full pipeline).

For compound patterns (e.g., "create a VPC"), the compound_dispatcher expands a single intent into multiple resources with dependency ordering, and the provisioner loops through them in parallel groups.

## Structured JSON Output

Use `-o json` with plan to get machine-readable output:

```bash
assignee plan -o json "Create an S3 bucket named my-logs" | jq .
```

This outputs structured JSON to stdout with all plan details (resource type, desired state, cost estimate, best practice findings). Spinners and interactive prompts are suppressed in JSON mode.

## Next Steps

- **Compound patterns**: `assignee plan "create a VPC with public and private subnets"` -- provisions 17 resources in dependency order
- **Drift detection**: `assignee drift` -- compares desired state against live AWS resources
- **Project config**: `assignee init` -- creates `.assignee/config.yaml` with region, tags, and auto-fix preferences
- **Global config**: `assignee init --global` -- sets user-wide defaults in `~/.config/assignee/config.yaml`
- **Infrastructure status**: `assignee status` -- summary of all managed resources with cost totals
- **Shell completions**: `eval "$(assignee completions zsh)"` -- tab completion for all commands
