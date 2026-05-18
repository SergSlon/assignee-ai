---
diataxis: reference
canonical: true
---

> **Diátaxis: Reference** — This is the canonical root page for this topic. Catalog of all supported AWS resource types, plugins, and co-provision relationships.

# Supported Resource Types

assignee.ai supports a registry of AWS resource types end-to-end via the CloudFormation CloudControl API. The canonical source of truth is the resource-type registry — see [`packages/core/src/config/resource-types/supported.ts`](../packages/core/src/config/resource-types/supported.ts) for the live list. Most types have dedicated plugins; two (`AWS::EC2::VPCGatewayAttachment`, `AWS::EC2::SubnetRouteTableAssociation`) are **compound-only** — they are emitted from compound patterns (vpc-networking, three-tier-web) via the marker-token resolver and never directly from a user intent, so they share the generic fallback plugin rather than getting a dedicated one. Additional auxiliary types are used in compound patterns.

## Resource Type Table

| #   | CloudFormation Type                         | Short Name           | Plugin                           | Co-provisions |
| --- | ------------------------------------------- | -------------------- | -------------------------------- | ------------- |
| 1   | `AWS::S3::Bucket`                           | S3 Bucket            | s3-bucket                        | -             |
| 2   | `AWS::SSM::Parameter`                       | SSM Parameter        | ssm-parameter                    | -             |
| 3   | `AWS::IAM::Role`                            | IAM Role             | iam-role                         | -             |
| 4   | `AWS::EC2::Instance`                        | EC2 Instance         | ec2-instance                     | -             |
| 5   | `AWS::RDS::DBInstance`                      | RDS Database         | rds-dbinstance                   | -             |
| 6   | `AWS::Lambda::Function`                     | Lambda Function      | lambda-function                  | LogGroup      |
| 7   | `AWS::EC2::VPC`                             | VPC                  | vpc                              | -             |
| 8   | `AWS::EC2::Subnet`                          | Subnet               | subnet                           | -             |
| 9   | `AWS::EC2::SecurityGroup`                   | Security Group       | security-group                   | -             |
| 10  | `AWS::DynamoDB::Table`                      | DynamoDB Table       | dynamodb-table                   | -             |
| 11  | `AWS::SQS::Queue`                           | SQS Queue            | sqs-queue                        | -             |
| 12  | `AWS::SNS::Topic`                           | SNS Topic            | sns-topic                        | -             |
| 13  | `AWS::ElasticLoadBalancingV2::LoadBalancer` | ALB/NLB              | elbv2-loadbalancer               | -             |
| 14  | `AWS::ECS::Cluster`                         | ECS Cluster          | ecs-cluster                      | LogGroup      |
| 15  | `AWS::ECR::Repository`                      | ECR Repository       | ecr-repository                   | -             |
| 16  | `AWS::Logs::LogGroup`                       | CloudWatch Log Group | logs-loggroup                    | -             |
| 17  | `AWS::EC2::InternetGateway`                 | Internet Gateway     | ec2-internet-gateway             | -             |
| 18  | `AWS::EC2::RouteTable`                      | Route Table          | ec2-route-table                  | -             |
| 19  | `AWS::EC2::Route`                           | Route                | ec2-route                        | -             |
| 20  | `AWS::EC2::NatGateway`                      | NAT Gateway          | ec2-nat-gateway                  | -             |
| 21  | `AWS::ApiGatewayV2::Api`                    | API Gateway V2       | apigatewayv2-api                 | -             |
| 22  | `AWS::CloudWatch::Alarm`                    | CloudWatch Alarm     | cloudwatch-alarm                 | -             |
| 23  | `AWS::SecretsManager::Secret`               | Secrets Manager      | secretsmanager-secret            | -             |
| 24  | `AWS::EC2::VPCGatewayAttachment`            | VPC Gateway Attach   | (compound-only)                  | -             |
| 25  | `AWS::EC2::SubnetRouteTableAssociation`     | Subnet→RT Assoc      | (compound-only)                  | -             |
| 26  | `AWS::EFS::FileSystem`                      | EFS File System      | efs-file-system                  | -             |
| 27  | `AWS::EFS::MountTarget`                     | EFS Mount Target     | efs-mount-target                 | -             |
| 28  | `AWS::Events::Rule`                         | EventBridge Rule     | events-rule                      | -             |
| 29  | `AWS::Events::EventBus`                     | EventBridge EventBus | events-eventbus                  | -             |
| 30  | `AWS::SNS::Subscription`                    | SNS Subscription     | sns-subscription                 | -             |
| 31  | `AWS::KMS::Key`                             | KMS Key (CMK)        | kms-key                          | -             |
| 32  | `AWS::Events::Connection`                   | EventBridge Conn.    | events-connection                | Secret (auto) |
| 33  | `AWS::Events::ApiDestination`               | EventBridge ApiDest. | events-apidestination            | -             |
| 34  | `AWS::CloudFront::Distribution`             | CloudFront CDN       | cloudfront-distribution          | -             |
| 35  | `AWS::CloudFront::OriginAccessControl`      | CloudFront OAC       | cloudfront-origin-access-control | -             |
| 36  | `AWS::S3::BucketPolicy`                     | S3 Bucket Policy     | s3-bucket-policy                 | -             |
| 37  | `AWS::RDS::DBSubnetGroup`                   | RDS DB Subnet Group  | rds-db-subnet-group              | -             |
| 38  | `AWS::EC2::EIP`                             | Elastic IP           | ec2-eip                          | -             |

A **generic plugin** handles any resource type not covered by a dedicated plugin, using CloudFormation schema defaults.

### Static Website Compound — CCAPI wiring

The `static-website` compound pattern provisions S3 + CloudFront + OAC + BucketPolicy entirely through CCAPI. The four resources are connected by marker-refs:

- `website-bucket` and `cdn-oac` are created in parallel.
- `cdn-distribution` references `cdn-oac` via `markerRef` (OriginAccessControlId) and `website-bucket` via `markerRef` (origin DomainName).
- `bucket-policy` references `website-bucket` via `markerRef` (Bucket primary identifier) and `cdn-distribution` via `markerRef` (aws:SourceArn — resolved to the full account-scoped distribution ARN via `buildResourceArn`).

The compound destroy pipeline tiers `bucket-policy` first (tier 0), then the distribution (tier 1, two-step disable+delete), then the OAC (tier 2), then the bucket (tier 5). Tier ordering lives in the shared destroy strategies under [`packages/core/src/destroy-strategies/`](../packages/core/src/destroy-strategies/) (CloudFront's two-step handled by [`strategies/cloudfront-distribution.ts`](../packages/core/src/destroy-strategies/strategies/cloudfront-distribution.ts)). The e2e sweep helper at [`apps/cli/src/e2e/bulk-sweep.ts`](../apps/cli/src/e2e/bulk-sweep.ts) is the only remaining tier-aware enumerator (test-only — there is no user-reachable `--all` / `--include-iam` CLI flag).

## Provisioning Notes

### State Guard

Before provisioning, the resource provisioner performs a "state guard" check (Read-Before-Write) via CloudControl to detect if a resource with the same identifier already exists. This prevents accidental overwrites.

**Exception:** The state guard is **skipped for S3 buckets** because bucket names are globally unique across all AWS accounts. Another account may own a bucket with the same name, which would cause a false-positive conflict. The CloudControl `CreateResource` call itself correctly handles name collisions for S3. When a bucket name is already taken, the error message reads: "S3 bucket name is already taken globally. Choose a different name."

### Tags Format

Every dedicated resource plugin accepts tags in `Key:Value` format (comma-separated). Tags are validated at input time via a shared `TAGS_VALIDATE` function -- invalid formats (missing colon separator) are rejected with an error message:

```
Invalid tag format. Use Key:Value pairs separated by commas (e.g. env:production, team:backend)
```

### Virtual Fields

Some plugins use virtual wizard fields that are stripped before sending to CloudFormation:

- **`RouteType`** (`AWS::EC2::Route`): An enum field (`public`/`private`) that controls which target field is shown (`GatewayId` for public, `NatGatewayId` for private). Stripped via `toCfn: () => undefined`.

### Numeric Field Conversion

Several plugins (CloudWatch Alarm, SQS Queue, RDS DBInstance) convert string inputs to numbers via `toCfn` using `Number()` to satisfy CloudFormation's type requirements.

### ELBv2 Defaults

The `AWS::ElasticLoadBalancingV2::LoadBalancer` plugin defaults `Scheme` to `internet-facing` (not `internal`).

### S3 Bucket Specifics

- **OwnershipControls**: Auto-fixed by BP-S3-008 to `BucketOwnerEnforced` (disables ACLs)
- **Lifecycle rules**: Use `Id: "assignee-default-lifecycle"`. Expiration <= 30d is rejected at prompt time. Expiration is clamped above transition days in `assembleS3Composites`
- **CORS**: `AllowedHeaders` defaults to `["*"]`
- **Replication**: Only shown when versioning is enabled. Skipped without an IAM Role ARN

### ApiGatewayV2 Tags

`AWS::ApiGatewayV2::Api` Tags are formatted as `[{Key, Value}]` array (not the `{Key: Value}` map format used by some other services).

### RDS Password

`AWS::RDS::DBInstance` `MasterUserPassword` has no hardcoded `initialValue`. Leaving it blank triggers AWS Secrets Manager auto-generation.

## CCAPI Fallback Types

assignee.ai has no direct SDK write paths for AWS resources — every first-class type flows through the CloudControl API. The only remaining entries in `CCAPI_FALLBACK_TYPES` are types that CCAPI cannot model at all, which are redirected to a supported alternative at plan time:

| Unsupported Type                     | Recommended Alternative             |
| ------------------------------------ | ----------------------------------- |
| `AWS::Lambda::Permission`            | `AWS::Lambda::PermissionPolicy`     |
| `AWS::ElastiCache::ReplicationGroup` | `AWS::ElastiCache::ServerlessCache` |

The operator IAM bundle is split across three managed policies (core + Services-A + Services-B) so the combined service-action surface fits inside AWS's 6144-byte per-managed-policy limit. All three policies attach to the same `assignee-operator` IAM user and AWS evaluates their union — see [`packages/core/src/config/iam-policies/`](../packages/core/src/config/iam-policies/) for the canonical generators.

## Co-provisioning

Certain resource types automatically create companion resources:

- **Lambda Function** -- auto-creates a CloudWatch LogGroup (`/aws/lambda/<function-name>`) for function logs
- **ECS Cluster** -- auto-creates a CloudWatch LogGroup for container logs

## Compound Architecture Patterns

Compound patterns let you provision multiple related resources with a single natural language command. Resources are created in dependency order with parallel groups where possible.

### VPC Networking (17 resources)

**Trigger keywords**: "create a vpc", "vpc with subnets", "vpc network", "multi-az vpc"

Creates a complete multi-AZ network topology:

| Resource               | Type                                    | Count |
| ---------------------- | --------------------------------------- | ----- |
| VPC                    | `AWS::EC2::VPC`                         | 1     |
| Public Subnets         | `AWS::EC2::Subnet`                      | 2     |
| Private Subnets        | `AWS::EC2::Subnet`                      | 2     |
| Internet Gateway       | `AWS::EC2::InternetGateway`             | 1     |
| VPC Gateway Attachment | `AWS::EC2::VPCGatewayAttachment`        | 1     |
| Route Tables           | `AWS::EC2::RouteTable`                  | 2     |
| Routes                 | `AWS::EC2::Route`                       | 2     |
| NAT Gateway            | `AWS::EC2::NatGateway`                  | 1     |
| Elastic IP             | `AWS::EC2::EIP`                         | 1     |
| Subnet-RT Associations | `AWS::EC2::SubnetRouteTableAssociation` | 4     |

Provisioning order (6 groups):

1. VPC
2. Subnets + IGW + EIP (parallel)
3. IGW Attachment + Route Tables (parallel)
4. Public Route + NAT Gateway (parallel)
5. Private Route
6. Subnet-RT Associations (parallel)

Cost: dominated by the NAT Gateway hourly + data-processing fee. Run `assignee infra plan --json "..."  | jq .estimatedMonthlyCost` for the live monthly estimate in your region.

### WebSocket API (12 resources)

**Trigger keywords**: "websocket api", "realtime api", "chat api", "ws api"

Provisions a complete WebSocket API Gateway with Lambda backend, execution role, and log group.

| Resource                       | Type                             |
| ------------------------------ | -------------------------------- |
| IAM Execution Role             | `AWS::IAM::Role`                 |
| Lambda Function                | `AWS::Lambda::Function`          |
| CloudWatch LogGroup            | `AWS::Logs::LogGroup`            |
| API Gateway V2 WS Api          | `AWS::ApiGatewayV2::Api`         |
| API Gateway V2 Integration     | `AWS::ApiGatewayV2::Integration` |
| Connect Route                  | `AWS::ApiGatewayV2::Route`       |
| Disconnect Route               | `AWS::ApiGatewayV2::Route`       |
| Default Route                  | `AWS::ApiGatewayV2::Route`       |
| API Gateway V2 Stage           | `AWS::ApiGatewayV2::Stage`       |
| Lambda Permission (connect)    | `AWS::Lambda::Permission`        |
| Lambda Permission (default)    | `AWS::Lambda::Permission`        |
| Lambda Permission (disconnect) | `AWS::Lambda::Permission`        |

The `protocolType` is `WEBSOCKET`. Clients connect via `wss://`. Lambda routes handle `$connect`, `$disconnect`, and `$default` message events. Lambda Permissions are display-only instructions (CCAPI routes `AWS::Lambda::Permission` through `AWS::Lambda::PermissionPolicy`).

> **Note on rows above:** `AWS::Lambda::Permission`, `AWS::ApiGatewayV2::Integration`, `AWS::ApiGatewayV2::Route`, and `AWS::ApiGatewayV2::Stage` are **display-only** — they are not first-class entries in `SUPPORTED_TYPES_ARRAY` (`packages/core/src/config/resource-types/supported.ts`). They appear inside compound patterns via the generic-plugin fallback rather than via a dedicated plugin.

### Serverless API (8 resources)

**Trigger keywords**: "serverless api", "api gateway lambda", "http api"

| Resource                | Type                             |
| ----------------------- | -------------------------------- |
| IAM Execution Role      | `AWS::IAM::Role`                 |
| Lambda Function         | `AWS::Lambda::Function`          |
| CloudWatch LogGroup     | `AWS::Logs::LogGroup`            |
| API Gateway V2 Api      | `AWS::ApiGatewayV2::Api`         |
| API Gateway Integration | `AWS::ApiGatewayV2::Integration` |
| API Gateway Route       | `AWS::ApiGatewayV2::Route`       |
| API Gateway Stage       | `AWS::ApiGatewayV2::Stage`       |
| Lambda Permission       | `AWS::Lambda::Permission`        |

### Message Processing Pipeline (5+ resources)

**Trigger keywords**: "message processing", "sqs lambda", "queue processor", "event-driven"

| Resource              | Type                    |
| --------------------- | ----------------------- |
| Dead Letter Queue     | `AWS::SQS::Queue`       |
| Main Processing Queue | `AWS::SQS::Queue`       |
| Results Table         | `AWS::DynamoDB::Table`  |
| Lambda Execution Role | `AWS::IAM::Role`        |
| Processor Lambda      | `AWS::Lambda::Function` |

### Container Service (ECS Fargate)

**Trigger keywords**: "container service", "ecs fargate", "docker service"

| Resource       | Type                                        |
| -------------- | ------------------------------------------- |
| ECR Repository | `AWS::ECR::Repository`                      |
| Task IAM Role  | `AWS::IAM::Role`                            |
| Security Group | `AWS::EC2::SecurityGroup`                   |
| ECS Cluster    | `AWS::ECS::Cluster`                         |
| ALB            | `AWS::ElasticLoadBalancingV2::LoadBalancer` |

### Three-Tier Web Application

**Trigger keywords**: "three tier", "3 tier", "web application with database", "alb ec2 rds"

| Resource                  | Type                                        |
| ------------------------- | ------------------------------------------- |
| ALB Security Group        | `AWS::EC2::SecurityGroup`                   |
| App Security Group        | `AWS::EC2::SecurityGroup`                   |
| EC2 Instance Profile Role | `AWS::IAM::Role`                            |
| ALB                       | `AWS::ElasticLoadBalancingV2::LoadBalancer` |
| EC2 Instance              | `AWS::EC2::Instance`                        |
| RDS Database              | `AWS::RDS::DBInstance`                      |

### Scheduled Lambda (EventBridge cron) — 4 resources

**Trigger keywords**: "scheduled lambda", "cron lambda", "periodic lambda", "nightly lambda", "nightly job", "cron job", "scheduled task", "recurring lambda", "eventbridge scheduled lambda"

Time-triggered Lambda function that fires on an EventBridge schedule. Bundles the IAM execution role, Lambda function, schedule rule, and display-only permission grant for events.amazonaws.com.

| Resource                  | Type                      | Count | Notes                                |
| ------------------------- | ------------------------- | ----- | ------------------------------------ |
| Lambda Execution Role     | `AWS::IAM::Role`          | 1     | PowerUserAccess permissions boundary |
| Lambda Function           | `AWS::Lambda::Function`   | 1     | arm64 Graviton, 512 MB, placeholder  |
| EventBridge Schedule Rule | `AWS::Events::Rule`       | 1     | `rate(1 hour)` by default, ENABLED   |
| Lambda Permission         | `AWS::Lambda::Permission` | 1     | display-only (manual post-apply)     |

**Defaults**: ScheduleExpression is `rate(1 hour)` — override with `--set ScheduleExpression="rate(5 minutes)"` or `--set ScheduleExpression="cron(0 12 * * ? *)"`. The rule has an inline Target referencing the Lambda's ARN via `markerGetAtt`. Lambda Permission is display-only because CCAPI routes `AWS::Lambda::Permission` through `AWS::Lambda::PermissionPolicy` (known-flaky for schedule rules), so users run `aws lambda add-permission` post-apply to let events.amazonaws.com actually invoke the function.

**Costs**: Rule evaluation on the default bus is free. The workload fee is the Lambda invocation cost at the scheduled rate.

### EFS File System (with private VPC) — 10 resources

**Trigger keywords**: "efs", "efs file system", "elastic file system", "nfs file system", "create an efs", "create a shared file system", "shared storage for lambda", "shared storage for ec2", "nfs mount"

Bare "create an EFS file system" intents bundle the minimum viable VPC topology so the file system is usable on first apply. EFS is reached by NFS mount from workloads inside a VPC, and every mount target needs a subnet + security group allowing TCP 2049, so there is no useful single-resource EFS plan.

| Resource                   | Type                                    | Count |
| -------------------------- | --------------------------------------- | ----- |
| VPC (10.0.0.0/16)          | `AWS::EC2::VPC`                         | 1     |
| Private Subnets (multi-AZ) | `AWS::EC2::Subnet`                      | 2     |
| Private Route Table        | `AWS::EC2::RouteTable`                  | 1     |
| Subnet-RT Associations     | `AWS::EC2::SubnetRouteTableAssociation` | 2     |
| NFS Security Group         | `AWS::EC2::SecurityGroup`               | 1     |
| EFS File System            | `AWS::EFS::FileSystem`                  | 1     |
| EFS Mount Targets          | `AWS::EFS::MountTarget`                 | 2     |

Provisioning order (4 groups):

1. VPC
2. Subnets + RouteTable + Security Group + EFS FileSystem (parallel — all depend only on VPC)
3. Subnet ↔ RouteTable associations (parallel)
4. Mount Targets (parallel — one per private subnet)

**Defaults**: Encrypted at rest, elastic throughput mode, backups ON via BackupPolicy, NFS SG allows TCP 2049 from the VPC CIDR only (never 0.0.0.0/0).

**Why private-only?** Public subnets + lax SGs are the canonical "open NFS to the world" misconfiguration. If you need outbound internet from the EFS-mounting workload, combine with the full `vpc-networking` pattern (`"create a vpc with EFS"` — matches vpc-networking first and EFS is added separately).

Cost: the networking layer (VPC + private subnets + route tables) is free-tier. EFS storage is billed per GB-month — run `assignee infra optimize` for the live rate from the Pricing MCP in your region.

### Static Website

**Trigger keywords**: "static website", "static site", "frontend hosting", "spa hosting"

| Resource                   | Type                                   |
| -------------------------- | -------------------------------------- |
| S3 Website Bucket          | `AWS::S3::Bucket`                      |
| CloudFront OAC             | `AWS::CloudFront::OriginAccessControl` |
| CloudFront Distribution    | `AWS::CloudFront::Distribution`        |
| S3 Bucket Policy           | `AWS::S3::BucketPolicy`                |
| S3 Upload (post-provision) | SDK: S3 PutObject                      |

All four CCAPI resources are provisioned in dependency order (see "Static Website Compound" section above for the full marker-ref wiring and destroy tier ordering). All public access on S3 is blocked by default. CloudFront serves content via Origin Access Control (OAC). When `--source <path>` is provided, files are uploaded to S3 after provisioning as a post-provision hook.

### VPC with Public Subnets Only (9 resources)

**Pattern ID**: `vpc-public-only`

**Trigger keywords**: "simple vpc", "vpc public only", "vpc public-only", "public-only vpc", "vpc no nat", "vpc without nat", "cheap vpc", "free-tier vpc"

Free-tier VPC variant — no NAT Gateway, no private subnets. All components (VPC, subnets, IGW, route tables) are free-tier. Use this when your workloads only need public internet access and you want to avoid the NAT Gateway hourly charge.

| Resource               | Type                                    | Count |
| ---------------------- | --------------------------------------- | ----- |
| VPC                    | `AWS::EC2::VPC`                         | 1     |
| Public Subnets         | `AWS::EC2::Subnet`                      | 2     |
| Internet Gateway       | `AWS::EC2::InternetGateway`             | 1     |
| VPC Gateway Attachment | `AWS::EC2::VPCGatewayAttachment`        | 1     |
| Public Route Table     | `AWS::EC2::RouteTable`                  | 1     |
| Public Route           | `AWS::EC2::Route`                       | 1     |
| Subnet-RT Associations | `AWS::EC2::SubnetRouteTableAssociation` | 2     |

Provisioning order (4 groups):

1. VPC
2. Public Subnets + IGW (parallel)
3. IGW Attachment + Public Route Table (parallel)
4. Public Route → Subnet-RT Associations (parallel)

Cost: $0 networking — IGW and routes are free. Run `assignee infra optimize` or `assignee infra plan --json "..."` to confirm against current AWS pricing.

### SQS Queue with Dead-Letter Queue (2 resources)

**Pattern ID**: `sqs-with-dlq` (CP-1, Epic-105)

**Trigger keywords**: "with dlq", "with dead-letter queue", "dead letter queue", "sqs dlq", "sqs with dlq", "queue with dlq", "queue and dlq"

Primary SQS queue wired to a DLQ companion via `RedrivePolicy`. The DLQ is created first so its ARN can be injected into the primary queue's `RedrivePolicy.deadLetterTargetArn` via `markerGetAtt`.

| Resource          | Type              | Notes                                        |
| ----------------- | ----------------- | -------------------------------------------- |
| Dead Letter Queue | `AWS::SQS::Queue` | Created first; SSE enabled, 14-day retention |
| Primary Queue     | `AWS::SQS::Queue` | RedrivePolicy → DLQ ARN, maxReceiveCount: 5  |

Provisioning order (2 groups):

1. Dead Letter Queue
2. Primary Queue (depends on DLQ ARN)

Both queues have `SqsManagedSseEnabled: true` and `MessageRetentionPeriod: 1209600` (14 days) by default. The `RedrivePolicy` on the primary queue uses `markerGetAtt(DLQ, "Arn")` resolved at apply time.

> **Note**: This pattern is suppressed when the intent includes "lambda", "processor", or "message processing" — those intents match the larger `message-processing` compound pattern instead.

### SNS Topic with Email Subscription (2 resources)

**Pattern ID**: `sns-with-email-subscription` (CP-2, Epic-105)

**Trigger keywords**: "with email subscription", "with subscriber", "sns email", "sns with email", "sns topic email", "topic with email subscription"

SNS Topic + email Subscription pair. The Subscription's `TopicArn` is wired via `markerRef(TOPIC)` so it resolves to the topic ARN returned by CCAPI after the topic is created. The email address is extracted from the intent by `email-extractor.ts` and injected into the Subscription's `Endpoint` field at plan time.

| Resource           | Type                     | Notes                                       |
| ------------------ | ------------------------ | ------------------------------------------- |
| SNS Topic          | `AWS::SNS::Topic`        | Created first                               |
| Email Subscription | `AWS::SNS::Subscription` | Protocol: email, TopicArn: markerRef(Topic) |

Provisioning order (2 groups):

1. SNS Topic
2. Email Subscription (depends on Topic ARN)

AWS sends a confirmation email to the subscribed address after the Subscription is created — the subscriber must click the confirmation link before messages are delivered.

> **Note**: This pattern is suppressed when the intent includes "lambda", "sqs", "queue", or "message processing".

### Lambda Function with Exec Role (2 resources)

**Pattern ID**: `lambda-with-exec-role` (Wave 13, pre-Epic-105)

**Trigger keywords**: "create a lambda", "create a function", "deploy a lambda", "lambda function", "node lambda", "python lambda", "serverless function", "background worker"

Minimal Lambda + auto-created IAM execution role. Closes the gap where `assignee infra plan "Create a Lambda"` previously required the user to provide a `--set Role=arn:…` workaround because Lambda's `Role` field is mandatory. With this pattern, plain "create a lambda" intents produce a 2-resource compound: the IAM role is created first, then the Lambda function with the role ARN injected via `markerGetAtt`.

| Resource              | Type                    | Notes                                             |
| --------------------- | ----------------------- | ------------------------------------------------- |
| Lambda Execution Role | `AWS::IAM::Role`        | Lambda trust policy + AWSLambdaBasicExecutionRole |
| Lambda Function       | `AWS::Lambda::Function` | Role injected via markerGetAtt from above         |

Provisioning order (2 groups):

1. IAM Execution Role (lambda.amazonaws.com trust policy, AWS-managed `AWSLambdaBasicExecutionRole` attached)
2. Lambda Function (Role ARN resolved from step 1)

The auto-named role follows the pattern `assignee-iam-execution-role-<runIdShort>`. If the intent specifies a `FunctionName`, it is preserved end-to-end; the auto-name fires only when the parser did not extract one.

> **Note**: The `serverless-api` pattern (8 resources, includes API Gateway) is registered first and wins for intents like "create a serverless api with lambda". This pattern matches bare "create a lambda" intents that do not reference an API.

## Usage

```bash
# Single resource
assignee infra plan "create an S3 bucket named logs-prod"

# Compound pattern
assignee infra plan "create a VPC with public and private subnets"

# The CLI auto-detects whether your intent matches a compound pattern
# and provisions all resources in dependency order
```
