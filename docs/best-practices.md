# Best Practices Engine

assignee.ai evaluates every plan against a library of AWS best practice rules before any resource is created. Violations are displayed, auto-fixed where possible, and blocking issues prevent provisioning.

## How It Works

The best practices pipeline runs as three nodes in the 12-node LangGraph graph:

```
plan_generator -> bp_evaluator -> auto_fix_applier -> preflight_guard
```

1. **bp_evaluator**: Loads all YAML rules from `packages/best-practices/`, matches them by resource type and triggers, then evaluates each rule's `check_type` against the plan's `desiredState`. Produces a list of `BPFinding` objects. Completes in <10ms for up to 50 rules.

2. **auto_fix_applier**: For findings with `fixType: auto`, patches the `desiredState` directly using `desiredStatePatch`. For findings with `fixType: interactive`, prompts the user with choices. Respects the `preferences.auto_fix` config setting (`ask` / `apply` / `skip`).

3. **preflight_guard**: Checks if any `blocking: true` findings remain unfixed. If so, sets `executionStatus: FAILED` and halts the pipeline. Non-blocking findings are displayed as warnings but allow provisioning to proceed.

## Categories

| Category            | Description                                                |
| ------------------- | ---------------------------------------------------------- |
| `security`          | Encryption, public access, IAM policies, network exposure  |
| `cost`              | Pricing tier selection, over-provisioning                  |
| `cost_optimization` | Free tier usage, reserved capacity, lifecycle policies     |
| `reliability`       | Multi-AZ, backups, deletion protection, dead letter queues |
| `performance`       | Instance sizing, throughput settings, caching              |
| `compliance`        | Tagging, naming conventions, regulatory requirements       |

## Severity Levels

| Severity   | Meaning                                           | Blocking by Default |
| ---------- | ------------------------------------------------- | ------------------- |
| `CRITICAL` | Must fix before provisioning                      | Yes                 |
| `HIGH`     | Should fix, may cause security/reliability issues | Configurable        |
| `MEDIUM`   | Recommended improvement                           | No                  |
| `INFO`     | Informational, no action required                 | No                  |

## Fix Types

### Type A: Automatic Fix (`fixType: auto`)

The rule includes a `desiredStatePatch` that is merged into the plan's `desiredState`. No user interaction required (unless `auto_fix: ask` is configured).

Example -- S3 public access blocking:

```yaml
id: BP-S3-001
title: "S3 bucket should block public ACLs"
severity: CRITICAL
resource_type: "AWS::S3::Bucket"
property_path: "PublicAccessBlockConfiguration.BlockPublicAcls"
check_type: "equals"
expected_value: true
source: "AWS Security Hub FSBP"
source_id: "S3.1"
category: security
blocking: true
autoFixable: true
fixType: auto
desiredStatePatch:
  PublicAccessBlockConfiguration:
    BlockPublicAcls: true
```

When this rule fires, the fix is applied by merging `desiredStatePatch` into the plan.

**Additional S3 auto-fix rules:**

| Rule ID    | Title                                | Severity   | Category      | What it fixes                                                            |
| ---------- | ------------------------------------ | ---------- | ------------- | ------------------------------------------------------------------------ |
| BP-S3-005  | Versioning should be enabled         | HIGH       | reliability   | Sets `VersioningConfiguration.Status` to `Enabled`                       |
| BP-S3-006  | Server-side encryption required      | CRITICAL   | security      | Adds `BucketEncryption` with SSE-S3 (AES256)                            |
| BP-S3-010  | Lifecycle configuration recommended  | HIGH       | cost          | Adds lifecycle rules (STANDARD_IA at 30d, GLACIER at 90d, expire 365d)  |

**Lifecycle expiration clamping:** When auto-fix applies BP-S3-010 or the user configures lifecycle rules, the plan generator automatically clamps `ExpirationInDays` to be greater than the highest `TransitionInDays` value (AWS requires expiration > transition days).

### Type B: Interactive Fix (`fixType: interactive`)

The rule presents choices to the user. Each option specifies an action (`prompt_value`, `set_value`, `remove_property`, `skip`) and an optional `targetField`.

```yaml
fixType: interactive
interactiveOptions:
  - label: "Set custom retention period"
    action: prompt_value
    targetField: "RetentionInDays"
  - label: "Skip (keep default)"
    action: skip
```

### Info-Only (`fixType: info`)

Displays a finding with no auto-fix. The user must modify their intent or configuration manually.

## Check Types

Rules evaluate conditions using these check types:

| Check Type                 | Passes When                                     |
| -------------------------- | ----------------------------------------------- |
| `equals`                   | Field value equals expected value               |
| `not_equals`               | Field value does not equal expected value       |
| `exists`                   | Field is present (not undefined)                |
| `not_exists`               | Field is absent (undefined)                     |
| `greater_than`             | Numeric field > expected value                  |
| `less_than`                | Numeric field < expected value                  |
| `contains`                 | Field value contains expected substring         |
| `not_contains`             | Field value does not contain expected substring |
| `conditional_forbidden`    | Field must not be set when a condition is met   |
| `cross_resource_count`     | Cross-resource count validation                 |
| `cross_resource_reference` | Cross-resource reference validation             |
| `awareness`                | Advisory check (always fires for awareness)     |

## Triggers

Rules can specify triggers to control when they fire:

```yaml
triggers:
  - resourceType: "AWS::S3::Bucket" # Only for this resource type
    always: true # Fire on every evaluation
  - intentKeywords: ["public", "website"] # Only when intent contains keywords
  - patternId: "serverless-api" # Only within this compound pattern
```

Trigger conditions use AND logic within a single trigger, OR logic across multiple triggers.

## Rule File Format

Rules are YAML files stored in `packages/best-practices/<service>/BP-<SERVICE>-<NNN>.yaml`.

Required fields:

```yaml
id: BP-S3-001 # Format: BP-{SERVICE}-{NNN}
title: "Human-readable title"
severity: CRITICAL # CRITICAL | HIGH | MEDIUM | INFO
resource_type: "AWS::S3::Bucket"
property_path: "Path.To.Field"
check_type: "equals"
expected_value: true
source: "AWS Security Hub FSBP"
category: security # security | cost | reliability | performance | compliance
lastVerified: "2026-03-22" # YYYY-MM-DD
```

Optional fields: `source_id`, `description`, `remediation`, `version`, `triggers`, `autoFixable`, `desiredStatePatch`, `blocking`, `fixType`, `interactiveOptions`, `condition`.

## Rule Coverage by Service

Rules are organized by service directory. Check current coverage:

```bash
assignee status --bp-coverage
```

This scans the rule directory at runtime and displays:

- Rules per resource type
- Auto-fixable vs. interactive vs. manual counts
- Auto-fix percentage
- Gap analysis (supported types with zero rules)
- Source breakdown (AWS Security Hub FSBP, CIS Benchmark, etc.)
- Severity distribution

Example output:

```
BP Coverage Dashboard
=====================

Resource Type                              Rules Auto-Fix Interactive Manual Last Verified
────────────────────────────────────────────────────────────────────────────────────────────
AWS::S3::Bucket                               18       12           2      4    2026-03-22
AWS::EC2::Instance                            14        8           1      5    2026-03-22
AWS::RDS::DBInstance                          10        6           1      3    2026-03-22
...

Summary: 95 rules | 52 auto-fixable (55%) | 8 interactive | 35 manual
```

## Controlling Auto-Fix Behavior

Three modes, configurable via `assignee init --global`, config file, or environment:

| Mode    | Behavior                              |
| ------- | ------------------------------------- |
| `ask`   | Prompt before each auto-fix (default) |
| `apply` | Apply all auto-fixes silently         |
| `skip`  | Never auto-fix, only display findings |

In config file:

```yaml
preferences:
  auto_fix: ask # ask | apply | skip
```

In project init:

```yaml
autoFixBestPractices: true # equivalent to auto_fix: apply
```
