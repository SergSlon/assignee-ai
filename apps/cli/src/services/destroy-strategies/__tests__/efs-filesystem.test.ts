/**
 * Tests for efs-filesystem destroy strategy — mount-target delete +
 * propagation poll.
 *
 * @see Wave-6 F1b
 */
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";

const hoisted = vi.hoisted(() => ({ mockEfsSend: vi.fn() }));
vi.mock("@aws-sdk/client-efs", () => {
  class EFSClient {
    send = hoisted.mockEfsSend;
    destroy = vi.fn();
  }
  function DescribeMountTargetsCommand(i: Record<string, unknown>) {
    return { _type: "DescribeMountTargets", ...i };
  }
  function DeleteMountTargetCommand(i: Record<string, unknown>) {
    return { _type: "DeleteMountTarget", ...i };
  }
  return {
    EFSClient,
    DescribeMountTargetsCommand,
    DeleteMountTargetCommand,
  };
});

import { efsFileSystemStrategy } from "@assignee/core";
import type { DestroyContext } from "@assignee/core";

const originalSetTimeout = globalThis.setTimeout;
beforeEach(() => {
  vi.clearAllMocks();
  // @ts-expect-error simplified stub
  globalThis.setTimeout = (fn: () => void) => originalSetTimeout(fn, 0);
  process.env["ASSIGNEE_OPERATOR_ACCESS_KEY_ID"] = "AKIAIOSFODNN7EXAMPLE";
  process.env["ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY"] =
    "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
});
afterAll(() => {
  globalThis.setTimeout = originalSetTimeout;
});

function makeCtx(): DestroyContext {
  return {
    resource: {
      arn: "arn:aws:elasticfilesystem:us-east-1:123456789012:file-system/fs-abc",
      resourceType: "AWS::EFS::FileSystem",
      identifier: "fs-abc",
      region: "us-east-1",
    },
    awsConfig: {
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      region: "us-east-1",
    },
    effectiveRegion: "us-east-1",
    warn: () => {},
  };
}

describe("efsFileSystemStrategy", () => {
  it("deletes every mount target and polls until none remain", async () => {
    let describeCount = 0;
    hoisted.mockEfsSend.mockImplementation((cmd: { _type: string }) => {
      if (cmd._type === "DescribeMountTargets") {
        describeCount++;
        // First call returns 2 MTs; subsequent poll calls return none.
        if (describeCount === 1) {
          return {
            MountTargets: [
              { MountTargetId: "fsmt-1" },
              { MountTargetId: "fsmt-2" },
            ],
          };
        }
        return { MountTargets: [] };
      }
      if (cmd._type === "DeleteMountTarget") return {};
      return {};
    });

    const outcome = await efsFileSystemStrategy.preDestroy!(makeCtx());
    expect(outcome).toBeUndefined();
    const delCalls = hoisted.mockEfsSend.mock.calls.filter(
      (c) => c[0]._type === "DeleteMountTarget",
    );
    expect(delCalls).toHaveLength(2);
    expect(delCalls.map((c) => c[0].MountTargetId).sort()).toEqual([
      "fsmt-1",
      "fsmt-2",
    ]);
  });

  it("no-ops when file system has no mount targets", async () => {
    hoisted.mockEfsSend.mockImplementation((cmd: { _type: string }) => {
      if (cmd._type === "DescribeMountTargets") return { MountTargets: [] };
      return {};
    });

    const outcome = await efsFileSystemStrategy.preDestroy!(makeCtx());
    expect(outcome).toBeUndefined();
    const delCalls = hoisted.mockEfsSend.mock.calls.filter(
      (c) => c[0]._type === "DeleteMountTarget",
    );
    expect(delCalls).toHaveLength(0);
  });
});
