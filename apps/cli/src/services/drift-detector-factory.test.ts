/**
 * Tests for DriftDetectorFactory — createDriftDetectorFromEnv.
 *
 * Mocks operator credentials, CloudControl client, and adapter.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Mocks ───────────────────────────────────────────────────────────────────

vi.mock("../config/operator-credentials.js", () => ({
  operatorCredentials: vi.fn(),
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

  it("returns undefined when accessKeyId is empty", async () => {
    const { operatorCredentials } =
      await import("../config/operator-credentials.js");
    vi.mocked(operatorCredentials).mockReturnValue({
      accessKeyId: "",
      secretAccessKey: "secret",
      region: "us-east-1",
    });

    const { createDriftDetectorFromEnv } =
      await import("./drift-detector-factory.js");
    const result = createDriftDetectorFromEnv();
    expect(result).toBeUndefined();
  });

  it("returns undefined when secretAccessKey is empty", async () => {
    const { operatorCredentials } =
      await import("../config/operator-credentials.js");
    vi.mocked(operatorCredentials).mockReturnValue({
      accessKeyId: "AKID",
      secretAccessKey: "",
      region: "us-east-1",
    });

    const { createDriftDetectorFromEnv } =
      await import("./drift-detector-factory.js");
    const result = createDriftDetectorFromEnv();
    expect(result).toBeUndefined();
  });

  it("returns undefined when both credentials are empty", async () => {
    const { operatorCredentials } =
      await import("../config/operator-credentials.js");
    vi.mocked(operatorCredentials).mockReturnValue({
      accessKeyId: "",
      secretAccessKey: "",
      region: "us-east-1",
    });

    const { createDriftDetectorFromEnv } =
      await import("./drift-detector-factory.js");
    const result = createDriftDetectorFromEnv();
    expect(result).toBeUndefined();
  });

  it("returns detector and port when credentials are valid", async () => {
    const { operatorCredentials } =
      await import("../config/operator-credentials.js");
    const { createCloudControlClient } =
      await import("./cloudcontrol-client.js");

    vi.mocked(operatorCredentials).mockReturnValue({
      accessKeyId: "AKID123",
      secretAccessKey: "SECRET456",
      region: "us-east-1",
    });

    const fakeClient = { send: vi.fn() };
    vi.mocked(createCloudControlClient).mockReturnValue(fakeClient as any);

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
    const { operatorCredentials } =
      await import("../config/operator-credentials.js");
    const { createCloudControlClient } =
      await import("./cloudcontrol-client.js");

    vi.mocked(operatorCredentials).mockReturnValue({
      accessKeyId: "AKID123",
      secretAccessKey: "SECRET456",
      region: "us-east-1",
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
