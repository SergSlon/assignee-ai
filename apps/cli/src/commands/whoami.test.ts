/**
 * Tests for `assignee whoami`.
 *
 * Mocks the STS client only — every other code path (env-var resolution,
 * config-file detection, output formatting) is exercised with real I/O
 * against a temp directory so we catch path/format regressions.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import { runWhoami } from "./whoami.js";

const ENV_KEYS = [
  "ASSIGNEE_OPERATOR_ACCESS_KEY_ID",
  "ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY",
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
] as const;

let savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>;

function clearEnv(): void {
  for (const k of ENV_KEYS) delete process.env[k];
}

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  clearEnv();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe("runWhoami", () => {
  it("exits non-zero with a recovery hint when no operator credentials are set", async () => {
    const stderr = vi.fn();
    const stdout = vi.fn();

    const code = await runWhoami({ stdout, stderr, cwd: () => tmpdir() });

    expect(code).toBe(1);
    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalled();
    const message = stderr.mock.calls.map((c) => c[0]).join("");
    expect(message).toContain("No AWS credentials configured");
    expect(message).toContain("ASSIGNEE_OPERATOR_ACCESS_KEY_ID");
    expect(message).toContain("ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY");
    expect(message).toContain("assignee setup");
  });

  it("prints account, ARN, region, role and 'no config' when STS succeeds in an empty cwd", async () => {
    process.env["ASSIGNEE_OPERATOR_ACCESS_KEY_ID"] = "AKIAIOSFODNN7EXAMPLE";
    process.env["ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY"] =
      "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
    process.env["AWS_REGION"] = "eu-west-1";

    const send = vi.fn().mockResolvedValue({
      Account: "123456789012",
      Arn: "arn:aws:iam::123456789012:user/assignee-operator",
      UserId: "AIDAEXAMPLEEXAMPLE",
    });
    const stsClientFactory = vi.fn().mockReturnValue({ send });

    const tmp = mkdtempSync(join(tmpdir(), "whoami-empty-"));
    try {
      const stdout = vi.fn();
      const stderr = vi.fn();
      const code = await runWhoami({
        stsClientFactory,
        cwd: () => tmp,
        stdout,
        stderr,
      });

      expect(code).toBe(0);
      expect(stderr).not.toHaveBeenCalled();
      expect(send).toHaveBeenCalledWith(expect.any(GetCallerIdentityCommand));
      expect(stsClientFactory).toHaveBeenCalledWith(
        expect.objectContaining({
          accessKeyId: "AKIAIOSFODNN7EXAMPLE",
          secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
        }),
        "eu-west-1",
      );
      const out = stdout.mock.calls.map((c) => c[0]).join("");
      expect(out).toContain("Account:  123456789012");
      expect(out).toContain(
        "User ARN: arn:aws:iam::123456789012:user/assignee-operator",
      );
      expect(out).toContain("Region:   eu-west-1");
      expect(out).toContain("operator (ASSIGNEE_OPERATOR_ACCESS_KEY_ID)");
      expect(out).toContain("Config:   (none in cwd)");
      expect(out).toContain("For full diagnostics, run `assignee doctor`.");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("detects ./assignee.yaml in the cwd and reports it as loaded", async () => {
    process.env["ASSIGNEE_OPERATOR_ACCESS_KEY_ID"] = "AKIAIOSFODNN7EXAMPLE";
    process.env["ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY"] =
      "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";

    const tmp = mkdtempSync(join(tmpdir(), "whoami-cfg-"));
    writeFileSync(join(tmp, "assignee.yaml"), "region: us-east-1\n");

    try {
      const stdout = vi.fn();
      const code = await runWhoami({
        stsClientFactory: () => ({
          send: vi.fn().mockResolvedValue({
            Account: "999999999999",
            Arn: "arn:aws:iam::999999999999:user/operator",
          }),
        }),
        cwd: () => tmp,
        stdout,
        stderr: vi.fn(),
      });
      expect(code).toBe(0);
      const out = stdout.mock.calls.map((c) => c[0]).join("");
      expect(out).toContain("Config:   ./assignee.yaml (loaded)");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("detects .assignee/config.yaml when assignee.yaml is absent", async () => {
    process.env["ASSIGNEE_OPERATOR_ACCESS_KEY_ID"] = "AKIAIOSFODNN7EXAMPLE";
    process.env["ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY"] =
      "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";

    const tmp = mkdtempSync(join(tmpdir(), "whoami-nested-"));
    mkdirSync(join(tmp, ".assignee"));
    writeFileSync(join(tmp, ".assignee", "config.yaml"), "region: us-east-1\n");

    try {
      const stdout = vi.fn();
      const code = await runWhoami({
        stsClientFactory: () => ({
          send: vi.fn().mockResolvedValue({
            Account: "1",
            Arn: "arn:aws:iam::1:user/x",
          }),
        }),
        cwd: () => tmp,
        stdout,
        stderr: vi.fn(),
      });
      expect(code).toBe(0);
      const out = stdout.mock.calls.map((c) => c[0]).join("");
      expect(out).toContain(".assignee/config.yaml (loaded)");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("returns exit code 1 with a diagnostic message when STS rejects", async () => {
    process.env["ASSIGNEE_OPERATOR_ACCESS_KEY_ID"] = "AKIAIOSFODNN7EXAMPLE";
    process.env["ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY"] =
      "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";

    const stderr = vi.fn();
    const stdout = vi.fn();
    const code = await runWhoami({
      stsClientFactory: () => ({
        send: vi
          .fn()
          .mockRejectedValue(
            Object.assign(
              new Error(
                "The security token included in the request is invalid.",
              ),
              { name: "UnrecognizedClientException" },
            ),
          ),
      }),
      cwd: () => tmpdir(),
      stdout,
      stderr,
    });

    expect(code).toBe(1);
    expect(stdout).not.toHaveBeenCalled();
    const out = stderr.mock.calls.map((c) => c[0]).join("");
    expect(out).toContain("Failed to verify AWS identity via STS");
    expect(out).toContain("UnrecognizedClientException");
    expect(out).toContain("sts:GetCallerIdentity");
  });

  it("returns exit code 1 when STS returns an empty identity payload", async () => {
    process.env["ASSIGNEE_OPERATOR_ACCESS_KEY_ID"] = "AKIAIOSFODNN7EXAMPLE";
    process.env["ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY"] =
      "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";

    const stderr = vi.fn();
    const code = await runWhoami({
      stsClientFactory: () => ({
        send: vi.fn().mockResolvedValue({}),
      }),
      cwd: () => tmpdir(),
      stdout: vi.fn(),
      stderr,
    });

    expect(code).toBe(1);
    const out = stderr.mock.calls.map((c) => c[0]).join("");
    expect(out).toContain("STS GetCallerIdentity returned an empty response");
  });

  it("falls back to AWS_DEFAULT_REGION then to the SDK default", async () => {
    process.env["ASSIGNEE_OPERATOR_ACCESS_KEY_ID"] = "AKIAIOSFODNN7EXAMPLE";
    process.env["ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY"] =
      "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
    process.env["AWS_DEFAULT_REGION"] = "ap-southeast-2";

    const factory = vi.fn().mockReturnValue({
      send: vi.fn().mockResolvedValue({
        Account: "1",
        Arn: "arn:aws:iam::1:user/x",
      }),
    });
    const stdout = vi.fn();
    await runWhoami({
      stsClientFactory: factory,
      cwd: () => tmpdir(),
      stdout,
      stderr: vi.fn(),
    });
    expect(factory).toHaveBeenCalledWith(expect.anything(), "ap-southeast-2");
    expect(stdout.mock.calls.map((c) => c[0]).join("")).toContain(
      "Region:   ap-southeast-2",
    );
  });
});
