/**
 * Tests for DriftDetectorFactory — createDriftDetectorFromEnv.
 *
 * Mocks operator credentials, CloudControl client, and adapter.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Mocks ───────────────────────────────────────────────────────────────────

vi.mock("../config/aws-credentials.js", () => ({
  tryAssigneeCredentials: vi.fn(),
}));

vi.mock("./cloudcontrol-client.js", () => ({
  createCloudControlClient: vi.fn(),
}));

vi.mock("./cloudcontrol-adapter.js", () => {
  // Class declaration so vitest mockReset cannot strip the constructor
  // body (matches setup.test.ts pattern).
  class CloudControlAdapter {
    getResource = vi.fn();
  }
  return { CloudControlAdapter };
});

vi.mock("./drift-detector.js", () => {
  class DriftDetectorService {
    detectDrift = vi.fn();
  }
  return { DriftDetectorService };
});

describe("createDriftDetectorFromEnv", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns undefined when credentials are missing (tryAssigneeCredentials returns undefined)", async () => {
    const { tryAssigneeCredentials } =
      await import("../config/aws-credentials.js");
    vi.mocked(tryAssigneeCredentials).mockReturnValue(undefined);

    const { createDriftDetectorFromEnv } =
      await import("./drift-detector-factory.js");
    const result = createDriftDetectorFromEnv();
    expect(result).toBeUndefined();
  });

  it("returns detector and port when credentials are valid", async () => {
    const { tryAssigneeCredentials } =
      await import("../config/aws-credentials.js");
    const { createCloudControlClient } =
      await import("./cloudcontrol-client.js");

    vi.mocked(tryAssigneeCredentials).mockReturnValue({
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    });

    const fakeClient = { send: vi.fn() };
    vi.mocked(createCloudControlClient).mockReturnValue(
      fakeClient as unknown as ReturnType<typeof createCloudControlClient>,
    );

    const { createDriftDetectorFromEnv } =
      await import("./drift-detector-factory.js");
    const result = createDriftDetectorFromEnv();

    // Tier C: strengthened — assert the actual shape (both detector and
    // port are present and non-null), not just defined-ness
    expect(result).toMatchObject({
      detector: expect.anything(),
      port: expect.anything(),
    });
  });

  it("returns undefined when createCloudControlClient throws", async () => {
    const { tryAssigneeCredentials } =
      await import("../config/aws-credentials.js");
    const { createCloudControlClient } =
      await import("./cloudcontrol-client.js");

    vi.mocked(tryAssigneeCredentials).mockReturnValue({
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    });

    vi.mocked(createCloudControlClient).mockImplementation(() => {
      throw new Error("ConfigurationError");
    });

    const { createDriftDetectorFromEnv } =
      await import("./drift-detector-factory.js");
    const result = createDriftDetectorFromEnv();
    expect(result).toBeUndefined();
  });
});
