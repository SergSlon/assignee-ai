/**
 * Unit tests for the shared SSH-on-Windows fail-fast guard
 * (`ssh-windows-guard.ts`). The guard is wired into BOTH the compound
 * plan-generator path (`compound-helpers.ts:postProcessEc2Compound`)
 * and the LLM-plan single-resource path
 * (`llm-plan/resource-post-process.ts:postProcessEc2Instance`); these
 * tests pin the guard's standalone contract independently of the call
 * sites.
 *
 * Coverage:
 *   - Linux AMI + SSH intent: no throw, lookup performed.
 *   - Windows AMI + SSH intent: throws AssigneeError with code
 *     WINDOWS_SSH_INCOMPATIBLE and the actionable message.
 *   - Non-SSH intent: no AMI lookup, no throw.
 *   - Missing / non-string ImageId: no AMI lookup.
 *   - ImageId still an OS-name placeholder ("amazon-linux-2023"):
 *     no AMI lookup (defense-in-depth — never call DescribeImages
 *     with garbage).
 *   - Lookup returns null (transient API blip): no throw, fall through.
 *
 * Real-shape AMI IDs and Windows PlatformDetails sentinel string
 * sourced from the AWS public catalog per
 * `feedback_real_data_mocks_all_cases`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { CfnKey, AssigneeError } from "@/index.js";

vi.mock("@/utils/aws-resource-discovery/ami-default-user.js", async () => {
  const actual = await vi.importActual<
    typeof import("@/utils/aws-resource-discovery/ami-default-user.js")
  >("@/utils/aws-resource-discovery/ami-default-user.js");
  return {
    ...actual,
    getAmiPlatformDetails: vi.fn(),
  };
});

import {
  assertSshIntentNotWindowsAmi,
  WINDOWS_SSH_INCOMPATIBLE_CODE,
} from "./ssh-windows-guard.js";
import {
  getAmiPlatformDetails,
  PLATFORM_DETAILS_WINDOWS,
} from "@/utils/aws-resource-discovery/ami-default-user.js";

const AMI_LINUX = "ami-0abcdef1234567890";
const AMI_WINDOWS = "ami-0d1e2f3a4b5c6d7e8";

beforeEach(() => {
  vi.mocked(getAmiPlatformDetails).mockReset();
});

describe("assertSshIntentNotWindowsAmi", () => {
  it("Linux AMI + SSH intent: no throw, lookup performed", async () => {
    vi.mocked(getAmiPlatformDetails).mockResolvedValueOnce("Linux/UNIX");
    const desiredState = { [CfnKey.IMAGE_ID]: AMI_LINUX };

    await expect(
      assertSshIntentNotWindowsAmi(desiredState, "Create an EC2 with SSH"),
    ).resolves.toBeUndefined();
    expect(getAmiPlatformDetails).toHaveBeenCalledWith(AMI_LINUX);
  });

  it("Windows AMI + SSH intent: throws AssigneeError(WINDOWS_SSH_INCOMPATIBLE) with actionable message", async () => {
    vi.mocked(getAmiPlatformDetails).mockResolvedValueOnce(
      PLATFORM_DETAILS_WINDOWS,
    );
    const desiredState = { [CfnKey.IMAGE_ID]: AMI_WINDOWS };

    await expect(
      assertSshIntentNotWindowsAmi(
        desiredState,
        "Create a Windows EC2 with SSH",
      ),
    ).rejects.toBeInstanceOf(AssigneeError);

    vi.mocked(getAmiPlatformDetails).mockResolvedValueOnce(
      PLATFORM_DETAILS_WINDOWS,
    );
    await expect(
      assertSshIntentNotWindowsAmi(
        desiredState,
        "Create a Windows EC2 with SSH",
      ),
    ).rejects.toMatchObject({
      code: WINDOWS_SSH_INCOMPATIBLE_CODE,
      message: expect.stringContaining(
        "Cannot create EC2 with SSH on a Windows AMI",
      ),
    });
  });

  it("non-SSH intent: no AMI lookup, no throw", async () => {
    const desiredState = { [CfnKey.IMAGE_ID]: AMI_WINDOWS };

    await expect(
      assertSshIntentNotWindowsAmi(
        desiredState,
        "Create a Windows EC2 for batch processing",
      ),
    ).resolves.toBeUndefined();
    expect(getAmiPlatformDetails).not.toHaveBeenCalled();
  });

  it("undefined intent: no AMI lookup, no throw", async () => {
    const desiredState = { [CfnKey.IMAGE_ID]: AMI_WINDOWS };

    await expect(
      assertSshIntentNotWindowsAmi(desiredState, undefined),
    ).resolves.toBeUndefined();
    expect(getAmiPlatformDetails).not.toHaveBeenCalled();
  });

  it("missing ImageId: no AMI lookup", async () => {
    const desiredState = {};

    await expect(
      assertSshIntentNotWindowsAmi(desiredState, "Create EC2 with SSH"),
    ).resolves.toBeUndefined();
    expect(getAmiPlatformDetails).not.toHaveBeenCalled();
  });

  it("ImageId still OS-name placeholder (not yet resolved to ami-…): no AMI lookup", async () => {
    // Defense-in-depth — we must NEVER pass an OS-name string to
    // getAmiPlatformDetails (it would call DescribeImages with garbage).
    const desiredState = { [CfnKey.IMAGE_ID]: "amazon-linux-2023" };

    await expect(
      assertSshIntentNotWindowsAmi(desiredState, "Create EC2 with SSH"),
    ).resolves.toBeUndefined();
    expect(getAmiPlatformDetails).not.toHaveBeenCalled();
  });

  it("AMI lookup returns null (transient API blip): no throw, fall through", async () => {
    vi.mocked(getAmiPlatformDetails).mockResolvedValueOnce(null);
    const desiredState = { [CfnKey.IMAGE_ID]: AMI_LINUX };

    await expect(
      assertSshIntentNotWindowsAmi(desiredState, "Create an EC2 with SSH"),
    ).resolves.toBeUndefined();
  });

  it("non-string ImageId (e.g. accidental object): no AMI lookup", async () => {
    const desiredState = { [CfnKey.IMAGE_ID]: { Ref: "MyAmi" } };

    await expect(
      assertSshIntentNotWindowsAmi(desiredState, "Create EC2 with SSH"),
    ).resolves.toBeUndefined();
    expect(getAmiPlatformDetails).not.toHaveBeenCalled();
  });
});
