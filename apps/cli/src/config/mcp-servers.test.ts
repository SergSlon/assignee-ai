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
    const configs = getMcpServerConfigs();
    expect(configs[McpServerName.PRICING]).toBeDefined();
    expect(configs[McpServerName.DOCS]).toBeDefined();
  });

  it("Knowledge server is optional (not core) and gated off by default", () => {
    const core = getMcpServerConfigs();
    const optional = getOptionalMcpServerConfigs();
    expect(core[McpServerName.KNOWLEDGE]).toBeUndefined();
    // Opt-in env var is NOT set — Knowledge must not appear even as optional.
    expect(optional[McpServerName.KNOWLEDGE]).toBeUndefined();
  });

  it("does not include cfn-mcp-server in any entry", () => {
    const configs = getMcpServerConfigs();
    for (const [name, config] of Object.entries(configs)) {
      expect(name).not.toContain("cfn-mcp-server");
      expect(config.args.join(" ")).not.toContain("cfn-mcp-server");
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
    // can still spawn its core MCP stack.
    expect(configs[McpServerName.DOCS]).toBeDefined();
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
    expect(configs[McpServerName.DOCS]).toBeDefined();
  });

  // With reader creds set, Pricing IS present (round-trip from previous case).
  it("includes Pricing when reader creds present (post-omission round-trip)", () => {
    setReaderEnv();
    const configs = getMcpServerConfigs();
    expect(configs[McpServerName.PRICING]).toBeDefined();
    expect(configs[McpServerName.DOCS]).toBeDefined();
  });

  it("never emits empty-string AWS_ACCESS_KEY_ID for the Pricing subprocess", () => {
    setReaderEnv();
    const configs = getMcpServerConfigs();
    const pricing = configs[McpServerName.PRICING]!;
    expect(pricing.env).toBeDefined();
    expect(pricing.env!["AWS_ACCESS_KEY_ID"]).toBe(READER_AK);
    expect(pricing.env!["AWS_ACCESS_KEY_ID"]).not.toBe("");
    expect(pricing.env!["AWS_SECRET_ACCESS_KEY"]).toBe(READER_SK);
  });
});

describe("getOptionalMcpServerConfigs", () => {
  // ── Supply-chain pinning (H2) ───────────────────────────────────────────
  it("pins the Billing MCP server to an exact version (never @latest)", () => {
    setReaderEnv();
    const configs = getOptionalMcpServerConfigs();
    const billing = configs[McpServerName.BILLING]!;
    expect(billing).toBeDefined();
    const joined = billing.args.join(" ");
    expect(joined).toMatch(/awslabs\.cost-management-mcp-server@\d+\.\d+\.\d+/);
    expect(joined).not.toContain("@latest");
  });

  it("pins the IAM MCP server to an exact version (never @latest)", () => {
    setAuditorEnv();
    const configs = getOptionalMcpServerConfigs();
    const iam = configs[McpServerName.IAM]!;
    expect(iam).toBeDefined();
    const joined = iam.args.join(" ");
    expect(joined).toMatch(/awslabs\.iam-mcp-server@\d+\.\d+\.\d+/);
    expect(joined).not.toContain("@latest");
    expect(joined).toContain("--readonly");
  });

  it("pins the Well-Architected Security MCP server (never @latest)", () => {
    setAuditorEnv();
    const configs = getOptionalMcpServerConfigs();
    const wa = configs[McpServerName.WELL_ARCHITECTED_SECURITY]!;
    expect(wa).toBeDefined();
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
    setReaderEnv();
    const configs = getOptionalMcpServerConfigs();
    const billing = configs[McpServerName.BILLING]!;
    expect(billing.env).toBeDefined();
    expect(billing.env!["AWS_ACCESS_KEY_ID"]).toBe(READER_AK);
    expect(billing.env!["AWS_SECRET_ACCESS_KEY"]).toBe(READER_SK);
    expect(billing.env!["AWS_DEFAULT_REGION"]).toBeDefined();
  });

  it("includes IAM and Well-Architected Security servers when auditor creds set", () => {
    setAuditorEnv();
    const configs = getOptionalMcpServerConfigs();
    expect(configs[McpServerName.IAM]).toBeDefined();
    expect(configs[McpServerName.WELL_ARCHITECTED_SECURITY]).toBeDefined();
    expect(configs[McpServerName.IAM]!.env!["AWS_ACCESS_KEY_ID"]).toBe(
      AUDITOR_AK,
    );
  });

  // ── Graceful degradation for optional servers (H1) ──────────────────────
  it("omits auditor-scoped servers when ASSIGNEE_AUDITOR_* unset", () => {
    setReaderEnv(); // only reader, no auditor
    const configs = getOptionalMcpServerConfigs();
    expect(configs[McpServerName.IAM]).toBeUndefined();
    expect(configs[McpServerName.WELL_ARCHITECTED_SECURITY]).toBeUndefined();
    // Billing still present — it uses reader creds.
    expect(configs[McpServerName.BILLING]).toBeDefined();
  });

  it("omits billing server when ASSIGNEE_READER_* unset", () => {
    setAuditorEnv(); // only auditor, no reader
    const configs = getOptionalMcpServerConfigs();
    expect(configs[McpServerName.BILLING]).toBeUndefined();
    // IAM + WA-Security still present.
    expect(configs[McpServerName.IAM]).toBeDefined();
  });

  it("returns an empty config when no Assignee creds are set", () => {
    // beforeEach already cleared all creds.
    const configs = getOptionalMcpServerConfigs();
    expect(Object.keys(configs)).toHaveLength(0);
  });

  // ── Remote knowledge MCP server opt-in (H2) ─────────────────────────────
  it("does NOT include the remote knowledge server by default", () => {
    const configs = getOptionalMcpServerConfigs();
    expect(configs[McpServerName.KNOWLEDGE]).toBeUndefined();
  });

  it("includes the remote knowledge server only when ASSIGNEE_ENABLE_REMOTE_MCP=1", () => {
    process.env["ASSIGNEE_ENABLE_REMOTE_MCP"] = "1";
    const configs = getOptionalMcpServerConfigs();
    expect(configs[McpServerName.KNOWLEDGE]).toBeDefined();
    expect(configs[McpServerName.KNOWLEDGE]!.args.join(" ")).toContain(
      "knowledge-mcp.global.api.aws",
    );
  });

  it("does NOT include the remote knowledge server when ASSIGNEE_ENABLE_REMOTE_MCP is a value other than '1'", () => {
    process.env["ASSIGNEE_ENABLE_REMOTE_MCP"] = "true"; // NOT "1"
    const configs = getOptionalMcpServerConfigs();
    expect(configs[McpServerName.KNOWLEDGE]).toBeUndefined();
  });
});
