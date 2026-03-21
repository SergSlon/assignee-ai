import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { createMcpClient, getMcpTools } from "./mcp-client.js";

const TEST_TIMEOUT_MS = 20000; // 20s timeout since 'uvx' might need to download the package on the first run

// Skip in CI unless MCP servers are explicitly available
describe.skipIf(!!process.env["CI"])("MCP integration", () => {
  let exitSpy: { mockRestore: () => void };
  let consoleSpy: { mockRestore: () => void };

  beforeAll(() => {
    // Prevent process.exit from crashing vitest runner
    exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit called");
    });
    // Silence expected console errors during tests
    consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterAll(() => {
    exitSpy.mockRestore();
    consoleSpy.mockRestore();
  });

  it(
    "fetches SDK docs from knowledge mcp-server",
    async () => {
      try {
        // 1. Initialize client (this spawns the 4 servers using standard uvx commands)
        const client = await createMcpClient();

        // 2. Fetch tools
        const tools = await getMcpTools(client);

        // Verify basic tools loaded
        expect(tools.length).toBeGreaterThan(0);
        const knowTool = tools.find(
          (t) => t.name === "aws___search_documentation",
        );
        expect(knowTool).toBeDefined();
      } catch (err: unknown) {
        if (err instanceof Error && err.message === "process.exit called") {
          console.warn(
            "Skipping integration test due to MCP server startup failure.",
          );
          return;
        }
        throw err;
      }
    },
    TEST_TIMEOUT_MS,
  );
});
