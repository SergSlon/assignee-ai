/**
 * Unit tests for `llm-plan/resource-post-process.ts` — focused on the
 * SSH-on-Windows fail-fast that mirrors the compound-path guard in
 * `compound-helpers.ts:postProcessEc2Compound`. The LLM-plan path is
 * the dominant single-resource flow; without this test the BLOCKER #1
 * regression (Windows + SSH slipping past `postProcessEc2Instance`)
 * would not be pinned.
 *
 * Coverage:
 *   - Windows AMI + SSH intent: postRepairPostProcess rejects with
 *     AssigneeError(WINDOWS_SSH_INCOMPATIBLE) BEFORE the KeyName
 *     placeholder is injected.
 *   - Linux AMI + SSH intent: passes through, KeyName placeholder
 *     injected (existing behaviour preserved).
 *   - Non-EC2 resource: no SSH guard runs.
 *
 * Real AWS-shape fixtures per `feedback_real_data_mocks_all_cases`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  RESOURCE_TYPES,
  CfnKey,
  ResourceDefault,
  AssigneeError,
} from "@/index.js";
import type { AgentState } from "@/graph/graph-state.js";

vi.mock("@/utils/aws-resource-discovery/ami-default-user.js", async () => {
  const actual = await vi.importActual<
    typeof import("@/utils/aws-resource-discovery/ami-default-user.js")
  >("@/utils/aws-resource-discovery/ami-default-user.js");
  return {
    ...actual,
    getAmiPlatformDetails: vi.fn(),
  };
});

import { postRepairPostProcess } from "./resource-post-process.js";
import { WINDOWS_SSH_INCOMPATIBLE_CODE } from "../ssh-windows-guard.js";
import {
  getAmiPlatformDetails,
  PLATFORM_DETAILS_WINDOWS,
} from "@/utils/aws-resource-discovery/ami-default-user.js";

const AMI_LINUX = "ami-0abcdef1234567890";
const AMI_WINDOWS = "ami-0d1e2f3a4b5c6d7e8";

function makeEc2State(overrides: Partial<AgentState> = {}): AgentState {
  return {
    resourceType: RESOURCE_TYPES.EC2_INSTANCE,
    runId: "run-llm-plan-postproc-test",
    userIntent: "Create an EC2 with SSH",
    ...overrides,
  } as AgentState;
}

beforeEach(() => {
  vi.mocked(getAmiPlatformDetails).mockReset();
});

describe("postRepairPostProcess — SSH-bundle Windows fail-fast (LLM-plan path)", () => {
  it("Windows AMI + SSH intent: throws AssigneeError(WINDOWS_SSH_INCOMPATIBLE) and does NOT inject KeyName", async () => {
    vi.mocked(getAmiPlatformDetails).mockResolvedValueOnce(
      PLATFORM_DETAILS_WINDOWS,
    );
    const desiredState: Record<string, unknown> = {
      [CfnKey.IMAGE_ID]: AMI_WINDOWS,
    };

    await expect(
      postRepairPostProcess(
        desiredState,
        makeEc2State({ userIntent: "Create a Windows EC2 with SSH" }),
      ),
    ).rejects.toBeInstanceOf(AssigneeError);

    // Re-arm the mock and assert the structured error payload.
    vi.mocked(getAmiPlatformDetails).mockResolvedValueOnce(
      PLATFORM_DETAILS_WINDOWS,
    );
    await expect(
      postRepairPostProcess(
        desiredState,
        makeEc2State({ userIntent: "Create a Windows EC2 with SSH" }),
      ),
    ).rejects.toMatchObject({
      code: WINDOWS_SSH_INCOMPATIBLE_CODE,
      message: expect.stringContaining(
        "Cannot create EC2 with SSH on a Windows AMI",
      ),
    });

    // The fail-fast must run BEFORE the KeyName placeholder injection,
    // i.e. desiredState is left untouched.
    expect(desiredState[CfnKey.KEY_NAME]).toBeUndefined();
  });

  it("Linux AMI + SSH intent: passes through, injects KeyName placeholder", async () => {
    vi.mocked(getAmiPlatformDetails).mockResolvedValueOnce("Linux/UNIX");
    const desiredState: Record<string, unknown> = {
      [CfnKey.IMAGE_ID]: AMI_LINUX,
    };

    await postRepairPostProcess(desiredState, makeEc2State());

    expect(getAmiPlatformDetails).toHaveBeenCalledWith(AMI_LINUX);
    expect(desiredState[CfnKey.KEY_NAME]).toBe(
      ResourceDefault.SSH_KEY_PLACEHOLDER,
    );
  });

  it("non-SSH intent + Windows AMI: no AMI lookup, no error", async () => {
    const desiredState: Record<string, unknown> = {
      [CfnKey.IMAGE_ID]: AMI_WINDOWS,
    };

    await postRepairPostProcess(
      desiredState,
      makeEc2State({ userIntent: "Create a Windows EC2 for batch processing" }),
    );

    expect(getAmiPlatformDetails).not.toHaveBeenCalled();
    expect(desiredState[CfnKey.KEY_NAME]).toBeUndefined();
  });

  it("non-EC2 resource: no SSH guard runs", async () => {
    const desiredState: Record<string, unknown> = {};
    await postRepairPostProcess(
      desiredState,
      makeEc2State({
        resourceType: RESOURCE_TYPES.S3_BUCKET,
        userIntent: "Create an S3 bucket with SSH access",
      }),
    );
    expect(getAmiPlatformDetails).not.toHaveBeenCalled();
  });

  it("preserves the existing SecurityGroupIds scrub semantics on Linux/SSH path", async () => {
    vi.mocked(getAmiPlatformDetails).mockResolvedValueOnce("Linux/UNIX");
    const desiredState: Record<string, unknown> = {
      [CfnKey.IMAGE_ID]: AMI_LINUX,
      [CfnKey.SECURITY_GROUP_IDS]: ["sg-12345678", "not-a-real-sg", ""],
    };

    await postRepairPostProcess(desiredState, makeEc2State());

    expect(desiredState[CfnKey.SECURITY_GROUP_IDS]).toEqual(["sg-12345678"]);
  });
});

// ---------------------------------------------------------------------------
// EPIC-106-7 / PH5-8-B — LLM name-hallucination guard
// ---------------------------------------------------------------------------

describe("postRepairPostProcess — LLM name-hallucination guard (EPIC-106-7)", () => {
  // runId prefix: "run-halluc" → first 8 chars = "run-hall"
  const S3_RUN_ID = "run-hallucination-guard-test";
  const S3_EXPECTED_NAME = "assignee-s3-bucket-run-hall";

  function makeS3State(overrides: Partial<AgentState> = {}): AgentState {
    return {
      resourceType: RESOURCE_TYPES.S3_BUCKET,
      runId: S3_RUN_ID,
      userIntent: "Create an S3 bucket",
      elicitedOptions: {},
      ...overrides,
    } as AgentState;
  }

  // Variation A — bare intent, no name extractor fired
  it("A: bare intent (no user name) → LLM-proposed BucketName replaced with assignee-s3-bucket-<runId[:8]>", async () => {
    const desiredState: Record<string, unknown> = {
      BucketName: "payments-data-prod", // LLM-hallucinated
      VersioningConfiguration: { Status: "Enabled" },
    };

    await postRepairPostProcess(
      desiredState,
      makeS3State({
        userIntent: "Create an S3 bucket with versioning enabled",
      }),
    );

    expect(desiredState["BucketName"]).toBe(S3_EXPECTED_NAME);
  });

  // Variation B — explicit "named foo" keyword: user name preserved
  it('B: "named my-data-bucket" → BucketName preserved from elicitedOptions', async () => {
    const desiredState: Record<string, unknown> = {
      BucketName: "my-data-bucket", // merged from elicitedOptions by mergeElicitedOptions upstream
      VersioningConfiguration: { Status: "Enabled" },
    };

    await postRepairPostProcess(
      desiredState,
      makeS3State({
        userIntent: "Create an S3 bucket named my-data-bucket with versioning",
        elicitedOptions: { BucketName: "my-data-bucket" },
      }),
    );

    expect(desiredState["BucketName"]).toBe("my-data-bucket");
  });

  // Variation C — inline-name extractor (SX-2) fired: user name preserved
  it("C: inline SX-2 name extractor fired → BucketName preserved from elicitedOptions", async () => {
    const desiredState: Record<string, unknown> = {
      BucketName: "data-archive", // merged from elicitedOptions by SX-2 path
    };

    await postRepairPostProcess(
      desiredState,
      makeS3State({
        userIntent: "Create an S3 bucket data-archive",
        elicitedOptions: { BucketName: "data-archive" },
      }),
    );

    expect(desiredState["BucketName"]).toBe("data-archive");
  });

  // Variation D — Lambda FunctionName in LLM path gets guarded too
  it("D: Lambda FunctionName hallucinated by LLM replaced with assignee-lambda-fn-<runId[:8]>", async () => {
    vi.mocked(getAmiPlatformDetails).mockReset();
    // runId "run-lambd" → first 8 chars = "run-lamb"
    const desiredState: Record<string, unknown> = {
      FunctionName: "my-payment-processor", // LLM-hallucinated
      Runtime: "nodejs22.x",
      Handler: "index.handler",
      Role: "arn:aws:iam::112233445566:role/my-role",
    };

    await postRepairPostProcess(desiredState, {
      resourceType: RESOURCE_TYPES.LAMBDA_FUNCTION,
      runId: "run-lambda-guard-test",
      userIntent: "Create a Lambda function for payment processing",
      elicitedOptions: {},
    } as AgentState);

    expect(desiredState["FunctionName"]).toBe("assignee-lambda-fn-run-lamb");
  });

  // Variation D-SQS — SQS QueueName in LLM path gets guarded too
  it("D-SQS: SQS QueueName hallucinated by LLM replaced with assignee-sqs-queue-<runId[:8]>", async () => {
    // runId "run-sqs-g" → first 8 chars = "run-sqs-"
    const desiredState: Record<string, unknown> = {
      QueueName: "orders-processing-queue", // LLM-hallucinated
      VisibilityTimeout: 30,
    };

    await postRepairPostProcess(desiredState, {
      resourceType: RESOURCE_TYPES.SQS_QUEUE,
      runId: "run-sqs-guard-test",
      userIntent: "Create an SQS queue for order processing",
      elicitedOptions: {},
    } as AgentState);

    expect(desiredState["QueueName"]).toBe("assignee-sqs-queue-run-sqs-");
  });

  // Edge case: no BucketName in LLM output at all → nothing set / no crash
  it("no BucketName in LLM output → desiredState unchanged", async () => {
    const desiredState: Record<string, unknown> = {
      VersioningConfiguration: { Status: "Enabled" },
    };

    await postRepairPostProcess(
      desiredState,
      makeS3State({ userIntent: "Create an S3 bucket with versioning" }),
    );

    expect(desiredState["BucketName"]).toBeUndefined();
  });

  // Verify DynamoDB is NOT in the guard list (it has a toCfn guard in plugin)
  it("DynamoDB TableName is NOT replaced by post-process guard (toCfn handles it)", async () => {
    const desiredState: Record<string, unknown> = {
      TableName: "my-dynamodb-table", // would normally be caught by plugin toCfn
      BillingMode: "PAY_PER_REQUEST",
    };

    await postRepairPostProcess(desiredState, {
      resourceType: RESOURCE_TYPES.DYNAMODB_TABLE,
      runId: "run-ddb-guard-test",
      userIntent: "Create a DynamoDB table",
      elicitedOptions: {},
    } as AgentState);

    // DynamoDB is NOT in the post-process guard list — its plugin toCfn handles it
    expect(desiredState["TableName"]).toBe("my-dynamodb-table");
  });

  // Idempotency regression guard: same state → same name across two calls
  it("idempotency: calling twice with the same state produces the same BucketName (plan→apply consistency)", async () => {
    const state = makeS3State({
      userIntent: "Create an S3 bucket with versioning enabled",
    });

    const ds1: Record<string, unknown> = { BucketName: "hallucinated-name-1" };
    await postRepairPostProcess(ds1, state);
    const name1 = ds1["BucketName"] as string;

    const ds2: Record<string, unknown> = { BucketName: "hallucinated-name-2" };
    await postRepairPostProcess(ds2, state);
    const name2 = ds2["BucketName"] as string;

    expect(name1).toBe(name2);
    expect(name1).toBe(S3_EXPECTED_NAME);
  });
});
