# Assignee.ai -- Component Inventory

> Reverse-engineered from source code, April 2026.

## Resource Plugins (24)

Located in `packages/core/src/resource-plugins/plugins/`. Each plugin defines wizard fields, defaults, toCfn transforms, and configHints.

| Plugin                     | Resource Type                             | Key Features                                                                                                  |
| -------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `s3-bucket.ts`             | AWS::S3::Bucket                           | Versioning, encryption (AES/KMS), lifecycle, CORS, replication, public access block, website hosting, logging |
| `ec2-instance.ts`          | AWS::EC2::Instance                        | AMI discovery, instance type categories, EBS storage, SSH key pair, security groups, monitoring               |
| `rds-dbinstance.ts`        | AWS::RDS::DBInstance                      | Engine selection (MySQL/PostgreSQL/MariaDB/Aurora), instance class, storage, multi-AZ, backup, encryption     |
| `lambda-function.ts`       | AWS::Lambda::Function                     | Runtime selection, memory/timeout, IAM role, handler, code placeholder injection                              |
| `security-group.ts`        | AWS::EC2::SecurityGroup                   | VPC selection, ingress/egress rules                                                                           |
| `dynamodb-table.ts`        | AWS::DynamoDB::Table                      | Billing mode (on-demand/provisioned), key schema, global secondary indexes, PITR, encryption                  |
| `vpc.ts`                   | AWS::EC2::VPC                             | CIDR block, DNS support/hostnames, tenancy                                                                    |
| `subnet.ts`                | AWS::EC2::Subnet                          | VPC selection, CIDR, AZ, public IP mapping                                                                    |
| `sqs-queue.ts`             | AWS::SQS::Queue                           | FIFO/standard, visibility timeout, message retention, dead letter queue, encryption                           |
| `sns-topic.ts`             | AWS::SNS::Topic                           | FIFO/standard, encryption, display name                                                                       |
| `ssm-parameter.ts`         | AWS::SSM::Parameter                       | Type (String/StringList/SecureString), value, tier, encryption                                                |
| `iam-role.ts`              | AWS::IAM::Role                            | Trust policy, managed policies, path, description                                                             |
| `ecs-cluster.ts`           | AWS::ECS::Cluster                         | Container insights, capacity providers, execute command                                                       |
| `ecr-repository.ts`        | AWS::ECR::Repository                      | Image scanning, encryption, image tag mutability, lifecycle policy                                            |
| `elbv2-loadbalancer.ts`    | AWS::ElasticLoadBalancingV2::LoadBalancer | Type (ALB/NLB), scheme (internet/internal), subnets, security groups                                          |
| `logs-loggroup.ts`         | AWS::Logs::LogGroup                       | Retention period, KMS encryption, log group class                                                             |
| `ec2-internet-gateway.ts`  | AWS::EC2::InternetGateway                 | Minimal config (tags only)                                                                                    |
| `ec2-route-table.ts`       | AWS::EC2::RouteTable                      | VPC selection                                                                                                 |
| `ec2-route.ts`             | AWS::EC2::Route                           | Route table, destination CIDR, gateway/NAT target                                                             |
| `ec2-nat-gateway.ts`       | AWS::EC2::NatGateway                      | Connectivity type (public/private), subnet, EIP auto-allocation                                               |
| `apigatewayv2-api.ts`      | AWS::ApiGatewayV2::Api                    | Protocol (HTTP/WebSocket), CORS, route key                                                                    |
| `cloudwatch-alarm.ts`      | AWS::CloudWatch::Alarm                    | Metric, namespace, statistic, threshold, period, actions                                                      |
| `secretsmanager-secret.ts` | AWS::SecretsManager::Secret               | Secret string/binary, KMS encryption, rotation                                                                |
| `generic.ts`               | Fallback                                  | Generic handler for resource types without dedicated plugins                                                  |

## Graph Nodes (12)

Located in `apps/cli/src/nodes/`.

| Node                 | File                    | Input State                                   | Key Outputs                                             | Dependencies                                  |
| -------------------- | ----------------------- | --------------------------------------------- | ------------------------------------------------------- | --------------------------------------------- |
| intent_parser        | intent-parser.ts        | userIntent                                    | resourceType, resourcePattern                           | LlmPort, PatternRegistry                      |
| schema_fetcher       | schema-fetcher.ts       | resourceType                                  | resourceSchema                                          | CloudFormationSchemaService                   |
| option_elicitor      | option-elicitor.ts      | resourceType, resourceSchema                  | elicitedOptions, orgConfig, userConfig                  | PluginRegistry, PricingMCP, ConfigLoaders     |
| compound_dispatcher  | compound-dispatcher.ts  | resourcePattern                               | resourceQueue, currentResourceIndex                     | --                                            |
| plan_generator       | plan-generator.ts       | resourceType, resourceSchema, elicitedOptions | desiredState                                            | LlmPort, PluginRegistry, MemoryService        |
| bp_evaluator         | bp-evaluator.ts         | resourceType, desiredState                    | bpFindings                                              | BestPractices YAML loader                     |
| fix_applicator       | fix-applicator.ts       | bpFindings, desiredState                      | desiredState (patched), appliedFixes                    | ConfigLoaders (auto_fix preference)           |
| preflight_guard      | preflight-guard.ts      | desiredState, resourceType                    | estimatedMonthlyCost, preflightPassed, pricingBreakdown | PricingRegistry, PricingMCP, IAM MCP          |
| human_approval       | human-approval.ts       | full state                                    | executionStatus (CANCELLED or pass)                     | Display utils                                 |
| resource_provisioner | resource-provisioner.ts | desiredState, resourceType                    | requestToken, executionStatus                           | ProvisioningPort, SDKFallbackDispatcher       |
| status_poller        | status-poller.ts        | requestToken                                  | executionStatus, resourceArn                            | ProvisioningPort                              |
| result_formatter     | result-formatter.ts     | full state                                    | display output, memory records                          | Display utils, MemoryService, SecurityPosture |

## Services (28)

Located in `apps/cli/src/services/`.

### Core Pipeline Services

| Service                  | Purpose                                                           |
| ------------------------ | ----------------------------------------------------------------- |
| `graph.ts`               | LangGraph StateGraph construction, node wiring, adapter injection |
| `graph-state.ts`         | AgentState Annotation with ~30 channels                           |
| `graph-routing.ts`       | 5 conditional routing functions                                   |
| `llm-adapter.ts`         | Universal LLM via Vercel AI SDK (5 providers)                     |
| `bedrock-llm-adapter.ts` | Direct Amazon Bedrock adapter                                     |
| `mcp-client.ts`          | MCP server process lifecycle (singleton, lazy, filtered)          |

### AWS Integration Services

| Service                      | Purpose                                                                 |
| ---------------------------- | ----------------------------------------------------------------------- |
| `cloudcontrol-client.ts`     | CloudControl SDK client factory                                         |
| `cloudcontrol-adapter.ts`    | ProvisioningPort implementation (create, get, delete, poll)             |
| `sdk-fallback-dispatcher.ts` | SDK handlers for CCAPI gap types (EventSourceMapping, SNS Subscription) |
| `resource-resolver.ts`       | Resolve resources by ARN or name via Tagging API                        |
| `list-resources.ts`          | Fetch managed resources via Resource Groups Tagging API                 |
| `credential-detector.ts`     | Auto-detect AWS credentials and region                                  |
| `s3-upload.ts`               | Upload static site files to S3 with progress                            |
| `cloudfront-setup.ts`        | Create CloudFront distribution + OAC                                    |

### Data Management Services

| Service          | Purpose                                              |
| ---------------- | ---------------------------------------------------- |
| `memory.ts`      | JSON-file backed provision/failure/pattern logs      |
| `checkpoint.ts`  | Plan checkpoint serialization, loading, pruning, TTL |
| `price-cache.ts` | TTL-based pricing result cache                       |
| `cleanup.ts`     | Orchestrates checkpoint/cache/memory cleanup         |
| `billing.ts`     | Live cost data from AWS Cost Management MCP          |

### Analysis Services

| Service                      | Purpose                                                    |
| ---------------------------- | ---------------------------------------------------------- |
| `drift-detector.ts`          | Deep-diff desired vs. actual state with type normalization |
| `drift-detector-factory.ts`  | Factory with env-based configuration                       |
| `status-aggregator.ts`       | Aggregate resources by type/region for status display      |
| `desired-state-sanitizer.ts` | Strip extraneous keys, coerce types against schema         |
| `required-field-repairer.ts` | Fill missing required fields from plugin defaults          |
| `completion-generator.ts`    | Shell completion file generation                           |

### Destroy Services

| Service              | Purpose                                            |
| -------------------- | -------------------------------------------------- |
| `destroy-service.ts` | Single-resource destroy via CloudControl + polling |
| `bulk-destroy.ts`    | Tier-ordered bulk destroy of all managed resources |

## Utilities (30+)

Located in `apps/cli/src/utils/`.

### Display and UI

| Utility               | Purpose                                                                   |
| --------------------- | ------------------------------------------------------------------------- |
| `display.ts`          | Plan box rendering, HITL prompts, spinners, tables, compound plan display |
| `display-plan.ts`     | Plan rendering helpers                                                    |
| `display-output.ts`   | Apply output rendering                                                    |
| `display-prompts.ts`  | Interactive prompt wrappers                                               |
| `display-findings.ts` | BP findings display                                                       |
| `display-docs.ts`     | Documentation display                                                     |
| `ui.ts`               | UI constants                                                              |

### Configuration

| Utility            | Purpose                           |
| ------------------ | --------------------------------- |
| `merge-configs.ts` | 6-level precedence resolver       |
| `env-writer.ts`    | .env file writing                 |
| `first-run.ts`     | First-run detection and bootstrap |

### Resource Processing

| Utility                     | Purpose                                                   |
| --------------------------- | --------------------------------------------------------- |
| `aws-resource-discovery.ts` | AMI, VPC, subnet, SG, instance type discovery via EC2 SDK |
| `option-enrichment.ts`      | Option label enrichment with pricing/metadata             |
| `option-ranker.ts`          | Option ranking and sorting                                |
| `pricing-lookup.ts`         | Price label injection into wizard options                 |
| `free-tier.ts`              | Free tier eligibility detection and notes                 |
| `tags.ts`                   | Mandatory tag injection (managed-by, runId, type)         |
| `intent-defaults.ts`        | Intent-based default value extraction                     |
| `workload-classifier.ts`    | Workload profile classification                           |
| `resolve-desired-state.ts`  | Desired state resolution for drift                        |
| `field-resolver.ts`         | Dynamic field resolution                                  |

### Best Practices

| Utility                     | Purpose                              |
| --------------------------- | ------------------------------------ |
| `fix-command-resolver.ts`   | Fix command resolution               |
| `fix-selection.ts`          | Interactive fix selection            |
| `bp-reeval.ts`              | BP re-evaluation after fixes         |
| `wizard-helpers.ts`         | Wizard utility functions             |
| `wizard-key-map.ts`         | CFN key to wizard key mapping        |
| `wizard-recommendations.ts` | Contextual recommendations in wizard |

### Infrastructure

| Utility               | Purpose                              |
| --------------------- | ------------------------------------ |
| `logger.ts`           | Structured JSON logging to stderr    |
| `error-messages.ts`   | User-friendly error message registry |
| `mcp.ts`              | MCP response unwrapping              |
| `mcp-types.ts`        | MCP type utilities                   |
| `timeout.ts`          | Promise timeout wrapper              |
| `recorder.ts`         | API call recording interceptor       |
| `memory-recorder.ts`  | Memory write helpers                 |
| `security-posture.ts` | Post-provision security checks       |
| `iam-actions.ts`      | IAM action resolution                |
| `command-runner.ts`   | Graph execution wrapper              |

## Core Package Components

### Schemas (`packages/core/src/schema/`)

| Schema           | Purpose                                                                 |
| ---------------- | ----------------------------------------------------------------------- |
| `graph-state.ts` | ExecutionMode, ExecutionStatus, PreflightMode, BPEnforcementLevel enums |
| `audit.ts`       | AuditEvent schema                                                       |
| `checkpoint.ts`  | PlanCheckpoint schema with version                                      |
| `memory.ts`      | ProvisionRecord, FailureRecord, PatternRecord schemas                   |
| `drift.ts`       | DriftStatus, ChangeType, DriftedField, DriftResult schemas              |

### Config (`packages/core/src/config/`)

| Module                    | Purpose                                                                     |
| ------------------------- | --------------------------------------------------------------------------- |
| `cfn-keys.ts`             | CloudFormation property key constants (200+ named constants)                |
| `resource-types.ts`       | 23 supported types, CCAPI fallbacks, companion types, list-only types       |
| `resource-identifiers.ts` | Primary identifier key per resource type                                    |
| `resource-policy.ts`      | Org/user field policy types (locked, always_ask, ask_if_not_set, never_ask) |
| `arn-type-map.ts`         | ARN service prefix to CloudFormation type mapping                           |
| `aws-arns.ts`             | AWS ARN prefixes, managed policy ARNs, service principals                   |
| `iam-actions.ts`          | Required IAM actions per resource type                                      |
| `iam-policies.ts`         | IAM policy document generators (operator, reader, auditor)                  |
| `config-schema.ts`        | AssigneeConfig Zod schema with defaults                                     |
| `discovery-keys.ts`       | Cache keys for resource discovery                                           |

### Pricing Engine (`packages/core/src/pricing/`)

**23 Pricing Strategies** -- one per resource type, providing local estimates and MCP query configs.

**23 Pricing Decomposers** -- one per resource type:

- EC2: compute + EBS storage
- RDS: instance + storage + multi-AZ
- Lambda: requests + duration
- S3: storage + requests + data transfer
- DynamoDB: RCU + WCU + storage
- NAT Gateway: hourly + data processing
- ELBv2: hourly + LCU
- API Gateway: requests
- SQS: requests
- SNS: publishes + deliveries
- Secrets Manager: secret + API calls
- CloudWatch: alarms
- Logs: ingestion + storage
- ECR: storage
- SSM: parameters + API calls
- Free types (VPC, Subnet, SG, IAM Role, IGW, Route Table, Route, ECS Cluster): $0.00

### Best Practices Engine (`packages/best-practices/`)

| Module        | Purpose                                                                                                         |
| ------------- | --------------------------------------------------------------------------------------------------------------- |
| `loader.ts`   | Walks service directories, loads YAML, validates with Zod. Skips `dist/`, `node_modules/`, `coverage/`, `src/`. |
| `evaluate.ts` | Evaluates triggers against EvalContext. Supports 11 check types.                                                |
| `schema.ts`   | Zod schema for BestPractice YAML structure.                                                                     |
| `types.ts`    | BestPractice, BPFinding, Trigger, severity/category/check_type/fix_type enums.                                  |

**136 YAML rules** across 18 service directories, covering:

- Security (public access, encryption, authentication)
- Performance (instance sizing, provisioned capacity)
- Reliability (multi-AZ, backups, retention)
- Cost optimization (lifecycle, right-sizing)
- Operational excellence (logging, monitoring, tagging)
