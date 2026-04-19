import { describe, it, expect } from "vitest";
import {
  ExecutionStatus,
  PROVISIONING_ERROR_CODES,
  RESOURCE_TYPES,
} from "../../../index.js";
import type { AgentState } from "../../graph-state.js";
import {
  ProvisioningErrorKind,
  type ProvisioningErrorKindType,
  type ProvisioningPortError,
} from "../../../ports/provisioning-port.js";
import { handleCreateError } from "./create-error-handler.js";

function baseState(overrides: Partial<AgentState> = {}): AgentState {
  return {
    runId: "run-create-error-001",
    // Use IAM_ROLE so cleanup() is a pure no-op (no EC2 SDK path triggered)
    // — keeps this unit test free of AWS SDK mocks. NAT-Gateway cleanup is
    // covered by cleanup.test.ts.
    resourceType: RESOURCE_TYPES.IAM_ROLE,
    ...overrides,
  } as unknown as AgentState;
}

function createErr(
  kind: ProvisioningErrorKindType,
  message: string,
): ProvisioningPortError {
  return { kind, message } as ProvisioningPortError;
}

describe("handleCreateError", () => {
  it("returns FAILED partial with ALREADY_EXISTS code for a duplicate resource", async () => {
    const desiredState = { RoleName: "my-role" };
    const result = await handleCreateError({
      state: baseState(),
      createErr: createErr(
        ProvisioningErrorKind.ALREADY_EXISTS,
        "Role with name my-role already exists",
      ),
      desiredState,
      freshlyAllocatedEipIds: new Set<string>(),
      sshKeyCreatedName: undefined,
    });

    expect(result.executionStatus).toBe(ExecutionStatus.FAILED);
    expect(result.errorMessage).toContain("CloudControl provisioning failed:");
    expect(result.errorMessage).toContain("Resource already exists");
    expect(
      (result.error as { provisioningCode?: string })?.provisioningCode,
    ).toBe(PROVISIONING_ERROR_CODES.ALREADY_EXISTS);
  });

  it("uses S3-specific prefix when ALREADY_EXISTS on AWS::S3::Bucket", async () => {
    // S3 global-namespace collision is the most common user confusion — the
    // classifier surfaces a dedicated "taken globally" prefix for that case.
    const result = await handleCreateError({
      state: baseState({ resourceType: RESOURCE_TYPES.S3_BUCKET }),
      createErr: createErr(
        ProvisioningErrorKind.ALREADY_EXISTS,
        "BucketAlreadyExists",
      ),
      desiredState: { BucketName: "my-bucket" },
      freshlyAllocatedEipIds: new Set<string>(),
      sshKeyCreatedName: undefined,
    });

    expect(result.errorMessage).toContain("taken globally");
    expect(
      (result.error as { provisioningCode?: string })?.provisioningCode,
    ).toBe(PROVISIONING_ERROR_CODES.ALREADY_EXISTS);
  });

  it("returns THROTTLED code for ProvisioningErrorKind.THROTTLED", async () => {
    const result = await handleCreateError({
      state: baseState(),
      createErr: createErr(
        ProvisioningErrorKind.THROTTLED,
        "Rate exceeded on CreateResource",
      ),
      desiredState: { RoleName: "r" },
      freshlyAllocatedEipIds: new Set<string>(),
      sshKeyCreatedName: undefined,
    });

    expect(result.executionStatus).toBe(ExecutionStatus.FAILED);
    expect(result.errorMessage).toContain("throttled");
    expect(
      (result.error as { provisioningCode?: string })?.provisioningCode,
    ).toBe(PROVISIONING_ERROR_CODES.THROTTLED);
  });

  it("surfaces raw adapter message for ACCESS_DENIED (UNKNOWN dispatch bucket)", async () => {
    // ACCESS_DENIED falls through to UNKNOWN semantics: surface the adapter's
    // raw message verbatim so the user sees the actual IAM reason.
    const raw =
      "AccessDenied: User: arn:aws:iam::123456789012:user/dev is not authorized to perform iam:CreateRole";
    const result = await handleCreateError({
      state: baseState(),
      createErr: createErr(ProvisioningErrorKind.ACCESS_DENIED, raw),
      desiredState: { RoleName: "r" },
      freshlyAllocatedEipIds: new Set<string>(),
      sshKeyCreatedName: undefined,
    });

    expect(result.executionStatus).toBe(ExecutionStatus.FAILED);
    expect(result.errorMessage).toContain(raw);
    expect(
      (result.error as { provisioningCode?: string })?.provisioningCode,
    ).toBe(PROVISIONING_ERROR_CODES.UNKNOWN);
  });

  it("ALWAYS surfaces desiredState back to the reducer on failure (invariant H9)", async () => {
    // Retry paths reuse allocated side-resources (EIPs, SSH keys) from the
    // prior desiredState. If we drop desiredState on failure, the retry
    // re-allocates and leaks. H9 locks this in.
    const desiredState = {
      RoleName: "my-role",
      // simulate a side-resource id embedded in desiredState that a retry
      // would reuse (not literal in IAM role, but representative of the
      // general contract):
      AssumeRolePolicyDocument: "{}",
    };
    const result = await handleCreateError({
      state: baseState(),
      createErr: createErr(
        ProvisioningErrorKind.SERVICE_ERROR,
        "InternalServerError",
      ),
      desiredState,
      freshlyAllocatedEipIds: new Set<string>(),
      sshKeyCreatedName: undefined,
    });

    expect(result.desiredState).toEqual(desiredState);
  });
});
