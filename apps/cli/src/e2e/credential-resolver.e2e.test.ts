/**
 * E2E test: credential resolver — end-to-end verification.
 *
 * GATED BY: RUN_E2E=1 environment variable.
 *
 * These tests make REAL AWS API calls (STS GetCallerIdentity) to verify that
 * the credential resolver correctly picks up different authentication sources
 * and that the resolved credentials can authenticate to AWS.
 *
 * PRE-REQUISITES for running:
 *
 *   Row 1 (env-var-only):
 *     ASSIGNEE_OPERATOR_ACCESS_KEY_ID and ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY
 *     must be set to valid AKIA* long-term credentials.
 *
 *   Row 2 (session token):
 *     ASSIGNEE_OPERATOR_ACCESS_KEY_ID + ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY +
 *     ASSIGNEE_OPERATOR_SESSION_TOKEN must all be set (STS AssumeRole or SSO
 *     credentials).
 *
 *   Row 3 (AWS_PROFILE):
 *     AWS_PROFILE must name a valid profile in ~/.aws/config.
 *     If the profile is SSO, run `aws sso login --profile <name>` first.
 *
 *   Row 4 (--profile flag):
 *     E2E_PROFILE_NAME env var must be set to the profile name to test.
 *
 * RUNNING:
 *   RUN_E2E=1 pnpm test -- credential-resolver.e2e
 *
 * REGION:
 *   Tests use AWS_REGION (default: us-east-1). STS is global but the
 *   credential chain honors AWS_REGION for the endpoint.
 */

import { describe, it, expect, beforeAll } from "vitest";

const RUN_E2E = process.env["RUN_E2E"] === "1";

describe.skipIf(!RUN_E2E)(
  "E2E: credential resolver — real AWS verification (RUN_E2E=1)",
  () => {
    beforeAll(() => {
      if (!RUN_E2E) {
        console.log(
          "[SKIP] Set RUN_E2E=1 to run real-AWS credential resolver tests.",
        );
      }
    });

    // ── Row 1: env-var-only (AKIA long-term credentials) ─────────────────────

    it("row-1: AKIA env-var-only — STS GetCallerIdentity succeeds (no session token)", async () => {
      const { STSClient, GetCallerIdentityCommand } =
        await import("@aws-sdk/client-sts");
      const { requireAssigneeCredentials } = await import("@assignee/core");

      const creds = requireAssigneeCredentials("operator");
      expect(creds.sessionToken).toBeUndefined();

      const sts = new STSClient({
        region: process.env["AWS_REGION"] ?? "us-east-1",
        credentials: {
          accessKeyId: creds.accessKeyId,
          secretAccessKey: creds.secretAccessKey,
        },
      });

      const identity = await sts.send(new GetCallerIdentityCommand({}));
      expect(identity.Account).toMatch(/^\d{12}$/);
      console.log(`[row-1] Authenticated as: ${identity.Arn}`);
      sts.destroy();
    }, 30_000);

    // ── Row 2: ASIA credentials + session token ───────────────────────────────

    it.skipIf(!process.env["ASSIGNEE_OPERATOR_SESSION_TOKEN"])(
      "row-2: ASIA env-var + session token — STS GetCallerIdentity succeeds",
      async () => {
        const { STSClient, GetCallerIdentityCommand } =
          await import("@aws-sdk/client-sts");
        const { requireAssigneeCredentials } = await import("@assignee/core");

        const creds = requireAssigneeCredentials("operator");
        expect(creds.sessionToken).toBeDefined();
        expect(creds.accessKeyId).toMatch(/^ASIA/);

        const sts = new STSClient({
          region: process.env["AWS_REGION"] ?? "us-east-1",
          credentials: {
            accessKeyId: creds.accessKeyId,
            secretAccessKey: creds.secretAccessKey,
            sessionToken: creds.sessionToken!,
          },
        });

        const identity = await sts.send(new GetCallerIdentityCommand({}));
        expect(identity.Account).toMatch(/^\d{12}$/);
        console.log(`[row-2] Authenticated as: ${identity.Arn}`);
        sts.destroy();
      },
      30_000,
    );

    // ── Row 3: AWS_PROFILE via provider chain ─────────────────────────────────

    it.skipIf(!process.env["AWS_PROFILE"])(
      "row-3: AWS_PROFILE — resolveOperatorCredentialProvider returns a working provider",
      async () => {
        const { STSClient, GetCallerIdentityCommand } =
          await import("@aws-sdk/client-sts");
        const { resolveOperatorCredentialProvider } =
          await import("@assignee/core");

        // Clear ASSIGNEE_OPERATOR_* so the profile branch is exercised
        const savedKey = process.env["ASSIGNEE_OPERATOR_ACCESS_KEY_ID"];
        const savedSecret = process.env["ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY"];
        delete process.env["ASSIGNEE_OPERATOR_ACCESS_KEY_ID"];
        delete process.env["ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY"];

        try {
          const result = await resolveOperatorCredentialProvider();
          expect(result.source).toContain(process.env["AWS_PROFILE"]);

          const sts = new STSClient({
            region: process.env["AWS_REGION"] ?? "us-east-1",
            credentials: result.provider,
          });

          const identity = await sts.send(new GetCallerIdentityCommand({}));
          expect(identity.Account).toMatch(/^\d{12}$/);
          console.log(`[row-3] Authenticated via profile as: ${identity.Arn}`);
          sts.destroy();
        } finally {
          if (savedKey)
            process.env["ASSIGNEE_OPERATOR_ACCESS_KEY_ID"] = savedKey;
          if (savedSecret)
            process.env["ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY"] = savedSecret;
        }
      },
      30_000,
    );

    // ── Row 4: --profile flag via resolveCredentialsWithProfile ───────────────

    it.skipIf(!process.env["E2E_PROFILE_NAME"])(
      "row-4: --profile flag — resolveCredentialsWithProfile promotes creds and STS succeeds",
      async () => {
        const { STSClient, GetCallerIdentityCommand } =
          await import("@aws-sdk/client-sts");
        const { resolveCredentialsWithProfile } =
          await import("../utils/command-runner/credentials.js");

        const profileName = process.env["E2E_PROFILE_NAME"]!;

        // Clear any pre-existing ASSIGNEE_OPERATOR_* to test the promotion path
        const savedKey = process.env["ASSIGNEE_OPERATOR_ACCESS_KEY_ID"];
        const savedSecret = process.env["ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY"];
        const savedToken = process.env["ASSIGNEE_OPERATOR_SESSION_TOKEN"];
        delete process.env["ASSIGNEE_OPERATOR_ACCESS_KEY_ID"];
        delete process.env["ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY"];
        delete process.env["ASSIGNEE_OPERATOR_SESSION_TOKEN"];

        try {
          await resolveCredentialsWithProfile(profileName, true);

          // resolveCredentialsWithProfile should have promoted creds
          expect(process.env["ASSIGNEE_OPERATOR_ACCESS_KEY_ID"]).toBeDefined();

          const sts = new STSClient({
            region: process.env["AWS_REGION"] ?? "us-east-1",
            credentials: {
              accessKeyId: process.env["ASSIGNEE_OPERATOR_ACCESS_KEY_ID"]!,
              secretAccessKey:
                process.env["ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY"]!,
              ...(process.env["ASSIGNEE_OPERATOR_SESSION_TOKEN"]
                ? {
                    sessionToken:
                      process.env["ASSIGNEE_OPERATOR_SESSION_TOKEN"],
                  }
                : {}),
            },
          });

          const identity = await sts.send(new GetCallerIdentityCommand({}));
          expect(identity.Account).toMatch(/^\d{12}$/);
          console.log(
            `[row-4] Authenticated via --profile as: ${identity.Arn}`,
          );
          sts.destroy();
        } finally {
          if (savedKey)
            process.env["ASSIGNEE_OPERATOR_ACCESS_KEY_ID"] = savedKey;
          else delete process.env["ASSIGNEE_OPERATOR_ACCESS_KEY_ID"];
          if (savedSecret)
            process.env["ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY"] = savedSecret;
          else delete process.env["ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY"];
          if (savedToken)
            process.env["ASSIGNEE_OPERATOR_SESSION_TOKEN"] = savedToken;
          else delete process.env["ASSIGNEE_OPERATOR_SESSION_TOKEN"];
        }
      },
      30_000,
    );

    // ── Row 5: no creds anywhere → configurationError ────────────────────────

    it("row-5: no creds anywhere — requireAssigneeCredentials throws with setup hint", async () => {
      const { requireAssigneeCredentials, MissingAssigneeCredentialsError } =
        await import("@assignee/core");

      // Save and clear all credential env vars
      const vars = [
        "ASSIGNEE_OPERATOR_ACCESS_KEY_ID",
        "ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY",
        "ASSIGNEE_OPERATOR_SESSION_TOKEN",
      ];
      const saved: Record<string, string | undefined> = {};
      for (const v of vars) {
        saved[v] = process.env[v];
        delete process.env[v];
      }

      try {
        expect(() => requireAssigneeCredentials("operator")).toThrow(
          MissingAssigneeCredentialsError,
        );
      } finally {
        for (const v of vars) {
          if (saved[v] !== undefined) process.env[v] = saved[v];
        }
      }
    });
  },
);
