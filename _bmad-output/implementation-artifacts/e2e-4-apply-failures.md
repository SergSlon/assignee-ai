# Story E2E.4: Fix All 13 Apply Failures

Status: ready-for-dev

## Story

As a developer using assignee.ai,
I want every resource type to provision successfully via MCP apply,
so that the tool actually works end-to-end for all 23 supported types.

## Acceptance Criteria

### AC1: Plugin defaults complete for all required fields

```gherkin
Given any of the 23 resource types
When the LLM omits a schema-required field
Then the repairer MUST have a fallback value from plugin defaults/initialValue
```

### AC2: State guard handles all identifier formats

```gherkin
Given SecretsManager, Route, or DynamoDB resources
When the state guard checks for existing resources
Then it uses the correct identifier format for CloudControl GetResource
```

### AC3: MCP timeout sufficient for provisioning

```gherkin
Given a resource that takes 30-60s to provision (SQS, compound patterns)
When the MCP tool handler runs apply_plan
Then it does NOT timeout before CloudControl completes
```

### AC4: IAM policy covers all required actions

```gherkin
Given ELBv2 LoadBalancer provisioning
When CloudControl calls the ELB service
Then iam:CreateServiceLinkedRole is permitted
```

### AC5: Companion resources auto-handled

```gherkin
Given Lambda with Code placeholder injected
When Runtime and Handler are missing
Then they are auto-filled (nodejs22.x, index.handler)
```

## Tasks / Subtasks

- [ ] Task 1: Add missing plugin defaults/initialValues (AC: #1, #5)
  - [ ] 1.1 Lambda: Add Runtime and Handler to plugin defaults block
  - [ ] 1.2 Lambda: Mark Handler as required, add initialValue "index.handler"
  - [ ] 1.3 CloudWatch Alarm: Add initialValues for MetricName, Namespace, Threshold
  - [ ] 1.4 RDS: Add MasterUsername initialValue "appuser", MasterUserPassword to defaults
  - [ ] 1.5 ECS Cluster: Verify CapacityProviderStrategy default is correct (remove extraneous)

- [ ] Task 2: Fix state guard identifier handling (AC: #2)
  - [ ] 2.1 Check resource-provisioner.ts state guard for SecretsManager identifier
  - [ ] 2.2 Check Route composite identifier handling
  - [ ] 2.3 Add state guard skip for resource types with auto-generated identifiers

- [ ] Task 3: Fix MCP timeout (AC: #3)
  - [ ] 3.1 Increase MCP tool request timeout in apply-plan.ts
  - [ ] 3.2 Add timeout configuration to MCP server transport if possible

- [ ] Task 4: Update IAM policy (AC: #4)
  - [ ] 4.1 Add iam:CreateServiceLinkedRole to operator policy

- [ ] Task 5: Write tests for all fixes
  - [ ] 5.1 Test repairer fills Lambda Runtime + Handler + Code together
  - [ ] 5.2 Test repairer fills CloudWatch required fields
  - [ ] 5.3 Test repairer fills RDS MasterUsername

## Dev Notes

### Files to Modify

- packages/core/src/resource-plugins/plugins/lambda-function.ts
- packages/core/src/resource-plugins/plugins/cloudwatch-alarm.ts
- packages/core/src/resource-plugins/plugins/rds-dbinstance.ts
- packages/core/src/resource-plugins/plugins/ecs-cluster.ts
- apps/cli/src/nodes/resource-provisioner.ts
- apps/mcp-server/src/tools/apply-plan.ts
- IAM policy (external)
