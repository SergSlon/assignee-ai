/**
 * Unit tests for mcp-client.ts
 * Story 9.9 — T7.12-T7.15: mcp-client.ts unit tests with mocked MCP servers
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ProcessExitCode } from "../constants/errors.js";

// ── Module-level mocks ──────────────────────────────────────────────────────

const mockInitializeConnections = vi.fn();
const mockGetTools = vi.fn();
const mockClose = vi.fn();
const MockMultiServerMCPClient = vi.fn().mockImplementation(() => ({
  initializeConnections: mockInitializeConnections,
  getTools: mockGetTools,
  close: mockClose,
}));

vi.mock("@langchain/mcp-adapters", () => ({
  MultiServerMCPClient: MockMultiServerMCPClient,
}));

vi.mock("../config/mcp-servers.js", () => ({
  getMcpServerConfigs: vi.fn(() => ({
    "cfn-mcp-server": {
      command: "uvx",
      args: ["cfn-mcp-server"],
      env: {},
    },
  })),
  getOptionalMcpServerConfigs: vi.fn(() => ({})),
}));

let exitSpy: ReturnType<typeof vi.spyOn>;
let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  exitSpy = vi
    .spyOn(process, "exit")
    .mockImplementation((() => {}) as never) as any;
  consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  exitSpy.mockRestore();
  consoleErrorSpy.mockRestore();
});

// Each test needs a fresh module to reset the singleton `client` variable
async function freshImport() {
  vi.resetModules();
  // Re-apply mocks after resetModules
  vi.doMock("@langchain/mcp-adapters", () => ({
    MultiServerMCPClient: MockMultiServerMCPClient,
  }));
  vi.doMock("../config/mcp-servers.js", () => ({
    getMcpServerConfigs: vi.fn(() => ({
      "cfn-mcp-server": {
        command: "uvx",
        args: ["cfn-mcp-server"],
        env: {},
      },
    })),
    getOptionalMcpServerConfigs: vi.fn(() => ({})),
  }));
  return import("./mcp-client.js");
}

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

  it("connection failure — logs error and calls process.exit", async () => {
    mockInitializeConnections.mockRejectedValue(
      new Error("cfn-mcp-server failed to start"),
    );
    const { createMcpClient } = await freshImport();

    await createMcpClient();

    expect(process.exit).toHaveBeenCalledWith(
      ProcessExitCode.MCP_STARTUP_FAILED,
    );
    expect(console.error).toHaveBeenCalled();
  });

  it("connection failure with known server name — shows install hint", async () => {
    mockInitializeConnections.mockRejectedValue(
      new Error("cfn-mcp-server connection refused"),
    );
    const { createMcpClient } = await freshImport();

    await createMcpClient();

    const errorCall = consoleErrorSpy.mock.calls[0]?.[0] as string;
    expect(errorCall).toContain("cfn-mcp-server");
    expect(errorCall).toContain("failed to start");
  });

  it("connection failure with unknown server — shows generic message", async () => {
    mockInitializeConnections.mockRejectedValue(
      new Error("Something went wrong"),
    );
    const { createMcpClient } = await freshImport();

    await createMcpClient();

    const errorCall = consoleErrorSpy.mock.calls[0]?.[0] as string;
    expect(errorCall).toContain("unknown MCP server");
  });
});

describe("getMcpTools", () => {
  it("T7.13: returns tools from core client", async () => {
    mockInitializeConnections.mockResolvedValue(undefined);
    const mockTools = [
      { name: "get_resource_schema" },
      { name: "get_pricing" },
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
      getMcpServerConfigs: vi.fn(() => ({
        "cfn-mcp-server": {
          command: "uvx",
          args: ["cfn-mcp-server"],
          env: {},
        },
      })),
      getOptionalMcpServerConfigs: vi.fn(() => ({
        "iam-mcp-server": {
          command: "uvx",
          args: ["iam-mcp-server"],
          env: {},
        },
      })),
    }));

    vi.resetModules();
    const { createMcpClient, getMcpTools } = await import("./mcp-client.js");

    const coreTools = [{ name: "schema" }];
    mockGetTools.mockResolvedValue(coreTools);

    const client = await createMcpClient();
    const tools = await getMcpTools(client);

    // Core tools should still be available even though optional server failed
    expect(tools).toEqual(coreTools);
    expect(process.exit).not.toHaveBeenCalled();
  });
});
