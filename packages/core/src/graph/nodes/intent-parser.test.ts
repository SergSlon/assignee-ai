import { describe, it, expect } from "vitest";
import {
  ExecutionStatus,
  RESOURCE_TYPES,
  SUPPORTED_TYPES_ARRAY,
  renderSupportedTypesHint,
} from "../../index.js";
import { MockLlmAdapter } from "../../testing/index.js";
import type { AgentState } from "../graph-state.js";
import {
  createIntentParserNode,
  extractAssertedValues,
  isValidCidr,
  isValidInstanceType,
  isValidAmiId,
  isValidEngineVersion,
} from "./intent-parser.js";

// Story 54-it1-04: errorMessage now delegates to the help-hints SSO
// module. Assert against the same rendered string so divergence
// between the node and the renderer fails the test loudly (this is
// stronger than the previous local-alias duplicate, which silently
// accepted any valid-looking string).
const SUPPORTED_TYPES = SUPPORTED_TYPES_ARRAY;
const SUPPORTED_TYPES_HINT = renderSupportedTypesHint("short");

describe("intentParserNode", () => {
  it("identifies valid resource type (S3)", async () => {
    const mock = new MockLlmAdapter({ resourceType: "AWS::S3::Bucket" });
    const node = createIntentParserNode({ llmClient: mock });

    const state = { userIntent: "create an S3 bucket" } as AgentState;
    const result = await node(state);

    expect(result.resourceType).toBe("AWS::S3::Bucket");
    expect(result.executionStatus).toBeUndefined();
  });

  // Wave 13: the Lambda intent must NOT match any of the
  // lambda-with-exec-role pattern's keywords ("create a lambda",
  // "lambda function", "create a function", "deploy a lambda",
  // "node lambda", "python lambda", "node function", "python function",
  // "serverless function", "background worker", "scheduled lambda").
  // The pre-Wave-13 phrase "create a Lambda function for image
  // processing" matched "lambda function" → was intercepted by the
  // pattern detector and never reached the LLM classifier this test
  // is meant to exercise. Use a phrasing that bypasses every keyword:
  // "create an AWS Lambda" — substring-disjoint from all keywords (no
  // "function", different prefix from "create a lambda" because "an"
  // breaks the substring match).
  it.each([
    ["AWS::EC2::Instance", "create an EC2 t3.micro instance"],
    ["AWS::RDS::DBInstance", "create a MySQL RDS database"],
    ["AWS::Lambda::Function", "create an AWS Lambda for image processing"],
  ])("identifies %s correctly", async (resourceType, intent) => {
    const mock = new MockLlmAdapter({ resourceType });
    const node = createIntentParserNode({ llmClient: mock });

    const state = { userIntent: intent } as AgentState;
    const result = await node(state);

    expect(result.resourceType).toBe(resourceType);
    expect(result.executionStatus).toBeUndefined();
  });

  it("rejects unsupported resource types", async () => {
    const mock = new MockLlmAdapter({ resourceType: "UNSUPPORTED" });
    const node = createIntentParserNode({ llmClient: mock });

    const state = { userIntent: "create an unknown resource" } as AgentState;
    const result = await node(state);

    expect(result.executionStatus).toBe(ExecutionStatus.UNSUPPORTED_RESOURCE);
    expect(result.errorMessage).toBe(
      `Unsupported resource type. ${SUPPORTED_TYPES_HINT}.`,
    );
    expect(result.resourceType).toBeUndefined();
  });

  it("returns FAILED when LLM call fails (network error)", async () => {
    const mock = new MockLlmAdapter(undefined, "", true, "ThrottlingException");
    const node = createIntentParserNode({ llmClient: mock });

    const state = { userIntent: "create an S3 bucket" } as AgentState;
    const result = await node(state);

    expect(result.executionStatus).toBe(ExecutionStatus.FAILED);
    expect(result.errorMessage).toContain("ThrottlingException");
    // Network errors should still hint at Bedrock connectivity
    expect(result.errorMessage).toContain("Bedrock connectivity");
  });

  it("HIGH 5: returns UNSUPPORTED_RESOURCE (not FAILED) when LLM returns a Zod validation error", async () => {
    // When the LLM halluccinates a resourceType like "AWS::Foo::Bar" (not in
    // the supported enum), the AI SDK's Output.object() throws a Zod validation
    // error. That error message contains "Validation" or "Invalid enum value".
    // The intent-parser must return UNSUPPORTED_RESOURCE with a helpful message,
    // NOT FAILED with a misleading "check Bedrock connectivity" hint.
    const mock = new MockLlmAdapter(
      undefined,
      "",
      true,
      "Invalid enum value. Expected one of: ..., received: AWS::Foo::Bar",
    );
    const node = createIntentParserNode({ llmClient: mock });

    const state = { userIntent: "create an AWS::Foo::Bar" } as AgentState;
    const result = await node(state);

    expect(result.executionStatus).toBe(ExecutionStatus.UNSUPPORTED_RESOURCE);
    // Must NOT hint at Bedrock connectivity for a Zod validation error.
    expect(result.errorMessage).not.toContain("Bedrock connectivity");
    expect(result.errorMessage).toContain("assignee plan --help");
  });

  it("SUPPORTED_TYPES contains all expected resource types", () => {
    expect(SUPPORTED_TYPES).toContain("AWS::S3::Bucket");
    expect(SUPPORTED_TYPES).toContain("AWS::SSM::Parameter");
    expect(SUPPORTED_TYPES).toContain("AWS::IAM::Role");
    expect(SUPPORTED_TYPES).toContain("AWS::EC2::Instance");
    expect(SUPPORTED_TYPES).toContain("AWS::RDS::DBInstance");
    expect(SUPPORTED_TYPES).toContain("AWS::Lambda::Function");
    // Story 8.1: 9 additional types added for compound architecture patterns
    expect(SUPPORTED_TYPES).toContain("AWS::EC2::VPC");
    expect(SUPPORTED_TYPES).toContain("AWS::EC2::SecurityGroup");
    expect(SUPPORTED_TYPES).toContain("AWS::DynamoDB::Table");
    expect(SUPPORTED_TYPES).toContain("AWS::SQS::Queue");
    expect(SUPPORTED_TYPES).toContain("AWS::ECS::Cluster");
    expect(SUPPORTED_TYPES).toContain("AWS::ECR::Repository");
    // A1 (2026-04-08): EFS + EFS::MountTarget lifted the count to 27.
    expect(SUPPORTED_TYPES).toContain("AWS::EFS::FileSystem");
    expect(SUPPORTED_TYPES).toContain("AWS::EFS::MountTarget");
    // A8 (2026-04-08): EventBridge Rule lifted the count to 28.
    expect(SUPPORTED_TYPES).toContain("AWS::Events::Rule");
    // A9  (2026-04-09): EventBridge custom event bus lifted the count to 29.
    expect(SUPPORTED_TYPES).toContain("AWS::Events::EventBus");
    // A10 (2026-04-09): SNS Subscription promoted to first-class, count 30.
    expect(SUPPORTED_TYPES).toContain("AWS::SNS::Subscription");
    // A11 (2026-04-09): KMS::Key first-class, count 31.
    expect(SUPPORTED_TYPES).toContain("AWS::KMS::Key");
    // A12 (2026-04-09): Events::Connection first-class, count 32.
    expect(SUPPORTED_TYPES).toContain("AWS::Events::Connection");
    // A13 (2026-04-09): Events::ApiDestination first-class, count 33.
    expect(SUPPORTED_TYPES).toContain("AWS::Events::ApiDestination");
    // A14 (2026-04-09): CloudFront::Distribution first-class, count 34.
    expect(SUPPORTED_TYPES).toContain("AWS::CloudFront::Distribution");
    // (f) 2026-04-09 Task 4b: CloudFront OriginAccessControl + S3 BucketPolicy
    // first-class to unblock the static-website compound migration, count 36.
    expect(SUPPORTED_TYPES).toContain("AWS::CloudFront::OriginAccessControl");
    expect(SUPPORTED_TYPES).toContain("AWS::S3::BucketPolicy");
    // 2026-04-13: RDS::DBSubnetGroup first-class, count 37.
    expect(SUPPORTED_TYPES).toContain("AWS::RDS::DBSubnetGroup");
    // e98.W5.N5 (B-03): EIP promoted from companion to first-class, count 38.
    expect(SUPPORTED_TYPES).toContain("AWS::EC2::EIP");
    expect(SUPPORTED_TYPES).toHaveLength(38);
  });

  // ─── Epic 92 Wave 2 — asserted-token preservation (B-01/B-07/B-09/B-16/C-12/C-13/A-03) ───

  it("preserves user-asserted VPC CIDR block (B-01)", async () => {
    const mock = new MockLlmAdapter({ resourceType: RESOURCE_TYPES.EC2_VPC });
    const node = createIntentParserNode({ llmClient: mock });

    const state = {
      userIntent: "Create a VPC with CIDR 10.42.0.0/16 for production",
    } as AgentState;
    const result = await node(state);

    expect(result.executionStatus).toBeUndefined();
    expect(result.resourceType).toBe(RESOURCE_TYPES.EC2_VPC);
    expect(result.elicitedOptions).toEqual(
      expect.objectContaining({ CidrBlock: "10.42.0.0/16" }),
    );
  });

  it("fails plan on invalid CIDR block (B-09)", async () => {
    const mock = new MockLlmAdapter({ resourceType: RESOURCE_TYPES.EC2_VPC });
    const node = createIntentParserNode({ llmClient: mock });

    const state = {
      userIntent: "Create a VPC with CIDR 999.999.999.999/99",
    } as AgentState;
    const result = await node(state);

    expect(result.executionStatus).toBe(ExecutionStatus.FAILED);
    expect(result.errorMessage).toContain("Invalid CIDR");
    expect(result.errorMessage).toContain("999.999.999.999/99");
    expect(result.resourceType).toBeUndefined();
  });

  it("fails plan on unknown instance type (C-13)", async () => {
    const mock = new MockLlmAdapter({
      resourceType: RESOURCE_TYPES.EC2_INSTANCE,
    });
    const node = createIntentParserNode({ llmClient: mock });

    const state = {
      userIntent: "Create an EC2 t99.huge instance for web hosting",
    } as AgentState;
    const result = await node(state);

    expect(result.executionStatus).toBe(ExecutionStatus.FAILED);
    expect(result.errorMessage).toContain("Unknown EC2 instance type");
    expect(result.errorMessage).toContain("t99.huge");
  });

  it("fails plan on unknown AWS region (C-13)", async () => {
    const mock = new MockLlmAdapter({ resourceType: RESOURCE_TYPES.S3_BUCKET });
    const node = createIntentParserNode({ llmClient: mock });

    const state = {
      userIntent: "Create an S3 bucket in region eu-west-fake-1",
    } as AgentState;
    const result = await node(state);

    expect(result.executionStatus).toBe(ExecutionStatus.FAILED);
    expect(result.errorMessage).toContain("Unknown AWS region");
    expect(result.errorMessage).toContain("eu-west-fake-1");
  });

  it("fails plan on invalid RDS engine version (C-13)", async () => {
    const mock = new MockLlmAdapter({
      resourceType: RESOURCE_TYPES.RDS_DB_INSTANCE,
    });
    const node = createIntentParserNode({ llmClient: mock });

    const state = {
      userIntent: "Create a PostgreSQL RDS database with engine version 99.99",
    } as AgentState;
    const result = await node(state);

    expect(result.executionStatus).toBe(ExecutionStatus.FAILED);
    expect(result.errorMessage).toContain("Invalid RDS engine version");
    expect(result.errorMessage).toContain("99.99");
  });

  it("preserves user-asserted instance type (C-12)", async () => {
    const mock = new MockLlmAdapter({
      resourceType: RESOURCE_TYPES.EC2_INSTANCE,
    });
    const node = createIntentParserNode({ llmClient: mock });

    const state = {
      userIntent: "Create a t3.micro instance for a web server",
    } as AgentState;
    const result = await node(state);

    expect(result.executionStatus).toBeUndefined();
    expect(result.elicitedOptions).toEqual(
      expect.objectContaining({ InstanceType: "t3.micro" }),
    );
  });

  it("preserves user-asserted AMI ID", async () => {
    const mock = new MockLlmAdapter({
      resourceType: RESOURCE_TYPES.EC2_INSTANCE,
    });
    const node = createIntentParserNode({ llmClient: mock });

    const state = {
      userIntent: "Launch EC2 from ami-0abc1234def567890",
    } as AgentState;
    const result = await node(state);

    expect(result.executionStatus).toBeUndefined();
    expect(result.elicitedOptions).toEqual(
      expect.objectContaining({ ImageId: "ami-0abc1234def567890" }),
    );
  });

  it("preserves RDS engine version 16.3 (B-01 sibling)", async () => {
    const mock = new MockLlmAdapter({
      resourceType: RESOURCE_TYPES.RDS_DB_INSTANCE,
    });
    const node = createIntentParserNode({ llmClient: mock });

    const state = {
      userIntent: "Create a PostgreSQL database with engine version 16.3",
    } as AgentState;
    const result = await node(state);

    expect(result.executionStatus).toBeUndefined();
    expect(result.elicitedOptions).toEqual(
      expect.objectContaining({ EngineVersion: "16.3" }),
    );
  });

  it("extracts Lambda FunctionName from 'named X' phrasing (A-03)", async () => {
    const mock = new MockLlmAdapter({
      resourceType: RESOURCE_TYPES.LAMBDA_FUNCTION,
    });
    const node = createIntentParserNode({ llmClient: mock });

    const state = {
      userIntent: "Create an AWS Lambda named hello-world for image processing",
    } as AgentState;
    const result = await node(state);

    expect(result.executionStatus).toBeUndefined();
    expect(result.elicitedOptions).toEqual(
      expect.objectContaining({ FunctionName: "hello-world" }),
    );
  });

  it("extracts DynamoDB TableName from 'called X' phrasing", async () => {
    const mock = new MockLlmAdapter({
      resourceType: RESOURCE_TYPES.DYNAMODB_TABLE,
    });
    const node = createIntentParserNode({ llmClient: mock });

    const state = {
      userIntent: "Create a DynamoDB table called user-sessions",
    } as AgentState;
    const result = await node(state);

    expect(result.executionStatus).toBeUndefined();
    expect(result.elicitedOptions).toEqual(
      expect.objectContaining({ TableName: "user-sessions" }),
    );
  });

  it("extracts SNS TopicName from 'named X' phrasing", async () => {
    const mock = new MockLlmAdapter({
      resourceType: RESOURCE_TYPES.SNS_TOPIC,
    });
    const node = createIntentParserNode({ llmClient: mock });

    const state = {
      userIntent: "Create an SNS topic named order-events",
    } as AgentState;
    const result = await node(state);

    expect(result.executionStatus).toBeUndefined();
    expect(result.elicitedOptions).toEqual(
      expect.objectContaining({ TopicName: "order-events" }),
    );
  });

  it("extracts SG ingress rules from 'allowing port 443 from 0.0.0.0/0' (B-07)", async () => {
    const mock = new MockLlmAdapter({
      resourceType: RESOURCE_TYPES.EC2_SECURITY_GROUP,
    });
    const node = createIntentParserNode({ llmClient: mock });

    const state = {
      userIntent:
        "Create a security group for web servers allowing port 443 from 0.0.0.0/0",
    } as AgentState;
    const result = await node(state);

    expect(result.executionStatus).toBeUndefined();
    const ingress = (result.elicitedOptions as Record<string, unknown>)[
      "SecurityGroupIngress"
    ] as Array<Record<string, unknown>>;
    expect(ingress).toBeDefined();
    expect(ingress.length).toBeGreaterThanOrEqual(1);
    expect(ingress[0]).toEqual(
      expect.objectContaining({
        IpProtocol: "tcp",
        FromPort: 443,
        ToPort: 443,
        CidrIp: "0.0.0.0/0",
      }),
    );
  });

  it("extracts 'do not attach to any VPC' directive (B-16)", async () => {
    const mock = new MockLlmAdapter({
      resourceType: RESOURCE_TYPES.EC2_SECURITY_GROUP,
    });
    const node = createIntentParserNode({ llmClient: mock });

    const state = {
      userIntent:
        "Create a security group; do not attach to any VPC — standalone for reference",
    } as AgentState;
    const result = await node(state);

    expect(result.executionStatus).toBeUndefined();
    expect(result.elicitedOptions).toEqual(
      expect.objectContaining({ __noVpc: true }),
    );
  });

  it("extracts SNS subscription Protocol from http:// endpoint", async () => {
    const mock = new MockLlmAdapter({
      resourceType: RESOURCE_TYPES.SNS_SUBSCRIPTION,
    });
    const node = createIntentParserNode({ llmClient: mock });

    const state = {
      userIntent:
        "SNS subscription that sends http://example.com/webhook to topic arn:aws:sns:us-east-1:210987654321:alerts",
    } as AgentState;
    const result = await node(state);

    expect(result.executionStatus).toBeUndefined();
    expect(result.elicitedOptions).toEqual(
      expect.objectContaining({
        Protocol: "http",
        Endpoint: "http://example.com/webhook",
      }),
    );
  });

  it("preserves existing elicitedOptions when merging parser assertions", async () => {
    const mock = new MockLlmAdapter({ resourceType: RESOURCE_TYPES.EC2_VPC });
    const node = createIntentParserNode({ llmClient: mock });

    // Simulate checkpoint-resumed state with a pre-existing elicited key.
    const state = {
      userIntent: "Create a VPC with CIDR 10.42.0.0/16",
      elicitedOptions: { EnableDnsHostnames: true },
    } as unknown as AgentState;
    const result = await node(state);

    expect(result.executionStatus).toBeUndefined();
    expect(result.elicitedOptions).toEqual(
      expect.objectContaining({
        EnableDnsHostnames: true,
        CidrBlock: "10.42.0.0/16",
      }),
    );
  });

  it("does not overwrite pre-existing elicited keys", async () => {
    // If the user's --set flag or a checkpoint already supplied InstanceType,
    // the parser must NOT clobber it — the explicit prior assertion wins.
    const mock = new MockLlmAdapter({
      resourceType: RESOURCE_TYPES.EC2_INSTANCE,
    });
    const node = createIntentParserNode({ llmClient: mock });

    const state = {
      userIntent: "Create a t3.micro instance",
      elicitedOptions: { InstanceType: "m5.large" },
    } as unknown as AgentState;
    const result = await node(state);

    expect(result.executionStatus).toBeUndefined();
    expect(
      (result.elicitedOptions as Record<string, unknown>)["InstanceType"],
    ).toBe("m5.large");
  });
});

describe("extractAssertedValues", () => {
  it("returns empty elicited + no errors for plain intent", () => {
    const out = extractAssertedValues(
      "Create a web server",
      RESOURCE_TYPES.EC2_INSTANCE,
    );
    expect(out.errors).toEqual([]);
    expect(Object.keys(out.elicited)).toHaveLength(0);
  });

  it("extracts VPC CIDR but not instance type when both absent", () => {
    const out = extractAssertedValues(
      "Create a VPC with CIDR 10.50.0.0/16",
      RESOURCE_TYPES.EC2_VPC,
    );
    expect(out.elicited["CidrBlock"]).toBe("10.50.0.0/16");
  });

  it("collects multiple errors when multiple tokens are invalid", () => {
    const out = extractAssertedValues(
      "EC2 instance type t99.fake in region xx-fake-1",
      RESOURCE_TYPES.EC2_INSTANCE,
    );
    expect(out.errors.length).toBeGreaterThanOrEqual(1);
  });

  it("extracts region as __assertedRegion (informational hint)", () => {
    const out = extractAssertedValues(
      "Create an S3 bucket in us-west-2",
      RESOURCE_TYPES.S3_BUCKET,
    );
    expect(out.elicited["__assertedRegion"]).toBe("us-west-2");
  });

  describe("error code stamping — e96.W2.R7 INVALID_NAME for non-ASCII name", () => {
    it("sets errorCode='INVALID_NAME' when a `named <x>` span contains non-ASCII", () => {
      // Pre-fix, this extraction returned `errors: [...]` with no
      // machine-readable classifier; the CLI's JSON envelope fell back
      // to the generic PLAN_FAILED code. A-11 regression of Epic 94 R8.
      const out = extractAssertedValues(
        "Create an S3 bucket named résumé-bucket",
        RESOURCE_TYPES.S3_BUCKET,
      );
      expect(out.errors.length).toBeGreaterThanOrEqual(1);
      expect(out.errors[0]).toContain("non-ASCII characters are not allowed");
      expect(out.errorCode).toBe("INVALID_NAME");
    });

    it("does NOT stamp INVALID_NAME on unrelated validation failures", () => {
      // Example: a bad CIDR fails without setting errorCode. The CLI
      // path falls back to the generic PLAN_FAILED classifier, which
      // is the desired behavior for unscoped failures.
      const out = extractAssertedValues(
        "Create a VPC with CIDR 999.999.999.999/99",
        RESOURCE_TYPES.EC2_VPC,
      );
      expect(out.errors.length).toBeGreaterThanOrEqual(1);
      expect(out.errorCode).toBeUndefined();
    });

    it("does NOT stamp an errorCode on a clean extraction", () => {
      const out = extractAssertedValues(
        "Create an S3 bucket named my-clean-bucket",
        RESOURCE_TYPES.S3_BUCKET,
      );
      expect(out.errors).toEqual([]);
      expect(out.errorCode).toBeUndefined();
    });

    it("first error wins — a mixed failure keeps its INVALID_NAME code", () => {
      // If both a non-ASCII name AND another validation failure fire,
      // the first stamped code wins. Today only extractResourceName
      // stamps a code, so this is effectively an invariant guard.
      const out = extractAssertedValues(
        "Create an S3 bucket named résumé-bucket with CIDR 999.999.999.999/99",
        RESOURCE_TYPES.S3_BUCKET,
      );
      expect(out.errorCode).toBe("INVALID_NAME");
    });
  });

  describe("CIDR scope — e96.W2.R6 Route destinations accept /0 and /32", () => {
    it("accepts 0.0.0.0/0 as EC2::Route DestinationCidrBlock", () => {
      // B-03 regression repro: before the scope fix, Route used
      // kind="vpc" (/16-/28 only) so the default route 0.0.0.0/0 was
      // rejected as "prefix must be 16-28 for a VPC". That broke the
      // Route BP tests.
      const out = extractAssertedValues(
        "Create a default route to 0.0.0.0/0",
        RESOURCE_TYPES.EC2_ROUTE,
      );
      expect(out.errors).toEqual([]);
      expect(out.elicited["DestinationCidrBlock"]).toBe("0.0.0.0/0");
      expect(out.elicited["CidrBlock"]).toBeUndefined();
    });

    it("accepts /32 host routes as EC2::Route DestinationCidrBlock", () => {
      const out = extractAssertedValues(
        "Create a host route to 10.0.0.42/32",
        RESOURCE_TYPES.EC2_ROUTE,
      );
      expect(out.errors).toEqual([]);
      expect(out.elicited["DestinationCidrBlock"]).toBe("10.0.0.42/32");
    });

    it("still rejects /8 on EC2::VPC (kind=vpc preserved for VPC)", () => {
      const out = extractAssertedValues(
        "Create a VPC with CIDR 10.0.0.0/8",
        RESOURCE_TYPES.EC2_VPC,
      );
      expect(out.errors.length).toBeGreaterThanOrEqual(1);
      expect(out.errors[0]).toContain("prefix must be 16-28");
    });

    it("still rejects /8 on EC2::Subnet (kind=vpc preserved for Subnet)", () => {
      const out = extractAssertedValues(
        "Create a subnet with CIDR 10.0.0.0/8",
        RESOURCE_TYPES.EC2_SUBNET,
      );
      expect(out.errors.length).toBeGreaterThanOrEqual(1);
    });

    it("accepts 0.0.0.0/0 as a SecurityGroup source CIDR (unchanged)", () => {
      const out = extractAssertedValues(
        "Allow port 443 from 0.0.0.0/0",
        RESOURCE_TYPES.EC2_SECURITY_GROUP,
      );
      expect(out.errors).toEqual([]);
    });

    it("emits a Route-specific error hint ('0-32', not '16-28')", () => {
      // An invalid octet on a Route should still fail loudly, and the
      // hint should not mislead the user with the VPC /16-/28 range.
      const out = extractAssertedValues(
        "Create a route to 999.999.999.999/33",
        RESOURCE_TYPES.EC2_ROUTE,
      );
      expect(out.errors.length).toBeGreaterThanOrEqual(1);
      expect(out.errors[0]).toContain("0-32");
      expect(out.errors[0]).not.toContain("16-28");
    });
  });

  describe("region extraction — e96.W1.B3 scope to region-intent phrases", () => {
    it("does NOT match a region-shaped substring nested inside a hyphenated name", () => {
      // `my-bucket-us-east-1-fake` contains the substring `us-east-1`
      // but that is a bucket name, not a region assertion. The real
      // region qualifier is `region eu-west-2`. Pre-fix the regex over-
      // matched and flagged `my-bucket-us-east-1` as an unknown region.
      const out = extractAssertedValues(
        "create S3 bucket named my-bucket-us-east-1-fake region eu-west-2",
        RESOURCE_TYPES.S3_BUCKET,
      );
      expect(out.errors).toEqual([]);
      expect(out.elicited["__assertedRegion"]).toBe("eu-west-2");
    });

    it("still catches an adversarial region-shaped token asserted via `region`", () => {
      // eu-west-fake-1 is whitespace-bracketed, so the loud-fail path
      // (unknown region) must still fire.
      const out = extractAssertedValues(
        "Create an S3 bucket in region eu-west-fake-1",
        RESOURCE_TYPES.S3_BUCKET,
      );
      expect(out.errors.some((e) => e.includes("Unknown AWS region"))).toBe(
        true,
      );
    });

    it("does NOT false-positive on ami-like hyphenated IDs (no region-shape)", () => {
      const out = extractAssertedValues(
        "Create an EC2 instance ami-12345abcdef ImageId",
        RESOURCE_TYPES.EC2_INSTANCE,
      );
      expect(out.elicited["__assertedRegion"]).toBeUndefined();
    });

    it("accepts a bare region token at end-of-string", () => {
      const out = extractAssertedValues(
        "Create an S3 bucket in us-west-2",
        RESOURCE_TYPES.S3_BUCKET,
      );
      expect(out.elicited["__assertedRegion"]).toBe("us-west-2");
    });

    it("accepts a region token followed by punctuation (comma/period)", () => {
      const out = extractAssertedValues(
        "Create an S3 bucket in us-west-2, encrypted",
        RESOURCE_TYPES.S3_BUCKET,
      );
      expect(out.elicited["__assertedRegion"]).toBe("us-west-2");
    });
  });
});

describe("token validators", () => {
  describe("isValidCidr", () => {
    it("accepts VPC-sized CIDR (/16)", () => {
      expect(isValidCidr("10.0.0.0/16", "vpc")).toBe(true);
    });
    it("accepts /28 VPC CIDR", () => {
      expect(isValidCidr("10.0.0.0/28", "vpc")).toBe(true);
    });
    it("rejects /8 as VPC CIDR (too large)", () => {
      expect(isValidCidr("10.0.0.0/8", "vpc")).toBe(false);
    });
    it("accepts /0 for SG source CIDR", () => {
      expect(isValidCidr("0.0.0.0/0", "source")).toBe(true);
    });
    it("rejects octets > 255", () => {
      expect(isValidCidr("999.999.999.999/99", "source")).toBe(false);
    });
    it("rejects malformed CIDR", () => {
      expect(isValidCidr("not-a-cidr", "source")).toBe(false);
    });
  });

  describe("isValidInstanceType", () => {
    it("accepts common types", () => {
      expect(isValidInstanceType("t3.micro")).toBe(true);
      expect(isValidInstanceType("m5.large")).toBe(true);
      expect(isValidInstanceType("c5.xlarge")).toBe(true);
      expect(isValidInstanceType("r5.2xlarge")).toBe(true);
      expect(isValidInstanceType("p4d.24xlarge")).toBe(true);
    });
    it("rejects unknown family", () => {
      expect(isValidInstanceType("t99.huge")).toBe(false);
    });
    it("rejects unknown size", () => {
      expect(isValidInstanceType("t3.huge")).toBe(false);
    });
    it("rejects non-dotted shapes", () => {
      expect(isValidInstanceType("t3micro")).toBe(false);
    });
  });

  describe("isValidAmiId", () => {
    it("accepts 8-char hex AMI", () => {
      expect(isValidAmiId("ami-0abc1234")).toBe(true);
    });
    it("accepts 17-char hex AMI", () => {
      expect(isValidAmiId("ami-0abc1234def567890")).toBe(true);
    });
    it("rejects non-hex chars", () => {
      expect(isValidAmiId("ami-zzzzzzzz")).toBe(false);
    });
    it("rejects wrong length", () => {
      expect(isValidAmiId("ami-1234")).toBe(false);
    });
  });

  describe("isValidEngineVersion", () => {
    it("accepts Postgres 16.3", () => {
      expect(isValidEngineVersion("16.3")).toBe(true);
    });
    it("accepts MySQL 8.0.35", () => {
      expect(isValidEngineVersion("8.0.35")).toBe(true);
    });
    it("rejects adversarial 99.99", () => {
      expect(isValidEngineVersion("99.99")).toBe(false);
    });
    it("rejects non-numeric", () => {
      expect(isValidEngineVersion("latest")).toBe(false);
    });
  });
});

// ─── Story: feature-query-intent-classifier ───────────────────────────────────
// Kind-classifier fixtures — NEW tests. All existing tests above must remain
// green (back-compat). These fixtures exercise the `kind` field added to the
// intent-parser schema. The MockLlmAdapter bypasses Zod parsing, so we supply
// `kind` explicitly in the fixture object.

describe("intentParserNode — kind classifier (feature-query-intent-classifier)", () => {
  it("routes kind=query to QUERY_INTENT status and stamps intentKind", async () => {
    const mock = new MockLlmAdapter({
      resourceType: "AWS::CloudFront::Distribution",
      kind: "query",
    });
    const node = createIntentParserNode({ llmClient: mock });

    const state = {
      userIntent: "what's my CloudFront site URL?",
    } as AgentState;
    const result = await node(state);

    expect(result.executionStatus).toBe(ExecutionStatus.QUERY_INTENT);
    expect(result.intentKind).toBe("query");
    expect(result.resourceType).toBe("AWS::CloudFront::Distribution");
  });

  it("routes kind=query with UNSUPPORTED type (no specific type) — still QUERY_INTENT", async () => {
    const mock = new MockLlmAdapter({
      resourceType: "UNSUPPORTED",
      kind: "query",
    });
    const node = createIntentParserNode({ llmClient: mock });

    const state = {
      userIntent: "list my managed resources",
    } as AgentState;
    const result = await node(state);

    expect(result.executionStatus).toBe(ExecutionStatus.QUERY_INTENT);
    expect(result.intentKind).toBe("query");
    // No specific type — resourceType should be omitted
    expect(result.resourceType).toBeUndefined();
  });

  it("kind=create with existing intent remains unchanged (back-compat)", async () => {
    const mock = new MockLlmAdapter({
      resourceType: "AWS::S3::Bucket",
      kind: "create",
    });
    const node = createIntentParserNode({ llmClient: mock });

    const state = { userIntent: "create an S3 bucket" } as AgentState;
    const result = await node(state);

    // Must behave identically to the legacy test above (no QUERY_INTENT).
    expect(result.executionStatus).toBeUndefined();
    expect(result.resourceType).toBe("AWS::S3::Bucket");
    expect(result.intentKind).toBe("create");
  });

  it("kind undefined (missing from LLM) defaults to create (back-compat)", async () => {
    // Legacy fixture shape — no 'kind' field. Must still work.
    const mock = new MockLlmAdapter({
      resourceType: "AWS::S3::Bucket",
      // kind: omitted intentionally
    });
    const node = createIntentParserNode({ llmClient: mock });

    const state = { userIntent: "create an S3 bucket" } as AgentState;
    const result = await node(state);

    expect(result.executionStatus).toBeUndefined();
    expect(result.resourceType).toBe("AWS::S3::Bucket");
    // undefined ?? "create" = "create"
    expect(result.intentKind).toBe("create");
  });

  it("kind=destroy redirects with UNSUPPORTED_RESOURCE + actionable message (BLOCKER 1 fix)", async () => {
    // BLOCKER 1: destroy intent must NOT reach the creation pipeline.
    // The guardrail terminates with UNSUPPORTED_RESOURCE + a redirect
    // message pointing the user to `assignee destroy <arn>`.
    const mock = new MockLlmAdapter({
      resourceType: "AWS::S3::Bucket",
      kind: "destroy",
    });
    const node = createIntentParserNode({ llmClient: mock });

    const state = {
      userIntent: "destroy my old test bucket called genai-demo-logs",
    } as AgentState;
    const result = await node(state);

    expect(result.executionStatus).toBe(ExecutionStatus.UNSUPPORTED_RESOURCE);
    expect(result.intentKind).toBe("destroy");
    // errorMessage must contain the redirect hint — NOT the 38-type wall
    expect(result.errorMessage).toContain("assignee destroy");
    expect(result.errorMessage).toContain("assignee list");
    // resourceType must NOT be set — destroy must not reach the creation pipeline
    expect(result.resourceType).toBeUndefined();
  });

  it("kind=destroy with UNSUPPORTED type still redirects cleanly", async () => {
    const mock = new MockLlmAdapter({
      resourceType: "UNSUPPORTED",
      kind: "destroy",
    });
    const node = createIntentParserNode({ llmClient: mock });

    const state = {
      userIntent: "destroy my old thing",
    } as AgentState;
    const result = await node(state);

    expect(result.executionStatus).toBe(ExecutionStatus.UNSUPPORTED_RESOURCE);
    expect(result.intentKind).toBe("destroy");
    expect(result.errorMessage).toContain("assignee destroy");
    expect(result.resourceType).toBeUndefined();
  });

  it("kind=update stamps intentKind and continues to creation path (deferred)", async () => {
    const mock = new MockLlmAdapter({
      resourceType: "AWS::S3::Bucket",
      kind: "update",
    });
    const node = createIntentParserNode({ llmClient: mock });

    const state = {
      userIntent: "update my S3 bucket to enable versioning",
    } as AgentState;
    const result = await node(state);

    expect(result.executionStatus).toBeUndefined();
    expect(result.intentKind).toBe("update");
    expect(result.resourceType).toBe("AWS::S3::Bucket");
  });

  it("kind=query with S3 type — stamps QUERY_INTENT (acceptance criterion 2)", async () => {
    const mock = new MockLlmAdapter({
      resourceType: "AWS::S3::Bucket",
      kind: "query",
    });
    const node = createIntentParserNode({ llmClient: mock });

    const state = { userIntent: "list my S3 buckets" } as AgentState;
    const result = await node(state);

    expect(result.executionStatus).toBe(ExecutionStatus.QUERY_INTENT);
    expect(result.intentKind).toBe("query");
    expect(result.resourceType).toBe("AWS::S3::Bucket");
  });
});

// ─── HIGH 3: singleton-override + pattern-detect must set intentKind ──────────
// Before the fix, the singleton-override branch (Step 1) and pattern-detect
// branch (Step 3) returned buildExtractionSuccessUpdate() without setting
// intentKind. A query intent that happened to match a singleton override
// keyword would then get intentKind=undefined, falling into the creation
// pipeline.

describe("intentParserNode — intentKind stamped on all fast-path branches (HIGH 3)", () => {
  it("singleton-override branch stamps intentKind='create'", async () => {
    // "EFS mount target" triggers the singleton override for AWS::EFS::MountTarget
    // (from SINGLETON_OVERRIDE_CUES) without reaching the LLM classifier.
    const mock = new MockLlmAdapter({ resourceType: "AWS::EFS::MountTarget" });
    const node = createIntentParserNode({ llmClient: mock });

    const state = {
      userIntent: "Create an EFS mount target for my existing file system",
    } as AgentState;
    const result = await node(state);

    // Singleton-override takes the Step 1 fast-path — LLM is NOT called.
    // intentKind must be explicitly "create" (not undefined).
    expect(result.intentKind).toBe("create");
    expect(result.executionStatus).toBeUndefined();
  });
});
