---
diataxis: reference
canonical: true
---

> **Diátaxis: Reference** — This is the canonical root page for this topic. Full configuration precedence chain, environment variables, and file formats.

# Configuration

assignee.ai uses a layered configuration system. Everything works out of the box with zero configuration -- all settings have sensible defaults.

## Configuration Precedence

Settings are resolved in this order (highest priority first):

| Priority | Source                | Example                                                      |
| -------- | --------------------- | ------------------------------------------------------------ |
| 1        | CLI flags             | `--yes`, `-o json`, `--set BucketName=my-bucket`             |
| 2        | Environment variables | `ASSIGNEE_AUTO_FIX=apply`                                    |
| 3        | Project config        | `.assignee/config.yaml`                                      |
| 4        | User config           | `~/.config/assignee/config.yaml`                             |
| 5        | Org policy            | Local org policy file (`org_policy:` in user/project config) |
| 6        | Plugin defaults       | Built-in defaults per resource type                          |

Higher-priority values override lower ones. Unknown keys are silently ignored for forward compatibility.

### Global Preferences (A2, 2026-04-08)

Global preferences (`defaults.region`, `defaults.tags`, `preferences.auto_fix`, `budget`) flow through a single `resolveGlobalConfig()` helper in `@assignee/core` that merges the sources above into a fully-populated `ResolvedGlobalConfig` object. The CLI calls this helper inside `plan`, `apply`, and `doctor --short` at boot, then plumbs the result into graph state as `resolvedConfig` so downstream nodes read one authoritative source instead of re-reading env vars or raw user config point-of-use.

- **Nested merging.** `defaults.tags` and `defaults.naming` merge **key-by-key** rather than whole-object replacement, so a user-level `defaults.naming.prefix` and a project-level `defaults.naming.suffix` both survive. Similarly, `defaults.tags.env=prod` from env can coexist with `defaults.tags.owner=alice` from user yaml.
- **`org_policy` is NOT merged.** The highest-priority source that defines `org_policy` wins wholesale — per-resource-type keys make shallow merging surprising and deep merging unsafe.
- **Verifying the resolution.** Run `assignee doctor --short` — the output includes a `Resolved global preferences` block showing the final `auto_fix` value after the merge. This is the quickest way to confirm an `ASSIGNEE_*` env var is taking effect.
- **Resource-level fields** (per-type wizard overrides like `InstanceType` or `BucketName`) use a separate 6-level merger in `apps/cli/src/utils/merge-configs.ts`. That merger handles the org-policy `locked` / `always_ask` semantics and is called inside the option-elicitor node, not at boot.

### `--set` Flag

The `--set key=value` flag (available on `plan` and `apply` commands) pre-fills wizard fields at the highest priority level (CLI flags). This skips the interactive prompt for that field entirely. It is repeatable:

```bash
assignee plan --set BucketName=my-logs --set Tags=env:prod "Create an S3 bucket"
assignee apply --set InstanceType=t3.small "Create an EC2 instance"
```

### `--verbose` Flag

The `--verbose` flag is a global option on the root `assignee` program. It controls structured JSON log output to stderr. Logs are suppressed by default so they never pollute terminal output. Enable via any of the following — the CLI flag has the highest priority:

| Priority | Source                               | Example                                    |
| -------- | ------------------------------------ | ------------------------------------------ |
| 1        | `--verbose` CLI flag                 | `assignee --verbose plan "..."`            |
| 2        | `ASSIGNEE_LOG_LEVEL=debug` env var   | `ASSIGNEE_LOG_LEVEL=debug assignee plan`   |
| 3        | `ASSIGNEE_VERBOSITY=verbose` env var | `ASSIGNEE_VERBOSITY=verbose assignee plan` |

The CLI flag wins: passing `--verbose` enables verbose output even when `ASSIGNEE_VERBOSITY=normal` or the env vars are unset. When the flag is present, the CLI also sets `ASSIGNEE_LOG_LEVEL=debug` in the process environment so child processes and MCP servers inherit the verbose setting.

As a global option, `--verbose` is registered on the root program. It must appear **before** the subcommand name (mirroring `--version` and `--help`):

```bash
assignee --verbose plan "Create an SSM parameter named test"
assignee --verbose apply --yes "Create an S3 bucket named logs-prod"
```

> **Note:** The `drift` subcommand has a local `--verbose` option with different semantics (shows all fields including matching ones in the drift diff table). To get JSON diagnostic logs during a drift run, pass `--verbose` before the subcommand: `assignee --verbose drift`. Both can be combined: `assignee --verbose drift --verbose`.

## Config File Locations

### Project Config

```
.assignee/config.yaml
```

Created by `assignee init`. Scoped to the current project directory. Checked into version control to share team settings.

```yaml
# Generated by assignee init
region: us-east-1
profile: default
tags:
  managed-by: assignee-ai
  environment: development
preferences:
  auto_fix: ask # ask | apply | skip
```

### User Config

```
~/.config/assignee/config.yaml
```

Created by `assignee init --global`. Applies to all projects for the current user.

```yaml
# Generated by assignee init --global
defaults:
  region: us-east-1
  tags:
    team: platform
    cost-center: eng-42
  naming:
    prefix: mycompany-
preferences:
  auto_fix: ask
```

### Org Policy

Org policies are loaded from local config files (`org_policy:` block under user or project config) and enforce company-wide guardrails. The fetch-from-SaaS path is design intent for future productisation; today only local-file policies are read.

```yaml
org_policy:
  security:
    require_encryption: locked # cannot be overridden
    min_tls_version: "1.2"
  cost:
    max_instance_type: default # can be overridden by user
    require_approval_above: 100 # monthly cost threshold
```

## Config Schema

### `defaults` Section

| Key                      | Type   | Default     | Description                             |
| ------------------------ | ------ | ----------- | --------------------------------------- |
| `defaults.region`        | string | `us-east-1` | Default AWS region for all operations   |
| `defaults.tags`          | object | `{}`        | Key-value tags applied to all resources |
| `defaults.naming.prefix` | string | `""`        | Prefix applied to resource names        |
| `defaults.naming.suffix` | string | `""`        | Suffix applied to resource names        |

### `preferences` Section

| Key                    | Type | Default | Description                                            |
| ---------------------- | ---- | ------- | ------------------------------------------------------ |
| `preferences.auto_fix` | enum | `ask`   | How to handle BP auto-fixes: `ask`, `apply`, or `skip` |

> `preferences.output_format` and `preferences.verbosity` were removed
> — no CLI command branched on those keys (`ASSIGNEE_VERBOSITY=verbose`
> still works via the logger's direct env read).

### `bestPractices` Section (planned -- not yet implemented)

> **Note:** The `bestPractices` config section is planned but does not exist in the current config schema (`packages/core/src/config/config-schema.ts`). Best-practice enforcement is currently controlled via `preferences.auto_fix` and the `ASSIGNEE_BP_INTEGRITY` env var. The fields below describe the intended future design.

```yaml
# .assignee/config.yaml (planned)
bestPractices:
  enforcement: enforce # enforce | warn | skip (default: enforce)
  autoFix: true # auto-fix best-practice violations when possible
```

| Key                         | Type | Default   | Description                                               |
| --------------------------- | ---- | --------- | --------------------------------------------------------- |
| `bestPractices.enforcement` | enum | `enforce` | How blocking BP violations are handled                    |
| `bestPractices.autoFix`     | bool | `true`    | Whether auto-fixable violations are patched automatically |

**Enforcement modes:**

| Mode      | Behavior                                                                                        |
| --------- | ----------------------------------------------------------------------------------------------- |
| `enforce` | Blocking BP violations halt ALL flows including `--yes` and `--no-wizard`. This is the default. |
| `warn`    | Blocking violations are logged as warnings but provisioning proceeds.                           |
| `skip`    | BP evaluation is disabled entirely. No rules are evaluated, no findings are produced.           |

**Org policy override:** When an org policy sets `bestPractices.enforcement: locked`, the user cannot downgrade from `enforce`. For example, if the org policy locks `enforce`, setting `warn` or `skip` in project or user config is silently ignored. This ensures security-critical rules cannot be bypassed in managed environments.

### `org_policy` Section

Pass-through section for organization-wide policies. Keys are domain-specific (e.g., `security`, `cost`). No deep validation -- the policy engine interprets them at runtime.

### `llm` Section

> **Note:** `llm.*` keys are not parsed today. The YAML example below describes the intended future design; the current config schema (`packages/core/src/config/config-schema.ts`) does not read these keys. Model selection is driven by the `ASSIGNEE_LLM_DEFAULT` environment variable instead.

LLM model selection. By default, all pipeline nodes use the same model (`ASSIGNEE_LLM_DEFAULT` or the built-in default `bedrock/amazon.nova-lite-v1:0`).

```yaml
# .assignee/config.yaml — only `default` is honoured today
llm:
  default: bedrock/us.amazon.nova-lite-v1:0
```

| Key           | Type   | Default                            | Description                               |
| ------------- | ------ | ---------------------------------- | ----------------------------------------- |
| `llm.default` | string | `ASSIGNEE_LLM_DEFAULT` or built-in | Model used by every pipeline LLM callsite |

Each value must be in `provider/model-id` format. Supported providers: `bedrock`, `anthropic`, `openai`, `google`, `ollama`.

**Per-node routing — designed but not wired.** The four per-callsite
slots (`llm.plan_generator`, `llm.intent_parser`, `llm.advice_generator`,
`llm.workload_classifier`) and their matching `ASSIGNEE_LLM_*` env-var
twins were defined as a routing surface but the factory sites that
would read them were never built. The dead env-var constants have been
removed; setting the keys (or env vars) has no effect today. See the
descope note in
[`packages/core/src/constants/env-vars.ts`](../packages/core/src/constants/env-vars.ts)
for revival guidance — wire the factory sites first, then re-add the slots.

**Diagnostics:** Run `assignee doctor` to see the resolved model.

### Data Registries

Several data tables that previously lived inline in source modules have been extracted into dedicated registry files. This gives each table a single source of truth, simplifies updates when AWS adds new instance families or Bedrock regions, and creates a clean seam for future config-driven overrides.

| Registry                 | File                                                           | Purpose                                                       | Consumer(s)                    |
| ------------------------ | -------------------------------------------------------------- | ------------------------------------------------------------- | ------------------------------ |
| Instance type catalog    | `packages/core/src/resource-plugins/instance-type-registry.ts` | EC2 instance types offered in the wizard, grouped by workload | `ec2-instance.ts` (wizard)     |
| Bedrock region list      | `packages/core/src/constants/bedrock-regions.ts`               | Known regions where Bedrock + Claude/Nova are available       | `llm-adapter.ts` (error hints) |
| Instance family registry | `apps/cli/src/constants/instance-family-registry.ts`           | ARM equivalents, Spot eligibility, RDS class detection tables | `cost-advisor` (advice node)   |

These registries are pure data declarations (no I/O, no imports of heavy modules). To add a new instance family or Bedrock region, edit only the relevant registry file -- no other source changes required.

### DataSource Tagging

Every user-facing dollar amount, security finding, or pricing hint carries a `DataSource` provenance tag so the display layer can tell the user where a value came from.

| Tag        | Meaning                                                           | Display suffix |
| ---------- | ----------------------------------------------------------------- | -------------- |
| `mcp`      | Fetched live from an MCP server during this command invocation    | `(live)`       |
| `cached`   | Fetched live during an earlier command, replayed from cache       | `(cached)`     |
| `fallback` | Produced by a local heuristic or hand-coded constant              | `(estimated)`  |
| `offline`  | Replayed from a persisted log entry (previous plan/apply output)  | `(from log)`   |
| `free`     | Authoritatively free of charge (IAM role, IGW, ECS control plane) | _(no suffix)_  |

The `DataSource` type and `formatLabelWithSource()` helper live in `@assignee/core` (`packages/core/src/pricing/types.ts`). Every `PricingEstimate` and `BillingCostData` record requires a `source` field -- the TypeScript compiler enforces this at every code path that produces a cost value.

## Environment Variables

The full table below is grouped logically by audience. The same variable
appears in only one row regardless of audience; use the index below to
jump to the section relevant to your operator role.

| Audience                 | Variables                                                                                                                                                                                                                                                                                                                              |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Credentials              | `AWS_REGION`, `AWS_PROFILE`, `ASSIGNEE_OPERATOR_ACCESS_KEY_ID`, `ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY`, `ASSIGNEE_OPERATOR_SESSION_TOKEN`, `ASSIGNEE_READER_ACCESS_KEY_ID`, `ASSIGNEE_READER_SECRET_ACCESS_KEY`, `ASSIGNEE_AUDITOR_ACCESS_KEY_ID`, `ASSIGNEE_AUDITOR_SECRET_ACCESS_KEY`                                                 |
| Behavior                 | `BEDROCK_MODEL_ID`, `ASSIGNEE_LLM_DEFAULT`, `ASSIGNEE_BP_INTEGRITY`, `ASSIGNEE_BP_SIGNING_KEY`, `ASSIGNEE_BP_REQUIRE_SIGNATURE`, `ASSIGNEE_NO_CLARIFIER`, `ASSIGNEE_DEMO_REDACT_ACCOUNT`, `ASSIGNEE_PREFLIGHT_UNKNOWN_BLOCKS`, `ASSIGNEE_SAAS_URL`, `ASSIGNEE_ORG_POLICY_TTL_MS`, `OLLAMA_BASE_URL`, `ASSIGNEE_MCP_MAX_ACTIVE_APPLIES` |
| Logging & Telemetry      | `ASSIGNEE_VERBOSITY`, `ASSIGNEE_LOG_LEVEL`, `ASSIGNEE_LOG_DIR`, `ASSIGNEE_LOG_RETENTION_DAYS`, `ASSIGNEE_OTEL_ENDPOINT`, `ASSIGNEE_OTEL_SERVICE_NAME`, `ASSIGNEE_OTEL_INCLUDE_PII`, `ASSIGNEE_TELEMETRY_ADAPTER`                                                                                                                       |
| Audit                    | `ASSIGNEE_AUDIT_KEY`, `ASSIGNEE_AUDIT_FSYNC`, `ASSIGNEE_AUDIT_RETENTION_DAYS`                                                                                                                                                                                                                                                          |
| Release pipeline         | `ASSIGNEE_RELEASE_PUBLISH`, `ASSIGNEE_TAP_PUBLISH`, `ASSIGNEE_DOWNGRADE_ACK`                                                                                                                                                                                                                                                           |
| Test-only / fixtures     | `RUN_E2E`, `ASSIGNEE_NIGHTLY_BUDGET_USD`, `ASSIGNEE_NIGHTLY_LEDGER_DIR`, `RUN_INSTALL_MITM_FIXTURE`                                                                                                                                                                                                                                    |
| Reserved (not yet wired) | `ASSIGNEE_OIDC_ADAPTER`                                                                                                                                                                                                                                                                                                                |

| Variable                              | Description                                                                                                                                                                                                                                                                                                            | Default                                         |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `AWS_REGION`                          | AWS region for all API calls. Also drives the Bedrock inference profile region, SaaS API base URL selection, and Pricing MCP region. Previously hard-coded to `us-east-1`; now **derived** from the environment — set explicitly for non-us-east-1 deployments.                                                        | `us-east-1`                                     |
| `BEDROCK_MODEL_ID`                    | **Legacy.** Bedrock model ID (bare, without provider prefix). Prefer `ASSIGNEE_LLM_DEFAULT` which supports all providers via `provider/model-id` format                                                                                                                                                                | `us.amazon.nova-lite-v1:0`                      |
| `ASSIGNEE_OPERATOR_ACCESS_KEY_ID`     | Access key for the operator IAM user                                                                                                                                                                                                                                                                                   | -                                               |
| `ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY` | Secret key for the operator IAM user                                                                                                                                                                                                                                                                                   | -                                               |
| `ASSIGNEE_READER_ACCESS_KEY_ID`       | Access key for the reader IAM user (MCP)                                                                                                                                                                                                                                                                               | -                                               |
| `ASSIGNEE_READER_SECRET_ACCESS_KEY`   | Secret key for the reader IAM user (MCP)                                                                                                                                                                                                                                                                               | -                                               |
| `ASSIGNEE_AUDITOR_ACCESS_KEY_ID`      | Access key for the auditor IAM user (MCP)                                                                                                                                                                                                                                                                              | -                                               |
| `ASSIGNEE_AUDITOR_SECRET_ACCESS_KEY`  | Secret key for the auditor IAM user (MCP)                                                                                                                                                                                                                                                                              | -                                               |
| `ASSIGNEE_LLM_DEFAULT`                | Override the default LLM model for every pipeline callsite. The per-node `ASSIGNEE_LLM_PLAN_GENERATOR` / `_INTENT_PARSER` / `_ADVICE_GENERATOR` / `_WORKLOAD_CLASSIFIER` slots are not wired today — see the `llm` section.                                                                                            | -                                               |
| `ASSIGNEE_VERBOSITY`                  | Set to `verbose` to enable structured log output                                                                                                                                                                                                                                                                       | -                                               |
| `ASSIGNEE_LOG_LEVEL`                  | Set to `debug` to enable structured log output                                                                                                                                                                                                                                                                         | -                                               |
| `ASSIGNEE_SAAS_URL`                   | SaaS API base URL for org policy fetch. Must start with `https://` or `http://localhost` — other schemes are rejected at startup.                                                                                                                                                                                      | `https://app.assignee.ai`                       |
| `ASSIGNEE_ORG_POLICY_TTL_MS`          | TTL for cached org policy (milliseconds)                                                                                                                                                                                                                                                                               | `300000` (5 min)                                |
| `ASSIGNEE_BP_INTEGRITY`               | Best-practices manifest integrity mode (see below)                                                                                                                                                                                                                                                                     | `enforce` (prod) / `warn` (test)                |
| `ASSIGNEE_BP_SIGNING_KEY`             | Release-only: when set, `pnpm --filter=@assignee/best-practices run generate-manifest` also emits a detached GPG signature (`manifest.json.sig`) using this local-user identity (key id, fingerprint, or email). Absent = unsigned manifest (current behaviour).                                                       | unset                                           |
| `ASSIGNEE_BP_REQUIRE_SIGNATURE`       | When set to any non-empty value, the CLI refuses to load BP rules in enforce mode unless a valid GPG signature is present alongside the manifest. Defense-in-depth beyond the hash check. Absent = unsigned manifests accepted in enforce mode (warns once).                                                           | unset                                           |
| `ASSIGNEE_LOG_DIR`                    | Override directory for always-on warn/error log file                                                                                                                                                                                                                                                                   | `~/.assignee/logs`                              |
| `ASSIGNEE_LOG_RETENTION_DAYS`         | Days to retain persistent warn/error log files before auto-prune (runs at most once per hour via `autoPruneLogsIfDue`) deletes them                                                                                                                                                                                    | `14`                                            |
| `ASSIGNEE_OTEL_ENDPOINT`              | When set, every structured log event is also POSTed to `<endpoint>/v1/logs` in OTLP/HTTP-JSON format. Errors and timeouts are swallowed silently — the exporter never blocks the CLI. Example: `http://localhost:4318` for a local OpenTelemetry Collector.                                                            | unset (disabled)                                |
| `ASSIGNEE_OTEL_SERVICE_NAME`          | Optional `service.name` resource attribute attached to every emitted log record. Only consulted when `ASSIGNEE_OTEL_ENDPOINT` is set.                                                                                                                                                                                  | `assignee-cli`                                  |
| `ASSIGNEE_PREFLIGHT_UNKNOWN_BLOCKS`   | Set to `1` to escalate unknown preflight verification errors to fail-closed (strict mode for SaaS/regulated tenants). See [invariants.md](explanation/invariants.md#preflight-fail-closed-on-auth-with-opt-in-unknown-error-escalation)                                                                                | unset (fail-open for unknown)                   |
| `ASSIGNEE_DEMO_REDACT_ACCOUNT`        | Set to `1` to redact 12-digit AWS account IDs in all CLI output (useful for demos and screenshots). State files and provision logs keep real ARNs; only rendered output is redacted. Source: `packages/core/src/constants/env-vars.ts` (canonical name) + `apps/cli/src/commands/output-format.ts` (consumer).         | unset (OFF — real account IDs appear in output) |
| `ASSIGNEE_NO_CLARIFIER`               | Set to `1` to skip the intent-clarifier prompt on ambiguous inputs (useful in CI or scripted flows where no operator is available to answer). Source: `apps/cli/src/services/clarifier.ts`.                                                                                                                            | unset                                           |
| `ASSIGNEE_MCP_MAX_ACTIVE_APPLIES`     | Override the default 100 concurrent-apply ceiling on the MCP server. Tune for high-concurrency CI fleets. Must be a positive integer — invalid values fall back to `100`. Source: `apps/mcp-server/src/tools/apply-plan/active-applies.ts`.                                                                            | `100`                                           |
| `RUN_E2E`                             | Set to `1` to enable the nightly destroy-smoke E2E suite (otherwise skipped). See also `ASSIGNEE_NIGHTLY_BUDGET_USD`.                                                                                                                                                                                                  | unset (skipped)                                 |
| `AWS_PROFILE`                         | AWS CLI named profile. Now honored: when set, `assignee init` uses the profile for SSO credential resolution. For `plan`/`apply`/`destroy`, prefer dedicated `ASSIGNEE_OPERATOR_*` keys; `AWS_PROFILE` alone is not sufficient for those commands.                                                                     | unset                                           |
| `ASSIGNEE_OPERATOR_SESSION_TOKEN`     | Session token for ASIA-prefixed STS / AWS SSO short-term credentials. Required when `ASSIGNEE_OPERATOR_ACCESS_KEY_ID` starts with `ASIA`. Forwarded to every AWS SDK client constructed for the operator role.                                                                                                         | -                                               |
| `ASSIGNEE_AUDIT_KEY`                  | Per-tenant HMAC key for the audit-log chain. Hex or base64. Without this variable a per-process ephemeral key is generated and a warning is emitted — cross-restart chain verification will fail.                                                                                                                      | unset (ephemeral per-process key)               |
| `ASSIGNEE_AUDIT_FSYNC`                | Controls whether the audit-log writer issues `fsync` + directory `fsync` after each appended entry. Default: **enabled** (any value other than `"0"` → fsync runs). Set to `"0"` to disable. See [`ASSIGNEE_AUDIT_FSYNC`](#assignee_audit_fsync) below.                                                                | enabled (`"0"` disables)                        |
| `ASSIGNEE_AUDIT_RETENTION_DAYS`       | Number of days to retain audit-log entries before auto-prune removes them. **Minimum: 90** (ISO 27001 A.12.4 + GDPR Art 30 ROPA compliance floor). Values below 90 are rejected at startup with an error and the 90-day floor is applied. See [`ASSIGNEE_AUDIT_RETENTION_DAYS`](#assignee_audit_retention_days) below. | `90`                                            |
| `ASSIGNEE_TELEMETRY_ADAPTER`          | Opt-in flag for in-process telemetry adapter. Set to `1` to enable. Default off.                                                                                                                                                                                                                                       | unset (off)                                     |
| `ASSIGNEE_OTEL_INCLUDE_PII`           | Set to `1` to include PII fields (user identifiers, resource names) in OTEL log events. Default off — PII is stripped before export.                                                                                                                                                                                   | unset (off)                                     |
| `ASSIGNEE_NIGHTLY_BUDGET_USD`         | Cost cap (USD) for the nightly real-AWS smoke run. The runner aborts before launching additional resources once cumulative spend reaches this ceiling.                                                                                                                                                                 | `5` (approx.)                                   |
| `ASSIGNEE_NIGHTLY_LEDGER_DIR`         | Directory for the JSONL cost ledger written by the nightly smoke runner.                                                                                                                                                                                                                                               | `~/.assignee/nightly-ledger`                    |
| `ASSIGNEE_RELEASE_PUBLISH`            | **Release pipeline only — no published artifacts yet.** Without `=1`, every publish-side step (npm publish, GitHub Release, Homebrew tap push) runs in dry-run mode. The flag has not been flipped on this course-submission build, so all release outputs are currently dry-run.                                      | unset (dry-run)                                 |
| `ASSIGNEE_TAP_PUBLISH`                | **Release pipeline only — no published artifacts yet.** Homebrew tap publish gate. Requires `ASSIGNEE_RELEASE_PUBLISH=1` as well. The Homebrew tap repository has not been published.                                                                                                                                  | unset (skipped)                                 |
| `ASSIGNEE_DOWNGRADE_ACK`              | Allowlist override for `install.sh` — acknowledges that a specific past version known to be vulnerable may be installed. Set to the exact version string.                                                                                                                                                              | unset                                           |
| `ASSIGNEE_OIDC_ADAPTER`               | **Reserved / not yet wired.** Placeholder for OIDC adapter selection. Today its absence triggers the "OIDC not configured; using AWS_PROFILE SSO" message in `assignee init`. The adapter slot is reserved for future productisation; nothing reads the value today.                                                   | unset                                           |
| `OLLAMA_BASE_URL`                     | Base URL for a local Ollama server when `ollama` is the configured LLM provider. Must start with `https://` or `http://localhost` — other schemes are rejected.                                                                                                                                                        | `http://localhost:11434`                        |
| `RUN_INSTALL_MITM_FIXTURE`            | Set to `1` to enable the `install.sh` MITM-tampering test fixture (CI only). Do not set in production environments.                                                                                                                                                                                                    | unset (disabled)                                |

### `ASSIGNEE_BP_INTEGRITY` modes

The best-practices library ships with a manifest (`manifest.json`) and, optionally, a detached GPG signature (`manifest.json.sig`). This variable controls how the loader reacts when the manifest is missing, malformed, or fails verification.

| Mode       | Behavior                                                                                               |
| ---------- | ------------------------------------------------------------------------------------------------------ |
| `enforce`  | Manifest must validate. On failure the CLI aborts before running any rules. **Default in production.** |
| `warn`     | Manifest is verified, but failures only emit a warning and the CLI continues. **Default in tests.**    |
| `disabled` | Manifest verification is skipped entirely. Use only for local development against unreleased rules.    |

### BP manifest signing (`ASSIGNEE_BP_SIGNING_KEY` / `ASSIGNEE_BP_REQUIRE_SIGNATURE`)

Signing is an **opt-in** release hardening step. It protects against the "attacker commits a tampered YAML + regenerated manifest in the same commit" scenario that a plain SHA-256 manifest cannot detect.

**Generation side (release infrastructure):**

```bash
# Sign manifest.json with your GPG key during release
ASSIGNEE_BP_SIGNING_KEY="release@assignee.ai" \
  pnpm --filter=@assignee/best-practices run generate-manifest
```

This writes a detached ASCII-armored signature to `packages/best-practices/manifest.json.sig`. If `gpg` is not installed the script logs a warning and skips signing — signing is not a dev prerequisite. Absence of `ASSIGNEE_BP_SIGNING_KEY` keeps the current unsigned-manifest behaviour.

**Verification side (CLI runtime):**

- If `manifest.json.sig` exists alongside `manifest.json`, the CLI runs `gpg --verify` on load. The result is attached to the integrity result as `signature.{verified, signedByKey, reason}`.
- If the signature is present but invalid, enforce mode throws `BpIntegrityError` regardless of `ASSIGNEE_BP_REQUIRE_SIGNATURE` — an invalid signature always fails.
- If no signature file is present, enforce mode accepts the manifest (with a one-time stderr warning: "BP manifest is unsigned — accepting on trust") UNLESS `ASSIGNEE_BP_REQUIRE_SIGNATURE` is set, in which case enforce mode refuses to load BP rules.
- If `gpg` is not installed, the CLI skips signature verification with a warning. Enforce mode + `ASSIGNEE_BP_REQUIRE_SIGNATURE` refuses to load in that case.

`ASSIGNEE_BP_REQUIRE_SIGNATURE=1` is recommended for organizations that can guarantee signed BP releases in their supply chain (private registry, curated build).

### `ASSIGNEE_LOG_DIR`

The CLI keeps an always-on `warn`/`error` log on disk so post-mortem debugging is possible even with no `--verbose` flag. By default the file lives under `~/.assignee/logs/`. Set `ASSIGNEE_LOG_DIR` to redirect it (used by tests to avoid polluting the user's home directory).

### `ASSIGNEE_LOG_RETENTION_DAYS`

Persistent warn/error log files (`cli-YYYY-MM-DD.jsonl` and their numbered rotations under `~/.assignee/logs/`) are auto-pruned by an internal hook. Files whose filename date is strictly older than `now - retentionDays` are deleted.

- **Default:** `14` days.
- **Override:** set `ASSIGNEE_LOG_RETENTION_DAYS` to a positive integer. Non-numeric, zero, or negative values fall back to the default.
- **How it runs:** the auto-prune hook (`autoPruneLogsIfDue` in `apps/cli/src/services/cleanup/orchestrator.ts`) runs opportunistically at most once per hour, gated by a `.last-prune` marker file inside the log directory. There is no `assignee clean` CLI command — pruning is entirely automatic and throttled.
- **Manual control:** if you need to force a prune, delete the `.last-prune` marker (`rm ~/.assignee/logs/.last-prune`) so the next CLI invocation re-runs the hook. To inspect retained files, run `ls ~/.assignee/logs/`.

### `ASSIGNEE_AUDIT_FSYNC`

After each entry is appended to the HMAC-chained audit log (`~/.assignee/audit/`), the audit writer calls `fsync` twice:

1. **File fsync** — flushes the appended bytes from the kernel page cache to the storage device.
2. **Directory fsync** — commits the directory entry (inode update, file size) so a kernel panic between the `appendFile` and the OS directory-flush cannot leave bytes on disk that are invisible to subsequent reads.

**Default: enabled.** The double-fsync runs unless `ASSIGNEE_AUDIT_FSYNC=0` is set.

```bash
# Disable fsync for high-throughput environments or slow-disk benchmarks
ASSIGNEE_AUDIT_FSYNC=0 assignee apply "Create S3 bucket"
```

**When to disable:**

| Scenario                                                   | Rationale                                                                                                                                   |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| High-throughput environments (bulk apply loops, CI fleets) | Audit log durability is provided by the storage layer (NFS, EBS replication, SAN). The OS-level fsync overhead is redundant and measurable. |
| Slow-disk benchmarks / local development on spinning HDDs  | fsync serializes writes; disabling removes the bottleneck for non-critical local runs.                                                      |
| Test suites                                                | Avoids `fsync` contention and speeds up audit-log tests (also how `audit-log.test.ts` is configured).                                       |

**Trade-off:** with fsync disabled, a hard kernel panic in the narrow window between the `appendFile` returning and the OS flushing its write-back cache can cause the last N appended entries to be missing from the audit file on recovery. On modern SSDs with power-loss protection this window is very short; on NFS/EBS it is effectively closed by the replication layer.

> Source: [`packages/core/src/audit/audit-log.ts`](../packages/core/src/audit/audit-log.ts).

### `ASSIGNEE_AUDIT_RETENTION_DAYS`

The audit log at `~/.assignee/audit/` is subject to a rolling-window retention policy enforced during the auto-prune pass that runs opportunistically at CLI startup.

- **Default:** `90` days.
- **Minimum:** `90` days — this floor is a compliance requirement (ISO 27001 A.12.4, GDPR Art 30 ROPA) and cannot be lowered. Attempts to set a value below 90 emit an error to stderr and the 90-day floor is applied automatically:

  ```
  [assignee] ERROR: ASSIGNEE_AUDIT_RETENTION_DAYS=30 is below the mandatory 90-day compliance floor
  (ISO 27001 A.12.4 + GDPR Art 30 ROPA). Applying the 90-day floor.
  Set a value ≥ 90 to suppress this error.
  ```

- **Override:** set `ASSIGNEE_AUDIT_RETENTION_DAYS` to a positive integer ≥ 90 to extend the retention window beyond the default. Non-numeric, zero, or negative values fall back to the default.

**When to change:**

| Scenario                                                          | Recommended value            |
| ----------------------------------------------------------------- | ---------------------------- |
| Regulated environment requiring longer retention (PCI DSS, SOC 2) | `365` or higher              |
| Default compliance posture (ISO 27001 / GDPR baseline)            | `90` (default — leave unset) |

> **Note:** Lowering below 90 is never permitted. The env var can only extend, never shrink, the minimum retention window.

> Source: [`packages/core/src/utils/logger/retention.ts`](../packages/core/src/utils/logger/retention.ts).

## Org Policy Semantics

Org policy keys support three enforcement modes:

| Mode         | Behavior                                                                 |
| ------------ | ------------------------------------------------------------------------ |
| `locked`     | Value cannot be overridden by project or user config. Enforced silently. |
| `default`    | Value is used as default but can be overridden by project/user config.   |
| `always_ask` | User is always prompted for this value, even if a default exists.        |

## Internal Constants

These constants control system behavior and are not user-configurable:

| Constant                       | Value       | Description                                        |
| ------------------------------ | ----------- | -------------------------------------------------- |
| `CHECKPOINT_DEFAULT_TTL_HOURS` | 72          | Hours before a plan checkpoint expires             |
| `CHECKPOINT_DIR`               | `.assignee` | Directory for checkpoint files                     |
| `SCHEMA_EXCERPT_MAX_CHARS`     | 3000        | Max characters of CFN schema sent to Bedrock       |
| `AUTO_CLEANUP_INTERVAL_MS`     | 3600000     | Auto-cleanup throttle (1 hour)                     |
| `MEMORY_MAX_PROVISIONS`        | 200         | Max provision records in memory rotation           |
| `MEMORY_MAX_FAILURES`          | 100         | Max failure records in memory rotation             |
| `MEMORY_MAX_PATTERNS`          | 100         | Max pattern records in memory rotation             |
| `EXTENDED_POLL_TIMEOUT_MS`     | 1200000     | Extended timeout for RDS/ELBv2/NatGateway (20 min) |

## State Directories

| Path                          | Purpose                                                                                                                |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `~/.assignee/`                | Global state directory (created on first run)                                                                          |
| `~/.assignee/memory/`         | Provision logs, failure records, pattern history (all writes use `acquireLock` + `atomicWrite` for concurrency safety) |
| `~/.assignee/audit/`          | HMAC-chained audit log (JSONL). Verified by `assignee audit-verify`. Key set via `ASSIGNEE_AUDIT_KEY`.                 |
| `~/.assignee/baselines/`      | Drift baselines adopted via `assignee drift --baseline <arn>`. Plain JSON; delete directly to drop a baseline.         |
| `.assignee/`                  | Project-level checkpoint and config directory                                                                          |
| `.assignee/config.yaml`       | Project configuration                                                                                                  |
| `.assignee/checkpoint-*.json` | Saved plan checkpoints                                                                                                 |

## Credentials

Assignee.ai uses an explicit, least-privilege credential model and **intentionally bypasses** the AWS SDK default credential provider chain. Plan, apply, destroy, and setup commands resolve credentials in the following order:

1. **`ASSIGNEE_OPERATOR_ACCESS_KEY_ID` + `ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY`** (preferred) — the dedicated operator IAM user created by `assignee setup`. This is the production path; reader and auditor roles use the matching `ASSIGNEE_READER_*` / `ASSIGNEE_AUDITOR_*` variables.
2. **`AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY`** (developer fallback) — auto-promoted to the operator role at process start. The CLI prints a one-line warning encouraging you to switch to dedicated operator credentials. If `AWS_SESSION_TOKEN` is set it is also promoted to `ASSIGNEE_OPERATOR_SESSION_TOKEN`.
3. **None** — the command fails fast with a `ConfigurationError` listing both supported forms and pointing at `assignee setup`.

### `AWS_PROFILE` — SSO support and limitations

`AWS_PROFILE` is now honored by `assignee init` for AWS SSO / Identity Center profile resolution. When set, the init wizard surfaces the matched profile's SSO session and lets you confirm before writing config.

For **provisioning commands** (`plan`, `apply`, `destroy`, `setup`) `AWS_PROFILE` alone is still **not sufficient**. These commands resolve credentials in the order listed above and intentionally bypass the AWS SDK default credential provider chain. The reason: assignee validates credentials at process start and requires a stable access-key pair; profile-based STS sessions don't provide that lifetime guarantee, and silently falling through to `~/.aws/credentials` could leak operations onto a developer's personal or root identity.

If you currently use `AWS_PROFILE` for provisioning, you have two options:

- **Recommended:** run `assignee setup` once to create the three least-privilege IAM users (`assignee-operator`, `assignee-reader`, `assignee-auditor`) and export their access keys.
- **Quick fallback:** export `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and (if using SSO) `AWS_SESSION_TOKEN` directly in your shell — the CLI will auto-promote them to the operator role for the duration of the process. `AWS_SESSION_TOKEN` is also promoted to `ASSIGNEE_OPERATOR_SESSION_TOKEN` automatically.

The same resolution sequence is documented in the `command-runner.ts` JSDoc and is the single source of truth for credential behavior. See [`how-to/sso-authentication.md`](how-to/sso-authentication.md) for a full SSO walkthrough.

## Setup Wizard

Run `assignee init` or `assignee init --global` for an interactive setup wizard. Both wizards auto-detect existing credentials and region, and prompt before overwriting existing config files.

```bash
# Project config
assignee init

# Global user config
assignee init --global
```

---

## Appendix — Planned but not implemented

The configuration surface below describes design intent. None of the
items in this appendix is parsed by the current schema in
[`packages/core/src/config/config-schema.ts`](../packages/core/src/config/config-schema.ts);
setting them has no effect today. The docs above point at this appendix
rather than embedding "planned but not yet implemented" disclaimers
inline.

| Surface                                                                                                            | Status today                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `bestPractices.excludePatterns`                                                                                    | Not parsed. Today's BP control surface is `preferences.auto_fix` and `ASSIGNEE_BP_INTEGRITY`.                                            |
| `bestPractices.enforcement` / `bestPractices.autoFix` (config-file forms)                                          | Not parsed. The same controls are exposed today via env vars and `preferences.auto_fix`.                                                 |
| `llm.plan_generator` / `llm.intent_parser` / `llm.advice_generator` / `llm.workload_classifier` (per-node routing) | Not parsed. The factory sites that would read them were never built; only `llm.default` (or `ASSIGNEE_LLM_DEFAULT`) is honoured.         |
| `ASSIGNEE_LLM_PLAN_GENERATOR` / `_INTENT_PARSER` / `_ADVICE_GENERATOR` / `_WORKLOAD_CLASSIFIER`                    | Not read. The dead env-var constants have been removed.                                                                                  |
| `ASSIGNEE_OIDC_ADAPTER`                                                                                            | Reserved. Today's absence triggers the "OIDC not configured; using AWS_PROFILE SSO" message in `assignee init`; nothing reads the value. |
| Org-policy `fetch-from-SaaS` source                                                                                | Not implemented. Only local-file `org_policy:` blocks under user/project config are read.                                                |
| Release-pipeline gates (`ASSIGNEE_RELEASE_PUBLISH=1`, `ASSIGNEE_TAP_PUBLISH=1`)                                    | Read by `.github/workflows/release.yml`, never flipped on this course-submission build, so all release outputs run dry-run.              |
