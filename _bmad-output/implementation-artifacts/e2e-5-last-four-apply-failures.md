# Story E2E.5: Fix Last 4 Apply Failures (Route, RDS, ELBv2, NatGateway)

Status: backlog

## Story

As a developer using assignee.ai,
I want the final 4 resource types to provision successfully,
so that ALL 23 types work end-to-end via MCP.

## Remaining Failures

1. **Route** — LLM adds `Tags` but `AWS::EC2::Route` schema doesn't allow Tags. Fix: add configHint "NEVER include Tags — Route does not support tagging" to the route plugin.

2. **RDS DBInstance** — Hits recursion limit 50 in apply-plan.ts. The compound provisioning loop runs too many iterations. Fix: investigate why RDS provisioning requires >50 graph iterations, likely state polling loop issue.

3. **ELBv2 LoadBalancer** — Same recursion limit issue. May need increase to 100 or fix in the provisioning loop to avoid unnecessary re-invocations.

4. **NatGateway** — Needs EIP `AllocationId` for public connectivity type. The NAT Gateway plugin has a `toCfn` method that auto-provisions an EIP, but it's not triggered in MCP/noWizard mode. Fix: ensure the companion resource provisioning path (EIP allocation) works in noWizard mode.

## Context

Session progress: 37/150 → 104/150 pass rate. 4 commits: 38b4b81, 44faca8, 5f74867, 11b45df.

Also needed: Fix CLI destroy resolver for SSM, IAM, DynamoDB, SQS, SNS, API-GW, compound patterns — these are CLI-side bugs, not MCP server bugs.
