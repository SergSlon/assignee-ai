import { describe, it, expect } from "vitest";
import { ExecutionStatus, PROVISIONING_ERROR_CODES } from "@/index.js";
import type { AgentState } from "../../graph-state.js";
import {
  checkUnsupportedRedirect,
  classifyUnsupported,
} from "./redirect-guard.js";

function baseState(overrides: Partial<AgentState> = {}): AgentState {
  return {
    runId: "run-redirect-guard-001",
    ...overrides,
  } as unknown as AgentState;
}

describe("classifyUnsupported", () => {
  it("returns AWS::Lambda::Permission-specific message", () => {
    const r = classifyUnsupported("AWS::Lambda::Permission");
    expect(r).not.toBeNull();
    expect(r?.redirect).toBe(true);
    expect(r?.message).toContain("AWS::Lambda::Permission");
    expect(r?.message).toContain("AWS::Lambda::PermissionPolicy");
  });

  it("returns ElastiCache ReplicationGroup-specific message", () => {
    const r = classifyUnsupported("AWS::ElastiCache::ReplicationGroup");
    expect(r).not.toBeNull();
    expect(r?.redirect).toBe(true);
    expect(r?.message).toContain("ElastiCache ReplicationGroup");
    expect(r?.message).toContain("ServerlessCache");
  });

  it("returns null for a fully-supported CCAPI type", () => {
    // S3::Bucket is the canonical first-class CCAPI type; nothing to redirect.
    expect(classifyUnsupported("AWS::S3::Bucket")).toBeNull();
  });

  it("returns null for an unknown/hallucinated type (neither supported nor redirected)", () => {
    // The caller downstream enforces `isResourceType`; here we only assert
    // the map-lookup contract returns null for anything not in the map.
    expect(classifyUnsupported("AWS::Fake::Resource")).toBeNull();
  });
});

describe("checkUnsupportedRedirect", () => {
  it("returns FAILED partial with UNSUPPORTED_TYPE code for Lambda::Permission", () => {
    const result = checkUnsupportedRedirect(
      baseState({ resourceType: "AWS::Lambda::Permission" }),
    );

    expect(result).not.toBeNull();
    expect(result?.executionStatus).toBe(ExecutionStatus.FAILED);
    expect(result?.errorMessage).toContain("PermissionPolicy");
    expect(
      (result?.error as { provisioningCode?: string })?.provisioningCode,
    ).toBe(PROVISIONING_ERROR_CODES.UNSUPPORTED_TYPE);
  });

  it("returns FAILED partial for ElastiCache::ReplicationGroup", () => {
    const result = checkUnsupportedRedirect(
      baseState({ resourceType: "AWS::ElastiCache::ReplicationGroup" }),
    );

    expect(result).not.toBeNull();
    expect(result?.executionStatus).toBe(ExecutionStatus.FAILED);
    expect(result?.errorMessage).toContain("ServerlessCache");
  });

  it("returns null for a supported CCAPI type (AWS::S3::Bucket)", () => {
    const result = checkUnsupportedRedirect(
      baseState({ resourceType: "AWS::S3::Bucket" }),
    );
    expect(result).toBeNull();
  });

  it("returns null when resourceType is undefined (later validator handles the empty case)", () => {
    const result = checkUnsupportedRedirect(
      baseState({ resourceType: undefined }),
    );
    expect(result).toBeNull();
  });
});
