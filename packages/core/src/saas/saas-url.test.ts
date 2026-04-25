/**
 * Region-derivation matrix tests for W5-01 (P007-tech → L1-F05 + L1-F20).
 *
 * Verifies that SAAS_API_URL and BEDROCK_MODEL_ID are derived correctly
 * from the operator's AWS_REGION for 7 canonical regions.
 *
 * Note: `config/constants/saas.ts` computes these at module-load time via
 * top-level calls. To test different region values we re-import the
 * derivation helpers in isolation by resetting vi.resetModules() between
 * cases and re-importing the module.
 */
import { describe, it, expect, afterEach, vi } from "vitest";

/** Re-import saas.ts with a given AWS_REGION set, returning the exports. */
async function importSaasWithRegion(
  region: string | undefined,
  overrideUrl?: string,
): Promise<{ SAAS_API_URL: string; BEDROCK_MODEL_ID: string }> {
  vi.resetModules();

  // Set env before dynamic import so module-level constants pick it up.
  if (region !== undefined) {
    process.env["AWS_REGION"] = region;
  } else {
    delete process.env["AWS_REGION"];
  }
  if (overrideUrl !== undefined) {
    process.env["ASSIGNEE_SAAS_URL"] = overrideUrl;
  } else {
    delete process.env["ASSIGNEE_SAAS_URL"];
  }
  delete process.env["BEDROCK_MODEL_ID"];

  const mod = (await import("../config/constants/saas.js")) as {
    SAAS_API_URL: string;
    BEDROCK_MODEL_ID: string;
  };
  return {
    SAAS_API_URL: mod.SAAS_API_URL,
    BEDROCK_MODEL_ID: mod.BEDROCK_MODEL_ID,
  };
}

describe("W5-01 region-derivation matrix", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    // Restore env to prevent leaking between tests.
    Object.keys(process.env).forEach((k) => {
      if (!(k in originalEnv)) delete process.env[k];
    });
    Object.assign(process.env, originalEnv);
    vi.resetModules();
  });

  const regionCases: Array<{
    region: string;
    expectedSaasUrl: string;
    expectedBedrockPrefix: string;
  }> = [
    {
      region: "eu-central-1",
      expectedSaasUrl: "https://eu-central-1.api.assignee.ai",
      expectedBedrockPrefix: "eu.",
    },
    {
      region: "eu-west-1",
      expectedSaasUrl: "https://eu-west-1.api.assignee.ai",
      expectedBedrockPrefix: "eu.",
    },
    {
      region: "eu-west-2",
      expectedSaasUrl: "https://eu-west-2.api.assignee.ai",
      expectedBedrockPrefix: "eu.",
    },
    {
      region: "eu-north-1",
      expectedSaasUrl: "https://eu-north-1.api.assignee.ai",
      expectedBedrockPrefix: "eu.",
    },
    {
      region: "us-east-1",
      expectedSaasUrl: "https://us-east-1.api.assignee.ai",
      expectedBedrockPrefix: "us.",
    },
    {
      region: "us-west-2",
      expectedSaasUrl: "https://us-west-2.api.assignee.ai",
      expectedBedrockPrefix: "us.",
    },
    {
      region: "ap-south-1",
      expectedSaasUrl: "https://ap-south-1.api.assignee.ai",
      expectedBedrockPrefix: "ap.",
    },
  ];

  for (const {
    region,
    expectedSaasUrl,
    expectedBedrockPrefix,
  } of regionCases) {
    it(`${region} → SaaS URL ${expectedSaasUrl}, Bedrock prefix "${expectedBedrockPrefix}"`, async () => {
      const { SAAS_API_URL, BEDROCK_MODEL_ID } =
        await importSaasWithRegion(region);
      expect(SAAS_API_URL).toBe(expectedSaasUrl);
      expect(BEDROCK_MODEL_ID).toMatch(new RegExp(`^${expectedBedrockPrefix}`));
    });
  }

  it("no AWS_REGION → legacy fallback https://app.assignee.ai", async () => {
    const { SAAS_API_URL } = await importSaasWithRegion(undefined);
    expect(SAAS_API_URL).toBe("https://app.assignee.ai");
  });

  it("ASSIGNEE_SAAS_URL override takes precedence over region derivation", async () => {
    const { SAAS_API_URL } = await importSaasWithRegion(
      "eu-central-1",
      "https://custom.example.com",
    );
    expect(SAAS_API_URL).toBe("https://custom.example.com");
  });

  it("ASSIGNEE_SAAS_URL=http://example.com is rejected (W5-03 integration)", async () => {
    await expect(
      importSaasWithRegion("us-east-1", "http://example.com"),
    ).rejects.toThrow(/ASSIGNEE_SAAS_URL/);
  });
});
