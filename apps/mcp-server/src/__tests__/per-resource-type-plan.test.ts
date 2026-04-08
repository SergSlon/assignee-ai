/**
 * Per-resource-type plan_resource MCP tool tests for all 23 resource types.
 * Validates that each type can be planned successfully through the MCP tool layer.
 *
 * @see Story E2E.2 — AC1: All 23 Resource Types Have MCP Tool Tests
 */

import { describe, it, expect, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ExecutionStatus } from "@assignee/core";
import type { GraphContext } from "../services/graph-init.js";
import { registerPlanResource } from "../tools/plan-resource.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function createMockGraphContext(
  invokeResult: Record<string, unknown>,
): GraphContext {
  return {
    graph: {
      invoke: vi.fn().mockResolvedValue(invokeResult),
      getState: vi.fn().mockResolvedValue({ values: {}, next: [] }),
    },
    cleanup: vi.fn().mockResolvedValue(undefined),
  };
}

async function createTestClient(ctx: GraphContext) {
  const server = new McpServer({ name: "plan-test", version: "0.1.0" });
  registerPlanResource(server, ctx);
  const client = new Client({ name: "test-client", version: "0.1.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

function parseResult(result: Record<string, unknown>) {
  const content = result["content"] as Array<{ type: string; text: string }>;
  return JSON.parse(content[0]!.text);
}

// ── All 23 resource types ────────────────────────────────────────────────────

const RESOURCE_TYPE_FIXTURES: Array<{
  name: string;
  cfnType: string;
  description: string;
  desiredState: Record<string, unknown>;
  cost: string;
}> = [
  {
    name: "S3 Bucket",
    cfnType: "AWS::S3::Bucket",
    description: "Create an S3 bucket",
    desiredState: { BucketName: "test-bucket" },
    cost: "~$0.02/month",
  },
  {
    name: "SSM Parameter",
    cfnType: "AWS::SSM::Parameter",
    description: "Create an SSM parameter",
    desiredState: { Name: "/test/param", Type: "String", Value: "test" },
    cost: "$0.00 (always free)",
  },
  {
    name: "IAM Role",
    cfnType: "AWS::IAM::Role",
    description: "Create an IAM role",
    desiredState: { RoleName: "test-role", AssumeRolePolicyDocument: "{}" },
    cost: "$0.00 (always free)",
  },
  {
    name: "Lambda Function",
    cfnType: "AWS::Lambda::Function",
    description: "Create a Lambda function",
    desiredState: {
      FunctionName: "test-fn",
      Runtime: "nodejs22.x",
      Handler: "index.handler",
      Code: { ZipFile: "exports.handler=()=>{}" },
      Role: "arn:aws:iam::123456789012:role/exec",
    },
    cost: "~$0.20/month",
  },
  {
    name: "DynamoDB Table",
    cfnType: "AWS::DynamoDB::Table",
    description: "Create a DynamoDB table",
    desiredState: {
      TableName: "test-table",
      KeySchema: [{ AttributeName: "id", KeyType: "HASH" }],
      AttributeDefinitions: [{ AttributeName: "id", AttributeType: "S" }],
      BillingMode: "PAY_PER_REQUEST",
    },
    cost: "$0.00 (within free tier)",
  },
  {
    name: "SQS Queue",
    cfnType: "AWS::SQS::Queue",
    description: "Create an SQS queue",
    desiredState: { QueueName: "test-queue" },
    cost: "$0.00 (within free tier)",
  },
  {
    name: "SNS Topic",
    cfnType: "AWS::SNS::Topic",
    description: "Create an SNS topic",
    desiredState: { TopicName: "test-topic" },
    cost: "$0.00 (within free tier)",
  },
  {
    name: "EC2 SecurityGroup",
    cfnType: "AWS::EC2::SecurityGroup",
    description: "Create a security group",
    desiredState: {
      GroupName: "test-sg",
      GroupDescription: "Test",
      VpcId: "vpc-123",
    },
    cost: "$0.00 (always free)",
  },
  {
    name: "EC2 VPC",
    cfnType: "AWS::EC2::VPC",
    description: "Create a VPC",
    desiredState: { CidrBlock: "10.0.0.0/16" },
    cost: "Free",
  },
  {
    name: "EC2 Subnet",
    cfnType: "AWS::EC2::Subnet",
    description: "Create a subnet",
    desiredState: {
      VpcId: "vpc-123",
      CidrBlock: "10.0.1.0/24",
      AvailabilityZone: "us-east-1a",
    },
    cost: "Free",
  },
  {
    name: "ECS Cluster",
    cfnType: "AWS::ECS::Cluster",
    description: "Create an ECS cluster",
    desiredState: { ClusterName: "test-cluster" },
    cost: "Free",
  },
  {
    name: "ECR Repository",
    cfnType: "AWS::ECR::Repository",
    description: "Create an ECR repository",
    desiredState: { RepositoryName: "test-repo" },
    cost: "~$0.10/month",
  },
  {
    name: "ELBv2 LoadBalancer",
    cfnType: "AWS::ElasticLoadBalancingV2::LoadBalancer",
    description: "Create a load balancer",
    desiredState: {
      Name: "test-lb",
      Type: "application",
      Subnets: ["subnet-1", "subnet-2"],
    },
    cost: "~$16.43/month",
  },
  {
    name: "EC2 Instance",
    cfnType: "AWS::EC2::Instance",
    description: "Create an EC2 instance",
    desiredState: { InstanceType: "t3.micro", ImageId: "ami-012345" },
    cost: "~$7.59/month",
  },
  {
    name: "RDS DBInstance",
    cfnType: "AWS::RDS::DBInstance",
    description: "Create an RDS instance",
    desiredState: {
      DBInstanceIdentifier: "test-db",
      DBInstanceClass: "db.t3.micro",
      Engine: "postgres",
      MasterUsername: "admin",
      MasterUserPassword: "pass123!",
    },
    cost: "~$12.41/month",
  },
  {
    name: "Logs LogGroup",
    cfnType: "AWS::Logs::LogGroup",
    description: "Create a CloudWatch log group",
    desiredState: { LogGroupName: "/test/logs", RetentionInDays: 7 },
    cost: "Free",
  },
  {
    name: "CloudWatch Alarm",
    cfnType: "AWS::CloudWatch::Alarm",
    description: "Create a CloudWatch alarm",
    desiredState: {
      AlarmName: "test-alarm",
      MetricName: "CPUUtilization",
      Namespace: "AWS/EC2",
      ComparisonOperator: "GreaterThanThreshold",
      Threshold: 80,
      Period: 300,
      EvaluationPeriods: 1,
      Statistic: "Average",
    },
    cost: "~$0.10/month",
  },
  {
    name: "SecretsManager Secret",
    cfnType: "AWS::SecretsManager::Secret",
    description: "Create a secret",
    desiredState: { Name: "test-secret", SecretString: "my-secret" },
    cost: "~$0.40/month",
  },
  {
    name: "EC2 InternetGateway",
    cfnType: "AWS::EC2::InternetGateway",
    description: "Create an internet gateway",
    desiredState: {},
    cost: "Free",
  },
  {
    name: "EC2 RouteTable",
    cfnType: "AWS::EC2::RouteTable",
    description: "Create a route table",
    desiredState: { VpcId: "vpc-123" },
    cost: "Free",
  },
  {
    name: "EC2 Route",
    cfnType: "AWS::EC2::Route",
    description: "Create a route",
    desiredState: {
      RouteTableId: "rtb-123",
      DestinationCidrBlock: "0.0.0.0/0",
      GatewayId: "igw-123",
    },
    cost: "Free",
  },
  {
    name: "EC2 NatGateway",
    cfnType: "AWS::EC2::NatGateway",
    description: "Create a NAT gateway",
    desiredState: { SubnetId: "subnet-123", ConnectivityType: "public" },
    cost: "~$32.40/month",
  },
  {
    name: "ApiGatewayV2 Api",
    cfnType: "AWS::ApiGatewayV2::Api",
    description: "Create an API Gateway",
    desiredState: { Name: "test-api", ProtocolType: "HTTP" },
    cost: "~$1.00/month",
  },
];

describe("plan_resource for all 23 resource types (Story E2E.2 AC1)", () => {
  for (const fixture of RESOURCE_TYPE_FIXTURES) {
    it(`plan_resource succeeds for ${fixture.name} (${fixture.cfnType})`, async () => {
      const mockState = {
        executionStatus: ExecutionStatus.PENDING,
        resourceType: fixture.cfnType,
        desiredState: fixture.desiredState,
        estimatedMonthlyCost: fixture.cost,
        preflightPassed: true,
        bpFindings: [],
      };

      const ctx = createMockGraphContext(mockState);
      const client = await createTestClient(ctx);

      const result = await client.callTool({
        name: "plan_resource",
        arguments: { description: fixture.description },
      });

      expect(result.isError).toBeFalsy();
      const body = parseResult(result);
      expect(body.resourceType).toBe(fixture.cfnType);
      // Tier C: strengthened — desiredState must be a plain object.
      // Some resource types (e.g. AWS::EC2::InternetGateway) legitimately
      // have empty desiredState because their only optional property is
      // Tags, so we don't enforce a non-zero key count here.
      expect(body.desiredState).toBeInstanceOf(Object);
      expect(Array.isArray(body.desiredState)).toBe(false);
      // Tier C: dropped redundant toBeDefined() — typeof string is stronger
      expect(typeof body.checkpointPath).toBe("string");
      expect(body.checkpointPath).toContain("checkpoint-");
    });
  }

  it("plan_resource passes region to graph invoke", async () => {
    const mockState = {
      executionStatus: ExecutionStatus.PENDING,
      resourceType: "AWS::S3::Bucket",
      desiredState: { BucketName: "test" },
      preflightPassed: true,
    };
    const ctx = createMockGraphContext(mockState);
    const client = await createTestClient(ctx);

    await client.callTool({
      name: "plan_resource",
      arguments: { description: "Create bucket", region: "eu-west-1" },
    });

    expect(ctx.graph.invoke).toHaveBeenCalledWith(
      expect.objectContaining({ awsRegion: "eu-west-1" }),
      expect.any(Object),
    );
  });

  it("plan_resource handles UNSUPPORTED_RESOURCE status", async () => {
    const mockState = {
      executionStatus: ExecutionStatus.UNSUPPORTED_RESOURCE,
      errorMessage: "Resource type not supported",
    };
    const ctx = createMockGraphContext(mockState);
    const client = await createTestClient(ctx);

    const result = await client.callTool({
      name: "plan_resource",
      arguments: { description: "Create a Neptune cluster" },
    });

    expect(result.isError).toBe(true);
    const body = parseResult(result);
    expect(body.status).toBe("UNSUPPORTED_RESOURCE");
    // Tier C: strengthened — hint must be a non-empty string
    expect(typeof body.hint).toBe("string");
    expect(body.hint.length).toBeGreaterThan(0);
  });
});
