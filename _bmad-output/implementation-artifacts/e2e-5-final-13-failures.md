# Story E2E.5: Fix Final 13 E2E Failures (4 Apply + 9 Destroy)

Status: ready-for-dev

## Story

As a developer using assignee.ai,
I want ALL 23 resource types + 2 compound patterns to pass the full 6-step MCP lifecycle,
so that the E2E pass rate reaches 150/150.

## Tasks / Subtasks

- [ ] Task 1: Route Tags — add configHint to prevent LLM from including Tags (AC: apply)
  - [ ] 1.1 Add configHint to ec2-route.ts: "NEVER include Tags — Route does not support tagging"
  - [ ] 1.2 Verify sanitizer strips Tags since it's not in Route schema

- [ ] Task 2: Recursion limit — fix provisioning loop for long-running resources (AC: apply)
  - [ ] 2.1 In apply-plan.ts, change loop to check terminal executionStatus (SUCCESS/FAILED) instead of just next.length
  - [ ] 2.2 Increase max iterations to 200 (RDS can take 20+ poll cycles × multiple resources)
  - [ ] 2.3 Add iteration counter logging

- [ ] Task 3: NatGateway EIP — ensure AllocationId is provided in noWizard mode (AC: apply)
  - [ ] 3.1 Add AllocationId handling in plan-generator for NatGateway: auto-allocate EIP via AWS CLI or add configHint requiring user to provide it
  - [ ] 3.2 Alternative: add configHint stating AllocationId is required for public NatGateway

- [ ] Task 4: CLI destroy resolver — update to match MCP server's SERVICE_TYPE_MAP (AC: destroy)
  - [ ] 4.1 Read apps/cli/src/services/resource-resolver.ts
  - [ ] 4.2 Add all missing resource types to CLI's ARN resolver
  - [ ] 4.3 Fix extractIdentifierFromArn for CLI (same as MCP fix)

- [ ] Task 5: Tests for all fixes

## Dev Notes

### Key Files

- packages/core/src/resource-plugins/plugins/ec2-route.ts
- apps/mcp-server/src/tools/apply-plan.ts (lines 174-193)
- packages/core/src/resource-plugins/plugins/ec2-nat-gateway.ts
- apps/cli/src/services/resource-resolver.ts
- apps/cli/src/commands/destroy.ts
