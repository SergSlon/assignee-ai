# Supported Resource Types

assignee.ai supports 23 AWS resource types via CloudFormation CloudControl API, plus additional auxiliary types used in compound patterns.

## Resource Type Table

| #   | CloudFormation Type                         | Short Name           | Plugin                | Co-provisions |
| --- | ------------------------------------------- | -------------------- | --------------------- | ------------- |
| 1   | `AWS::S3::Bucket`                           | S3 Bucket            | s3-bucket             | -             |
| 2   | `AWS::SSM::Parameter`                       | SSM Parameter        | ssm-parameter         | -             |
| 3   | `AWS::IAM::Role`                            | IAM Role             | iam-role              | -             |
| 4   | `AWS::EC2::Instance`                        | EC2 Instance         | ec2-instance          | -             |
| 5   | `AWS::RDS::DBInstance`                      | RDS Database         | rds-dbinstance        | -             |
| 6   | `AWS::Lambda::Function`                     | Lambda Function      | lambda-function       | LogGroup      |
| 7   | `AWS::EC2::VPC`                             | VPC                  | vpc                   | -             |
| 8   | `AWS::EC2::Subnet`                          | Subnet               | subnet                | -             |
| 9   | `AWS::EC2::SecurityGroup`                   | Security Group       | security-group        | -             |
| 10  | `AWS::DynamoDB::Table`                      | DynamoDB Table       | dynamodb-table        | -             |
| 11  | `AWS::SQS::Queue`                           | SQS Queue            | sqs-queue             | -             |
| 12  | `AWS::SNS::Topic`                           | SNS Topic            | sns-topic             | -             |
| 13  | `AWS::ElasticLoadBalancingV2::LoadBalancer` | ALB/NLB              | elbv2-loadbalancer    | -             |
| 14  | `AWS::ECS::Cluster`                         | ECS Cluster          | ecs-cluster           | LogGroup      |
| 15  | `AWS::ECR::Repository`                      | ECR Repository       | ecr-repository        | -             |
| 16  | `AWS::Logs::LogGroup`                       | CloudWatch Log Group | logs-loggroup         | -             |
| 17  | `AWS::EC2::InternetGateway`                 | Internet Gateway     | ec2-internet-gateway  | -             |
| 18  | `AWS::EC2::RouteTable`                      | Route Table          | ec2-route-table       | -             |
| 19  | `AWS::EC2::Route`                           | Route                | ec2-route             | -             |
| 20  | `AWS::EC2::NatGateway`                      | NAT Gateway          | ec2-nat-gateway       | -             |
| 21  | `AWS::ApiGatewayV2::Api`                    | API Gateway V2       | apigatewayv2-api      | -             |
| 22  | `AWS::CloudWatch::Alarm`                    | CloudWatch Alarm     | cloudwatch-alarm      | -             |
| 23  | `AWS::SecretsManager::Secret`               | Secrets Manager      | secretsmanager-secret | -             |

A **generic plugin** handles any resource type not covered by a dedicated plugin, using CloudFormation schema defaults.

## Provisioning Notes

### State Guard

Before provisioning, the resource provisioner performs a "state guard" check (Read-Before-Write) via CloudControl to detect if a resource with the same identifier already exists. This prevents accidental overwrites.

**Exception:** The state guard is **skipped for S3 buckets** because bucket names are globally unique across all AWS accounts. Another account may own a bucket with the same name, which would cause a false-positive conflict. The CloudControl `CreateResource` call itself correctly handles name collisions for S3.

### Tags Format

All resource plugins accept tags in `Key:Value` format (comma-separated). Tags are validated at input time -- invalid formats (missing colon separator) are rejected with an error message:

```
Invalid tag format. Use Key:Value pairs separated by commas (e.g. env:production, team:backend)
```

## CCAPI Fallback Types

These resource types cannot be provisioned via CloudControl API and use direct SDK calls:

| Type                              | Fallback Method                      |
| --------------------------------- | ------------------------------------ |
| `AWS::Lambda::EventSourceMapping` | SDK: Lambda CreateEventSourceMapping |
| `AWS::SNS::Subscription`          | SDK: SNS Subscribe                   |

These types are redirected with a suggestion to use an alternative:

| Unsupported Type                     | Recommended Alternative             |
| ------------------------------------ | ----------------------------------- |
| `AWS::Lambda::Permission`            | `AWS::Lambda::PermissionPolicy`     |
| `AWS::ElastiCache::ReplicationGroup` | `AWS::ElastiCache::ServerlessCache` |

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

### Static Website

**Trigger keywords**: "static website", "static site", "frontend hosting", "spa hosting"

| Resource          | Type              |
| ----------------- | ----------------- |
| S3 Website Bucket | `AWS::S3::Bucket` |

All public access is blocked by default. CloudFront integration is planned for a future release.

## Usage

```bash
# Single resource
assignee plan "create an S3 bucket named logs-prod"

# Compound pattern
assignee plan "create a VPC with public and private subnets"

# The CLI auto-detects whether your intent matches a compound pattern
# and provisions all resources in dependency order
```
