/**
 * Tests for MCP server configuration.
 *
 * Story 19.7 — billing server registration.
 * Wave-2 security hardening:
 *  - Every MCP server package is PINNED to an exact version (no @latest).
 *  - readerEnv()/auditorEnv() THROW when creds are missing instead of
 *    launching subprocesses with empty-string AWS_ACCESS_KEY_ID.
 *  - The remote knowledge MCP server is opt-in via ASSIGNEE_ENABLE_REMOTE_MCP=1.
 *
 * Core MCP servers: Pricing + Docs. Optional: Knowledge (opt-in), IAM,
 * WA-Security, Billing.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { McpServerName, McpCommand } from "../constants/mcp.js";
import {
  getMcpServerConfigs,
  getOptionalMcpServerConfigs,
} from "./mcp-servers.js";

// Realistic-shaped example AWS credentials (same format AWS uses in docs).
const READER_AK = "AKIAIOSFODNN7EXAMPLE";
const READER_SK = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
const AUDITOR_AK = "AKIAI44QH8DHBEXAMPLE";
const AUDITOR_SK = "je7MtGbClwBF/2Zp9Utk/h3yCo8nvbEXAMPLEKEY";

const ORIGINAL_ENV = { ...process.env };

function setReaderEnv(): void {
  process.env["ASSIGNEE_READER_ACCESS_KEY_ID"] = READER_AK;
  process.env["ASSIGNEE_READER_SECRET_ACCESS_KEY"] = READER_SK;
}

function setAuditorEnv(): void {
  process.env["ASSIGNEE_AUDITOR_ACCESS_KEY_ID"] = AUDITOR_AK;
  process.env["ASSIGNEE_AUDITOR_SECRET_ACCESS_KEY"] = AUDITOR_SK;
}

beforeEach(() => {
  // Start each test with no Assignee creds and no opt-in for remote MCP.
  delete process.env["ASSIGNEE_READER_ACCESS_KEY_ID"];
  delete process.env["ASSIGNEE_READER_SECRET_ACCESS_KEY"];
  delete process.env["ASSIGNEE_AUDITOR_ACCESS_KEY_ID"];
  delete process.env["ASSIGNEE_AUDITOR_SECRET_ACCESS_KEY"];
  delete process.env["ASSIGNEE_ENABLE_REMOTE_MCP"];
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("McpServerName", () => {
  it("defines the BILLING constant", () => {
    expect(McpServerName.BILLING).toBe("aws-cost-management-mcp-server");
  });

  it("does not define IAC constant (removed in Story 31.4)", () => {
    expect("IAC" in McpServerName).toBe(false);
  });
});

describe("getMcpServerConfigs", () => {
  beforeEach(() => setReaderEnv());

  it("returns exactly 2 core servers (Pricing, Docs) when reader creds set", () => {
    const configs = getMcpServerConfigs();
    expect(Object.keys(configs)).toHaveLength(2);
  });

  it("includes Pricing and Docs servers", () => {
    // Tier C: strengthened — assert config shape (command + args), not
    // just defined-ness. The MCP server config is { command, args, env }
    // and a typo in any of those fields silently breaks the spawn.
    const configs = getMcpServerConfigs();
    expect(configs[McpServerName.PRICING]).toMatchObject({
      command: expect.any(String),
      args: expect.any(Array),
    });
    expect(configs[McpServerName.DOCS]).toMatchObject({
      command: expect.any(String),
      args: expect.any(Array),
    });
  });

  it("Knowledge server is optional (not core) and gated off by default", () => {
    const core = getMcpServerConfigs();
    const optional = getOptionalMcpServerConfigs();
    expect(core[McpServerName.KNOWLEDGE]).toBeUndefined();
    // Opt-in env var is NOT set — Knowledge must not appear even as optional.
    expect(optional[McpServerName.KNOWLEDGE]).toBeUndefined();
  });

  // Guardrail: none of the deprecated/declined AWS Labs IaC MCP wrappers may
  // re-appear in the spawned server list. cfn-mcp-server and ccapi-mcp-server
  // are deprecated (Story 7.6 / Story 31.1 migrated us to @aws-sdk/client-
  // cloudformation DescribeType + @aws-sdk/client-cloudcontrol direct calls).
  // aws-iac-mcp-server is the announced replacement for both but was
  // evaluated and declined — see docs/iac-mcp-evaluation.md for the full
  // rationale (architectural mismatch with our in-pipeline BP engine,
  // stack-bound troubleshooter unreachable for CCAPI direct, @latest-only
  // supply-chain story regressing the Wave-2 pinning policy).
  it("does not include any deprecated or declined IaC MCP server", () => {
    const forbidden = [
      "cfn-mcp-server",
      "ccapi-mcp-server",
      "aws-iac-mcp-server",
    ];
    const configs = {
      ...getMcpServerConfigs(),
      ...getOptionalMcpServerConfigs(),
    };
    for (const [name, config] of Object.entries(configs)) {
      for (const banned of forbidden) {
        expect(name).not.toContain(banned);
        expect(config.args.join(" ")).not.toContain(banned);
      }
    }
  });

  // ── Supply-chain pinning (H2) ───────────────────────────────────────────
  it("pins the Pricing MCP server to an exact version (never @latest)", () => {
    const configs = getMcpServerConfigs();
    const pricing = configs[McpServerName.PRICING]!;
    const joined = pricing.args.join(" ");
    expect(joined).toMatch(/awslabs\.aws-pricing-mcp-server@\d+\.\d+\.\d+/);
    expect(joined).not.toContain("@latest");
  });

  it("pins the Documentation MCP server to an exact version (never @latest)", () => {
    const configs = getMcpServerConfigs();
    const docs = configs[McpServerName.DOCS]!;
    const joined = docs.args.join(" ");
    expect(joined).toMatch(
      /awslabs\.aws-documentation-mcp-server@\d+\.\d+\.\d+/,
    );
    expect(joined).not.toContain("@latest");
  });

  // ── Graceful degradation for operator-only environments (REG-N2) ────────
  // The Pricing server requires reader creds, but commands like
  // `assignee plan` (dry-run), `assignee setup`, and `assignee init` must
  // still work in operator-only environments. We OMIT the Pricing entry
  // rather than throw — falling back to local pricing estimates — and
  // continue spawning the rest of the MCP stack.
  it("does NOT throw when ASSIGNEE_READER_* unset; omits Pricing instead", () => {
    delete process.env["ASSIGNEE_READER_ACCESS_KEY_ID"];
    delete process.env["ASSIGNEE_READER_SECRET_ACCESS_KEY"];
    // Belt-and-suspenders: shell AWS_* must NOT be used as a fallback.
    process.env["AWS_ACCESS_KEY_ID"] = "shell-leak-key";
    process.env["AWS_SECRET_ACCESS_KEY"] = "shell-leak-secret";

    let configs: Record<string, unknown> = {};
    expect(() => {
      configs = getMcpServerConfigs();
    }).not.toThrow();

    expect(configs[McpServerName.PRICING]).toBeUndefined();
    // Docs server is credential-free and must still be present so the CLI
    // can still spawn its core MCP stack. Tier C: assert it's actually a
    // config object with args, not just defined.
    expect(configs[McpServerName.DOCS]).toMatchObject({
      args: expect.any(Array),
    });
  });

  // Symmetric: operator-only env returns successfully, with the same
  // omission semantics, even when ALL standard AWS_* shell vars are unset.
  it("returns successfully on operator-only environments (no reader creds)", () => {
    delete process.env["ASSIGNEE_READER_ACCESS_KEY_ID"];
    delete process.env["ASSIGNEE_READER_SECRET_ACCESS_KEY"];
    delete process.env["AWS_ACCESS_KEY_ID"];
    delete process.env["AWS_SECRET_ACCESS_KEY"];
    delete process.env["AWS_SESSION_TOKEN"];

    const configs = getMcpServerConfigs();
    expect(configs[McpServerName.PRICING]).toBeUndefined();
    // Tier C: strengthened
    expect(configs[McpServerName.DOCS]).toMatchObject({
      args: expect.any(Array),
    });
  });

  // With reader creds set, Pricing IS present (round-trip from previous case).
  it("includes Pricing when reader creds present (post-omission round-trip)", () => {
    setReaderEnv();
    const configs = getMcpServerConfigs();
    // Tier C: strengthened — assert env carries the reader creds
    expect(configs[McpServerName.PRICING]).toMatchObject({
      env: expect.objectContaining({ AWS_ACCESS_KEY_ID: READER_AK }),
    });
    expect(configs[McpServerName.DOCS]).toMatchObject({
      args: expect.any(Array),
    });
  });

  it("never emits empty-string AWS_ACCESS_KEY_ID for the Pricing subprocess", () => {
    setReaderEnv();
    const configs = getMcpServerConfigs();
    const pricing = configs[McpServerName.PRICING]!;
    // Tier C: strengthened — env must be a non-empty object, not just defined
    expect(pricing.env).toBeInstanceOf(Object);
    expect(pricing.env!["AWS_ACCESS_KEY_ID"]).toBe(READER_AK);
    expect(pricing.env!["AWS_ACCESS_KEY_ID"]).not.toBe("");
    expect(pricing.env!["AWS_SECRET_ACCESS_KEY"]).toBe(READER_SK);
  });
});

describe("getOptionalMcpServerConfigs", () => {
  // ── Supply-chain pinning (H2) ───────────────────────────────────────────
  it("pins the Billing MCP server to an exact version (never @latest)", () => {
    // Tier C: dropped redundant toBeDefined() — the next toMatch fails
    // naturally if the entry is undefined
    setReaderEnv();
    const configs = getOptionalMcpServerConfigs();
    const billing = configs[McpServerName.BILLING]!;
    const joined = billing.args.join(" ");
    expect(joined).toMatch(
      /awslabs\.billing-cost-management-mcp-server@\d+\.\d+\.\d+/,
    );
    expect(joined).not.toContain("@latest");
  });

  it("pins the IAM MCP server to an exact version (never @latest)", () => {
    // Tier C: dropped redundant toBeDefined()
    setAuditorEnv();
    const configs = getOptionalMcpServerConfigs();
    const iam = configs[McpServerName.IAM]!;
    const joined = iam.args.join(" ");
    expect(joined).toMatch(/awslabs\.iam-mcp-server@\d+\.\d+\.\d+/);
    expect(joined).not.toContain("@latest");
    expect(joined).toContain("--readonly");
  });

  it("pins the Well-Architected Security MCP server (never @latest)", () => {
    // Tier C: dropped redundant toBeDefined()
    setAuditorEnv();
    const configs = getOptionalMcpServerConfigs();
    const wa = configs[McpServerName.WELL_ARCHITECTED_SECURITY]!;
    const joined = wa.args.join(" ");
    expect(joined).toMatch(
      /awslabs\.well-architected-security-mcp-server@\d+\.\d+\.\d+/,
    );
    expect(joined).not.toContain("@latest");
  });

  it("billing server uses uvx command", () => {
    setReaderEnv();
    const configs = getOptionalMcpServerConfigs();
    const billing = configs[McpServerName.BILLING]!;
    expect(billing.command).toBe(McpCommand.UVX);
  });

  it("billing server emits real reader credentials in its env block", () => {
    // Tier C: strengthened — assert env shape including a non-empty
    // AWS_DEFAULT_REGION (not just "defined").
    setReaderEnv();
    const configs = getOptionalMcpServerConfigs();
    const billing = configs[McpServerName.BILLING]!;
    expect(billing.env).toBeInstanceOf(Object);
    expect(billing.env!["AWS_ACCESS_KEY_ID"]).toBe(READER_AK);
    expect(billing.env!["AWS_SECRET_ACCESS_KEY"]).toBe(READER_SK);
    expect(billing.env!["AWS_DEFAULT_REGION"]).toMatch(/^[a-z]{2}-[a-z]+-\d$/);
  });

  it("includes IAM and Well-Architected Security servers when auditor creds set", () => {
    // Tier C: strengthened — toMatchObject with expected env
    setAuditorEnv();
    const configs = getOptionalMcpServerConfigs();
    expect(configs[McpServerName.IAM]).toMatchObject({
      env: expect.objectContaining({ AWS_ACCESS_KEY_ID: AUDITOR_AK }),
    });
    expect(configs[McpServerName.WELL_ARCHITECTED_SECURITY]).toMatchObject({
      env: expect.objectContaining({ AWS_ACCESS_KEY_ID: AUDITOR_AK }),
    });
  });

  // ── Graceful degradation for optional servers (H1) ──────────────────────
  it("omits auditor-scoped servers when ASSIGNEE_AUDITOR_* unset", () => {
    setReaderEnv(); // only reader, no auditor
    const configs = getOptionalMcpServerConfigs();
    expect(configs[McpServerName.IAM]).toBeUndefined();
    expect(configs[McpServerName.WELL_ARCHITECTED_SECURITY]).toBeUndefined();
    // Billing still present — it uses reader creds. Tier C: assert shape.
    expect(configs[McpServerName.BILLING]).toMatchObject({
      args: expect.any(Array),
    });
  });

  it("omits billing server when ASSIGNEE_READER_* unset", () => {
    setAuditorEnv(); // only auditor, no reader
    const configs = getOptionalMcpServerConfigs();
    expect(configs[McpServerName.BILLING]).toBeUndefined();
    // IAM + WA-Security still present. Tier C: assert shape.
    expect(configs[McpServerName.IAM]).toMatchObject({
      args: expect.any(Array),
    });
  });

  it("returns an empty config when no Assignee creds are set", () => {
    // beforeEach already cleared all creds.
    const configs = getOptionalMcpServerConfigs();
    expect(Object.keys(configs)).toHaveLength(0);
  });

  // ── Remote knowledge MCP server retired (acquisition-DD L4-S01) ─────────
  // The previously opt-in remote `knowledge-mcp.global.api.aws` server was
  // REMOVED on 2026-04-24 because the opt-in surface itself was the vuln
  // (RCE via unpinned remote Python fetch-and-execute). These tests lock in
  // the removal — the env var must now be a no-op regardless of its value.

  it("does NOT include the remote knowledge server by default", () => {
    const configs = getOptionalMcpServerConfigs();
    expect(configs[McpServerName.KNOWLEDGE]).toBeUndefined();
  });

  it("IGNORES ASSIGNEE_ENABLE_REMOTE_MCP=1 (remote knowledge server removed per L4-S01)", () => {
    // Regression guard for the acquisition-DD fix. Setting the retired
    // env var must NOT re-enable the remote fetch-and-execute path.
    process.env["ASSIGNEE_ENABLE_REMOTE_MCP"] = "1";
    const configs = getOptionalMcpServerConfigs();
    expect(configs[McpServerName.KNOWLEDGE]).toBeUndefined();
  });

  it("IGNORES ASSIGNEE_ENABLE_REMOTE_MCP with any other value", () => {
    process.env["ASSIGNEE_ENABLE_REMOTE_MCP"] = "true"; // NOT "1"
    const configs = getOptionalMcpServerConfigs();
    expect(configs[McpServerName.KNOWLEDGE]).toBeUndefined();
  });

  it("NEVER emits a remote URL to an MCP server args array (no fetch-exec surface)", () => {
    // Belt-and-braces: even if a future change re-introduces a knowledge
    // server, this asserts nothing in the spawned config args contains the
    // old remote-execution endpoint. Catches accidental reintroduction.
    for (const envValue of ["1", "true", "yes", undefined] as const) {
      if (envValue === undefined)
        delete process.env["ASSIGNEE_ENABLE_REMOTE_MCP"];
      else process.env["ASSIGNEE_ENABLE_REMOTE_MCP"] = envValue;
      setReaderEnv();
      setAuditorEnv();
      const configs = {
        ...getMcpServerConfigs(),
        ...getOptionalMcpServerConfigs(),
      };
      for (const config of Object.values(configs)) {
        expect(config.args.join(" ")).not.toContain(
          "knowledge-mcp.global.api.aws",
        );
      }
    }
  });
});
