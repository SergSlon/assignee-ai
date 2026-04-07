import { describe, it, expect, vi } from "vitest";
import { ConfigurationError } from "@assignee/core";

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
    const client = createCloudControlClient(VALID_CONFIG);
    expect(client).toBeDefined();
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
});
