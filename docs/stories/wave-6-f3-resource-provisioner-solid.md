# Story: Wave-6 F3 — SOLID refactor of `resourceProvisionerNode`

## Context

`apps/cli/src/nodes/resource-provisioner.ts` had grown to 905 LOC, a classic
god-function with cross-cutting concerns: CCAPI create + poll orchestration,
NAT Gateway EIP pre-allocation (~150 LOC inline), EC2 SSH key pre-provision,
failure-path cleanup, State Guard (FR-15 Read-Before-Write), SDK-fallback
redirect dispatch, LangGraph state immutability, CloudFront S3 DNS retry,
and ClientToken generation — all in one function.

The test file (`resource-provisioner.test.ts`, 2129 LOC, 67 specs) is the
safety net: refactor must preserve all 67 specs passing.

## Acceptance Criteria

1. `resource-provisioner.ts` ≤ 300 LOC (excluding imports/types).
2. Each sub-module ≤ 400 LOC; each has unit tests.
3. All 67 existing resource-provisioner specs pass unchanged.
4. EIP leak invariants hold (per-EIP tracking, orphan auto-release,
   multi-runId race safety).
5. Exported public API preserved: `resourceProvisionerNode`,
   `sanitizeKeyName`, `formatErrorForLog`.
6. `bmad-code-review` returns zero Critical/High.

## Decomposition (SRP/OCP/LSP/ISP/DIP)

- `resource-provisioner/util.ts` — `formatErrorForLog`, `sanitizeKeyName`,
  `isResourceType` (pure helpers).
- `resource-provisioner/state.ts` — thin re-export of `safeCloneDesiredState`
  from `plan-generator.ts` (F2 has NOT yet moved it to a dedicated module, so
  we import from plan-generator). Decouples the provisioner from plan-generator
  internals — a single line to update when F2 completes its own split.
- `resource-provisioner/state-guard.ts` — FR-15 Read-Before-Write logic.
- `resource-provisioner/eip-allocator.ts` — NAT Gateway EIP allocate/reuse/
  orphan-auto-release, returns `{ allocationId, freshlyAllocated }`.
- `resource-provisioner/ssh-keypair.ts` — EC2 Instance SSH keypair verify/
  create/persist, returns `{ created, mutateDesiredStateOnCreateFailure }`.
- `resource-provisioner/cleanup.ts` — idempotent best-effort cleanup of
  resources allocated by pre-hooks when the create fails.
- `resource-provisioner/ccapi.ts` — CloudControl create with CloudFront S3-DNS
  retry budget; ClientToken synthesis.
- `resource-provisioner.ts` — thin orchestrator that wires pre-hooks → CCAPI
  → cleanup-on-failure → result. No direct AWS SDK imports remain in the node
  entrypoint.

## Retry policy note

The only explicit retry budget in this node is the CloudFront S3-DNS
propagation retry (5s/10s/20s plus an initial 30s pre-create wait when an
S3 bucket is in the same compound plan). CCAPI poll-status retries live in
`status-poller.ts` (a separate node). We therefore keep the retry delays as
a private constant in `ccapi.ts` rather than inventing an artificial
`retry-policy.ts` module with only one consumer. If future work adds per-
resource-type create-time retry budgets, that module can be extracted then.

## SOLID mapping

- SRP: each hook file changes for exactly one reason.
- OCP: adding a future pre-hook (e.g. VPC endpoint attach) = new file +
  one call site in `resource-provisioner.ts`.
- LSP: pre-hook signatures are `(state, desiredState) => Promise<HookResult>`
  with cleanup exposed as a separate named export.
- ISP: each hook declares only the AWS SDK clients it needs.
- DIP: the node remains `ProvisioningPort`-driven; new submodules take the
  same `AgentState` contract the god-function used.

## Tests

New unit tests per submodule (`*.test.ts`). Existing
`resource-provisioner.test.ts` preserved unchanged and still passes.
