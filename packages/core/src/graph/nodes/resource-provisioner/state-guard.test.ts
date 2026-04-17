import { describe, it, expect, vi } from "vitest";
import {
  ExecutionStatus,
  PROVISIONING_ERROR_CODES,
  RESOURCE_TYPES,
} from "../../../index.js";
import type { AgentState } from "../../graph-state.js";
import {
  ProvisioningErrorKind,
  type ProvisioningPort,
} from "../../../ports/provisioning-port.js";
import { runStateGuard } from "./state-guard.js";

function mockProvisioner(): ProvisioningPort & {
  getResource: ReturnType<typeof vi.fn>;
} {
  return {
    getResource: vi.fn(),
    createResource: vi.fn(),
    deleteResource: vi.fn(),
    updateResource: vi.fn(),
    getRequestStatus: vi.fn(),
  } as unknown as ProvisioningPort & {
    getResource: ReturnType<typeof vi.fn>;
  };
}

function baseState(overrides: Partial<AgentState> = {}): AgentState {
  return { runId: "run-sg-001", ...overrides } as unknown as AgentState;
}

describe("runStateGuard", () => {
  it("ABORTS when the resource already exists", async () => {
    const p = mockProvisioner();
    p.getResource.mockResolvedValue([null, { exists: true }]);
    const r = await runStateGuard(baseState(), p, RESOURCE_TYPES.IAM_ROLE, {
      RoleName: "my-role",
    });
    expect(r.abort).toBe(true);
    if (r.abort) {
      expect(r.partial.executionStatus).toBe(ExecutionStatus.FAILED);
      expect(
        (r.partial.error as { provisioningCode?: string })?.provisioningCode,
      ).toBe(PROVISIONING_ERROR_CODES.STATE_MISMATCH);
      expect(r.partial.errorMessage).toContain("already exists");
    }
  });

  it("SKIPS the guard entirely for S3::Bucket (global uniqueness)", async () => {
    const p = mockProvisioner();
    const r = await runStateGuard(baseState(), p, RESOURCE_TYPES.S3_BUCKET, {
      BucketName: "my-bucket",
    });
    expect(r.abort).toBe(false);
    expect(p.getResource).not.toHaveBeenCalled();
  });

  it("proceeds when getResource returns NOT_FOUND", async () => {
    const p = mockProvisioner();
    p.getResource.mockResolvedValue([
      { kind: ProvisioningErrorKind.NOT_FOUND, message: "Not found" },
      null,
    ]);
    const r = await runStateGuard(baseState(), p, RESOURCE_TYPES.IAM_ROLE, {
      RoleName: "my-role",
    });
    expect(r.abort).toBe(false);
  });

  it("proceeds (does NOT block) when getResource returns ACCESS_DENIED", async () => {
    const p = mockProvisioner();
    p.getResource.mockResolvedValue([
      { kind: ProvisioningErrorKind.ACCESS_DENIED, message: "denied" },
      null,
    ]);
    const r = await runStateGuard(baseState(), p, RESOURCE_TYPES.IAM_ROLE, {
      RoleName: "my-role",
    });
    expect(r.abort).toBe(false);
  });

  it("proceeds when primary identifier is unresolved (compound)", async () => {
    const p = mockProvisioner();
    const r = await runStateGuard(
      baseState(),
      p,
      RESOURCE_TYPES.EC2_ROUTE,
      {} /* no RouteTableId/CIDR so identifier unresolved */,
    );
    expect(r.abort).toBe(false);
    expect(p.getResource).not.toHaveBeenCalled();
  });
});
