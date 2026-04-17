# Invariants — rules assignee.ai enforces that are not obvious from code

New contributors repeatedly re-discover the same load-bearing rules.
This page is the single canonical list. Each entry cites the enforcing
code path so the invariant stays honest: if the code moves, update the
citation here. If the code is deleted, delete the entry.

These come directly from multi-wave adversarial reviews and the
maintainer's working notes (filenames cited inline as `feedback_*.md`
hints — see internal coordinator notes for the source of those files).
Read them before touching ARN handling, destroy paths, credential
plumbing, or the redaction pipeline.

---

## Partition-aware ARN matching

**Rule.** Never match ARNs with the literal prefix `arn:aws:` or the
enum `ArnPrefix.AWS`. Always use the regex `/^arn:aws[\w-]*:/` (or the
shared constant `ARN_PATTERN_SOURCE`). Hard-coding `arn:aws:` silently
breaks GovCloud (`arn:aws-us-gov:…`), China (`arn:aws-cn:…`), and the
ISO partitions.

**Why.** Customers running assignee in GovCloud or ISO partitions have
valid ARNs that start with `arn:aws-us-gov:`. A plan generator or
redactor that matches `arn:aws:` over-rejects or over-leaks.

**Where it's enforced.**

- `packages/core/src/config/aws-partition.ts` — canonical helper
- `apps/cli/src/utils/error-messages.ts` — redaction regex
  (`ARN_PATTERN`)
- `packages/core/src/plugins/*` — every validator that uses
  `ARN_PATTERN_SOURCE` rather than string literals

**Source memory.** `feedback_partition_aware_arn_matching.md`

---

## CCAPI NotFound short-circuit

**Rule.** Treat both forms of CloudControl `NotFound` during destroy
as success:

1. Synchronous `ResourceNotFoundException` from `DeleteResource`.
2. Status poll returning `FAILED` with `ErrorCode=NotFound`.

**Why.** AWS caches tag-API responses for up to an hour after a
delete. A user can see the ghost in `list`, try to destroy it, and hit
either failure mode. Treating both as success keeps destroy idempotent.

**Where it's enforced.**

- `apps/mcp-server/src/tools/destroy-resource.ts`
- `apps/cli/src/services/destroy-service.ts`

**Source memory.** `feedback_cloudcontrol_notfound_short_circuit.md`

---

## Placeholder ARN preflight

**Rule.** Reject any ARN containing the literal
`arn:aws:iam::123456789012:` (or the same 12-digit "123…012" placeholder
in any partition) at preflight, before it reaches CloudControl.

**Why.** That account ID is the canonical AWS documentation example —
LLMs hallucinate it reliably. Letting it through silently creates
cross-account references that fail at apply time with confusing
errors.

**Where it's enforced.**

- `packages/core/src/graph/nodes/preflight-guard/guards/placeholder-arn.ts`
  (canonical); `apps/cli/src/nodes/preflight-guard.ts` is a thin
  re-export shim.

**Source memory.** `feedback_placeholder_arn_preflight_guard.md`

---

## Preflight fail-closed on auth (with opt-in unknown-error escalation)

**Rule.** ManagedPolicyArn verification (preflight for `AWS::IAM::Role`)
is **always fail-closed** on AWS session-auth failures (ExpiredToken,
InvalidClientTokenId, SignatureDoesNotMatch, TokenRefreshRequired, HTTP 401) — both on the per-ARN `iam:GetPolicy` call and on IAM-client
construction itself. Truly unknown errors (e.g. transient network
blips) default to **unverified + WARN** (fail-open) so a single ARN's
network hiccup cannot abort an entire plan for local CLI users.
Operators running a stricter posture (SaaS multi-tenant, regulated
tenants) can opt in by setting `ASSIGNEE_PREFLIGHT_UNKNOWN_BLOCKS=1` to
escalate unknown errors to fail-closed. Throttling retry-3× and
per-ARN `AccessDenied` paths are **unaffected** by the flag — they are
rate-limit / permission signals, not verification anomalies.

**Why.** Wave 4 F2 P0-R2-1: stale credentials must never let a
hallucinated ARN slip past preflight just because STS expired. The
fail-open default for unknown errors is intentional — a one-off
network blip on a single ARN should not kill a plan a local user is
actively iterating on. SaaS tenants, however, want the strictest
possible posture on any verification anomaly; the env flag gives them
that without forcing it on everyone.

**Where it's enforced.**

- `packages/core/src/graph/nodes/preflight-guard/guards/managed-policy.ts`
  — per-ARN auth / AccessDenied / Throttling / unknown branches and the
  outer client-construction auth branch. The
  `ASSIGNEE_PREFLIGHT_UNKNOWN_BLOCKS=1` check sits inside the unknown
  (`else`) branch _after_ auth / NoSuchEntity / AccessDenied /
  Throttling so strict mode can never demote those signals.

**Source memory.** `feedback_placeholder_arn_preflight_guard.md`
(context). Story 48.3 added the opt-in escalation flag.

---

## IAM role RGTA gap

**Rule.** Always enumerate IAM roles via `iam:ListRoles` +
`iam:ListRoleTags` as a parallel listing path — the Resource Groups
Tagging API **does not** return IAM roles regardless of tags.

**Why.** Assignee-managed IAM roles would be invisible to `list` /
`drift` / `bulk-destroy` if we trusted RGTA alone. This is a silent
AWS quirk, not a bug you'd catch in unit tests.

**Where it's enforced.**

- `apps/cli/src/services/iam-role-inventory.ts`

**Source memory.** `feedback_iam_role_rgta_gap.md`

---

## Lazy credential resolution in MCP

**Rule.** MCP config builders resolve credentials lazily per-server
with `try/catch`. Eager credential resolution breaks operator-only
flows where some servers (billing, cost-explorer) can't be reached
but the operator still needs pricing / docs.

**Why.** A single missing-credential failure must not abort the entire
MCP boot — downstream commands that don't need that server still
deserve to run.

**Where it's enforced.**

- `apps/cli/src/config/mcp-servers.ts`

**Source memory.** `feedback_lazy_credential_resolution_in_mcp.md`

---

## Destroy pre-delete hooks for non-taggable constructs

**Rule.** IGW and RouteTable destroy paths need pre-detach /
pre-disassociate hooks before calling `DeleteResource`.
`AWS::EC2::VPCGatewayAttachment` and
`AWS::EC2::SubnetRouteTableAssociation` are non-taggable, so the
generic destroy path doesn't see them.

**Why.** Without the hook, CloudControl rejects delete on "resource in
use" — the user sees a confusing error for an association they didn't
create.

**Where it's enforced.**

- `apps/cli/src/services/destroy-service.ts` (pre-delete hook table)

**Source memory.**
`feedback_destroy_predelete_hooks_for_cfn_only_constructs.md`

---

## Redaction: allowlist, not denylist

**Rule.** The CloudFormation secret redactor uses an allowlist of field
names to keep. A regex denylist over-matches fields like
`PasswordPolicy`, `UserData`, and `TokenValidityUnits` whose names
contain secret-shaped substrings but whose values are safe and
required for apply.

**Where it's enforced.**

- `packages/core/src/graph/nodes/plan-generator/safe-clone.ts`
  (canonical allowlist + redactor); `apps/cli/src/nodes/plan-generator.ts`
  is a thin re-export shim.

**Source memory.** `feedback_redaction_allowlist_not_denylist.md`

---

## MCP STS account cache — value, not promise

**Rule.** When caching the STS account identity result, cache the
resolved value — not the in-flight promise. A single transient STS
error must not permanently disable the cross-account guard for the MCP
process lifetime.

**Where it's enforced.**

- `apps/mcp-server/src/tools/destroy-resource.ts` (STS cache)

**Source memory (wave 2 R2 finding).** P1-R2-1.

---

## Destroy TOCTOU window

**Rule.** The MCP destroy path re-verifies the `managed-by=assignee-ai`
tag immediately before dispatching `DeleteResource`. The pre-delete
re-verify sits _between_ the pre-destroy hook and the CloudControl
`DeleteResource` call. If the second verify returns unmanaged, the
delete is refused with a structured `DESTROY_TOCTOU_TAG_MISSING` error
and a single `[destroy_resource][SECURITY] toctou-tag-missing`
`console.warn` line (intentionally unredacted — the ARN is operator-
owned and SOC needs it for CloudTrail correlation). If the second
verify throws (RGTA error), the destroy fails closed with a distinct
"Pre-delete tag re-verification failed" error; we never fail open.
Composite-identifier resources (e.g. `AWS::EC2::Route`, no ARN, no
tag) bypass the second verify.

**Why.** A co-tenant principal with `tag:UntagResources` (but not
`cloudcontrol:DeleteResource`) could otherwise strip the managed-by
tag in the ~tens-of-ms window between resolve-time verify and the
CCAPI delete, tricking the operator into deleting an unmanaged
resource. Option (a) "ETag fencing" is rejected because CloudControl
silently ignores stale fencing tokens for most `AWS::*` types. The
re-verify closes the bulk of the window at a cost of one extra RGTA
`GetResources` call per destroy (~50–150 ms). Residual window is the
sub-ms gap between the second `GetResources` call and the
`DeleteResource` dispatch — accepted as not exploitable in practice;
forensic CloudTrail correlation on `UntagResources` events catches
any exploitation of the residual.

**Where it's enforced.**

- `apps/mcp-server/src/tools/destroy-resource.ts` (re-verify call site
  - SECURITY warn emission)
- `apps/mcp-server/src/tools/destroy-resource/dispatcher.ts`
  (`verifyTagBeforeDelete`)
- `apps/mcp-server/src/tools/destroy-resource/error-envelope.ts`
  (`DESTROY_ERROR_CODES.TOCTOU_TAG_MISSING`)
- `docs/troubleshooting.md` — operator-facing SECURITY warning docs
  and CloudTrail Lake query.

**Source memory.** Story 48.4 (Epic 48 — Session Leftover Cleanups).

---

## ARN builder for display

**Rule.** `buildResourceArn` synthesizes full ARNs from bare CCAPI
identifiers; `result-formatter` mutates `state.resourceArn` once per
resource so display / log / provision-record all see the same value.

**Why.** CloudControl sometimes returns bare identifiers (bucket
names, role names) — users expect full ARNs in every surface.

**Where it's enforced.**

- `packages/core/src/graph/nodes/result-formatter.ts` (canonical);
  `apps/cli/src/nodes/result-formatter.ts` is a thin re-export shim.

**Source memory.** `feedback_arn_builder_for_display.md`

---

## Token-cost callsite

**Rule.** Every LLM call passes a `callsite` to `LlmCallOptions` so
per-command token cost is greppable via the `token_usage` structured
log event.

**Why.** Answers the "which node is the token hog" question that
gates SaaS unit economics. A stray `generateText({…})` without a
callsite is a P1 regression.

**Where it's enforced.**

- `apps/cli/src/services/llm-adapter.ts`

**Source memory.** `feedback_token_cost_visibility.md`

---

## S3 state guard skipped

**Rule.** `resource-provisioner.ts` deliberately skips the state
guard for `AWS::S3::Bucket`. Do not re-add it.

**Why.** CloudControl `GetResource` returns false positives on S3
because bucket names are globally unique — a name owned by another
AWS account reads as "already exists in your account" and blocks
apply.

**Where it's enforced.**

- `packages/core/src/graph/nodes/resource-provisioner.ts` (S3 special
  case, canonical); `apps/cli/src/nodes/resource-provisioner.ts` is a
  thin re-export shim.

**Source memory.** AGENTS.md (moved — now documented here).

---

## Filter-dispatched pricing mocks

**Rule.** Pricing tests must use `createS3PricingDispatchTool`,
`createServicePricingDispatchTool`,
`createEc2PricingDispatchTool`, or `createRdsPricingDispatchTool` —
not static `createMockTool`. Static mocks mask filter-related bugs
that only fire on the real AWS Pricing API.

**Where it's enforced.**

- `apps/cli/src/test-fixtures/mcp-mock-responses.ts`

**Source memory.** AGENTS.md.

---

## Pattern registry case-folding

**Rule.** Compound pattern keyword matching is case-insensitive
(`.toLowerCase()` before the substring check). New pattern keys must
be added in lowercase or they will silently never match.

**Why.** Users type "Static Website" / "static website" / "STATIC
WEBSITE" — all three must route to the same pattern.

**Where it's enforced.**

- `packages/core/src/pattern-templates/registry.ts`

**Source memory.** AGENTS.md (moved — now documented here).

---

## How to add a new invariant

1. Write the rule (one sentence).
2. Explain the "why" in one paragraph — if the rationale takes more
   than that, the rule is probably two rules.
3. Cite the enforcing source file. **If you can't name a file, the
   invariant is aspirational, not enforced — fix that first.**
4. Link to the auto-memory file (or this page if it replaces one).

Invariants without citations get deleted during wiki maintenance.
