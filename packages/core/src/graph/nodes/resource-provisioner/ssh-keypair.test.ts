import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  CfnKey,
  ExecutionStatus,
  RESOURCE_TYPES,
  ResourceDefault,
} from "@/index.js";
import type { AgentState } from "../../graph-state.js";
import { ensureSshKeypair } from "./ssh-keypair.js";

const { mockEc2Send } = vi.hoisted(() => ({ mockEc2Send: vi.fn() }));

vi.mock("@aws-sdk/client-ec2", () => {
  class EC2Client {
    send = mockEc2Send;
    destroy = vi.fn();
  }
  function DescribeKeyPairsCommand(input: unknown) {
    return { _type: "DescribeKeyPairsCommand", input };
  }
  function CreateKeyPairCommand(input: unknown) {
    return { _type: "CreateKeyPairCommand", input };
  }
  return { EC2Client, DescribeKeyPairsCommand, CreateKeyPairCommand };
});

const { mockMkdirSync, mockWriteFileSync, mockChmodSync } = vi.hoisted(() => ({
  mockMkdirSync: vi.fn(),
  mockWriteFileSync: vi.fn(),
  mockChmodSync: vi.fn(),
}));

vi.mock("node:fs", () => ({
  mkdirSync: mockMkdirSync,
  writeFileSync: mockWriteFileSync,
  chmodSync: mockChmodSync,
}));

vi.mock("node:os", () => ({ homedir: () => "/home/testuser" }));

vi.mock("../../../config/aws-credentials.js", () => ({
  requireAssigneeCredentials: () => ({
    accessKeyId: "AKIATEST",
    secretAccessKey: "secret",
  }),
}));

function baseState(overrides: Partial<AgentState> = {}): AgentState {
  return {
    runId: "run-ssh-001",
    resourceType: RESOURCE_TYPES.EC2_INSTANCE,
    ...overrides,
  } as unknown as AgentState;
}

describe("ensureSshKeypair", () => {
  beforeEach(() => {
    mockEc2Send.mockReset();
    mockMkdirSync.mockReset();
    mockWriteFileSync.mockReset();
    mockChmodSync.mockReset();
  });

  it("no-ops for non-EC2::Instance resources", async () => {
    const r = await ensureSshKeypair(
      baseState({ resourceType: RESOURCE_TYPES.S3_BUCKET }),
      {},
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.sshKeyCreatedName).toBeUndefined();
    expect(mockEc2Send).not.toHaveBeenCalled();
  });

  it("no-ops when KeyName is a user-supplied value (not placeholder)", async () => {
    const r = await ensureSshKeypair(baseState(), {
      [CfnKey.KEY_NAME]: "user-key",
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.sshKeyCreatedName).toBeUndefined();
    expect(mockEc2Send).not.toHaveBeenCalled();
  });

  it("skips creation when key already exists in AWS", async () => {
    mockEc2Send.mockResolvedValueOnce({ KeyPairs: [{ KeyName: "k" }] });
    const desired: Record<string, unknown> = {
      [CfnKey.KEY_NAME]: ResourceDefault.SSH_KEY_PLACEHOLDER,
    };
    const r = await ensureSshKeypair(baseState(), desired);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.sshKeyCreatedName).toBeUndefined();
    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });

  it("creates keypair and persists PEM when not-found", async () => {
    const nf = new Error("not found");
    (nf as { name?: string }).name = "InvalidKeyPair.NotFound";
    mockEc2Send
      .mockRejectedValueOnce(nf)
      .mockResolvedValueOnce({ KeyMaterial: "-----BEGIN RSA-----\n..." });
    const desired: Record<string, unknown> = {
      [CfnKey.KEY_NAME]: ResourceDefault.SSH_KEY_PLACEHOLDER,
    };
    const r = await ensureSshKeypair(baseState(), desired);
    expect(r.ok).toBe(true);
    if (r.ok)
      expect(r.sshKeyCreatedName).toBe(ResourceDefault.SSH_KEY_PLACEHOLDER);
    expect(mockMkdirSync).toHaveBeenCalled();
    expect(mockWriteFileSync).toHaveBeenCalled();
    const writeCall = mockWriteFileSync.mock.calls[0];
    expect(writeCall![1]).toContain("BEGIN RSA");
    expect(writeCall![2]).toEqual({ mode: 0o400 });
  });

  it("FAILS on transient DescribeKeyPairs error (C2: no silent KeyName strip)", async () => {
    const rateErr = new Error("Rate exceeded");
    (rateErr as { name?: string }).name = "ThrottlingException";
    mockEc2Send.mockRejectedValueOnce(rateErr);
    const desired: Record<string, unknown> = {
      [CfnKey.KEY_NAME]: ResourceDefault.SSH_KEY_PLACEHOLDER,
    };
    const r = await ensureSshKeypair(baseState(), desired);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.partial.executionStatus).toBe(ExecutionStatus.FAILED);
      expect(r.partial.errorMessage).toContain(
        "SSH key pair verification failed",
      );
    }
    // KeyName MUST still be present in desiredState — we never stripped it.
    expect(desired[CfnKey.KEY_NAME]).toBe(ResourceDefault.SSH_KEY_PLACEHOLDER);
  });

  it("strips KeyName on CreateKeyPair failure (post-DescribeKeyPairs-not-found)", async () => {
    const nf = new Error("not found");
    (nf as { name?: string }).name = "InvalidKeyPair.NotFound";
    mockEc2Send
      .mockRejectedValueOnce(nf)
      .mockRejectedValueOnce(new Error("AccessDenied"));
    const desired: Record<string, unknown> = {
      [CfnKey.KEY_NAME]: ResourceDefault.SSH_KEY_PLACEHOLDER,
    };
    const r = await ensureSshKeypair(baseState(), desired);
    expect(r.ok).toBe(true);
    expect(desired[CfnKey.KEY_NAME]).toBeUndefined();
  });

  it("throws on empty KeyMaterial and reports SSH key creation failed", async () => {
    const nf = new Error("not found");
    (nf as { name?: string }).name = "InvalidKeyPair.NotFound";
    mockEc2Send
      .mockRejectedValueOnce(nf)
      .mockResolvedValueOnce({ KeyMaterial: undefined });
    const desired: Record<string, unknown> = {
      [CfnKey.KEY_NAME]: ResourceDefault.SSH_KEY_PLACEHOLDER,
    };
    const r = await ensureSshKeypair(baseState(), desired);
    // Create succeeded (in the sense DescribeKeyPairs said not-found and CreateKeyPair was attempted)
    // but KeyMaterial was empty → treated as create failure → KeyName stripped.
    expect(r.ok).toBe(true);
    expect(desired[CfnKey.KEY_NAME]).toBeUndefined();
  });
});
