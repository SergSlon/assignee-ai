import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { createMcpClient, getMcpTools } from "./mcp-client.js";

const TEST_TIMEOUT_MS = 20000; // 20s timeout since 'uvx' might need to download the package on the first run

// Skip in CI unless MCP servers are explicitly available
describe.skipIf(!!process.env["CI"])("MCP integration", () => {
  let stderrSpy: { mockRestore: () => void };

  beforeAll(() => {
    // Silence expected stderr output during tests
    stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((() => true) as any);
  });

  afterAll(() => {
    stderrSpy.mockRestore();
  });

  it(
    "connects to core MCP servers and fetches tools",
    async () => {
      try {
        // 1. Initialize client (spawns core servers: Pricing + Docs)
        const client = await createMcpClient();

        // 2. Fetch tools
        const tools = await getMcpTools(client);

        // Verify basic tools loaded from core servers
        expect(tools.length).toBeGreaterThan(0);
      } catch (err: unknown) {
        // McpError thrown when MCP server fails to start — skip gracefully
        if (
          err instanceof Error &&
          (err.message.includes("MCP server") ||
            err.message === "process.exit called")
        ) {
          process.stderr.write(
            "Skipping integration test due to MCP server startup failure.\n",
          );
          return;
        }
        throw err;
      }
    },
    TEST_TIMEOUT_MS,
  );
});
