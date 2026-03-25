# Story E2E.2: Comprehensive AWS Mock & Test Coverage for All 23 Resource Types

Status: review

## Story

As a maintainer of assignee.ai,
I want every MCP tool response path covered by mocks with real data for all 23 resource types and all AWS error scenarios,
so that regressions are caught before they reach production and the E2E pass rate reaches 100%.

## Context

Audit of existing test infrastructure found 152 MCP server tests but critical gaps:

- Only 5/23 resource types have MCP-level tests (S3, Lambda, DynamoDB, EC2, IAM)
- AWS error scenarios only 4/10 covered (missing: InvalidInput, ServiceUnavailable, Timeout, InternalServer, RateLimit, PartialFailure)
- Tagging API has zero error scenario tests
- Pricing MCP tool integration never tested (all local estimates)
- Destroy ARN resolution not tested for 18 resource types
- Compound pattern provisioning loop not tested

## Acceptance Criteria (BDD)

### AC1: All 23 Resource Types Have MCP Tool Tests

```gherkin
Given each of the 23 supported resource types
When tested through the MCP tool layer (not just plugin unit tests)
Then each type MUST have at minimum:
  - plan_resource success case with correct resourceType and desiredState
  - estimate_cost returning a non-error estimate
  - apply_plan success case returning resourceArn
  - list_managed_resources showing the resource after creation
  - destroy_resource success case with polling
```

### AC2: All AWS Error Scenarios Covered

```gherkin
Given the CloudControl API client
When it encounters each of these error conditions:
  | Error | Expected Behavior |
  | ThrottlingException | Retry with backoff, then THROTTLED error |
  | ResourceNotFoundException | NOT_FOUND error |
  | AlreadyExistsException | ALREADY_EXISTS error |
  | AccessDeniedException | ACCESS_DENIED error |
  | InvalidInputException | INVALID_INPUT error with details |
  | ServiceUnavailableException | SERVICE_UNAVAILABLE retry then error |
  | InternalServerException | INTERNAL_ERROR |
  | RequestTimeout | TIMEOUT error |
  | NetworkError | CONNECTION_ERROR |
  | PartialFailure (compound) | PARTIAL_FAILURE with completed list |
Then appropriate error kind is returned with actionable message
And each error scenario has a dedicated test case
```

### AC3: Tagging API Error Coverage

```gherkin
Given the ResourceGroupsTaggingAPI client
When it encounters ThrottlingException, InternalServiceException, InvalidParameterException
Then list_managed_resources and destroy_resource handle gracefully
And each scenario has a test with real error response shape
```

### AC4: Destroy ARN Resolution for All 23 Types

```gherkin
Given an ARN for each of the 23 resource types
When passed to destroy_resource
Then the correct CloudFormation type name is resolved
And a test exists for each ARN pattern
```

### AC5: Mock Data Uses Real AWS Response Shapes

```gherkin
Given all mock responses in test files
When they simulate AWS SDK responses
Then they MUST use real response shapes (not simplified stubs)
And they MUST include realistic ARN formats, error codes, and metadata
```

### AC6: desiredState Sanitizer Test Coverage

```gherkin
Given the new desiredState sanitizer (from Story E2E.1)
When tested with all 23 resource type schemas
Then each type has at least one test case with known extraneous keys from E2E results
And type coercion cases are tested for integer, boolean, and array types
```

## Tasks / Subtasks

- [ ] Task 1: Create shared test fixtures for all 23 resource types (AC: #1, #5)
  - [ ] 1.1 Create `apps/mcp-server/src/__tests__/fixtures/resource-fixtures.ts` with real-shaped mock data
  - [ ] 1.2 For each type: mock desiredState, mock ARN, mock CloudControl success response, mock CloudControl error responses
  - [ ] 1.3 Include realistic tag structures with `managed-by`, `created-at`, `run-id`

- [ ] Task 2: CloudControl error scenario tests (AC: #2)
  - [ ] 2.1 Add to `cloudcontrol-adapter.test.ts`: InvalidInputException, ServiceUnavailableException, InternalServerException
  - [ ] 2.2 Add timeout simulation test (AbortController / socket timeout)
  - [ ] 2.3 Add network error test (ECONNREFUSED, ENOTFOUND)
  - [ ] 2.4 Add partial failure test for compound provisioning

- [ ] Task 3: Tagging API error tests (AC: #3)
  - [ ] 3.1 Add ThrottlingException test to `list-managed-resources.test.ts`
  - [ ] 3.2 Add InternalServiceException test
  - [ ] 3.3 Add InvalidParameterException test
  - [ ] 3.4 Add same error tests to `destroy-resource.test.ts` (uses Tagging API for resolution)

- [ ] Task 4: Destroy ARN resolution tests for all 23 types (AC: #4)
  - [ ] 4.1 Create `apps/mcp-server/src/__tests__/destroy-arn-resolution.test.ts`
  - [ ] 4.2 Test each of the 23 ARN patterns → correct CloudFormation type
  - [ ] 4.3 Test edge cases: malformed ARNs, unknown services, empty identifiers

- [ ] Task 5: Per-resource-type MCP tool tests (AC: #1)
  - [ ] 5.1 Expand `plan-resource.test.ts` with mock graph responses for all 23 types
  - [ ] 5.2 Expand `estimate-cost.test.ts` with classification tests for all 23 types
  - [ ] 5.3 Expand `destroy-resource.test.ts` with success cases for all 23 types
  - [ ] 5.4 Add compound pattern tests (message-queue, serverless-api) to apply-plan.test.ts

- [ ] Task 6: desiredState sanitizer tests (AC: #6)
  - [ ] 6.1 Create `apps/cli/src/services/desired-state-sanitizer.test.ts`
  - [ ] 6.2 Test extraneous key stripping for each of the 6 known-bad types from E2E
  - [ ] 6.3 Test type coercion (string→int for SQS, NatGateway)
  - [ ] 6.4 Test nested object sanitization (CreditSpecification.CpuCredits)
  - [ ] 6.5 Test no-op for already-clean desiredState
  - [ ] 6.6 Test with missing/empty schema (graceful no-op)

- [ ] Task 7: Apply-plan compound + timeout tests (AC: #2)
  - [ ] 7.1 Add test for recursionLimit=50 configuration
  - [ ] 7.2 Add test for 5-minute timeout behavior
  - [ ] 7.3 Add test for compound pattern with 5+ resources (multi-step polling)
  - [ ] 7.4 Add test for partial success (3/5 resources succeed, 4th fails)

## Dev Notes

### Test Files to Modify/Create

| File                                                           | Change                             |
| -------------------------------------------------------------- | ---------------------------------- |
| `apps/mcp-server/src/__tests__/fixtures/resource-fixtures.ts`  | **NEW** — shared fixtures          |
| `apps/mcp-server/src/__tests__/destroy-arn-resolution.test.ts` | **NEW** — 23-type ARN tests        |
| `apps/mcp-server/src/__tests__/plan-resource.test.ts`          | Expand with 23 type variants       |
| `apps/mcp-server/src/__tests__/estimate-cost.test.ts`          | Add 8 missing type classifications |
| `apps/mcp-server/src/__tests__/destroy-resource.test.ts`       | Add error scenarios + type success |
| `apps/mcp-server/src/__tests__/list-managed-resources.test.ts` | Add Tagging API errors             |
| `apps/mcp-server/src/__tests__/apply-plan.test.ts`             | Add compound + timeout tests       |
| `apps/cli/src/services/desired-state-sanitizer.test.ts`        | **NEW** — sanitizer tests          |
| `apps/cli/src/services/cloudcontrol-adapter.test.ts`           | Add 3 missing error types          |

### All 23 Resource Types (for fixture generation)

1. `AWS::S3::Bucket` — `arn:aws:s3:::e2e-bucket`
2. `AWS::SSM::Parameter` — `arn:aws:ssm:us-east-1:123456789012:parameter/e2e-param`
3. `AWS::IAM::Role` — `arn:aws:iam::123456789012:role/e2e-role`
4. `AWS::Lambda::Function` — `arn:aws:lambda:us-east-1:123456789012:function:e2e-fn`
5. `AWS::DynamoDB::Table` — `arn:aws:dynamodb:us-east-1:123456789012:table/e2e-table`
6. `AWS::SQS::Queue` — `arn:aws:sqs:us-east-1:123456789012:e2e-queue`
7. `AWS::SNS::Topic` — `arn:aws:sns:us-east-1:123456789012:e2e-topic`
8. `AWS::EC2::SecurityGroup` — `arn:aws:ec2:us-east-1:123456789012:security-group/sg-0123`
9. `AWS::EC2::VPC` — `arn:aws:ec2:us-east-1:123456789012:vpc/vpc-0123`
10. `AWS::EC2::Subnet` — `arn:aws:ec2:us-east-1:123456789012:subnet/subnet-0123`
11. `AWS::ECS::Cluster` — `arn:aws:ecs:us-east-1:123456789012:cluster/e2e-cluster`
12. `AWS::ECR::Repository` — `arn:aws:ecr:us-east-1:123456789012:repository/e2e-repo`
13. `AWS::ElasticLoadBalancingV2::LoadBalancer` — `arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/e2e-lb/abc123`
14. `AWS::EC2::Instance` — `arn:aws:ec2:us-east-1:123456789012:instance/i-0123abc`
15. `AWS::RDS::DBInstance` — `arn:aws:rds:us-east-1:123456789012:db:e2e-rds`
16. `AWS::Logs::LogGroup` — `arn:aws:logs:us-east-1:123456789012:log-group:/e2e/test`
17. `AWS::CloudWatch::Alarm` — `arn:aws:cloudwatch:us-east-1:123456789012:alarm:e2e-alarm`
18. `AWS::SecretsManager::Secret` — `arn:aws:secretsmanager:us-east-1:123456789012:secret:e2e-secret-AbCdEf`
19. `AWS::EC2::InternetGateway` — `arn:aws:ec2:us-east-1:123456789012:internet-gateway/igw-0123`
20. `AWS::EC2::RouteTable` — `arn:aws:ec2:us-east-1:123456789012:route-table/rtb-0123`
21. `AWS::EC2::Route` — (no ARN — composite identifier: `RouteTableId|CidrBlock`)
22. `AWS::EC2::NatGateway` — `arn:aws:ec2:us-east-1:123456789012:natgateway/nat-0123`
23. `AWS::ApiGatewayV2::Api` — `arn:aws:apigateway:us-east-1::/apis/abc123`

### Mock Pattern Reference

```typescript
// CloudControl success response
mockSend.mockResolvedValueOnce({
  ProgressEvent: {
    OperationStatus: "SUCCESS",
    Identifier: "e2e-bucket",
    RequestToken: "req-token-123",
    TypeName: "AWS::S3::Bucket",
  },
});

// CloudControl error response
mockSend.mockRejectedValueOnce(
  Object.assign(new Error("Rate exceeded"), {
    name: "ThrottlingException",
    $metadata: { httpStatusCode: 429 },
  }),
);

// Tagging API response
mockSend.mockResolvedValueOnce({
  ResourceTagMappingList: [
    {
      ResourceARN: "arn:aws:s3:::e2e-bucket",
      Tags: [
        { Key: "managed-by", Value: "assignee-ai" },
        { Key: "created-at", Value: "2026-03-25T10:00:00Z" },
      ],
    },
  ],
  PaginationToken: undefined,
});
```

### Testing Framework

- Vitest 3.1.0 with `vi.mock()` and `vi.fn()`
- InMemoryTransport from MCP SDK for tool-level tests
- Co-located test files (`*.test.ts`)
- Run: `pnpm test` (Turbo parallel across packages)

### References

- [Source: apps/mcp-server/src/__tests__/mcp-protocol-compliance.test.ts] — Existing MCP test patterns
- [Source: apps/mcp-server/src/__tests__/destroy-resource.test.ts] — Existing destroy mock patterns
- [Source: apps/cli/src/services/cloudcontrol-adapter.test.ts] — Existing CloudControl error mocks
- [Source: packages/core/src/config/resource-types.ts] — All 23 type constants
- [Source: packages/core/src/config/iam-actions.ts] — All 23 types with required IAM actions

## Dev Agent Record

### Agent Model Used

Claude Opus 4.6

### Completion Notes List

- Depends on Story E2E.1 (sanitizer must exist before writing sanitizer tests)
- 18 resource types currently have zero MCP-level tests
- E2E test harness at apps/mcp-server/e2e-test.mjs can validate final results
