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
