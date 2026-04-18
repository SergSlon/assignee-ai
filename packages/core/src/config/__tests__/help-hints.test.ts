import { describe, it, expect } from "vitest";
import {
  HINT_MAX_COLUMNS,
  getCompoundPatterns,
  getPatternCount,
  getSupportedResourceTypes,
  getSupportedTypeCount,
  renderPatternsHint,
  renderSupportedTypesHint,
} from "../help-hints.js";
import { SUPPORTED_TYPES_ARRAY } from "../resource-types/supported.js";
import { defaultPatternRegistry } from "../../pattern-templates/index.js";

describe("help-hints — registry-derivation (drift guards)", () => {
  it("getSupportedTypeCount matches SUPPORTED_TYPES_ARRAY.length", () => {
    expect(getSupportedTypeCount()).toBe(SUPPORTED_TYPES_ARRAY.length);
    // Epic 54 iteration 1 baseline: 37 curated types.
    expect(getSupportedTypeCount()).toBe(37);
  });

  it("getPatternCount matches defaultPatternRegistry.size()", () => {
    expect(getPatternCount()).toBe(defaultPatternRegistry.size());
    // Epic 54 iteration 1 baseline: 10 registered patterns.
    expect(getPatternCount()).toBe(10);
  });

  it("getSupportedResourceTypes returns the registry contents verbatim", () => {
    expect(getSupportedResourceTypes()).toStrictEqual(SUPPORTED_TYPES_ARRAY);
  });

  it("getCompoundPatterns mirrors defaultPatternRegistry.list() shape", () => {
    const registered = defaultPatternRegistry.list();
    const exposed = getCompoundPatterns();

    expect(exposed).toHaveLength(registered.length);
    for (let i = 0; i < registered.length; i += 1) {
      expect(exposed[i]).toEqual({
        patternId: registered[i]!.patternId,
        displayName: registered[i]!.displayName,
        resourceCount: registered[i]!.resourceList.length,
      });
    }
  });
});

describe("renderSupportedTypesHint — CLI style", () => {
  const hint = renderSupportedTypesHint("cli");

  it("opens with the registry-derived count", () => {
    expect(hint).toContain(
      `What you can create (${getSupportedTypeCount()} resource types):`,
    );
  });

  it("includes every domain group header", () => {
    for (const group of [
      "Compute",
      "Storage",
      "Databases",
      "Networking",
      "Edge / CDN",
      "API",
      "Messaging",
      "Security",
      "Containers",
      "Observability",
    ]) {
      expect(hint).toContain(group);
    }
  });

  it("ends with the Examples: block", () => {
    expect(hint).toContain("Examples:");
    expect(hint).toContain('assignee plan "Create an S3 bucket');
  });

  it("every line fits within HINT_MAX_COLUMNS columns", () => {
    for (const line of hint.split("\n")) {
      expect(line.length).toBeLessThanOrEqual(HINT_MAX_COLUMNS);
    }
  });
});

describe("renderSupportedTypesHint — short style", () => {
  const hint = renderSupportedTypesHint("short");

  it("opens with the registry-derived count", () => {
    expect(hint).toContain(
      `What you can create (${getSupportedTypeCount()} resource types):`,
    );
  });

  it("stays within HINT_MAX_COLUMNS per line", () => {
    for (const line of hint.split("\n")) {
      expect(line.length).toBeLessThanOrEqual(HINT_MAX_COLUMNS);
    }
  });
});

describe("renderSupportedTypesHint — MCP style", () => {
  const hint = renderSupportedTypesHint("mcp");

  it("is a single line", () => {
    expect(hint).not.toContain("\n");
  });

  it("mentions the registry-derived count", () => {
    expect(hint).toContain(`Supported types (${getSupportedTypeCount()})`);
  });

  it("points the reader at `assignee plan --help`", () => {
    expect(hint).toContain("assignee plan --help");
  });
});

describe("renderPatternsHint — CLI style", () => {
  const hint = renderPatternsHint("cli");

  it("opens with the registry-derived pattern count", () => {
    expect(hint).toContain(
      `Architecture patterns (${getPatternCount()} compound,`,
    );
  });

  it("mentions every registered pattern by displayName", () => {
    for (const p of defaultPatternRegistry.list()) {
      expect(hint.toLowerCase()).toContain(p.displayName.toLowerCase());
    }
  });

  it("every line fits within HINT_MAX_COLUMNS columns", () => {
    for (const line of hint.split("\n")) {
      expect(line.length).toBeLessThanOrEqual(HINT_MAX_COLUMNS);
    }
  });
});

describe("renderPatternsHint — short / mcp style", () => {
  it("short style lists every patternId", () => {
    const hint = renderPatternsHint("short");
    expect(hint).toContain(`Compound patterns (${getPatternCount()}):`);
    for (const p of defaultPatternRegistry.list()) {
      expect(hint).toContain(p.patternId);
    }
  });

  it("mcp style is identical to short (compact surfaces share it)", () => {
    expect(renderPatternsHint("mcp")).toBe(renderPatternsHint("short"));
  });
});

// Drift guard — the most important test in the module. Closes the
// L6-test-review coverage gap for L3-H2: every registered type must be
// represented in the rendered hint so the grouped layout cannot fall
// behind the SUPPORTED_TYPES_ARRAY registry silently.
describe("drift guard — registry coverage", () => {
  it("every supported type is mentioned in the CLI hint (or its family alias)", () => {
    const hint = renderSupportedTypesHint("cli").toLowerCase();

    // Map each CFN type to the family alias shown in the grouped hint.
    // If a type changes its alias here, either the hint or this map
    // needs updating.
    const cfnToAlias: Record<string, string> = {
      "AWS::S3::Bucket": "s3 bucket",
      "AWS::S3::BucketPolicy": "s3 bucket policy",
      "AWS::SSM::Parameter": "ssm parameter",
      "AWS::IAM::Role": "iam role",
      "AWS::EC2::Instance": "ec2 instance",
      "AWS::RDS::DBInstance": "rds db instance",
      "AWS::Lambda::Function": "lambda function",
      "AWS::EC2::VPC": "vpc",
      "AWS::EC2::Subnet": "subnet",
      "AWS::EC2::SecurityGroup": "security group",
      "AWS::DynamoDB::Table": "dynamodb table",
      "AWS::SQS::Queue": "sqs queue",
      "AWS::SNS::Topic": "sns topic",
      "AWS::ElasticLoadBalancingV2::LoadBalancer": "load balancer",
      "AWS::ECS::Cluster": "ecs cluster",
      "AWS::ECR::Repository": "ecr repository",
      "AWS::Logs::LogGroup": "cloudwatch logs",
      "AWS::EC2::InternetGateway": "internet gateway",
      "AWS::EC2::RouteTable": "route table",
      "AWS::EC2::Route": "route",
      "AWS::EC2::NatGateway": "nat gateway",
      "AWS::ApiGatewayV2::Api": "api gateway v2",
      "AWS::CloudWatch::Alarm": "cloudwatch alarm",
      "AWS::SecretsManager::Secret": "secrets manager",
      "AWS::EC2::VPCGatewayAttachment": "vpc gateway attachment",
      "AWS::EC2::SubnetRouteTableAssociation": "route table association",
      "AWS::EFS::FileSystem": "efs file system",
      "AWS::EFS::MountTarget": "efs mount target",
      "AWS::Events::Rule": "eventbridge rule",
      "AWS::Events::EventBus": "eventbridge event bus",
      "AWS::SNS::Subscription": "sns subscription",
      "AWS::KMS::Key": "kms key",
      "AWS::Events::Connection": "eventbridge connection",
      "AWS::Events::ApiDestination": "eventbridge api destination",
      "AWS::CloudFront::Distribution": "cloudfront distribution",
      "AWS::CloudFront::OriginAccessControl": "cloudfront oac",
      "AWS::RDS::DBSubnetGroup": "rds db subnet group",
    };

    // Every SUPPORTED_TYPES_ARRAY entry must have an alias in the map
    // (so adding a new type without updating the hint fails here).
    for (const t of SUPPORTED_TYPES_ARRAY) {
      expect(cfnToAlias[t], `missing alias for ${t}`).toBeDefined();
      expect(hint, `hint missing entry for ${t}`).toContain(cfnToAlias[t]!);
    }
  });

  it("every registered pattern appears in the CLI patterns hint", () => {
    const hint = renderPatternsHint("cli").toLowerCase();
    for (const p of defaultPatternRegistry.list()) {
      expect(hint, `patterns hint missing ${p.patternId}`).toContain(
        p.displayName.toLowerCase(),
      );
    }
  });
});
