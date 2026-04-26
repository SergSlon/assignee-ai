/**
 * Integration-style tests for the 8 plan-time name validators added in
 * Epic 99 Wave 4 Lane 4a (W-006).
 *
 * Each describe block covers:
 *   1. Pass cases — valid names.
 *   2. Fail cases — each published AWS constraint.
 *   3. Edge cases — empty string, boundary lengths, unicode.
 *   4. Back-compat — resource type not covered → no error.
 *   5. Integration — fixture → validateDesiredStateNode → error envelope.
 */

import { describe, it, expect } from "vitest";
import {
  validateLambdaName,
  validateDdbTableName,
  validateSgName,
  validateIamRoleName,
  validateRdsDbIdentifier,
  validateSqsQueueName,
  validateSnsTopicName,
  validateKmsAliasName,
  validateEcrRepositoryName,
  validateDesiredState,
  validateDesiredStateNode,
} from "../../validate-desired-state.js";
import { AssigneeError } from "../../../../errors.js";
import { ErrorCode } from "../../../../constants/errors.js";
import { ExecutionStatus } from "../../../../schema/graph-state.js";
import type { AgentState } from "../../../graph-state.js";

// Minimal AgentState factory matching the pattern in the parent test file.
const mkState = (partial: Partial<AgentState>): AgentState =>
  ({
    executionStatus: ExecutionStatus.PENDING,
    resourceType: "",
    desiredState: {},
    ...partial,
  }) as unknown as AgentState;

// ---------------------------------------------------------------------------
// AWS::Lambda::Function — FunctionName
// ---------------------------------------------------------------------------

describe("validateLambdaName", () => {
  // Pass cases
  it("accepts a typical function name", () => {
    expect(validateLambdaName("my-lambda-function").ok).toBe(true);
  });

  it("accepts underscore-separated name", () => {
    expect(validateLambdaName("my_lambda_fn").ok).toBe(true);
  });

  it("accepts single-character name (min length)", () => {
    expect(validateLambdaName("a").ok).toBe(true);
  });

  it("accepts exactly 64-char name (upper boundary)", () => {
    expect(validateLambdaName("a".repeat(64)).ok).toBe(true);
  });

  it("accepts mixed case", () => {
    expect(validateLambdaName("MyFunction123").ok).toBe(true);
  });

  it("treats empty string as valid (auto-generate)", () => {
    expect(validateLambdaName("").ok).toBe(true);
  });

  // Fail cases — length
  it("rejects 65-char name (above max)", () => {
    const r = validateLambdaName("a".repeat(65));
    expect(r.ok).toBe(false);
    expect(r.error).toContain("1-64");
    expect(r.fix).toBeDefined();
  });

  // Fail cases — charset
  it("rejects name with spaces", () => {
    const r = validateLambdaName("my function");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("[a-zA-Z0-9-_]");
  });

  it("rejects name with dots", () => {
    const r = validateLambdaName("my.function");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("[a-zA-Z0-9-_]");
  });

  it("rejects name with unicode characters", () => {
    const r = validateLambdaName("my-λ-fn");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("[a-zA-Z0-9-_]");
  });
});

// Integration: validateDesiredStateNode with Lambda
describe("validateDesiredStateNode — AWS::Lambda::Function", () => {
  it("passes through on valid FunctionName", async () => {
    const state = mkState({
      resourceType: "AWS::Lambda::Function",
      desiredState: { FunctionName: "my-valid-fn" },
    });
    expect(await validateDesiredStateNode(state)).toEqual({});
  });

  it("sets FAILED with INVALID_DESIRED_STATE code on invalid FunctionName", async () => {
    const state = mkState({
      resourceType: "AWS::Lambda::Function",
      desiredState: { FunctionName: "my.function" },
    });
    const patch = await validateDesiredStateNode(state);
    expect(patch.executionStatus).toBe(ExecutionStatus.FAILED);
    expect(patch.errorMessage).toContain("[ERROR]");
    expect(patch.errorMessage).toContain("[FIX]");
    expect(patch.error).toBeInstanceOf(AssigneeError);
    expect(patch.error?.code).toBe(ErrorCode.INVALID_DESIRED_STATE);
  });

  it("passes through when FunctionName is absent (no-op)", async () => {
    const state = mkState({
      resourceType: "AWS::Lambda::Function",
      desiredState: {},
    });
    expect(await validateDesiredStateNode(state)).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// AWS::DynamoDB::Table — TableName
// ---------------------------------------------------------------------------

describe("validateDdbTableName", () => {
  // Pass cases
  it("accepts a typical table name", () => {
    expect(validateDdbTableName("UserProfiles").ok).toBe(true);
  });

  it("accepts names with underscores, hyphens, and dots", () => {
    expect(validateDdbTableName("my-table_name.v2").ok).toBe(true);
  });

  it("accepts exactly 3-char name (min boundary)", () => {
    expect(validateDdbTableName("abc").ok).toBe(true);
  });

  it("accepts exactly 255-char name (upper boundary)", () => {
    expect(validateDdbTableName("a".repeat(255)).ok).toBe(true);
  });

  it("treats empty string as valid (auto-generate)", () => {
    expect(validateDdbTableName("").ok).toBe(true);
  });

  // Fail cases — length
  it("rejects 2-char name (below min)", () => {
    const r = validateDdbTableName("ab");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("3-255");
    expect(r.fix).toBeDefined();
  });

  it("rejects 256-char name (above max)", () => {
    const r = validateDdbTableName("a".repeat(256));
    expect(r.ok).toBe(false);
    expect(r.error).toContain("3-255");
  });

  // Fail cases — charset
  it("rejects name with spaces", () => {
    const r = validateDdbTableName("my table");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("[a-zA-Z0-9_.-]");
  });

  it("rejects name with @ symbol", () => {
    const r = validateDdbTableName("table@prod");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("[a-zA-Z0-9_.-]");
  });

  // W4c reviewer follow-up: original regex `/^[a-zA-Z0-9_.\\-]+$/`
  // accidentally allowed literal backslash. AWS forbids it. Regex
  // corrected to `/^[a-zA-Z0-9_.-]+$/`; this test pins the fix.
  it("rejects name with backslash (W4c regex fix)", () => {
    const r = validateDdbTableName("my\\table");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("[a-zA-Z0-9_.-]");
  });
});

// Integration: validateDesiredStateNode with DynamoDB
describe("validateDesiredStateNode — AWS::DynamoDB::Table", () => {
  it("passes through on valid TableName", async () => {
    const state = mkState({
      resourceType: "AWS::DynamoDB::Table",
      desiredState: { TableName: "UserProfiles" },
    });
    expect(await validateDesiredStateNode(state)).toEqual({});
  });

  it("sets FAILED on invalid TableName (space in name)", async () => {
    const state = mkState({
      resourceType: "AWS::DynamoDB::Table",
      desiredState: { TableName: "my table" },
    });
    const patch = await validateDesiredStateNode(state);
    expect(patch.executionStatus).toBe(ExecutionStatus.FAILED);
    expect(patch.error).toBeInstanceOf(AssigneeError);
    expect(patch.error?.code).toBe(ErrorCode.INVALID_DESIRED_STATE);
  });
});

// ---------------------------------------------------------------------------
// AWS::EC2::SecurityGroup — GroupName
// ---------------------------------------------------------------------------

describe("validateSgName", () => {
  // Pass cases
  it("accepts a typical security group name", () => {
    expect(validateSgName("web-app-sg").ok).toBe(true);
  });

  it("accepts names with permitted special chars", () => {
    expect(validateSgName("app (prod) #1").ok).toBe(true);
  });

  it("accepts a single character name", () => {
    expect(validateSgName("a").ok).toBe(true);
  });

  it("treats empty string as valid (auto-generate)", () => {
    expect(validateSgName("").ok).toBe(true);
  });

  // Fail cases — reserved words
  it('rejects exactly "default" (reserved for default VPC SG)', () => {
    const r = validateSgName("default");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("reserved");
    expect(r.fix).toBeDefined();
  });

  it('rejects name starting with "sg-" (reserved for SG IDs)', () => {
    const r = validateSgName("sg-0abc1234");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("sg-");
    expect(r.fix).toBeDefined();
  });

  // Fail cases — charset
  it("rejects name with backtick character", () => {
    const r = validateSgName("my`group");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("not allowed");
  });

  it("rejects name with backslash", () => {
    const r = validateSgName("my\\group");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("not allowed");
  });

  // Fail cases — length
  it("rejects 256-char name (above max)", () => {
    const r = validateSgName("a".repeat(256));
    expect(r.ok).toBe(false);
    expect(r.error).toContain("1-255");
  });
});

// Integration: validateDesiredStateNode with EC2 SecurityGroup
describe("validateDesiredStateNode — AWS::EC2::SecurityGroup", () => {
  it("passes through on valid GroupName", async () => {
    const state = mkState({
      resourceType: "AWS::EC2::SecurityGroup",
      desiredState: { GroupName: "web-app-sg" },
    });
    expect(await validateDesiredStateNode(state)).toEqual({});
  });

  it('sets FAILED on "default" GroupName', async () => {
    const state = mkState({
      resourceType: "AWS::EC2::SecurityGroup",
      desiredState: { GroupName: "default" },
    });
    const patch = await validateDesiredStateNode(state);
    expect(patch.executionStatus).toBe(ExecutionStatus.FAILED);
    expect(patch.errorMessage).toContain("[ERROR]");
    expect(patch.error).toBeInstanceOf(AssigneeError);
    expect(patch.error?.code).toBe(ErrorCode.INVALID_DESIRED_STATE);
  });

  it('sets FAILED on "sg-" prefixed GroupName', async () => {
    const state = mkState({
      resourceType: "AWS::EC2::SecurityGroup",
      desiredState: { GroupName: "sg-my-group" },
    });
    const patch = await validateDesiredStateNode(state);
    expect(patch.executionStatus).toBe(ExecutionStatus.FAILED);
    expect(patch.error?.code).toBe(ErrorCode.INVALID_DESIRED_STATE);
  });
});

// ---------------------------------------------------------------------------
// AWS::IAM::Role — RoleName
// ---------------------------------------------------------------------------

describe("validateIamRoleName", () => {
  // Pass cases
  it("accepts a typical IAM role name", () => {
    expect(validateIamRoleName("MyServiceRole").ok).toBe(true);
  });

  it("accepts names with permitted special chars (+=,.@-)", () => {
    expect(validateIamRoleName("App.Role+v2@prod").ok).toBe(true);
  });

  it("accepts single-character name", () => {
    expect(validateIamRoleName("R").ok).toBe(true);
  });

  it("accepts exactly 64-char name (upper boundary)", () => {
    expect(validateIamRoleName("a".repeat(64)).ok).toBe(true);
  });

  it("treats empty string as valid (auto-generate)", () => {
    expect(validateIamRoleName("").ok).toBe(true);
  });

  // Fail cases — length
  it("rejects 65-char name (above max)", () => {
    const r = validateIamRoleName("a".repeat(65));
    expect(r.ok).toBe(false);
    expect(r.error).toContain("1-64");
    expect(r.fix).toBeDefined();
  });

  // Fail cases — charset
  it("accepts name with leading hyphen (allowed by AWS regex [\\w+=,.@-]+)", () => {
    // AWS IAM's published pattern [\w+=,.@-]+ does not restrict leading hyphens.
    const r = validateIamRoleName("-MyRole");
    expect(r.ok).toBe(true);
  });

  it("rejects name with spaces", () => {
    const r = validateIamRoleName("My Role");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("[a-zA-Z0-9_+=,.@-]");
  });

  it("rejects name with unicode characters", () => {
    const r = validateIamRoleName("Röle");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("[a-zA-Z0-9_+=,.@-]");
  });
});

// Integration: validateDesiredStateNode with IAM Role
describe("validateDesiredStateNode — AWS::IAM::Role", () => {
  it("passes through on valid RoleName", async () => {
    const state = mkState({
      resourceType: "AWS::IAM::Role",
      desiredState: { RoleName: "MyServiceRole" },
    });
    expect(await validateDesiredStateNode(state)).toEqual({});
  });

  it("sets FAILED on RoleName with disallowed character (space)", async () => {
    // Leading hyphen is allowed; spaces are not.
    const state = mkState({
      resourceType: "AWS::IAM::Role",
      desiredState: { RoleName: "My Role" },
    });
    const patch = await validateDesiredStateNode(state);
    expect(patch.executionStatus).toBe(ExecutionStatus.FAILED);
    expect(patch.errorMessage).toContain("[ERROR]");
    expect(patch.error).toBeInstanceOf(AssigneeError);
    expect(patch.error?.code).toBe(ErrorCode.INVALID_DESIRED_STATE);
  });
});

// ---------------------------------------------------------------------------
// AWS::RDS::DBInstance — DBInstanceIdentifier
// ---------------------------------------------------------------------------

describe("validateRdsDbIdentifier", () => {
  // Pass cases
  it("accepts a typical DB instance identifier", () => {
    expect(validateRdsDbIdentifier("prod-db-01").ok).toBe(true);
  });

  it("accepts single-letter identifier", () => {
    expect(validateRdsDbIdentifier("a").ok).toBe(true);
  });

  it("accepts exactly 63-char identifier (upper boundary)", () => {
    // Must start with letter; pad with 'a' then digits
    const name = "a" + "0".repeat(62);
    expect(validateRdsDbIdentifier(name).ok).toBe(true);
  });

  it("treats empty string as valid (auto-generate)", () => {
    expect(validateRdsDbIdentifier("").ok).toBe(true);
  });

  // Fail cases — must start with letter
  it("rejects identifier starting with digit", () => {
    const r = validateRdsDbIdentifier("1prod-db");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("start with a letter");
    expect(r.fix).toBeDefined();
  });

  it("rejects identifier starting with hyphen", () => {
    const r = validateRdsDbIdentifier("-prod-db");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("start with a letter");
  });

  // Fail cases — trailing hyphen
  it("rejects identifier ending with hyphen", () => {
    const r = validateRdsDbIdentifier("prod-db-");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("not end with a hyphen");
    expect(r.fix).toBeDefined();
  });

  // Fail cases — consecutive hyphens
  it("rejects identifier with consecutive hyphens", () => {
    const r = validateRdsDbIdentifier("prod--db");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("consecutive hyphens");
    expect(r.fix).toBeDefined();
  });

  // Fail cases — charset
  it("rejects identifier with underscores", () => {
    const r = validateRdsDbIdentifier("prod_db");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("[a-zA-Z0-9-]");
  });

  // Fail cases — length
  it("rejects 64-char identifier (above max)", () => {
    const r = validateRdsDbIdentifier("a" + "0".repeat(63));
    expect(r.ok).toBe(false);
    expect(r.error).toContain("1-63");
  });
});

// Integration: validateDesiredStateNode with RDS DBInstance
describe("validateDesiredStateNode — AWS::RDS::DBInstance", () => {
  it("passes through on valid DBInstanceIdentifier", async () => {
    const state = mkState({
      resourceType: "AWS::RDS::DBInstance",
      desiredState: { DBInstanceIdentifier: "prod-db-01" },
    });
    expect(await validateDesiredStateNode(state)).toEqual({});
  });

  it("sets FAILED on identifier starting with digit", async () => {
    const state = mkState({
      resourceType: "AWS::RDS::DBInstance",
      desiredState: { DBInstanceIdentifier: "1bad-db" },
    });
    const patch = await validateDesiredStateNode(state);
    expect(patch.executionStatus).toBe(ExecutionStatus.FAILED);
    expect(patch.errorMessage).toContain("[ERROR]");
    expect(patch.error).toBeInstanceOf(AssigneeError);
    expect(patch.error?.code).toBe(ErrorCode.INVALID_DESIRED_STATE);
  });

  it("sets FAILED on identifier ending with hyphen", async () => {
    const state = mkState({
      resourceType: "AWS::RDS::DBInstance",
      desiredState: { DBInstanceIdentifier: "prod-db-" },
    });
    const patch = await validateDesiredStateNode(state);
    expect(patch.executionStatus).toBe(ExecutionStatus.FAILED);
    expect(patch.error?.code).toBe(ErrorCode.INVALID_DESIRED_STATE);
  });
});

// ---------------------------------------------------------------------------
// AWS::SQS::Queue — QueueName
// ---------------------------------------------------------------------------

describe("validateSqsQueueName", () => {
  // Pass cases
  it("accepts a typical standard queue name", () => {
    expect(validateSqsQueueName("my-queue").ok).toBe(true);
  });

  it("accepts a valid FIFO queue name", () => {
    expect(validateSqsQueueName("my-queue.fifo").ok).toBe(true);
  });

  it("accepts names with underscores", () => {
    expect(validateSqsQueueName("my_queue_prod").ok).toBe(true);
  });

  it("accepts exactly 80-char name (upper boundary)", () => {
    // 80 chars total; standard queue
    expect(validateSqsQueueName("a".repeat(80)).ok).toBe(true);
  });

  it("accepts FIFO queue with 75-char base + .fifo = 80 total", () => {
    expect(validateSqsQueueName("a".repeat(75) + ".fifo").ok).toBe(true);
  });

  it("treats empty string as valid (auto-generate)", () => {
    expect(validateSqsQueueName("").ok).toBe(true);
  });

  // Fail cases — length
  it("rejects 81-char name (above max)", () => {
    const r = validateSqsQueueName("a".repeat(81));
    expect(r.ok).toBe(false);
    expect(r.error).toContain("1-80");
    expect(r.fix).toBeDefined();
  });

  // Fail cases — charset
  it("rejects name with dot that is not .fifo suffix", () => {
    const r = validateSqsQueueName("my.queue");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("[a-zA-Z0-9_-]");
  });

  it("rejects name with spaces", () => {
    const r = validateSqsQueueName("my queue");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("[a-zA-Z0-9_-]");
  });
});

// Integration: validateDesiredStateNode with SQS Queue
describe("validateDesiredStateNode — AWS::SQS::Queue", () => {
  it("passes through on valid standard QueueName", async () => {
    const state = mkState({
      resourceType: "AWS::SQS::Queue",
      desiredState: { QueueName: "my-queue" },
    });
    expect(await validateDesiredStateNode(state)).toEqual({});
  });

  it("passes through on valid FIFO QueueName", async () => {
    const state = mkState({
      resourceType: "AWS::SQS::Queue",
      desiredState: { QueueName: "my-queue.fifo" },
    });
    expect(await validateDesiredStateNode(state)).toEqual({});
  });

  it("sets FAILED on QueueName with invalid dot", async () => {
    const state = mkState({
      resourceType: "AWS::SQS::Queue",
      desiredState: { QueueName: "my.queue" },
    });
    const patch = await validateDesiredStateNode(state);
    expect(patch.executionStatus).toBe(ExecutionStatus.FAILED);
    expect(patch.errorMessage).toContain("[ERROR]");
    expect(patch.error).toBeInstanceOf(AssigneeError);
    expect(patch.error?.code).toBe(ErrorCode.INVALID_DESIRED_STATE);
  });
});

// ---------------------------------------------------------------------------
// AWS::SNS::Topic — TopicName
// ---------------------------------------------------------------------------

describe("validateSnsTopicName", () => {
  // Pass cases
  it("accepts a typical topic name", () => {
    expect(validateSnsTopicName("my-topic").ok).toBe(true);
  });

  it("accepts a valid FIFO topic name", () => {
    expect(validateSnsTopicName("my-topic.fifo").ok).toBe(true);
  });

  it("accepts names with underscores", () => {
    expect(validateSnsTopicName("my_topic_alerts").ok).toBe(true);
  });

  it("accepts exactly 256-char name (upper boundary)", () => {
    expect(validateSnsTopicName("a".repeat(256)).ok).toBe(true);
  });

  it("treats empty string as valid (auto-generate)", () => {
    expect(validateSnsTopicName("").ok).toBe(true);
  });

  // Fail cases — length
  it("rejects 257-char name (above max)", () => {
    const r = validateSnsTopicName("a".repeat(257));
    expect(r.ok).toBe(false);
    expect(r.error).toContain("1-256");
    expect(r.fix).toBeDefined();
  });

  // Fail cases — charset
  it("rejects name with dot that is not .fifo suffix", () => {
    const r = validateSnsTopicName("my.topic");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("[a-zA-Z0-9_-]");
  });

  it("rejects name with spaces", () => {
    const r = validateSnsTopicName("my topic");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("[a-zA-Z0-9_-]");
  });

  it("rejects name with unicode", () => {
    const r = validateSnsTopicName("my-tópic");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("[a-zA-Z0-9_-]");
  });
});

// Integration: validateDesiredStateNode with SNS Topic
describe("validateDesiredStateNode — AWS::SNS::Topic", () => {
  it("passes through on valid TopicName", async () => {
    const state = mkState({
      resourceType: "AWS::SNS::Topic",
      desiredState: { TopicName: "my-alerts" },
    });
    expect(await validateDesiredStateNode(state)).toEqual({});
  });

  it("sets FAILED on invalid TopicName (with space)", async () => {
    const state = mkState({
      resourceType: "AWS::SNS::Topic",
      desiredState: { TopicName: "my topic" },
    });
    const patch = await validateDesiredStateNode(state);
    expect(patch.executionStatus).toBe(ExecutionStatus.FAILED);
    expect(patch.errorMessage).toContain("[ERROR]");
    expect(patch.error).toBeInstanceOf(AssigneeError);
    expect(patch.error?.code).toBe(ErrorCode.INVALID_DESIRED_STATE);
  });
});

// ---------------------------------------------------------------------------
// AWS::KMS::Alias — AliasName
// ---------------------------------------------------------------------------

describe("validateKmsAliasName", () => {
  // Pass cases
  it("accepts a typical alias name", () => {
    expect(validateKmsAliasName("alias/my-app-key").ok).toBe(true);
  });

  it("accepts alias with nested path using slash", () => {
    expect(validateKmsAliasName("alias/prod/app/key").ok).toBe(true);
  });

  it("accepts alias with underscore in suffix", () => {
    expect(validateKmsAliasName("alias/my_key_v2").ok).toBe(true);
  });

  it("treats empty string as valid (auto-generate)", () => {
    expect(validateKmsAliasName("").ok).toBe(true);
  });

  // Fail cases — missing alias/ prefix
  it("rejects name without alias/ prefix", () => {
    const r = validateKmsAliasName("my-key");
    expect(r.ok).toBe(false);
    expect(r.error).toContain('must start with "alias/"');
    expect(r.fix).toBeDefined();
  });

  // Fail cases — reserved aws prefix
  it('rejects alias starting with "alias/aws"', () => {
    const r = validateKmsAliasName("alias/aws/my-key");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("alias/aws");
    expect(r.fix).toBeDefined();
  });

  // Fail cases — empty suffix
  it('rejects "alias/" with no suffix', () => {
    const r = validateKmsAliasName("alias/");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("empty suffix");
  });

  // Fail cases — charset in suffix
  it("rejects alias suffix with spaces", () => {
    const r = validateKmsAliasName("alias/my key");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("characters outside");
  });

  it("rejects alias suffix with @ symbol", () => {
    const r = validateKmsAliasName("alias/my@key");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("characters outside");
  });

  // Fail cases — length
  it("rejects name exceeding 256 chars", () => {
    // "alias/" (6) + 251 'a' = 257
    const r = validateKmsAliasName("alias/" + "a".repeat(251));
    expect(r.ok).toBe(false);
    expect(r.error).toContain("1-256");
  });
});

// Integration: validateDesiredStateNode with KMS Alias
describe("validateDesiredStateNode — AWS::KMS::Alias", () => {
  it("passes through on valid AliasName", async () => {
    const state = mkState({
      resourceType: "AWS::KMS::Alias",
      desiredState: { AliasName: "alias/my-app-key" },
    });
    expect(await validateDesiredStateNode(state)).toEqual({});
  });

  it("sets FAILED on AliasName without alias/ prefix", async () => {
    const state = mkState({
      resourceType: "AWS::KMS::Alias",
      desiredState: { AliasName: "my-key" },
    });
    const patch = await validateDesiredStateNode(state);
    expect(patch.executionStatus).toBe(ExecutionStatus.FAILED);
    expect(patch.errorMessage).toContain("[ERROR]");
    expect(patch.error).toBeInstanceOf(AssigneeError);
    expect(patch.error?.code).toBe(ErrorCode.INVALID_DESIRED_STATE);
  });

  it("sets FAILED on reserved alias/aws prefix", async () => {
    const state = mkState({
      resourceType: "AWS::KMS::Alias",
      desiredState: { AliasName: "alias/aws/my-managed-key" },
    });
    const patch = await validateDesiredStateNode(state);
    expect(patch.executionStatus).toBe(ExecutionStatus.FAILED);
    expect(patch.error?.code).toBe(ErrorCode.INVALID_DESIRED_STATE);
  });
});

// ---------------------------------------------------------------------------
// AWS::ECR::Repository — RepositoryName
// ---------------------------------------------------------------------------

describe("validateEcrRepositoryName", () => {
  // Pass cases
  it("accepts a typical repository name", () => {
    expect(validateEcrRepositoryName("my-app").ok).toBe(true);
  });

  it("accepts namespaced repository name", () => {
    expect(validateEcrRepositoryName("org/team/app").ok).toBe(true);
  });

  it("accepts names with dots and underscores", () => {
    expect(validateEcrRepositoryName("my.app_v2").ok).toBe(true);
  });

  it("accepts exactly 2-char name (min boundary)", () => {
    expect(validateEcrRepositoryName("ab").ok).toBe(true);
  });

  it("accepts exactly 256-char name (upper boundary)", () => {
    // 256 chars of 'a'
    expect(validateEcrRepositoryName("a".repeat(256)).ok).toBe(true);
  });

  it("treats empty string as valid (auto-generate)", () => {
    expect(validateEcrRepositoryName("").ok).toBe(true);
  });

  // Fail cases — uppercase
  it("rejects uppercase characters", () => {
    const r = validateEcrRepositoryName("MyApp");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("uppercase");
    expect(r.fix).toBeDefined();
  });

  // Fail cases — length
  it("rejects 1-char name (below min)", () => {
    const r = validateEcrRepositoryName("a");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("2-256");
  });

  it("rejects 257-char name (above max)", () => {
    const r = validateEcrRepositoryName("a".repeat(257));
    expect(r.ok).toBe(false);
    expect(r.error).toContain("2-256");
  });

  // Fail cases — component structure
  it("rejects component starting with separator", () => {
    const r = validateEcrRepositoryName("-myapp");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("invalid");
  });

  it("rejects component ending with separator", () => {
    const r = validateEcrRepositoryName("myapp-");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("invalid");
  });

  it("rejects component with consecutive separators", () => {
    const r = validateEcrRepositoryName("my--app");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("invalid");
  });

  it("rejects path component with uppercase in nested path", () => {
    const r = validateEcrRepositoryName("org/MyRepo");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("uppercase");
  });

  it("rejects name with spaces", () => {
    const r = validateEcrRepositoryName("my repo");
    expect(r.ok).toBe(false);
  });
});

// Integration: validateDesiredStateNode with ECR Repository
describe("validateDesiredStateNode — AWS::ECR::Repository", () => {
  it("passes through on valid RepositoryName", async () => {
    const state = mkState({
      resourceType: "AWS::ECR::Repository",
      desiredState: { RepositoryName: "my-app-repo" },
    });
    expect(await validateDesiredStateNode(state)).toEqual({});
  });

  it("sets FAILED on uppercase RepositoryName", async () => {
    const state = mkState({
      resourceType: "AWS::ECR::Repository",
      desiredState: { RepositoryName: "MyApp" },
    });
    const patch = await validateDesiredStateNode(state);
    expect(patch.executionStatus).toBe(ExecutionStatus.FAILED);
    expect(patch.errorMessage).toContain("[ERROR]");
    expect(patch.error).toBeInstanceOf(AssigneeError);
    expect(patch.error?.code).toBe(ErrorCode.INVALID_DESIRED_STATE);
  });

  it("sets FAILED on invalid path component", async () => {
    const state = mkState({
      resourceType: "AWS::ECR::Repository",
      desiredState: { RepositoryName: "my--app" },
    });
    const patch = await validateDesiredStateNode(state);
    expect(patch.executionStatus).toBe(ExecutionStatus.FAILED);
    expect(patch.error?.code).toBe(ErrorCode.INVALID_DESIRED_STATE);
  });
});

// ---------------------------------------------------------------------------
// Back-compat: unregistered resource types → no error
// ---------------------------------------------------------------------------

describe("validateDesiredState — back-compat for unregistered types", () => {
  it("returns ok=true for AWS::CloudFront::Distribution (no validator)", () => {
    const r = validateDesiredState("AWS::CloudFront::Distribution", {
      DistributionId: "EDFDVBD6EXAMPLE",
    });
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it("returns ok=true for AWS::ECS::Cluster (no validator)", () => {
    const r = validateDesiredState("AWS::ECS::Cluster", {
      ClusterName: "my cluster!",
    });
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
  });
});
