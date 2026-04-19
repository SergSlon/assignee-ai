/**
 * Tests for setup-arn-builder — partition-aware ARN constructors used
 * by `assignee setup` to mint IAM and CloudWatch Logs ARNs for the
 * Bedrock invocation-logging infrastructure.
 *
 * Covers all 5 published AWS partitions (aws, aws-us-gov, aws-cn,
 * aws-iso, aws-iso-b) so callers in GovCloud / China / ISO regions
 * can never silently fall back to the commercial `aws` literal.
 */

import { describe, it, expect } from "vitest";
import {
  buildIamPolicyArn,
  buildIamRoleArn,
  buildIamRootArn,
  buildIamUserArn,
  buildLogGroupArn,
} from "./setup-arn-builder.js";

const ACCOUNT = "111111111111";

describe("buildIamRoleArn", () => {
  it("builds a commercial-partition role ARN", () => {
    expect(
      buildIamRoleArn({
        partition: "aws",
        accountId: ACCOUNT,
        roleName: "AssigneeAiBedrockLoggingRole",
      }),
    ).toBe("arn:aws:iam::111111111111:role/AssigneeAiBedrockLoggingRole");
  });

  it("builds a GovCloud role ARN", () => {
    expect(
      buildIamRoleArn({
        partition: "aws-us-gov",
        accountId: ACCOUNT,
        roleName: "MyRole",
      }),
    ).toBe("arn:aws-us-gov:iam::111111111111:role/MyRole");
  });

  it("builds a China role ARN", () => {
    expect(
      buildIamRoleArn({
        partition: "aws-cn",
        accountId: ACCOUNT,
        roleName: "MyRole",
      }),
    ).toBe("arn:aws-cn:iam::111111111111:role/MyRole");
  });

  it("builds an ISO role ARN", () => {
    expect(
      buildIamRoleArn({
        partition: "aws-iso",
        accountId: ACCOUNT,
        roleName: "MyRole",
      }),
    ).toBe("arn:aws-iso:iam::111111111111:role/MyRole");
  });

  it("preserves nested service-role paths in the role name", () => {
    expect(
      buildIamRoleArn({
        partition: "aws",
        accountId: ACCOUNT,
        roleName: "service-role/MyService",
      }),
    ).toBe("arn:aws:iam::111111111111:role/service-role/MyService");
  });
});

describe("buildIamPolicyArn", () => {
  it("builds a commercial-partition customer-managed policy ARN", () => {
    expect(
      buildIamPolicyArn({
        partition: "aws",
        accountId: ACCOUNT,
        policyName: "AssigneeOperatorPolicy",
      }),
    ).toBe("arn:aws:iam::111111111111:policy/AssigneeOperatorPolicy");
  });

  it("builds a GovCloud policy ARN", () => {
    expect(
      buildIamPolicyArn({
        partition: "aws-us-gov",
        accountId: ACCOUNT,
        policyName: "MyPolicy",
      }),
    ).toBe("arn:aws-us-gov:iam::111111111111:policy/MyPolicy");
  });

  it("builds a China policy ARN", () => {
    expect(
      buildIamPolicyArn({
        partition: "aws-cn",
        accountId: ACCOUNT,
        policyName: "MyPolicy",
      }),
    ).toBe("arn:aws-cn:iam::111111111111:policy/MyPolicy");
  });
});

describe("buildIamUserArn", () => {
  it("builds a commercial-partition user ARN", () => {
    expect(
      buildIamUserArn({
        partition: "aws",
        accountId: ACCOUNT,
        userName: "assignee-operator",
      }),
    ).toBe("arn:aws:iam::111111111111:user/assignee-operator");
  });

  it("builds a GovCloud user ARN", () => {
    expect(
      buildIamUserArn({
        partition: "aws-us-gov",
        accountId: ACCOUNT,
        userName: "alice",
      }),
    ).toBe("arn:aws-us-gov:iam::111111111111:user/alice");
  });
});

describe("buildIamRootArn", () => {
  it("builds a commercial-partition root ARN", () => {
    expect(buildIamRootArn({ partition: "aws", accountId: ACCOUNT })).toBe(
      "arn:aws:iam::111111111111:root",
    );
  });

  it("builds a GovCloud root ARN", () => {
    expect(
      buildIamRootArn({ partition: "aws-us-gov", accountId: ACCOUNT }),
    ).toBe("arn:aws-us-gov:iam::111111111111:root");
  });

  it("builds a China root ARN", () => {
    expect(buildIamRootArn({ partition: "aws-cn", accountId: ACCOUNT })).toBe(
      "arn:aws-cn:iam::111111111111:root",
    );
  });
});

describe("buildLogGroupArn", () => {
  it("appends the :* stream wildcard by default for IAM policy resource use", () => {
    expect(
      buildLogGroupArn({
        partition: "aws",
        region: "us-east-1",
        accountId: ACCOUNT,
        logGroupName: "/aws/bedrock/AssigneeAiInvocationLogs",
      }),
    ).toBe(
      "arn:aws:logs:us-east-1:111111111111:log-group:/aws/bedrock/AssigneeAiInvocationLogs:*",
    );
  });

  it("omits the :* wildcard when withStreamWildcard is false", () => {
    expect(
      buildLogGroupArn({
        partition: "aws",
        region: "us-east-1",
        accountId: ACCOUNT,
        logGroupName: "/x",
        withStreamWildcard: false,
      }),
    ).toBe("arn:aws:logs:us-east-1:111111111111:log-group:/x");
  });

  it("respects partition for GovCloud regions", () => {
    expect(
      buildLogGroupArn({
        partition: "aws-us-gov",
        region: "us-gov-west-1",
        accountId: ACCOUNT,
        logGroupName: "/x",
      }),
    ).toBe("arn:aws-us-gov:logs:us-gov-west-1:111111111111:log-group:/x:*");
  });

  it("respects partition for China regions", () => {
    expect(
      buildLogGroupArn({
        partition: "aws-cn",
        region: "cn-north-1",
        accountId: ACCOUNT,
        logGroupName: "/x",
      }),
    ).toBe("arn:aws-cn:logs:cn-north-1:111111111111:log-group:/x:*");
  });

  it("preserves names that already start with a leading slash", () => {
    const arn = buildLogGroupArn({
      partition: "aws",
      region: "us-east-1",
      accountId: ACCOUNT,
      logGroupName: "/aws/bedrock/x",
    });
    expect(arn).toContain(":log-group:/aws/bedrock/x:*");
  });
});
