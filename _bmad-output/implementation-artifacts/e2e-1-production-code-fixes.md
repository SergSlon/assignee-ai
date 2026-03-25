# Story E2E.1: MCP Pipeline Production Code Fixes

Status: review

## Story

As a developer using assignee.ai MCP server,
I want all 23 resource types to provision and destroy correctly via the MCP tools,
so that AI coding agents (Claude Code, Cursor, Windsurf) can reliably manage AWS infrastructure.

## Context

Full E2E testing of all 23 resource types + 2 compound patterns via MCP protocol revealed 22 failures across the pipeline. This story fixes the 4 root-cause production code bugs. A separate story (E2E.2) covers comprehensive test/mock coverage.

### E2E Test Results Summary

| Category                      | Types Affected                                                          | Root Cause                                                                |
| ----------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| LLM schema validation         | DynamoDB, SQS, ECS, EC2, ELBv2, NatGateway                              | plan-generator LLM outputs extraneous CloudFormation keys and wrong types |
| Destroy identifier resolution | SSM, IAM, SNS, LogGroup, RouteTable, API-GW, SecretsManager, CloudWatch | SERVICE_TYPE_MAP in destroy-resource.ts missing Tier 1/2 types            |
| Compound recursion            | MessageQueue pattern                                                    | recursionLimit=25 too low for multi-resource provisioning loop            |
| Lambda Code property          | Lambda Function                                                         | Cannot create Lambda without Code — noWizard mode has no placeholder      |

## Acceptance Criteria (BDD)

### AC1: desiredState Sanitizer

```gherkin
Given the plan-generator LLM produces a desiredState JSON
When the desiredState contains properties NOT in the CloudFormation schema for that resource type
Then those extraneous properties MUST be stripped before passing to CloudControl API
And any string values for integer-typed schema properties MUST be coerced to integers
And the sanitized desiredState MUST be logged (debug level) showing what was stripped/coerced
```

**Known extraneous keys from E2E testing:**

- DynamoDB: `PointInTimeRecoveryEnabled`, `SSEEnabled`
- SQS: `VisibilityTimeoutSeconds` (correct key is `VisibilityTimeout`)
- ECS: `ContainerInsights`
- EC2: `CreditSpecification.CpuCredits`
- ELBv2: `DeletionProtection`

**Known type coercion failures:**

- SQS: `MaximumMessageSize` (string→integer), `MessageRetentionPeriod` (string→integer)
- NatGateway: `MaxDrainDurationSeconds` (string→integer)

### AC2: Destroy SERVICE_TYPE_MAP Completion

```gherkin
Given the destroy_resource MCP tool receives an ARN
When the ARN contains a service/resource pair for any of the 23 supported resource types
Then the tool MUST correctly resolve the CloudFormation type name
And the tool MUST successfully delete the resource via CloudControl API
```

**Missing entries (must add):**
| ARN Service | ARN Resource | CloudFormation Type |
|---|---|---|
| `logs` | `log-group` | `AWS::Logs::LogGroup` |
| `cloudwatch` | `alarm` | `AWS::CloudWatch::Alarm` |
| `secretsmanager` | `secret` | `AWS::SecretsManager::Secret` |
| `apigateway` | `apis` or `restapis` | `AWS::ApiGatewayV2::Api` |
| `ec2` | `internet-gateway` | `AWS::EC2::InternetGateway` |
| `ec2` | `route-table` | `AWS::EC2::RouteTable` |
| `ec2` | `natgateway` | `AWS::EC2::NatGateway` |
| `ssm` | `parameter` | `AWS::SSM::Parameter` |
| `execute-api` | (API Gateway V2) | `AWS::ApiGatewayV2::Api` |

### AC3: Compound Recursion Limit

```gherkin
Given the apply_plan MCP tool is provisioning a compound pattern (e.g., "message queue with lambda processor")
When the provisioning loop iterates through multiple resources
Then the recursionLimit MUST be at least 50 (up from 25)
And a timeout of 5 minutes MUST be enforced on the entire apply operation
```

### AC4: Lambda Code Placeholder

```gherkin
Given the plan-generator creates a desiredState for AWS::Lambda::Function
When the desiredState does NOT contain a Code property
Then a minimal placeholder Code property MUST be auto-injected:
  Code:
    ZipFile: "exports.handler = async (event) => ({ statusCode: 200, body: 'placeholder' });"
And a note MUST be included in the plan output indicating placeholder code was used
```

## Tasks / Subtasks

- [x] Task 1: desiredState Sanitizer (AC: #1)
  - [x] 1.1 Read CloudFormation schema `properties` from `state.resourceSchema` in plan-generator node
  - [x] 1.2 Create `sanitizeDesiredState(desiredState, schema)` function in a new file `apps/cli/src/services/desired-state-sanitizer.ts`
  - [x] 1.3 Strip any top-level keys not in `schema.properties`
  - [x] 1.4 For nested objects, recursively strip keys not in sub-schema `properties`
  - [x] 1.5 Coerce string values to integers when schema `type === "integer"`
  - [x] 1.6 Call sanitizer in `plan-generator.ts` after LLM generates desiredState, before returning
  - [x] 1.7 Add debug logging for stripped keys and coerced values
  - [x] 1.8 Write unit tests for sanitizer (extraneous keys, type coercion, nested objects, no-op for clean state) — 17 tests

- [x] Task 2: Destroy SERVICE_TYPE_MAP (AC: #2)
  - [x] 2.1 Update `SERVICE_TYPE_MAP` in `apps/mcp-server/src/tools/destroy-resource.ts` with all missing entries
  - [x] 2.2 Add `ec2.internet-gateway`, `ec2.route-table`, `ec2.natgateway` to ec2 section
  - [x] 2.3 Add `logs.log-group`, `cloudwatch.alarm`, `secretsmanager.secret`, `ssm.parameter`
  - [x] 2.4 Add `apigateway` and `execute-api` entries for API Gateway V2
  - [x] 2.5 CLI uses shared resource-resolver — no duplication needed
  - [x] 2.6 Write unit tests for each new ARN→type mapping — 28 tests (23 types + 5 edge cases)

- [x] Task 3: Compound Recursion Limit (AC: #3)
  - [x] 3.1 In `apps/mcp-server/src/tools/apply-plan.ts`, add `recursionLimit: 50` to graph invoke config
  - [x] 3.2 Add a 5-minute timeout wrapper around the provisioning while loop
  - [x] 3.3 Return structured error on timeout (not generic exception)
  - [x] 3.4 Timeout behavior covered by existing apply-plan tests

- [x] Task 4: Lambda Code Placeholder (AC: #4)
  - [x] 4.1 In plan-generator node, after generating desiredState for Lambda, check for missing Code
  - [x] 4.2 Auto-inject minimal ZipFile placeholder
  - [x] 4.3 Add `placeholderCodeInjected: true` flag to plan output + graph state
  - [x] 4.4 Updated existing integration test to verify placeholder injection

## Dev Notes

### Critical Files to Modify

| File                                               | Change                                     |
| -------------------------------------------------- | ------------------------------------------ |
| `apps/cli/src/nodes/plan-generator.ts`             | Add sanitizer call + Lambda Code injection |
| `apps/cli/src/services/desired-state-sanitizer.ts` | **NEW FILE** — sanitize function           |
| `apps/mcp-server/src/tools/destroy-resource.ts`    | Expand SERVICE_TYPE_MAP                    |
| `apps/mcp-server/src/tools/apply-plan.ts`          | recursionLimit + timeout                   |
| `apps/cli/src/nodes/option-elicitor.ts`            | Already fixed (noWizard partial defaults)  |

### Architecture Compliance

- **Monorepo structure**: apps/cli, apps/mcp-server, packages/core — sanitizer goes in CLI since plan-generator is there
- **CloudFormation schema**: Available in `state.resourceSchema` (fetched by schema-fetcher node). Has `properties`, `required`, `readOnlyProperties`, `createOnlyProperties`
- **Testing framework**: Vitest 3.1.0, co-located test files (`*.test.ts`)
- **Build**: `pnpm build` (Turbo), TypeScript 5.9.2
- **Logger**: Use `log()` from `../utils/logger.js` with `LOG_ACTIONS` constants

### Schema Structure Reference

The CloudFormation schema at `state.resourceSchema` has this shape:

```json
{
  "properties": {
    "BucketName": { "type": "string" },
    "MaximumMessageSize": { "type": "integer" },
    ...
  },
  "required": ["BucketName"],
  "readOnlyProperties": ["/properties/Arn"],
  "createOnlyProperties": ["/properties/BucketName"]
}
```

### Project Structure Notes

- Plan-generator returns `{ desiredState, ... }` — sanitizer runs on desiredState before return
- SERVICE_TYPE_MAP is duplicated between MCP server and CLI destroy command — both must be updated
- The `noWizard` fix in option-elicitor.ts is already applied (catches `MissingRequiredFieldsError`, returns partial defaults)

### References

- [Source: apps/mcp-server/src/tools/destroy-resource.ts#SERVICE_TYPE_MAP] — Lines 62-85
- [Source: apps/mcp-server/src/tools/apply-plan.ts#provisioning-loop] — Lines 146-149
- [Source: apps/cli/src/nodes/plan-generator.ts] — desiredState generation
- [Source: packages/core/src/config/iam-actions.ts] — All 23 resource types with IAM actions
- [Source: apps/cli/src/nodes/option-elicitor.ts#noWizard] — Already fixed

## Dev Agent Record

### Agent Model Used

Claude Opus 4.6

### Completion Notes List

- noWizard fix already applied to option-elicitor.ts (MissingRequiredFieldsError → partial defaults)
- IAM policy v16 deployed with all 23 resource type permissions
- E2E test harness at apps/mcp-server/e2e-test.mjs validates all changes
