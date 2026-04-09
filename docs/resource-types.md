# Supported Resource Types

assignee.ai supports 36 AWS resource types via CloudFormation CloudControl API, plus additional auxiliary types used in compound patterns.

## Resource Type Table

| #   | CloudFormation Type                              | Short Name           | Plugin                           | Co-provisions |
| --- | ------------------------------------------------ | -------------------- | -------------------------------- | ------------- |
| 1   | `AWS::S3::Bucket`                                | S3 Bucket            | s3-bucket                        | -             |
| 2   | `AWS::SSM::Parameter`                            | SSM Parameter        | ssm-parameter                    | -             |
| 3   | `AWS::IAM::Role`                                 | IAM Role             | iam-role                         | -             |
| 4   | `AWS::EC2::Instance`                             | EC2 Instance         | ec2-instance                     | -             |
| 5   | `AWS::RDS::DBInstance`                           | RDS Database         | rds-dbinstance                   | -             |
| 6   | `AWS::Lambda::Function`                          | Lambda Function      | lambda-function                  | LogGroup      |
| 7   | `AWS::EC2::VPC`                                  | VPC                  | vpc                              | -             |
| 8   | `AWS::EC2::Subnet`                               | Subnet               | subnet                           | -             |
| 9   | `AWS::EC2::SecurityGroup`                        | Security Group       | security-group                   | -             |
| 10  | `AWS::DynamoDB::Table`                           | DynamoDB Table       | dynamodb-table                   | -             |
| 11  | `AWS::SQS::Queue`                                | SQS Queue            | sqs-queue                        | -             |
| 12  | `AWS::SNS::Topic`                                | SNS Topic            | sns-topic                        | -             |
| 13  | `AWS::ElasticLoadBalancingV2::LoadBalancer`      | ALB/NLB              | elbv2-loadbalancer               | -             |
| 14  | `AWS::ECS::Cluster`                              | ECS Cluster          | ecs-cluster                      | LogGroup      |
| 15  | `AWS::ECR::Repository`                           | ECR Repository       | ecr-repository                   | -             |
| 16  | `AWS::Logs::LogGroup`                            | CloudWatch Log Group | logs-loggroup                    | -             |
| 17  | `AWS::EC2::InternetGateway`                      | Internet Gateway     | ec2-internet-gateway             | -             |
| 18  | `AWS::EC2::RouteTable`                           | Route Table          | ec2-route-table                  | -             |
| 19  | `AWS::EC2::Route`                                | Route                | ec2-route                        | -             |
| 20  | `AWS::EC2::NatGateway`                           | NAT Gateway          | ec2-nat-gateway                  | -             |
| 21  | `AWS::ApiGatewayV2::Api`                         | API Gateway V2       | apigatewayv2-api                 | -             |
| 22  | `AWS::CloudWatch::Alarm`                         | CloudWatch Alarm     | cloudwatch-alarm                 | -             |
| 23  | `AWS::SecretsManager::Secret`                    | Secrets Manager      | secretsmanager-secret            | -             |
| 24  | `AWS::EC2::VPCGatewayAttachment`                 | VPC Gateway Attach   | (compound-only)                  | -             |
| 25  | `AWS::EC2::SubnetRouteTableAssociation`          | Subnet→RT Assoc      | (compound-only)                  | -             |
| 26  | `AWS::EFS::FileSystem` (A1)                      | EFS File System      | efs-file-system                  | -             |
| 27  | `AWS::EFS::MountTarget` (A1 follow-up)           | EFS Mount Target     | efs-mount-target                 | -             |
| 28  | `AWS::Events::Rule` (A8)                         | EventBridge Rule     | events-rule                      | -             |
| 29  | `AWS::Events::EventBus` (A9)                     | EventBridge EventBus | events-eventbus                  | -             |
| 30  | `AWS::SNS::Subscription` (A10)                   | SNS Subscription     | sns-subscription                 | -             |
| 31  | `AWS::KMS::Key` (A11)                            | KMS Key (CMK)        | kms-key                          | -             |
| 32  | `AWS::Events::Connection` (A12)                  | EventBridge Conn.    | events-connection                | Secret (auto) |
| 33  | `AWS::Events::ApiDestination` (A13)              | EventBridge ApiDest. | events-apidestination            | -             |
| 34  | `AWS::CloudFront::Distribution` (A14)            | CloudFront CDN       | cloudfront-distribution          | -             |
| 35  | `AWS::CloudFront::OriginAccessControl` (Task 4b) | CloudFront OAC       | cloudfront-origin-access-control | -             |
| 36  | `AWS::S3::BucketPolicy` (Task 4b)                | S3 Bucket Policy     | s3-bucket-policy                 | -             |

A **generic plugin** handles any resource type not covered by a dedicated plugin, using CloudFormation schema defaults.

### Static Website Compound — fully CCAPI as of Task 4b

Pre (f) 2026-04-09 the `static-website` compound pattern provisioned S3 via CCAPI but the CloudFront distribution, OriginAccessControl, and S3 bucket policy were created via direct SDK calls in a post-provision hook (`apps/cli/src/services/cloudfront-setup.ts`, ~430 LOC). That hook has been **deleted**. CloudFront + OAC + BucketPolicy are now first-class CCAPI resources in the compound, with marker-ref cross-references wiring them together:

- `website-bucket` → `cdn-oac` (parallel)
- `cdn-distribution` references `cdn-oac` via `markerRef` (OriginAccessControlId) and `website-bucket` via `markerRef` (origin DomainName)
- `bucket-policy` references `website-bucket` via `markerRef` (Bucket primary identifier) and `cdn-distribution` via `markerRef` (aws:SourceArn condition — resolved to the full account-scoped distribution ARN via `buildResourceArn`)

The compound apply is fully deterministic via CCAPI; the destroy pipeline tiers `bucket-policy` first (tier 0), then the distribution (tier 1, two-step disable+delete), then the OAC (tier 2), then the bucket (tier 5). See `apps/cli/src/services/bulk-destroy.ts` for the full ordering.

## Provisioning Notes

### State Guard

Before provisioning, the resource provisioner performs a "state guard" check (Read-Before-Write) via CloudControl to detect if a resource with the same identifier already exists. This prevents accidental overwrites.

**Exception:** The state guard is **skipped for S3 buckets** because bucket names are globally unique across all AWS accounts. Another account may own a bucket with the same name, which would cause a false-positive conflict. The CloudControl `CreateResource` call itself correctly handles name collisions for S3. When a bucket name is already taken, the error message reads: "S3 bucket name is already taken globally. Choose a different name."

### Tags Format

All 22 resource plugins accept tags in `Key:Value` format (comma-separated). Tags are validated at input time via a shared `TAGS_VALIDATE` function -- invalid formats (missing colon separator) are rejected with an error message:

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

After the A6 and A10 migrations, assignee.ai no longer has any direct
SDK write paths for AWS resources — every first-class type flows through
the CloudControl API. The only remaining entries in `CCAPI_FALLBACK_TYPES`
are types that CCAPI cannot model at all, which are redirected to a
supported alternative at plan time:

| Unsupported Type                     | Recommended Alternative             |
| ------------------------------------ | ----------------------------------- |
| `AWS::Lambda::Permission`            | `AWS::Lambda::PermissionPolicy`     |
| `AWS::ElastiCache::ReplicationGroup` | `AWS::ElastiCache::ServerlessCache` |

Historical note:

- **A6 (2026-04-08)** — `AWS::Lambda::EventSourceMapping` was migrated
  from SDK fallback to CCAPI after a live-AWS probe confirmed full
  handler support.
- **A10 (2026-04-09)** — `AWS::SNS::Subscription` was promoted from
  `CCAPI_FALLBACK_TYPES` to a first-class CCAPI type. The SDK
  `SubscribeCommand`/`UnsubscribeCommand` code paths in
  `sdk-fallback-dispatcher.ts` were deleted, and the `sns:Subscribe` /
  `sns:Unsubscribe` IAM actions moved from the unscoped
  `SdkFallbackActions` policy statement to the CCAPI-scoped
  `ServiceSpecificActions` statements (split across
  `operatorServicesAPolicy()` + `operatorServicesBPolicy()` after the
  (f) 2026-04-09 A/B split).
- **(f) 2026-04-09 A/B split** — the single
  `AssigneeOperatorServicesPolicy` managed policy was split into two
  byte-balanced halves (`AssigneeOperatorServicesAPolicy` +
  `AssigneeOperatorServicesBPolicy`) so the combined service-action
  surface fits inside AWS's 6144-byte managed-policy limit with
  ~3300 bytes of headroom per half. All three operator policies
  (core + A + B) attach to the same `assignee-operator` IAM user and
  AWS evaluates the union — strictly equivalent to the pre-split
  single-policy version. The split unblocks ~30 additional resource
  type promotions before the next headroom threshold fires.

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

Cost: ~$32/month (NAT Gateway is the dominant cost driver).

**Public-only variant**: "simple vpc", "vpc public only" -- creates 9 resources (no NAT, no private subnets). Cost: ~$0/month.

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

Cost: ~$0 for the networking layer (VPC + private subnets + route tables are free). EFS storage bills at the per-GB/month rate from the Pricing MCP.

### Static Website

**Trigger keywords**: "static website", "static site", "frontend hosting", "spa hosting"

| Resource                   | Type                                   |
| -------------------------- | -------------------------------------- |
| S3 Website Bucket          | `AWS::S3::Bucket`                      |
| CloudFront Distribution    | `AWS::CloudFront::Distribution`        |
| CloudFront OAC             | `AWS::CloudFront::OriginAccessControl` |
| S3 Upload (post-provision) | SDK: S3 PutObject                      |

All public access on S3 is blocked by default. CloudFront serves content via Origin Access Control (OAC). When `--source <path>` is provided, files are uploaded to S3 after provisioning as a post-provision hook.

## Usage

```bash
# Single resource
assignee plan "create an S3 bucket named logs-prod"

# Compound pattern
assignee plan "create a VPC with public and private subnets"

# The CLI auto-detects whether your intent matches a compound pattern
# and provisions all resources in dependency order
```
