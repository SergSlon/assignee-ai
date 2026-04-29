import { describe, it, expect, vi, afterEach } from "vitest";
import { ConfigurationError } from "../errors.js";

vi.mock("@aws-sdk/client-cloudcontrol", () => {
  // Use class declaration so vitest mockReset cannot strip the
  // constructor body (matches setup.test.ts pattern).
  class CloudControlClient {}
  return { CloudControlClient };
});

import { createCloudControlClient } from "./cloudcontrol-client.js";

const VALID_CONFIG = {
  accessKeyId: "AKIAIOSFODNN7EXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  region: "us-east-1",
};

describe("createCloudControlClient", () => {
  it("returns a CloudControlClient when config is valid", () => {
    // Tier C: strengthened — assert it's a real object, not just defined.
    // The shape varies by SDK version so we don't assert specific methods.
    const client = createCloudControlClient(VALID_CONFIG);
    expect(client).toBeInstanceOf(Object);
    expect(client).not.toBeNull();
  });

  it("throws ConfigurationError when accessKeyId is empty", () => {
    expect(() =>
      createCloudControlClient({ ...VALID_CONFIG, accessKeyId: "" }),
    ).toThrow(ConfigurationError);

    expect(() =>
      createCloudControlClient({ ...VALID_CONFIG, accessKeyId: "" }),
    ).toThrow("ASSIGNEE_OPERATOR_ACCESS_KEY_ID is missing or empty");
  });

  it("throws ConfigurationError when secretAccessKey is empty", () => {
    expect(() =>
      createCloudControlClient({ ...VALID_CONFIG, secretAccessKey: "" }),
    ).toThrow(ConfigurationError);

    expect(() =>
      createCloudControlClient({ ...VALID_CONFIG, secretAccessKey: "" }),
    ).toThrow("ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY is missing or empty");
  });

  it("throws ConfigurationError when region is empty", () => {
    expect(() =>
      createCloudControlClient({ ...VALID_CONFIG, region: "" }),
    ).toThrow(ConfigurationError);

    expect(() =>
      createCloudControlClient({ ...VALID_CONFIG, region: "" }),
    ).toThrow("AWS_REGION is missing or empty");
  });

  it("ConfigurationError has code CONFIGURATION_ERROR", () => {
    try {
      createCloudControlClient({ ...VALID_CONFIG, accessKeyId: "" });
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigurationError);
      expect((err as ConfigurationError).code).toBe("CONFIGURATION_ERROR");
    }
  });

  describe("NoCredentialsConfig path (accessKeyId === undefined)", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let stderrSpy: ReturnType<typeof vi.fn> & { mockRestore: () => void };

    afterEach(() => {
      stderrSpy?.mockRestore();
    });

    it("returns a CloudControlClient without throwing when credentials are absent", () => {
      stderrSpy = vi
        .spyOn(process.stderr, "write")
        .mockImplementation(() => true) as unknown as ReturnType<
        typeof vi.fn
      > & { mockRestore: () => void };
      // R10a-03 lenient-at-construction: must not throw
      expect(() =>
        createCloudControlClient({ region: "us-east-1" }),
      ).not.toThrow();

      const client = createCloudControlClient({ region: "us-east-1" });
      expect(client).toBeInstanceOf(Object);
      expect(client).not.toBeNull();
    });

    it("emits the missing-cred warning to stderr when credentials are absent", () => {
      stderrSpy = vi
        .spyOn(process.stderr, "write")
        .mockImplementation(() => true) as unknown as ReturnType<
        typeof vi.fn
      > & { mockRestore: () => void };
      createCloudControlClient({ region: "us-east-1" });

      const calls = stderrSpy.mock.calls.map((args) => String(args[0]));
      expect(
        calls.some((msg) =>
          msg.includes(
            "assignee: operator credentials not found — downstream AWS calls will fail with auth errors",
          ),
        ),
      ).toBe(true);
    });

    it("does NOT emit a warning when valid credentials are provided", () => {
      stderrSpy = vi
        .spyOn(process.stderr, "write")
        .mockImplementation(() => true) as unknown as ReturnType<
        typeof vi.fn
      > & { mockRestore: () => void };
      createCloudControlClient(VALID_CONFIG);

      const calls = stderrSpy.mock.calls.map((args) => String(args[0]));
      expect(
        calls.some((msg) => msg.includes("operator credentials not found")),
      ).toBe(false);
    });

    it("throws ConfigurationError when region is empty in no-cred path", () => {
      stderrSpy = vi
        .spyOn(process.stderr, "write")
        .mockImplementation(() => true) as unknown as ReturnType<
        typeof vi.fn
      > & { mockRestore: () => void };
      expect(() => createCloudControlClient({ region: "" })).toThrow(
        ConfigurationError,
      );
      expect(() => createCloudControlClient({ region: "" })).toThrow(
        "AWS_REGION is missing or empty",
      );
    });
  });
});
