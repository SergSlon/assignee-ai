/**
 * Tests for `buildOperatorClientConfig`.
 *
 * Coverage:
 *   - Returns config with credentials when tryAssigneeCredentials returns non-null.
 *   - Returns config without credentials (just region) when tryAssigneeCredentials returns null.
 *   - Falls back to AWS_REGION when resolved.region is undefined.
 *   - Falls back to AWS_REGION when resolved.region is empty string.
 *   - Uses resolved.region when it is provided.
 *   - Includes sessionToken when credentials have one.
 *   - Omits sessionToken when credentials do not have one.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  buildOperatorClientConfig,
  type OperatorClientConfig,
} from "../operator-client-config.js";

// We mock at the leaf module level to avoid barrel-cycle issues.
vi.mock("../../../config/aws-credentials.js", () => ({
  tryAssigneeCredentials: vi.fn(),
}));
vi.mock("../../../config/constants.js", () => ({
  AWS_REGION: "us-east-1",
}));

import { tryAssigneeCredentials } from "../../../config/aws-credentials.js";

const mockTryAssigneeCredentials = vi.mocked(tryAssigneeCredentials);

/** Type-narrowing helper: asserts the config has credentials. */
function hasCredentials(config: OperatorClientConfig): config is {
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
} {
  return typeof config.accessKeyId === "string";
}

describe("buildOperatorClientConfig", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns config with credentials when tryAssigneeCredentials returns non-null", () => {
    mockTryAssigneeCredentials.mockReturnValue({
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      sessionToken: "AQoDYXdzEJr//fake-session-token==",
    });

    const config = buildOperatorClientConfig({ region: "eu-west-1" });

    expect(config.region).toBe("eu-west-1");
    expect(hasCredentials(config)).toBe(true);
    if (hasCredentials(config)) {
      expect(config.accessKeyId).toBe("AKIAIOSFODNN7EXAMPLE");
      expect(config.secretAccessKey).toBe(
        "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      );
      expect(config.sessionToken).toBe("AQoDYXdzEJr//fake-session-token==");
    }
  });

  it("returns config without credentials when tryAssigneeCredentials returns undefined", () => {
    mockTryAssigneeCredentials.mockReturnValue(undefined);

    const config = buildOperatorClientConfig({ region: "eu-west-1" });

    expect(config.region).toBe("eu-west-1");
    expect(hasCredentials(config)).toBe(false);
    expect(config.accessKeyId).toBeUndefined();
    expect(config.secretAccessKey).toBeUndefined();
    expect(config.sessionToken).toBeUndefined();
  });

  it("falls back to AWS_REGION when resolved.region is undefined", () => {
    mockTryAssigneeCredentials.mockReturnValue(undefined);

    const config = buildOperatorClientConfig({ region: undefined });

    expect(config.region).toBe("us-east-1");
  });

  it("falls back to AWS_REGION when resolved.region is empty string", () => {
    mockTryAssigneeCredentials.mockReturnValue(undefined);

    const config = buildOperatorClientConfig({ region: "" });

    expect(config.region).toBe("us-east-1");
  });

  it("uses resolved.region over AWS_REGION when provided", () => {
    mockTryAssigneeCredentials.mockReturnValue(undefined);

    const config = buildOperatorClientConfig({ region: "ap-southeast-1" });

    expect(config.region).toBe("ap-southeast-1");
  });

  it("includes sessionToken when credentials have one", () => {
    mockTryAssigneeCredentials.mockReturnValue({
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      sessionToken: "session-token-value",
    });

    const config = buildOperatorClientConfig({ region: "us-west-2" });

    expect(hasCredentials(config)).toBe(true);
    if (hasCredentials(config)) {
      expect(config.sessionToken).toBe("session-token-value");
    }
  });

  it("omits sessionToken when credentials do not have one", () => {
    mockTryAssigneeCredentials.mockReturnValue({
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    });

    const config = buildOperatorClientConfig({ region: "us-west-2" });

    expect(hasCredentials(config)).toBe(true);
    if (hasCredentials(config)) {
      expect(config.sessionToken).toBeUndefined();
    }
  });
});
