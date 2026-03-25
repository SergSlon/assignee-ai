/**
 * Shared resource fixtures for all 23 supported CloudFormation resource types.
 *
 * Provides realistic ARNs, identifiers, desired states, and tags for use
 * across MCP server and CLI test suites.
 */

// ── Types ────────────────────────────────────────────────────────────────────

export interface ResourceFixture {
  resourceType: string;
  arn: string;
  identifier: string;
  desiredState: Record<string, unknown>;
  tags: Array<{ Key: string; Value: string }>;
}

// ── Standard tags applied to every managed resource ──────────────────────────

const STANDARD_TAGS: Array<{ Key: string; Value: string }> = [
  { Key: "managed-by", Value: "assignee-ai" },
  { Key: "assignee-run-id", Value: "2026-03-25T12:00:00Z" },
];

// ── Fixture map ──────────────────────────────────────────────────────────────

export const RESOURCE_FIXTURES: Map<string, ResourceFixture> = new Map([
  [
    "AWS::S3::Bucket",
    {
      resourceType: "AWS::S3::Bucket",
      arn: "arn:aws:s3:::my-test-bucket-20260325",
      identifier: "my-test-bucket-20260325",
      desiredState: {
        BucketName: "my-test-bucket-20260325",
      },
      tags: [...STANDARD_TAGS],
    },
  ],
  [
    "AWS::SSM::Parameter",
    {
      resourceType: "AWS::SSM::Parameter",
      arn: "arn:aws:ssm:us-east-1:123456789012:parameter/app/config/db-url",
      identifier: "/app/config/db-url",
      desiredState: {
        Name: "/app/config/db-url",
        Type: "String",
        Value: "postgresql://localhost:5432/mydb",
      },
      tags: [...STANDARD_TAGS],
    },
  ],
  [
    "AWS::IAM::Role",
    {
      resourceType: "AWS::IAM::Role",
      arn: "arn:aws:iam::123456789012:role/my-service-role",
      identifier: "my-service-role",
      desiredState: {
        RoleName: "my-service-role",
        AssumeRolePolicyDocument: JSON.stringify({
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Principal: { Service: "lambda.amazonaws.com" },
              Action: "sts:AssumeRole",
            },
          ],
        }),
      },
      tags: [...STANDARD_TAGS],
    },
  ],
  [
    "AWS::Lambda::Function",
    {
      resourceType: "AWS::Lambda::Function",
      arn: "arn:aws:lambda:us-east-1:123456789012:function:my-api-handler",
      identifier: "my-api-handler",
      desiredState: {
        FunctionName: "my-api-handler",
        Runtime: "nodejs20.x",
        Handler: "index.handler",
        Role: "arn:aws:iam::123456789012:role/my-service-role",
        Code: { ZipFile: "exports.handler=async()=>({statusCode:200})" },
      },
      tags: [...STANDARD_TAGS],
    },
  ],
  [
    "AWS::DynamoDB::Table",
    {
      resourceType: "AWS::DynamoDB::Table",
      arn: "arn:aws:dynamodb:us-east-1:123456789012:table/my-app-table",
      identifier: "my-app-table",
      desiredState: {
        TableName: "my-app-table",
        AttributeDefinitions: [{ AttributeName: "pk", AttributeType: "S" }],
        KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }],
        BillingMode: "PAY_PER_REQUEST",
      },
      tags: [...STANDARD_TAGS],
    },
  ],
  [
    "AWS::SQS::Queue",
    {
      resourceType: "AWS::SQS::Queue",
      arn: "arn:aws:sqs:us-east-1:123456789012:my-task-queue",
      identifier:
        "https://sqs.us-east-1.amazonaws.com/123456789012/my-task-queue",
      desiredState: {
        QueueName: "my-task-queue",
        VisibilityTimeout: 30,
      },
      tags: [...STANDARD_TAGS],
    },
  ],
  [
    "AWS::SNS::Topic",
    {
      resourceType: "AWS::SNS::Topic",
      arn: "arn:aws:sns:us-east-1:123456789012:my-notifications",
      identifier: "arn:aws:sns:us-east-1:123456789012:my-notifications",
      desiredState: {
        TopicName: "my-notifications",
      },
      tags: [...STANDARD_TAGS],
    },
  ],
  [
    "AWS::EC2::SecurityGroup",
    {
      resourceType: "AWS::EC2::SecurityGroup",
      arn: "arn:aws:ec2:us-east-1:123456789012:security-group/sg-0123456789abcdef0",
      identifier: "sg-0123456789abcdef0",
      desiredState: {
        GroupDescription: "Allow HTTPS inbound",
        GroupName: "my-web-sg",
        VpcId: "vpc-0123456789abcdef0",
      },
      tags: [...STANDARD_TAGS],
    },
  ],
  [
    "AWS::EC2::VPC",
    {
      resourceType: "AWS::EC2::VPC",
      arn: "arn:aws:ec2:us-east-1:123456789012:vpc/vpc-0123456789abcdef0",
      identifier: "vpc-0123456789abcdef0",
      desiredState: {
        CidrBlock: "10.0.0.0/16",
        EnableDnsSupport: true,
        EnableDnsHostnames: true,
      },
      tags: [...STANDARD_TAGS],
    },
  ],
  [
    "AWS::EC2::Subnet",
    {
      resourceType: "AWS::EC2::Subnet",
      arn: "arn:aws:ec2:us-east-1:123456789012:subnet/subnet-0123456789abcdef0",
      identifier: "subnet-0123456789abcdef0",
      desiredState: {
        VpcId: "vpc-0123456789abcdef0",
        CidrBlock: "10.0.1.0/24",
        AvailabilityZone: "us-east-1a",
      },
      tags: [...STANDARD_TAGS],
    },
  ],
  [
    "AWS::ECS::Cluster",
    {
      resourceType: "AWS::ECS::Cluster",
      arn: "arn:aws:ecs:us-east-1:123456789012:cluster/my-app-cluster",
      identifier: "my-app-cluster",
      desiredState: {
        ClusterName: "my-app-cluster",
      },
      tags: [...STANDARD_TAGS],
    },
  ],
  [
    "AWS::ECR::Repository",
    {
      resourceType: "AWS::ECR::Repository",
      arn: "arn:aws:ecr:us-east-1:123456789012:repository/my-app-repo",
      identifier: "my-app-repo",
      desiredState: {
        RepositoryName: "my-app-repo",
      },
      tags: [...STANDARD_TAGS],
    },
  ],
  [
    "AWS::ElasticLoadBalancingV2::LoadBalancer",
    {
      resourceType: "AWS::ElasticLoadBalancingV2::LoadBalancer",
      arn: "arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/my-alb/50dc6c495c0c9188",
      identifier:
        "arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/my-alb/50dc6c495c0c9188",
      desiredState: {
        Name: "my-alb",
        Scheme: "internet-facing",
        Type: "application",
        Subnets: ["subnet-0123456789abcdef0", "subnet-0123456789abcdef1"],
      },
      tags: [...STANDARD_TAGS],
    },
  ],
  [
    "AWS::EC2::Instance",
    {
      resourceType: "AWS::EC2::Instance",
      arn: "arn:aws:ec2:us-east-1:123456789012:instance/i-0123456789abcdef0",
      identifier: "i-0123456789abcdef0",
      desiredState: {
        InstanceType: "t3.micro",
        ImageId: "ami-0abcdef1234567890",
        SubnetId: "subnet-0123456789abcdef0",
      },
      tags: [...STANDARD_TAGS],
    },
  ],
  [
    "AWS::RDS::DBInstance",
    {
      resourceType: "AWS::RDS::DBInstance",
      arn: "arn:aws:rds:us-east-1:123456789012:db:my-postgres-db",
      identifier: "my-postgres-db",
      desiredState: {
        DBInstanceIdentifier: "my-postgres-db",
        DBInstanceClass: "db.t3.micro",
        Engine: "postgres",
        MasterUsername: "admin",
        MasterUserPassword: "PLACEHOLDER",
        AllocatedStorage: 20,
      },
      tags: [...STANDARD_TAGS],
    },
  ],
  [
    "AWS::Logs::LogGroup",
    {
      resourceType: "AWS::Logs::LogGroup",
      arn: "arn:aws:logs:us-east-1:123456789012:log-group:/aws/lambda/my-api-handler",
      identifier: "/aws/lambda/my-api-handler",
      desiredState: {
        LogGroupName: "/aws/lambda/my-api-handler",
        RetentionInDays: 14,
      },
      tags: [...STANDARD_TAGS],
    },
  ],
  [
    "AWS::CloudWatch::Alarm",
    {
      resourceType: "AWS::CloudWatch::Alarm",
      arn: "arn:aws:cloudwatch:us-east-1:123456789012:alarm:high-cpu-alarm",
      identifier: "high-cpu-alarm",
      desiredState: {
        AlarmName: "high-cpu-alarm",
        MetricName: "CPUUtilization",
        Namespace: "AWS/EC2",
        Statistic: "Average",
        Period: 300,
        EvaluationPeriods: 2,
        Threshold: 80,
        ComparisonOperator: "GreaterThanThreshold",
      },
      tags: [...STANDARD_TAGS],
    },
  ],
  [
    "AWS::SecretsManager::Secret",
    {
      resourceType: "AWS::SecretsManager::Secret",
      arn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:my-app/db-password-AbCdEf",
      identifier: "my-app/db-password",
      desiredState: {
        Name: "my-app/db-password",
        Description: "Database password for my-app",
      },
      tags: [...STANDARD_TAGS],
    },
  ],
  [
    "AWS::EC2::InternetGateway",
    {
      resourceType: "AWS::EC2::InternetGateway",
      arn: "arn:aws:ec2:us-east-1:123456789012:internet-gateway/igw-0123456789abcdef0",
      identifier: "igw-0123456789abcdef0",
      desiredState: {},
      tags: [...STANDARD_TAGS],
    },
  ],
  [
    "AWS::EC2::RouteTable",
    {
      resourceType: "AWS::EC2::RouteTable",
      arn: "arn:aws:ec2:us-east-1:123456789012:route-table/rtb-0123456789abcdef0",
      identifier: "rtb-0123456789abcdef0",
      desiredState: {
        VpcId: "vpc-0123456789abcdef0",
      },
      tags: [...STANDARD_TAGS],
    },
  ],
  [
    "AWS::EC2::Route",
    {
      resourceType: "AWS::EC2::Route",
      arn: "arn:aws:ec2:us-east-1:123456789012:route-table/rtb-0123456789abcdef0",
      identifier: "rtb-0123456789abcdef0|0.0.0.0/0",
      desiredState: {
        RouteTableId: "rtb-0123456789abcdef0",
        DestinationCidrBlock: "0.0.0.0/0",
        GatewayId: "igw-0123456789abcdef0",
      },
      tags: [...STANDARD_TAGS],
    },
  ],
  [
    "AWS::EC2::NatGateway",
    {
      resourceType: "AWS::EC2::NatGateway",
      arn: "arn:aws:ec2:us-east-1:123456789012:natgateway/nat-0123456789abcdef0",
      identifier: "nat-0123456789abcdef0",
      desiredState: {
        SubnetId: "subnet-0123456789abcdef0",
        AllocationId: "eipalloc-0123456789abcdef0",
      },
      tags: [...STANDARD_TAGS],
    },
  ],
  [
    "AWS::ApiGatewayV2::Api",
    {
      resourceType: "AWS::ApiGatewayV2::Api",
      arn: "arn:aws:apigateway:us-east-1:123456789012:/apis/abc123def4",
      identifier: "abc123def4",
      desiredState: {
        Name: "my-http-api",
        ProtocolType: "HTTP",
      },
      tags: [...STANDARD_TAGS],
    },
  ],
]);

// ── Helper functions ─────────────────────────────────────────────────────────

/**
 * Returns a mock CloudControl success ProgressEvent.
 */
export function mockCloudControlSuccess(identifier: string) {
  return {
    ProgressEvent: {
      OperationStatus: "SUCCESS",
      Identifier: identifier,
      RequestToken: `req-${identifier}-${Date.now()}`,
      StatusMessage: "Operation completed successfully",
    },
  };
}

/**
 * Returns a properly shaped AWS SDK error object.
 */
export function mockCloudControlError(
  errorName: string,
  message: string,
  httpStatus: number,
) {
  const error = Object.assign(new Error(message), {
    name: errorName,
    $metadata: { httpStatusCode: httpStatus },
    $fault: httpStatus >= 500 ? ("server" as const) : ("client" as const),
  });
  return error;
}

/**
 * Returns a mock GetResources response with managed-by tags for given ARNs.
 */
export function mockTaggingResponse(arns: string[]) {
  return {
    ResourceTagMappingList: arns.map((arn) => ({
      ResourceARN: arn,
      Tags: [
        { Key: "managed-by", Value: "assignee-ai" },
        { Key: "assignee-run-id", Value: "2026-03-25T12:00:00Z" },
      ],
    })),
    PaginationToken: undefined,
  };
}
