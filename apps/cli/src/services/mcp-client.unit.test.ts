/**
 * Unit tests for mcp-client.ts
 * Story 9.9 — T7.12-T7.15: mcp-client.ts unit tests with mocked MCP servers
 * Story 29.3 — MCP Server Lazy Loading: requiredServers filter
 * Core servers: Pricing + Docs. Schema fetching via direct SDK.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MCP_PINS } from "../config/mcp-servers.js";

// ── Module-level mocks ──────────────────────────────────────────────────────

const mockInitializeConnections = vi.fn();
const mockGetTools = vi.fn();
const mockClose = vi.fn();
// MockMultiServerMCPClient uses a stable vi.fn whose implementation is
// re-installed in beforeEach (mockReset:true wipes it between tests).
const MockMultiServerMCPClient = vi.fn();

vi.mock("@langchain/mcp-adapters", () => ({
  MultiServerMCPClient: MockMultiServerMCPClient,
}));

vi.mock("../config/mcp-servers.js", async (importOriginal) => {
  // Preserve the real MCP_PINS export so test fixtures can reference the
  // pinned versions instead of hardcoding @latest (V3 audit). Only the
  // factory functions are mocked.
  const actual =
    (await importOriginal()) as typeof import("../config/mcp-servers.js");
  return {
    MCP_PINS: actual.MCP_PINS,
    getMcpServerConfigs: vi.fn(),
    getOptionalMcpServerConfigs: vi.fn(),
  };
});

let exitSpy: ReturnType<typeof vi.spyOn>;
let stderrWriteSpy: any;

function installDefaultMocks() {
  MockMultiServerMCPClient.mockImplementation(() => ({
    initializeConnections: mockInitializeConnections,
    getTools: mockGetTools,
    close: mockClose,
  }));
}

beforeEach(async () => {
  vi.clearAllMocks();
  installDefaultMocks();
  // Re-install factory mocks for config module
  const configMod = await import("../config/mcp-servers.js");
  vi.mocked(configMod.getMcpServerConfigs).mockReturnValue({
    "aws-pricing-mcp-server": {
      command: "uvx",
      args: [MCP_PINS.AWS_PRICING],
      env: {},
    },
  });
  vi.mocked(configMod.getOptionalMcpServerConfigs).mockReturnValue({});
  exitSpy = vi
    .spyOn(process, "exit")
    .mockImplementation((() => {}) as never) as any;
  stderrWriteSpy = vi
    .spyOn(process.stderr, "write")
    .mockImplementation((() => true) as any);
});

afterEach(() => {
  exitSpy.mockRestore();
  stderrWriteSpy.mockRestore();
});

// Each test needs a fresh module to reset the singleton `client` variable
async function freshImport() {
  vi.resetModules();
  // Re-apply mocks after resetModules
  vi.doMock("@langchain/mcp-adapters", () => ({
    MultiServerMCPClient: MockMultiServerMCPClient,
  }));
  vi.doMock("../config/mcp-servers.js", () => ({
    MCP_PINS,
    getMcpServerConfigs: vi.fn(() => ({
      "aws-pricing-mcp-server": {
        command: "uvx",
        args: [MCP_PINS.AWS_PRICING],
        env: {},
      },
    })),
    getOptionalMcpServerConfigs: vi.fn(() => ({})),
  }));
  return import("./mcp-client.js");
}

describe("MCP_PINS supply-chain pinning (V3 audit)", () => {
  it("never references @latest in any pin", () => {
    for (const [name, pin] of Object.entries(MCP_PINS)) {
      expect(pin, `${name} must be a pinned version, not @latest`).not.toMatch(
        /@latest$/,
      );
      // Sanity: every pin must contain a semver-ish suffix.
      expect(pin, `${name} must include an explicit @version`).toMatch(
        /@\d+\.\d+\.\d+/,
      );
    }
  });
});

describe("createMcpClient", () => {
  it("T7.12: creates and initializes client on first call", async () => {
    mockInitializeConnections.mockResolvedValue(undefined);
    const { createMcpClient } = await freshImport();

    const client = await createMcpClient();

    expect(MockMultiServerMCPClient).toHaveBeenCalled();
    expect(mockInitializeConnections).toHaveBeenCalledOnce();
    expect(client).toBeDefined();
  });

  it("returns singleton on subsequent calls", async () => {
    mockInitializeConnections.mockResolvedValue(undefined);
    const { createMcpClient } = await freshImport();

    const client1 = await createMcpClient();
    const client2 = await createMcpClient();

    expect(client1).toBe(client2);
    expect(mockInitializeConnections).toHaveBeenCalledOnce();
  });

  it("connection failure — logs error and throws McpError", async () => {
    mockInitializeConnections.mockRejectedValue(
      new Error("aws-pricing-mcp-server failed to start"),
    );
    const { createMcpClient } = await freshImport();

    await expect(createMcpClient()).rejects.toThrow(
      "MCP server 'aws-pricing-mcp-server' failed to start.",
    );
    expect(stderrWriteSpy).toHaveBeenCalled();
  });

  it("connection failure with known server name — shows install hint", async () => {
    mockInitializeConnections.mockRejectedValue(
      new Error("aws-pricing-mcp-server connection refused"),
    );
    const { createMcpClient } = await freshImport();

    await expect(createMcpClient()).rejects.toThrow(
      "MCP server 'aws-pricing-mcp-server' failed to start.",
    );

    const errorCall = stderrWriteSpy.mock.calls[0]?.[0] as string;
    expect(errorCall).toContain("aws-pricing-mcp-server");
    expect(errorCall).toContain("failed to start");
  });

  it("connection failure with unknown server — shows generic message", async () => {
    mockInitializeConnections.mockRejectedValue(
      new Error("Something went wrong"),
    );
    const { createMcpClient } = await freshImport();

    await expect(createMcpClient()).rejects.toThrow(
      "An unknown MCP server failed to start: Something went wrong",
    );

    const errorCall = stderrWriteSpy.mock.calls[0]?.[0] as string;
    expect(errorCall).toContain("unknown MCP server");
  });
});

describe("createMcpClient — lazy loading (Story 29.3)", () => {
  /** Fresh import with multiple core servers to test filtering */
  async function freshImportMultiServer() {
    vi.resetModules();
    vi.doMock("@langchain/mcp-adapters", () => ({
      MultiServerMCPClient: MockMultiServerMCPClient,
    }));
    vi.doMock("../config/mcp-servers.js", () => ({
      MCP_PINS,
      getMcpServerConfigs: vi.fn(() => ({
        "aws-pricing-mcp-server": {
          command: "uvx",
          args: [MCP_PINS.AWS_PRICING],
          env: {},
        },
        "aws-documentation-mcp-server": {
          command: "uvx",
          args: [MCP_PINS.AWS_DOCUMENTATION],
        },
      })),
      getOptionalMcpServerConfigs: vi.fn(() => ({
        "aws-knowledge-mcp-server": {
          command: "uvx",
          args: ["fastmcp", "run", "https://knowledge-mcp.global.api.aws"],
        },
        "iam-mcp-server": {
          command: "uvx",
          args: [MCP_PINS.AWS_IAM, "--readonly"],
          env: {},
        },
      })),
    }));
    return import("./mcp-client.js");
  }

  it("null requiredServers starts all core and optional servers", async () => {
    mockInitializeConnections.mockResolvedValue(undefined);
    const { createMcpClient } = await freshImportMultiServer();

    await createMcpClient(null);

    // Core client created with all servers
    const coreConfig = MockMultiServerMCPClient.mock.calls[0]?.[0];
    expect(Object.keys(coreConfig.mcpServers)).toEqual([
      "aws-pricing-mcp-server",
      "aws-documentation-mcp-server",
    ]);
    // Optional client created (2nd call) with all optional servers
    expect(MockMultiServerMCPClient).toHaveBeenCalledTimes(2);
    const optionalConfig = MockMultiServerMCPClient.mock.calls[1]?.[0];
    expect(Object.keys(optionalConfig.mcpServers)).toEqual([
      "aws-knowledge-mcp-server",
      "iam-mcp-server",
    ]);
  });

  it("undefined requiredServers starts all servers (legacy behavior)", async () => {
    mockInitializeConnections.mockResolvedValue(undefined);
    const { createMcpClient } = await freshImportMultiServer();

    await createMcpClient();

    const coreConfig = MockMultiServerMCPClient.mock.calls[0]?.[0];
    expect(Object.keys(coreConfig.mcpServers)).toEqual([
      "aws-pricing-mcp-server",
      "aws-documentation-mcp-server",
    ]);
  });

  it("requiredServers filters core servers to only requested ones", async () => {
    mockInitializeConnections.mockResolvedValue(undefined);
    const { createMcpClient } = await freshImportMultiServer();

    await createMcpClient(["aws-pricing-mcp-server"] as any);

    const coreConfig = MockMultiServerMCPClient.mock.calls[0]?.[0];
    expect(Object.keys(coreConfig.mcpServers)).toEqual([
      "aws-pricing-mcp-server",
    ]);
  });

  it("requiredServers filters optional servers too", async () => {
    mockInitializeConnections.mockResolvedValue(undefined);
    const { createMcpClient } = await freshImportMultiServer();

    // Request only pricing (core) + iam (optional)
    await createMcpClient(["aws-pricing-mcp-server", "iam-mcp-server"] as any);

    // Core: only pricing
    const coreConfig = MockMultiServerMCPClient.mock.calls[0]?.[0];
    expect(Object.keys(coreConfig.mcpServers)).toEqual([
      "aws-pricing-mcp-server",
    ]);
    // Optional: only iam
    expect(MockMultiServerMCPClient).toHaveBeenCalledTimes(2);
    const optionalConfig = MockMultiServerMCPClient.mock.calls[1]?.[0];
    expect(Object.keys(optionalConfig.mcpServers)).toEqual(["iam-mcp-server"]);
  });

  it("empty requiredServers array starts zero optional servers", async () => {
    mockInitializeConnections.mockResolvedValue(undefined);
    const { createMcpClient } = await freshImportMultiServer();

    await createMcpClient([]);

    // Core client still created (with empty mcpServers)
    const coreConfig = MockMultiServerMCPClient.mock.calls[0]?.[0];
    expect(Object.keys(coreConfig.mcpServers)).toEqual([]);
    // No optional client created since no optional servers matched
    expect(MockMultiServerMCPClient).toHaveBeenCalledTimes(1);
  });
});

describe("getMcpTools", () => {
  it("T7.13: returns tools from core client", async () => {
    mockInitializeConnections.mockResolvedValue(undefined);
    const mockTools = [
      { name: "get_pricing" },
      { name: "search_documentation" },
    ];
    mockGetTools.mockResolvedValue(mockTools);

    const { createMcpClient, getMcpTools } = await freshImport();
    const client = await createMcpClient();
    const tools = await getMcpTools(client);

    expect(tools).toBe(mockTools);
  });
});

describe("closeMcpClient", () => {
  it("T7.14: closes client and resets singleton", async () => {
    mockInitializeConnections.mockResolvedValue(undefined);
    mockClose.mockResolvedValue(undefined);

    const { createMcpClient, closeMcpClient } = await freshImport();
    await createMcpClient();
    await closeMcpClient();

    expect(mockClose).toHaveBeenCalled();
  });
});

describe("getBillingMcpToolsAsync", () => {
  it("returns undefined when optional client is null", async () => {
    mockInitializeConnections.mockResolvedValue(undefined);
    const { createMcpClient, getBillingMcpToolsAsync } = await freshImport();
    await createMcpClient();

    const result = await getBillingMcpToolsAsync();
    expect(result).toBeUndefined();
  });
});

describe("closeMcpClient — no client initialized", () => {
  it("does nothing when no client exists", async () => {
    const { closeMcpClient } = await freshImport();
    // Should not throw
    await closeMcpClient();
    expect(mockClose).not.toHaveBeenCalled();
  });
});

describe("optional server failure isolation", () => {
  it("T7.15: optional server fails — core client still works", async () => {
    mockInitializeConnections.mockResolvedValue(undefined);

    const optionalInitMock = vi
      .fn()
      .mockRejectedValue(new Error("IAM server down"));
    const optionalCloseMock = vi.fn().mockResolvedValue(undefined);

    // Track which client is which
    let callCount = 0;
    MockMultiServerMCPClient.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        // Core client
        return {
          initializeConnections: mockInitializeConnections,
          getTools: mockGetTools,
          close: mockClose,
        };
      }
      // Optional client
      return {
        initializeConnections: optionalInitMock,
        getTools: vi.fn(),
        close: optionalCloseMock,
      };
    });

    vi.doMock("../config/mcp-servers.js", () => ({
      MCP_PINS,
      getMcpServerConfigs: vi.fn(() => ({
        "aws-pricing-mcp-server": {
          command: "uvx",
          args: [MCP_PINS.AWS_PRICING],
          env: {},
        },
      })),
      getOptionalMcpServerConfigs: vi.fn(() => ({
        "iam-mcp-server": {
          command: "uvx",
          args: [MCP_PINS.AWS_IAM],
          env: {},
        },
      })),
    }));

    vi.resetModules();
    const { createMcpClient, getMcpTools } = await import("./mcp-client.js");

    const coreTools = [{ name: "get_pricing" }];
    mockGetTools.mockResolvedValue(coreTools);

    const client = await createMcpClient();
    const tools = await getMcpTools(client);

    // Core tools should still be available even though optional server failed
    expect(tools).toEqual(coreTools);
    expect(process.exit).not.toHaveBeenCalled();
  });
});
