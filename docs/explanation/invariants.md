# Invariants — rules assignee.ai enforces that are not obvious from code

New contributors repeatedly re-discover the same load-bearing rules.
This page is the single canonical list. Each entry cites the enforcing
code path so the invariant stays honest: if the code moves, update the
citation here. If the code is deleted, delete the entry.

These come directly from the project's auto-memory
(`~/.claude/projects/-Users-serhii-l-code-GenAi/memory/`) and from
multi-wave adversarial reviews. Read them before touching ARN handling,
destroy paths, credential plumbing, or the redaction pipeline.

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

- `apps/cli/src/nodes/preflight-guard.ts`

**Source memory.** `feedback_placeholder_arn_preflight_guard.md`

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

## Safety allowlist in bulk-destroy

**Rule.** `bulk-destroy --include-iam` unconditionally excludes
`AssigneeOperator`, `AssigneeReader`, `AssigneeAuditor`, and `Bedrock*`
IAM roles. No flag overrides this.

**Why.** Without the allowlist, a single `destroy --all --include-iam`
sweep locks the operator out of their own tooling — including the
credentials needed to undo the mistake.

**Where it's enforced.**

- `apps/cli/src/services/bulk-destroy.ts`

**Source memory.** `feedback_assignee_infra_safety_allowlist.md`

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

- `apps/cli/src/nodes/plan-generator.ts` / sanitizer

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

## ARN builder for display

**Rule.** `buildResourceArn` synthesizes full ARNs from bare CCAPI
identifiers; `result-formatter` mutates `state.resourceArn` once per
resource so display / log / provision-record all see the same value.

**Why.** CloudControl sometimes returns bare identifiers (bucket
names, role names) — users expect full ARNs in every surface.

**Where it's enforced.**

- `apps/cli/src/nodes/result-formatter.ts`

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

- `apps/cli/src/nodes/resource-provisioner.ts` (S3 special case)

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
