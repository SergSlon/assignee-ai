# OSS vs SaaS — design intent

> Diátaxis: **explanation** (understanding-oriented). This document
> describes the **design intent** for which parts of Assignee.ai would
> stay open-source and which would live behind a paywall in a future,
> hypothetical SaaS productisation. It is not a price commitment for
> this course-submission build; no SaaS product exists, no concrete
> pricing has been chosen, and no monetisation plan is in flight today.
> Read this as architectural framing, not as a sales document.

## Status for this build

- The CLI source tree, the LangGraph pipeline, the MCP server, the
  bundled best-practice rules, and the bundled compound patterns are all
  MIT-licensed (see [LICENSE](../../LICENSE)). They will stay MIT-licensed
  even if any future productisation work happens.
- A handful of features described below as "what would live behind the
  paywall" are partially scaffolded in the source tree (RBAC, OIDC port,
  HMAC audit chain). None of them are enforced at command boundaries
  today, and none of them constitute a paid tier — they are present so
  the architecture is inspectable.
- No public release has been published to npm or Homebrew; all four
  workspace packages are marked `"private": true`.

## What stays MIT, by design

The credential-handling code is the part a security team would want to
audit; it is open and stays open.

### CLI core, ports, and adapters

The `assignee` CLI binary, the 15-node LangGraph pipeline, the seven
hexagonal ports under `packages/core/src/ports/`, and the MCP server
(`apps/mcp-server`) are MIT-licensed. That includes:

- **Every AWS credential path** — `operatorCredentials()`,
  `readerCredentials()`, `auditorCredentials()`. Anyone auditing
  credential flow can trace it in a single read of the source.
- **Every provisioning call** — the CloudControl dispatcher, the
  fallback path, the error hint registry, the run-ledger writer.
- **Every BP evaluator code path** — the YAML loader, the Zod schema,
  the trigger language, the auto-fix patch application, the interactive
  fix UX.

### Best-practice rules and compound patterns

The rule library at [`packages/best-practices/`](../../packages/best-practices)
is MIT-licensed. Community contributions are welcome (see
[`CONTRIBUTING.md § Contributing a Best-Practice Rule`](../../CONTRIBUTING.md#contributing-a-best-practice-rule)).
The bundled compound patterns (`serverless-api`, `static-website`,
`efs-with-vpc`, `vpc-networking`, `vpc-public-only`, `lambda-with-exec-role`,
`scheduled-lambda`, `message-processing`, `container-service`,
`three-tier-web`, `websocket-api`, … — around a dozen, see
[`packages/core/src/pattern-templates/index.ts`](../../packages/core/src/pattern-templates/index.ts)
for the live registry) live alongside the rules and are MIT-licensed
for the same reason: they are reusable knowledge, not a monetisation surface.

### Cost preflight, mandatory tagging, BYOK Bedrock

The Pricing MCP integration, the pricing strategies, the free-tier
detection, the budget-guard pre-confirm check — all open. The
mandatory-tag injector (`managed-by` + `assignee-run-id` + `environment`)
is open. The Bedrock adapter wraps the AWS SDK with region/availability
hints and token-cost telemetry; users always bring their own AWS account
and their own Bedrock model access. There is no Assignee-operated LLM
endpoint and no plan to build one on the OSS side.

### Single-user run-ledger

The local run-ledger (tags + memory records + checkpoint files) stays
open. See [`run-ledger-design.md`](./run-ledger-design.md) for the
current capabilities and deferred work.

The key OSS property: **no Assignee-operated server is in the loop**.
Every bit of state lives in the user's AWS account (resource tags) or
the user's local filesystem (`~/.assignee/memory/`).

## Features deferred to future productisation (design intent only)

The features below are noted as _design intent_ — they describe the
shape of work that _could_ happen if the project were productised. They
are not committed for this course-submission build, and no concrete
pricing has been attached to any of them.

### Multi-user org + RBAC + SSO

Single-user CLI work is the current scope. Multi-user role-based access
control and SSO (Okta, Azure AD, generic OIDC) are out of scope for the
course submission.

**Scaffolding present today.** `packages/core/src/rbac/` ships the Zod
policy schema, in-memory and file-backed policy stores, and a role-context
resolver. Five fixture policies (admin / operator / read-only / auditor /
restricted) are committed. `packages/core/src/ports/oidc-port.ts`
defines the `OIDCPort` interface. Neither is enforced at CLI command
boundaries yet — enforcement would be future work.

### Signed-intent audit trail

The local HMAC-chain audit log (`packages/core/src/audit/`) is the open
foundation: it chains every audit record to its predecessor with
`HMAC(key, prevHmac || record_serialised)` and a verifier that reports
the first-broken index.

Possible future extensions (not built): a KMS-anchored signature at
apply time, S3 Object Lock storage, and a CloudTrail integration.
These are sketched in [`audit-threat-model.md`](./audit-threat-model.md).

### Org-wide policy-as-code

BP rules are already data today — a future extension could be a central
policy store that every CLI instance in an org pulls from. Team-wide
deny rules ("no public S3 buckets in any account", "no unencrypted RDS")
enforced from a central control plane instead of per-workstation
config. The OSS rule format would be re-used as-is; only the
distribution layer would be added.

### Anonymised provisioning telemetry

The opt-in telemetry design ([`telemetry-design.md`](./telemetry-design.md))
is sketched on the open side; usage-telemetry is not implemented today
and there is no operated endpoint. Opt-in would be mandatory on either
side; there is no telemetry path that fires without explicit user consent.

### Drift detection + continuous reconciliation

The OSS run-ledger is a snapshot — the resource tags + provision
records at the moment of apply. Drift is what happens after: someone
edits the S3 bucket policy in the AWS console, or a Terraform import
re-tags a resource, or IAM permissions get rotated. Drift detection
(comparing live state against the desired-state hash in the provision
record) is sketched as future work; the current build ships read-only
drift inspection commands but no continuous reconciliation loop.

### Curated compliance rule packs

Curated, maintained, legally-defensible rule sets for specific compliance
regimes (SOC 2, PCI-DSS, HIPAA, FedRAMP) take dedicated maintenance.
A future `assignee bp install <pack-name>` flow could distribute such
packs. This is design intent; no packs have been built.

## Explicit non-goals (for any future productisation)

If the project is ever productised, these lines are intended to stay on
the open side, to keep the OSS surface whole:

- Access to the bundled BP rules — they stay free.
- Access to the bundled compound patterns — they stay free.
- Cost preflight — the pre-confirm cost estimate stays free.
- A "pro" version of the CLI binary — the binary is one build, MIT,
  with no feature flags gated on a license server.
- Plan generation throttling — no rate limit on `assignee infra plan`.

## Related reading

- [`run-ledger-design.md`](./run-ledger-design.md) — single-user ledger
  design.
- [`telemetry-design.md`](./telemetry-design.md) — the opt-in telemetry
  design.
- [`contributing-a-bp-rule.md`](./contributing-a-bp-rule.md) — the
  contribution on-ramp for new BP rules.
