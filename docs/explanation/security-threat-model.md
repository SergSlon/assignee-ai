# Assignee.ai Security Threat Model

**Status**: v1.0-rc.1 baseline (replaces 108-A-06 stub)
**Last reviewed**: 2026-05-18
**Scope**: this document covers the v1.0 surface of Assignee.ai as a
developer tool installed locally and run against an AWS account the
operator owns. It is sized for a developer-tool threat profile, not
for a regulated-environment runtime (HIPAA, PCI, FedRAMP).

## 1. Scope, assumptions, threat-actor model

### 1.1 What's in scope

- The `assignee` CLI binary (npm-published, `apps/cli`) running on a
  developer workstation.
- The `@assignee/mcp-server` (`apps/mcp-server`) when launched as an
  MCP tool by a Claude Code session.
- The graph orchestration + LLM-adapter + provisioning paths inside
  `@assignee/core`.
- Communication with AWS APIs (CloudControl, CloudFormation, the 38
  resource-type-specific control planes) and with the configured LLM
  provider (default: Amazon Bedrock).
- The supply chain that ships the CLI to operators (npm registry +
  GitHub Actions release workflow).

### 1.2 What's out of scope

- The security of the operator's workstation OS, terminal session,
  or shell history. If an attacker has root/Administrator on the
  workstation, every assumption in this document collapses; that's
  not a problem this tool can solve.
- Side-channel attacks against the LLM provider (Bedrock model
  inversion, prompt-injection of upstream training data, etc.).
- Multi-tenant SaaS deployment. Assignee.ai v1.0 is single-operator
  by design. A future SaaS deployment will require its own threat
  model — see § 8 "Out-of-scope for v1.0".

### 1.3 Threat-actor model

| Actor                                                                   | Capability                                                                                                                          | Mitigation surface                                                                                                                                                                                              |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Honest operator**                                                     | Owns the AWS account; runs the CLI for legitimate IaC ops. Default mental model for every flow.                                     | Plan-then-apply gating; cost-leading plan output; preflight guards.                                                                                                                                             |
| **Curious operator**                                                    | Honest, but unfamiliar with AWS pricing or destruction blast radius. Most user-visible safety features target this actor.           | Pricing summary at plan time, destroy confirmation prompts, bulk-destroy IAM allowlist, --dry-run defaults.                                                                                                     |
| **Malicious local user**                                                | Has shell on the workstation but not root; can run the CLI with the operator's credentials.                                         | Out of scope — operator's workstation hygiene is upstream of this tool. The CLI carries no privilege elevation.                                                                                                 |
| **Attacker controlling the LLM endpoint**                               | Compromised Bedrock account or man-in-the-middle on the LLM API. Could attempt to coerce the LLM into emitting destructive intents. | Plan-then-apply boundary (LLM never directly invokes AWS); strict JSON-schema validation of LLM output; preflight guards run after LLM and reject obviously-wrong shapes (placeholder ARNs, IAM self-lockouts). |
| **Attacker controlling the npm registry**                               | Compromised maintainer credentials, malicious dep substitution, or registry-side tampering.                                         | npm provenance (sigstore attestation via OIDC); pnpm `auditConfig` + lockfile; pinned third-party transitive deps via overrides; no `npm_config_*` install scripts in production deps.                          |
| **Attacker controlling a Claude Code session that uses the MCP server** | Could attempt to coerce the MCP server into describing or destroying resources the human operator didn't authorize.                 | MCP server credential resolution is lazy-per-server (reader/auditor roles only, never operator); MCP tool surface excludes mutating verbs by design.                                                            |

### 1.4 Compliance baseline

Assignee.ai v1.0 is a **developer tool**. The threat model is sized
for that scope — we assume the operator owns or has been delegated
authority over the AWS account the tool acts on, and that the
operator's workstation is hardened to that organization's normal
standards. No claim is made for HIPAA, PCI, FedRAMP, or SOC-2
deployment as currently shipped.

A future SaaS deployment (multi-tenant control plane) will require:

- Per-tenant IAM role isolation
- Separate signed attestation of plan + apply provenance
- Persistent audit log with tamper-evident chaining (foundation
  already in place — see § 4.3 below)
- Re-evaluation of every section here against the multi-tenant
  threat model

## 2. Trust boundaries

The CLI has four trust boundaries; each is crossed by a small number
of well-defined surfaces.

### 2.1 CLI ↔ AWS API

**Boundary**: every AWS API call from the CLI or MCP server.

**Trust direction**: outbound only. AWS APIs are trusted to be
correctly authenticated, replay-protected, and TLS-encrypted by the
AWS SDK. The CLI does not implement its own AWS API client.

**Defenses**:

- AWS SDK v3 with default credential providers (env vars, profile,
  EC2/ECS metadata, SSO).
- Region pinning: every CLI invocation requires an explicit
  `AWS_REGION` (defaults reject with a clear error rather than
  silently using us-east-1).
- Partition-aware ARN matching (`/^arn:aws[\w-]*:/`) — covers
  GovCloud + China partitions, not just commercial AWS.
- Placeholder ARN preflight guard — LLM-hallucinated
  `arn:aws:iam::123456789012:...` strings are rejected before
  reaching CloudControl.

### 2.2 CLI ↔ LLM provider (Bedrock by default)

**Boundary**: every prompt + response that crosses the LLM API.

**Trust direction**: outbound prompt is untrusted by the CLI (LLM
output is never executed verbatim); response is treated as
machine-validated structured JSON or rejected.

**Defenses**:

- **Plan-then-apply boundary**: the LLM produces a plan-data object;
  it never executes the plan. Apply is a separate, deterministic
  step run by the CLI after operator review.
- **Strict JSON schema** on LLM output: malformed responses fall
  through to LLM-error UX (operator sees the validation failure)
  rather than silently being acted on.
- **Cost-leading plan output**: the plan box surfaces estimated
  monthly cost FIRST, before the operator can approve apply — an
  LLM producing an unexpectedly expensive plan (e.g. NAT Gateway
  cascade) becomes visible.
- **Token-cost telemetry**: every LLM call is tagged with a callsite
  ID so an attacker driving up token cost via prompt manipulation
  is greppable in `~/.assignee/logs/`.
- **Region availability errors are surfaced with actionable hints**
  — `LlmAdapter` wraps Bedrock region/availability errors with the
  current `AWS_REGION` + a suggested fix.

### 2.3 CLI ↔ MCP server

**Boundary**: the JSON-RPC over stdio channel between Claude Code
(or another MCP client) and `@assignee/mcp-server`.

**Trust direction**: bi-directional structured RPC. The MCP server
treats inbound tool-call arguments as untrusted (validated against
Zod schemas) and treats outbound responses as already-validated
domain types.

**Defenses**:

- **Lazy-per-server credential resolution** with try/catch per
  server. Eager resolution (the original design) broke operator-only
  flows when the reader/auditor roles weren't configured.
- **No mutating verbs in the MCP tool surface**. The MCP server can
  `describe`, `list`, `audit-verify`, `plan` (read-only), but does
  not expose `apply` or `destroy`. An attacker who compromises the
  Claude Code session can read but not mutate.
- **Schema validation** at every RPC boundary using
  `@modelcontextprotocol/sdk` + project-local Zod schemas.

### 2.4 CLI ↔ local filesystem

**Boundary**: every file read/write under `~/.assignee/` (config,
logs, credentials backup, audit log, HMAC keys).

**Trust direction**: outbound only. The CLI assumes it owns the
`~/.assignee/` tree; another process writing to it is treated as
tampering.

**Defenses**:

- **File mode 0o600 for sensitive files** (HMAC keys, credentials
  cache, audit log, lock files). On NTFS this is a no-op — Windows
  enforcement relies on NTFS ACLs which are out of scope; the v1.0
  Windows experience is "best-effort" (see `RELEASE_CHECKLIST.md`
  RR-12 + the `experimental: true` matrix flag in
  `ci-cross-platform.yml`).
- **Directory mode 0o700** for `~/.assignee/` and child dirs.
- **`fsync` after critical writes** (audit log, HMAC chain). On
  Windows runners that reject fsync with EPERM, the call is wrapped
  in try/catch and downgrades to a non-fsync write with a one-time
  stderr warning. This is acceptable on Windows-developer
  workstations because the audit log is for operational debugging,
  not regulated retention.
- **Atomic writes** for plan checkpoints (write-temp-then-rename).
- **HMAC-chained audit log** — every entry includes a SHA-256 hash
  of the previous entry's payload + the new entry's payload, keyed
  by a per-installation HMAC secret. Tampering with an entry
  invalidates every entry after it.

## 3. Credentials handling

### 3.1 The three IAM roles

Assignee.ai provisions three IAM users (or assumes three IAM roles,
in the SSO path) for runtime separation:

| Role         | Capability                                                                        | Used by                                 |
| ------------ | --------------------------------------------------------------------------------- | --------------------------------------- |
| **operator** | Create/Update/Delete on the 38 supported resource types + bulk-destroy guardrails | `apply` / `destroy` / `reconcile`       |
| **reader**   | Describe / List on every supported type                                           | `plan` / `list` / `status` / MCP server |
| **auditor**  | CloudTrail event read + IAM role enumeration + audit-log verification             | `audit-verify` / `doctor` / MCP server  |

The operator role is the only one that can mutate. Plan flows use
reader. MCP flows use reader + auditor. This separation is enforced
at the SDK-client construction layer: each invocation explicitly
selects a role, and the wrong role's credentials being present
returns a deterministic `MissingAssigneeCredentialsError` rather
than silently degrading to the operator credentials.

### 3.2 The fail-closed guard

`requireAssigneeCredentials()` throws a typed error naming both env
vars (`ASSIGNEE_OPERATOR_ACCESS_KEY_ID` +
`ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY`) before any AWS SDK call. This
is the canonical "did you run `assignee dev setup`?" failure mode.
Tests in `resource-provisioner/__tests__/` exercise this path for
every mutating operation.

### 3.3 SSO + AWS_PROFILE alternative

For SSO users, raw access keys are never required. The CLI accepts
`AWS_PROFILE` and uses the AWS SDK's default credential provider
chain. This bypasses the three-role separation (SSO sessions
typically run as a single principal) — that trade-off is documented
in `docs/how-to/sso-authentication.md`. SSO users get the same
plan-then-apply boundary but lose the IAM-role-level least privilege.

### 3.4 MCP credential resolution

Each MCP server invocation resolves credentials lazily, per server,
with try/catch. If only operator credentials are configured (the
common case for solo developers), the MCP server's reader-role
resolution returns `MissingAssigneeCredentialsError` and that
specific tool fails fast with a clear message. The MCP session
continues; other operator-credentialed flows still work.

## 4. Telemetry boundary

### 4.1 Opt-in by default

`packages/core/src/telemetry/otel-exporter.ts:isOtelEnabled()` gates
every emission on the `ASSIGNEE_OTEL_ENDPOINT` env var. Absent or
empty → no-op; zero network calls; zero file writes outside the
local JSONL log. This is verified by the doctor command's Axis H
test in
`apps/cli/src/commands/doctor/checks/__tests__/intent-routing-health.test.ts`.

### 4.2 Local JSONL log

A local file at `~/.assignee/logs/cli-<date>.jsonl` records
operational events (intent routing path, LLM-call cost, preflight
guard hits). This file is local-only and 0o600 on POSIX; it is
never transmitted off the workstation unless the operator explicitly
configures an OTEL exporter via `ASSIGNEE_OTEL_ENDPOINT`.

The `doctor` command's intent-routing-health check reads this log
to surface miss-rate trends. If the log is absent or corrupt, the
check reports "telemetry not enabled" rather than failing.

### 4.3 Audit log (separate from telemetry)

The audit log at `~/.assignee/logs/audit-<date>.jsonl` is HMAC-chained
and records every provisioning event (which resources were created /
updated / destroyed under which run-id). It is required for the
`audit-verify` / `restore-provisions` commands. It is NOT controlled
by the `ASSIGNEE_OTEL_ENDPOINT` opt-in — it is always-on, because
operators rely on it for replay and reconciliation. The audit log
is local-only by the same mechanism as telemetry; no transmission
off-workstation.

## 5. Plan/apply isolation

### 5.1 The plan-then-apply boundary

Every mutating CLI flow has two phases:

1. **Plan**: read-only. Produces a structured plan-data object that
   includes desired-state, estimated cost, preflight findings, and
   any best-practice advisories. No AWS mutation occurs.
2. **Apply**: takes a previously-produced plan as input. Applies
   each resource via CloudControl or the type-specific control
   plane. Apply CANNOT be invoked with a "fresh" intent — only with
   a plan that the operator has already reviewed.

This separation gives the operator a deterministic review surface
even when an LLM produces the plan. Apply is reproducible: the same
plan produces the same AWS calls.

### 5.2 Preflight guards

Before any apply, a set of preflight guards run against the plan:

- **Lambda IAM autorole** — if the operator's Lambda function intent
  doesn't include an IAM role, the guard either auto-creates a
  least-privilege role or fails with a clear "specify a role" error.
  Prevents the LLM from emitting a Lambda function with a
  placeholder IAM role ARN.
- **RDS subnet group + security group sanity** — RDS instances
  emitted by the LLM are checked for valid subnet group + SG
  references against the current VPC topology. Mismatch → advisory
  message, not silent apply failure.
- **Placeholder ARN preflight guard** — any string in the plan
  matching the common LLM-hallucinated placeholder ARN pattern
  is rejected at plan time.
- **ACCESS_DENIED classifier** — when a CloudControl call fails
  with AccessDeniedException, the structured-error classifier maps
  the failure to a specific advice string (operator's IAM role
  missing the required permission). The classifier handles all
  partition variations (`arn:aws-cn`, `arn:aws-us-gov`, etc.).

### 5.3 ARN partition awareness

Every ARN-matching regex in production code uses
`/^arn:aws[\w-]*:/` not the literal `/^arn:aws:/`. This covers:

- `arn:aws:...` (commercial AWS)
- `arn:aws-cn:...` (China partitions)
- `arn:aws-us-gov:...` (GovCloud)

A GovCloud or China-region operator running the same CLI gets the
same safety properties.

## 6. Destroy safety

### 6.1 Bulk-destroy IAM allowlist

`assignee infra destroy --all --include-iam` is the highest-blast-
radius operation. To prevent self-lockout, the bulk-destroy code
path unconditionally excludes the following IAM identities from any
sweep:

- `AssigneeOperator`, `AssigneeReader`, `AssigneeAuditor` (the three
  managed roles)
- `AssigneeBedrock*` (the LLM-access role)

An operator who runs `--include-iam` AFTER setup cannot delete
their own access to the CLI. The allowlist is hard-coded; there is
no flag to override it within v1.0.

### 6.2 Destroy confirmation gate

`assignee infra destroy --all --yes --no-confirm` is the only path
that bypasses interactive confirmation. Even with both flags, the
CLI inspects the resource list against a "today's session"
heuristic (resources tagged with the current run ID) and prompts
for explicit re-confirmation on any resource that doesn't match —
a memory of a costly mistake (see operator-memory note on
bulk-destroy inspection).

### 6.3 Non-taggable pre-delete hooks

Some AWS constructs (Internet Gateway attachments, Subnet route
table associations) are not directly addressable by tag — they're
implicit associations between two taggable resources. The destroy
strategy for these resources runs a pre-detach/disassociate hook
before calling CloudControl delete, otherwise the delete fails with
"DependencyViolation" on the parent. This is handled deterministically
by the destroy-strategies in `packages/core/src/destroy-strategies/`.

### 6.4 CloudControl NotFound short-circuit

CloudControl's tag API caches resource state for ~1 hour after
delete. A back-to-back delete + describe can return "not found" for
a resource that was successfully deleted moments ago. The destroy
flow treats CCAPI `NotFound` (both `deleteResource` error AND poll
`FAILED + ErrorCode=NotFound`) as destroy success rather than
retrying-and-failing-loudly.

## 7. Supply chain

### 7.1 npm provenance

The release workflow at `.github/workflows/release.yml:278` runs
`pnpm -r publish --access public --provenance --no-git-checks`. The
`--provenance` flag attaches a sigstore attestation to every
published tarball via OIDC `id-token: write` permission on the
publish-npm job. No long-lived `NPM_TOKEN` secret is required;
short-lived OIDC identity tokens drive the signature.

A dedicated `generate-provenance` job emits SLSA-compatible build
attestations alongside the tarball, so consumers can verify the
provenance trail via standard SLSA tooling.

### 7.2 Third-party attribution

`THIRD-PARTY-NOTICES.md` is auto-generated by `scripts/generate-notice.ts`
from the resolved pnpm lockfile. As of 2026-05-18 the production
dependency tree is 310 packages with 100% permissive licenses
(MIT / Apache-2.0 / ISC / BSD / 0BSD / Python-2.0 / multi-license
permissive). Zero copyleft or unlicensed entries.

The script is run on every release and the file's hash is part of
the published tarball.

### 7.3 Override rationale

`pnpm.overrides` in `package.json` pins 20 transitive deps to
patched versions for known CVEs. Every override has a rationale
entry in `package.json.overrides-rationale.md` enforced by
`scripts/audit-overrides.ts` (runs in CI on every push). Adding an
override without a rationale fails CI.

`pnpm.auditConfig.ignoreCves` carries 2 entries (CVE-2026-41650 for
fast-xml-parser + CVE-2026-45134 for langsmith). Each is documented
in the same rationale file with the specific exposure analysis
explaining why our resolved version is not vulnerable.

### 7.4 Git history hygiene

A real 12-digit AWS account-ID that was committed to the repo during
development was purged from published history via `git filter-repo`
in Story 108-A-04. The published `origin/main` returns zero hits for
the literal ID. Local-only safety refs (intentionally retained as
disaster-recovery state) preserve the pre-rewrite history; these
refs are never pushed (enforced by a refname guard in
`.husky/pre-push` — see Quinn epic-108-close finding F-06).

### 7.5 Pre-publish gate

`apps/cli/package.json` stays `"private": true` until every item in
`RELEASE_CHECKLIST.md` is checked AND the operator manually flips
the flag. The CI workflow `check-release.yml` parses the checklist
on `workflow_dispatch` and fails if any BLOCKING item is unchecked.

## 8. Out-of-scope for v1.0

These threats are explicitly out of scope and deferred to a future
SaaS-deployment threat model:

- **Multi-tenant isolation** — the CLI assumes a single operator.
  A SaaS deployment will need per-tenant IAM role separation and
  per-tenant audit-log signing.
- **Build-time attestation of the npm tarball** — npm provenance
  attests publication, not the build pipeline that produced the
  tarball. A SLSA L3+ trail requires the build to happen in a
  hermetic builder, which the current GitHub Actions setup does not
  provide. The current SLSA level is L2 (build provenance via
  hosted runners).
- **Cryptographic verification of the LLM provider's output** —
  Bedrock's response is not signed. An attacker with TLS-MITM
  capability between the CLI and Bedrock could substitute a malicious
  plan. Mitigated by the plan-then-apply boundary + operator
  review; not eliminated.
- **Side-channel cost attacks** — an adversary who controls the
  prompt corpus could attempt to drive up token cost. Telemetry
  callsite tagging makes this visible to the operator but does not
  prevent it.
- **Insider threat from a malicious maintainer** — a maintainer
  with publish rights could ship a backdoor. Mitigated by signed
  commits + branch protection requiring PR review + reviewer-skip
  BAN enforced by pre-push hook; not eliminated (a maintainer with
  admin rights can disable these). The standard advice applies: keep
  the maintainer set small and audit it regularly.

## 9. Review cadence

This document is part of the v1.0 release gate. It should be
re-reviewed:

- Before any minor-version bump that adds a new resource type or
  changes the LLM-output schema.
- After any change to the IAM role definitions or the bulk-destroy
  allowlist.
- After any incident involving the CLI in a customer environment.
- Annually as part of the project's security cadence (independent
  of release schedule).

## 10. References

- `RELEASE_CHECKLIST.md` — the v1.0 publish gate.
- `_archive/dogfood-sessions/git-history-purge-sign-off.md` — RR-2
  evidence + retained-ref documentation.
- `_archive/dogfood-sessions/rr-7-license-audit-2026-05-18.md` —
  RR-7 evidence.
- `_archive/dogfood-sessions/rr-8-rr-11-audit-2026-05-18.md` —
  RR-8 / RR-11 / Bob retro evidence.
- `_archive/dogfood-sessions/external-dogfood-template.md` — RR-10
  external dogfood sign-off template.
- `_backlog/cross-platform-windows-residual-failures.md` — known
  Windows-specific gaps + the experimental:true rationale.
- `apps/cli/scripts/PROBE_MANIFEST.yaml` — runtime invariants
  checked by pre-close-probes (post-merge gate).
- `packages/core/src/telemetry/otel-exporter.ts` — opt-in telemetry
  gate.
- `packages/core/src/audit/audit-log.ts` — HMAC-chained audit log
  implementation.
