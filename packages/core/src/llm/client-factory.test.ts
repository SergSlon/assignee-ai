/**
 * Regression tests for client-factory.ts session-token passthrough.
 *
 * Bug history: createAmazonBedrock was called with accessKeyId +
 * secretAccessKey but NOT sessionToken. With STS / SSO / federated
 * temp credentials (ASIA-prefix), AWS rejects every Bedrock request as
 * "security token included in the request is invalid" — the long-lived
 * IAM-user (AKIA-prefix) path worked, masking the regression.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ConfigPort } from "../config/config-port.js";
import { LlmProvider } from "../constants/llm-providers.js";
import { EnvVar } from "../constants/env-vars.js";
import { createLanguageModel } from "./client-factory.js";

interface BedrockOpts {
  region?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
}
const mockCreateAmazonBedrock = vi.fn((_opts: BedrockOpts) => () => ({}));
vi.mock("@ai-sdk/amazon-bedrock", () => ({
  createAmazonBedrock: (opts: BedrockOpts) => mockCreateAmazonBedrock(opts),
}));

function fakeConfig(map: Partial<Record<string, string>>): ConfigPort {
  return {
    get: (k: string, dv?: string) => map[k] ?? dv,
    getRequired: (k: string) => {
      const v = map[k];
      if (v === undefined) throw new Error(`missing ${k}`);
      return v;
    },
    getInt: (k: string, dv?: number) => {
      const v = map[k];
      if (v === undefined) return dv;
      const n = parseInt(v, 10);
      return Number.isFinite(n) ? n : dv;
    },
    getBool: (k: string, dv?: boolean) => {
      const v = map[k];
      if (v === undefined) return dv;
      return ["1", "true", "yes", "on"].includes(v.toLowerCase());
    },
  };
}

describe("createLanguageModel — Bedrock session-token passthrough", () => {
  beforeEach(() => mockCreateAmazonBedrock.mockClear());

  it("passes sessionToken when ASSIGNEE_OPERATOR_SESSION_TOKEN is set", async () => {
    await createLanguageModel(
      { provider: LlmProvider.BEDROCK, modelId: "amazon.nova-lite-v1:0" },
      fakeConfig({
        [EnvVar.OPERATOR_ACCESS_KEY]: "ASIAEXAMPLEKEY",
        [EnvVar.OPERATOR_SECRET_KEY]: "examplesecret",
        [EnvVar.OPERATOR_SESSION_TOKEN]: "examplesessiontoken",
      }),
    );
    expect(mockCreateAmazonBedrock).toHaveBeenCalledTimes(1);
    const opts = mockCreateAmazonBedrock.mock.calls[0]![0] as BedrockOpts;
    expect(opts.accessKeyId).toBe("ASIAEXAMPLEKEY");
    expect(opts.secretAccessKey).toBe("examplesecret");
    expect(opts.sessionToken).toBe("examplesessiontoken");
  });

  it("omits sessionToken when ASSIGNEE_OPERATOR_SESSION_TOKEN is not set (long-lived AKIA path)", async () => {
    await createLanguageModel(
      { provider: LlmProvider.BEDROCK, modelId: "amazon.nova-lite-v1:0" },
      fakeConfig({
        [EnvVar.OPERATOR_ACCESS_KEY]: "AKIAEXAMPLEKEY",
        [EnvVar.OPERATOR_SECRET_KEY]: "examplesecret",
      }),
    );
    expect(mockCreateAmazonBedrock).toHaveBeenCalledTimes(1);
    const opts = mockCreateAmazonBedrock.mock.calls[0]![0] as BedrockOpts;
    expect(opts.accessKeyId).toBe("AKIAEXAMPLEKEY");
    expect("sessionToken" in opts).toBe(false);
  });
});
