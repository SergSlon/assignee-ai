import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock dependencies to prevent actual execution side-effects during import
vi.mock("commander", () => {
  const MockCommand = vi.fn();
  MockCommand.prototype.name = vi.fn().mockReturnThis();
  MockCommand.prototype.description = vi.fn().mockReturnThis();
  MockCommand.prototype.version = vi.fn().mockReturnThis();
  MockCommand.prototype.addCommand = vi.fn().mockReturnThis();
  MockCommand.prototype.argument = vi.fn().mockReturnThis();
  MockCommand.prototype.option = vi.fn().mockReturnThis();
  MockCommand.prototype.action = vi.fn().mockReturnThis();
  MockCommand.prototype.command = vi.fn().mockReturnThis();
  MockCommand.prototype.addHelpText = vi.fn().mockReturnThis();
  MockCommand.prototype.configureHelp = vi.fn().mockReturnThis();
  MockCommand.prototype.hook = vi.fn().mockReturnThis();
  MockCommand.prototype.commands = [];
  MockCommand.prototype.parseAsync = vi.fn().mockResolvedValue(undefined);
  return { Command: MockCommand };
});

vi.mock("./services/mcp-client.js", () => ({
  closeMcpClient: vi.fn().mockResolvedValue(undefined),
}));

describe("CLI Entrypoint (index.ts) process handlers", () => {
  let initialSigintCount: number;
  let initialSigtermCount: number;

  beforeEach(() => {
    initialSigintCount = process.listenerCount("SIGINT");
    initialSigtermCount = process.listenerCount("SIGTERM");
  });

  it("registers SIGINT and SIGTERM handlers", { timeout: 15_000 }, async () => {
    // Dynamic import to execute the file
    await import("./index.js");

    const currentSigintCount = process.listenerCount("SIGINT");
    const currentSigtermCount = process.listenerCount("SIGTERM");

    expect(currentSigintCount).toBeGreaterThan(initialSigintCount);
    expect(currentSigtermCount).toBeGreaterThan(initialSigtermCount);
  });
});
