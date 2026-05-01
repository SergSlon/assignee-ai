/**
 * Tests for renderHitlConfirm, renderAdvancedConfirm, spinner functions,
 * renderDocHelp (Story 7.5), and renderTradeoffHelp (Story 10.6).
 *
 * Split from display.test.ts (W19-S1).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { StructuredTool } from "@langchain/core/tools";
import { mockState } from "./__tests__/display-test-utils.js";

// ── @clack/prompts mock ───────────────────────────────────────────────────────

vi.mock("@clack/prompts", () => ({
  confirm: vi.fn(),
  select: vi.fn(),
  text: vi.fn(),
  multiselect: vi.fn(),
  autocomplete: vi.fn(),
  autocompleteMultiselect: vi.fn(),
  isCancel: vi.fn(() => false),
  cancel: vi.fn(),
  note: vi.fn(),
  log: { info: vi.fn() },
}));

const { confirm, isCancel, note, log } = await import("@clack/prompts");

// ── makeTool helper ───────────────────────────────────────────────────────────

function makeTool(
  name: string,
  invokeFn: () => Promise<unknown>,
): StructuredTool {
  // Each test creates a fresh tool via this helper, and some tests assert
  // on `.toHaveBeenCalledOnce()`, so we need a real `vi.fn()`. Pass the
  // implementation directly to the constructor (vi.fn(impl)) — this binds
  // the implementation as the default that survives intra-test usage.
  return {
    name,
    description: "",
    invoke: vi.fn(invokeFn),
  } as unknown as StructuredTool;
}

// ── renderHitlConfirm — TTY mode ──────────────────────────────────────────────

describe("renderHitlConfirm — TTY mode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(process.stdin, "isTTY", {
      value: true,
      configurable: true,
    });
  });
  afterEach(() => {
    Object.defineProperty(process.stdin, "isTTY", {
      value: undefined,
      configurable: true,
    });
  });

  it("user approves — returns true", async () => {
    vi.mocked(confirm).mockResolvedValueOnce(true);
    const { renderHitlConfirm } = await import("./display.js");
    const result = await renderHitlConfirm(mockState);
    expect(result).toBe(true);
  });

  it("user rejects — returns false", async () => {
    vi.mocked(confirm).mockResolvedValueOnce(false);
    const { renderHitlConfirm } = await import("./display.js");
    const result = await renderHitlConfirm(mockState);
    expect(result).toBe(false);
  });

  it("throws UserCancelledError when user cancels", async () => {
    vi.mocked(confirm).mockResolvedValueOnce(
      Symbol("cancel") as unknown as boolean,
    );
    vi.mocked(isCancel).mockReturnValueOnce(true);
    const { renderHitlConfirm } = await import("./display.js");
    await expect(renderHitlConfirm(mockState)).rejects.toThrow(
      "Operation cancelled by user.",
    );
  });
});

// ── renderHitlConfirm — non-TTY mode ─────────────────────────────────────────

describe("renderHitlConfirm — non-TTY mode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(process.stdin, "isTTY", {
      value: false,
      configurable: true,
    });
  });
  afterEach(() => {
    Object.defineProperty(process.stdin, "isTTY", {
      value: undefined,
      configurable: true,
    });
  });

  it("returns false without prompting", async () => {
    const { renderHitlConfirm } = await import("./display.js");
    const result = await renderHitlConfirm(mockState);
    expect(result).toBe(false);
    expect(confirm).not.toHaveBeenCalled();
  });
});

// ── renderHitlConfirm — TTY mode (duplicate describe, second set) ─────────────

describe("renderHitlConfirm — TTY mode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(process.stdin, "isTTY", {
      value: true,
      configurable: true,
    });
  });
  afterEach(() => {
    Object.defineProperty(process.stdin, "isTTY", {
      value: undefined,
      configurable: true,
    });
  });

  it("user approves — returns true", async () => {
    vi.mocked(confirm).mockResolvedValueOnce(true);
    const { renderHitlConfirm } = await import("./display.js");
    const result = await renderHitlConfirm(mockState);
    expect(result).toBe(true);
  });

  it("user rejects — returns false", async () => {
    vi.mocked(confirm).mockResolvedValueOnce(false);
    const { renderHitlConfirm } = await import("./display.js");
    const result = await renderHitlConfirm(mockState);
    expect(result).toBe(false);
  });

  it("throws UserCancelledError when user cancels", async () => {
    vi.mocked(confirm).mockResolvedValueOnce(
      Symbol("cancel") as unknown as boolean,
    );
    vi.mocked(isCancel).mockReturnValueOnce(true);
    const { renderHitlConfirm } = await import("./display.js");
    await expect(renderHitlConfirm(mockState)).rejects.toThrow(
      "Operation cancelled by user.",
    );
  });
});

// ── renderHitlConfirm — non-TTY mode (duplicate describe, second set) ────────

describe("renderHitlConfirm — non-TTY mode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(process.stdin, "isTTY", {
      value: false,
      configurable: true,
    });
  });
  afterEach(() => {
    Object.defineProperty(process.stdin, "isTTY", {
      value: undefined,
      configurable: true,
    });
  });

  it("returns false without prompting", async () => {
    const { renderHitlConfirm } = await import("./display.js");
    const result = await renderHitlConfirm(mockState);
    expect(result).toBe(false);
    expect(confirm).not.toHaveBeenCalled();
  });
});

// ── spinner functions ─────────────────────────────────────────────────────────

describe("spinner functions", () => {
  it("startSpinner non-TTY — writes label to stdout", async () => {
    Object.defineProperty(process.stdout, "isTTY", {
      value: false,
      configurable: true,
    });
    const writeSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    const { startSpinner } = await import("./display.js");
    startSpinner("Loading...");
    expect(writeSpy).toHaveBeenCalledWith("Loading......\n");
    writeSpy.mockRestore();
    Object.defineProperty(process.stdout, "isTTY", {
      value: undefined,
      configurable: true,
    });
  });

  it("updateSpinner non-TTY — writes label to stdout", async () => {
    Object.defineProperty(process.stdout, "isTTY", {
      value: false,
      configurable: true,
    });
    const writeSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    const { updateSpinner } = await import("./display.js");
    updateSpinner("Still loading...");
    expect(writeSpy).toHaveBeenCalledWith("Still loading......\n");
    writeSpy.mockRestore();
    Object.defineProperty(process.stdout, "isTTY", {
      value: undefined,
      configurable: true,
    });
  });
});

// ── renderAdvancedConfirm ─────────────────────────────────────────────────────

describe("renderAdvancedConfirm", () => {
  it("non-TTY — returns false", async () => {
    vi.clearAllMocks();
    Object.defineProperty(process.stdin, "isTTY", {
      value: false,
      configurable: true,
    });
    const { renderAdvancedConfirm } = await import("./display.js");
    const result = await renderAdvancedConfirm();
    expect(result).toBe(false);
    expect(confirm).not.toHaveBeenCalled();
    Object.defineProperty(process.stdin, "isTTY", {
      value: undefined,
      configurable: true,
    });
  });

  it("TTY approve — returns true", async () => {
    Object.defineProperty(process.stdin, "isTTY", {
      value: true,
      configurable: true,
    });
    vi.mocked(confirm).mockResolvedValueOnce(true);
    const { renderAdvancedConfirm } = await import("./display.js");
    const result = await renderAdvancedConfirm();
    expect(result).toBe(true);
    Object.defineProperty(process.stdin, "isTTY", {
      value: undefined,
      configurable: true,
    });
  });

  it("TTY cancel — throws UserCancelledError", async () => {
    Object.defineProperty(process.stdin, "isTTY", {
      value: true,
      configurable: true,
    });
    vi.mocked(confirm).mockResolvedValueOnce(
      Symbol("cancel") as unknown as boolean,
    );
    vi.mocked(isCancel).mockReturnValueOnce(true);
    const { renderAdvancedConfirm } = await import("./display.js");
    await expect(renderAdvancedConfirm()).rejects.toThrow(
      "Operation cancelled by user.",
    );
    Object.defineProperty(process.stdin, "isTTY", {
      value: undefined,
      configurable: true,
    });
  });
});

// ── renderDocHelp tests (Story 7.5) ───────────────────────────────────────────

describe("renderDocHelp", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows fallback when search tool not in tools array and returns null", async () => {
    const { renderDocHelp } = await import("./display.js");

    const result = await renderDocHelp("BucketName", "AWS::S3::Bucket", []);

    expect(vi.mocked(log.info)).toHaveBeenCalledWith(
      expect.stringContaining("BucketName"),
    );
    expect(result).toBeNull();
  });

  it("shows fallback when search tool times out (returns null via race) and returns null", async () => {
    // Search tool never resolves — timeout wins
    const searchTool = makeTool(
      "search_documentation",
      () => new Promise(() => {}),
    );
    const readTool = makeTool("read_sections", () => Promise.resolve("text"));

    // Use fake timers to trigger the 2s timeout immediately
    vi.useFakeTimers();
    const { renderDocHelp } = await import("./display.js");
    const promise = renderDocHelp("BucketName", "AWS::S3::Bucket", [
      searchTool,
      readTool,
    ]);
    await vi.advanceTimersByTimeAsync(16000);
    const result = await promise;
    vi.useRealTimers();

    expect(vi.mocked(log.info)).toHaveBeenCalledWith(
      expect.stringContaining("timeout"),
    );
    expect(result).toBeNull();
  }, 12_000);

  it("shows fallback when search returns no URL", async () => {
    const searchTool = makeTool("search_documentation", () =>
      Promise.resolve("No results found."),
    );
    const readTool = makeTool("read_sections", () => Promise.resolve("text"));

    const { renderDocHelp } = await import("./display.js");
    await renderDocHelp("BucketName", "AWS::S3::Bucket", [
      searchTool,
      readTool,
    ]);

    expect(vi.mocked(log.info)).toHaveBeenCalledWith(
      expect.stringContaining("No documentation page found"),
    );
  });

  it("calls clack.note with description when search + read succeed and returns hint text", async () => {
    const searchTool = makeTool("search_documentation", () =>
      Promise.resolve(
        "See https://docs.aws.amazon.com/AmazonS3/latest/userguide/BucketName.html for details",
      ),
    );
    const readTool = makeTool("read_sections", () =>
      Promise.resolve(
        "The BucketName property specifies the name of the S3 bucket.",
      ),
    );

    const { renderDocHelp } = await import("./display.js");
    const result = await renderDocHelp("BucketName", "AWS::S3::Bucket", [
      searchTool,
      readTool,
    ]);

    expect(vi.mocked(note)).toHaveBeenCalledWith(
      expect.stringContaining("BucketName"),
      expect.stringContaining("📖 BucketName"),
    );
    expect(result).toEqual(
      expect.stringContaining("BucketName property specifies"),
    );
  });

  it("shows fallback when read_sections times out", async () => {
    const searchTool = makeTool("search_documentation", () =>
      Promise.resolve(
        "See https://docs.aws.amazon.com/AmazonS3/latest/userguide/BucketName.html for details",
      ),
    );
    // read_sections never resolves
    const readTool = makeTool("read_sections", () => new Promise(() => {}));

    vi.useFakeTimers();
    const { renderDocHelp } = await import("./display.js");
    const promise = renderDocHelp("BucketName", "AWS::S3::Bucket", [
      searchTool,
      readTool,
    ]);
    // advanceTimersByTimeAsync flushes pending microtasks between steps,
    // allowing the search result to resolve before the read timeout fires
    await vi.advanceTimersByTimeAsync(16000);
    await promise;
    vi.useRealTimers();

    expect(vi.mocked(log.info)).toHaveBeenCalledWith(
      expect.stringContaining("unreachable"),
    );
  }, 12_000);

  it("falls back to read_documentation when read_sections throws No matching sections", async () => {
    const searchTool = makeTool("search_documentation", () =>
      Promise.resolve(
        "See https://docs.aws.amazon.com/AmazonS3/latest/userguide/BucketName.html for details",
      ),
    );
    const readTool = makeTool("read_sections", () =>
      Promise.reject(new Error("No matching sections were found")),
    );
    const readDocTool = makeTool("read_documentation", () =>
      Promise.resolve("Full page content fallback"),
    );

    const { renderDocHelp } = await import("./display.js");
    await renderDocHelp("BucketName", "AWS::S3::Bucket", [
      searchTool,
      readTool,
      readDocTool,
    ]);

    expect(readDocTool.invoke).toHaveBeenCalledOnce();
    expect(vi.mocked(note)).toHaveBeenCalledWith(
      expect.stringContaining("Full page content fallback"),
      expect.stringContaining("📖 BucketName"),
    );
  });

  it("falls back to read_documentation when read_sections throws 'does not contain subsections'", async () => {
    // Live-reproduced error from aws-documentation-mcp-server on SubnetId page:
    // "This document does not contain subsections. Please use the read_documentation
    //  tool instead to get the full document content."
    const searchTool = makeTool("search_documentation", () =>
      Promise.resolve(
        "See https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-ec2-instance.html for details",
      ),
    );
    const readTool = makeTool("read_sections", () =>
      Promise.reject(
        new Error(
          "This document does not contain subsections. Please use the read_documentation tool instead to get the full document content.",
        ),
      ),
    );
    const readDocTool = makeTool("read_documentation", () =>
      Promise.resolve(
        "SubnetId: The ID of the subnet to launch the instance into.",
      ),
    );

    const { renderDocHelp } = await import("./display.js");
    await renderDocHelp("SubnetId", "AWS::EC2::Instance", [
      searchTool,
      readTool,
      readDocTool,
    ]);

    expect(readDocTool.invoke).toHaveBeenCalledOnce();
    expect(vi.mocked(note)).toHaveBeenCalledWith(
      expect.stringContaining("SubnetId"),
      expect.stringContaining("📖 SubnetId"),
    );
  });

  // ── Story 7.9: LLM synthesis tests ──────────────────────────────────────────

  describe("with llmClient", () => {
    const makeDocTools = () => ({
      searchTool: makeTool("search_documentation", () =>
        Promise.resolve(
          "See https://docs.aws.amazon.com/AmazonS3/latest/userguide/BucketName.html for more",
        ),
      ),
      readTool: makeTool("read_sections", () =>
        Promise.resolve(
          "BucketName specifies the raw CloudFormation property syntax for S3...",
        ),
      ),
    });

    it("calls generateText and displays synthesized hint when LLM succeeds, returns hint text", async () => {
      const { searchTool, readTool } = makeDocTools();
      const llmClient = {
        generateText: vi
          .fn()
          .mockResolvedValue([
            null,
            "BucketName is the globally unique S3 bucket identifier. It must be 3-63 lowercase characters. Choose a name like `my-company-logs`.",
          ] as const),
        generateStructured: vi.fn(),
      };

      const { renderDocHelp } = await import("./display.js");
      const result = await renderDocHelp(
        "BucketName",
        "AWS::S3::Bucket",
        [searchTool, readTool],
        llmClient,
      );

      expect(llmClient.generateText).toHaveBeenCalledOnce();
      expect(llmClient.generateText).toHaveBeenCalledWith(
        expect.stringContaining("BucketName"),
      );
      expect(vi.mocked(note)).toHaveBeenCalledWith(
        expect.stringContaining("globally unique"),
        expect.stringContaining("📖 BucketName"),
      );
      expect(result).toEqual(expect.stringContaining("globally unique"));
    });

    it("falls back to raw doc text when generateText returns an error", async () => {
      const { searchTool, readTool } = makeDocTools();
      const llmClient = {
        generateText: vi
          .fn()
          .mockResolvedValue([new Error("Bedrock throttled"), null] as const),
        generateStructured: vi.fn(),
      };

      const { renderDocHelp } = await import("./display.js");
      await renderDocHelp(
        "BucketName",
        "AWS::S3::Bucket",
        [searchTool, readTool],
        llmClient,
      );

      expect(llmClient.generateText).toHaveBeenCalledOnce();
      // Falls back — clack.note called with the raw unwrapped doc text, not synthesized text
      expect(vi.mocked(note)).toHaveBeenCalledWith(
        expect.stringContaining("BucketName specifies"),
        expect.stringContaining("📖 BucketName"),
      );
    });
  });
});

// ── renderTradeoffHelp tests (Story 10.6) ─────────────────────────────────────

describe("renderTradeoffHelp", () => {
  const testOptions = [
    { value: "t3.micro", label: "t3.micro — 2 vCPU, 1 GiB" },
    { value: "t3.small", label: "t3.small — 2 vCPU, 2 GiB" },
    { value: "m5.large", label: "m5.large — 2 vCPU, 8 GiB" },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls generateText and displays trade-off in clack.note on success, returns trimmed text", async () => {
    const llmClient = {
      generateText: vi
        .fn()
        .mockResolvedValue([
          null,
          "t3.micro: ~$8/mo, best for light workloads.\nt3.small: ~$15/mo, best for moderate traffic.\nRecommendation: t3.micro for a low-traffic blog.",
        ] as const),
      generateStructured: vi.fn(),
    };

    const { renderTradeoffHelp } = await import("./display.js");
    const result = await renderTradeoffHelp(
      "InstanceType",
      "AWS::EC2::Instance",
      testOptions,
      "low-traffic blog",
      [],
      llmClient,
    );

    expect(llmClient.generateText).toHaveBeenCalledOnce();
    expect(llmClient.generateText).toHaveBeenCalledWith(
      expect.stringContaining("low-traffic blog"),
    );
    expect(llmClient.generateText).toHaveBeenCalledWith(
      expect.stringContaining("InstanceType"),
    );
    expect(vi.mocked(note)).toHaveBeenCalledWith(
      expect.stringContaining("t3.micro"),
      expect.stringContaining("⚖️ InstanceType — Trade-off Analysis"),
    );
    expect(result).toEqual(expect.stringContaining("t3.micro"));
  });

  it("falls back to renderDocHelp when LLM times out (returns null)", async () => {
    // Simulate timeout: generateText never resolves within the timeout.
    // Plain function so vitest mockReset cannot strip the never-resolving body.
    const llmClient = {
      generateText: () => new Promise<never>(() => {}),
      generateStructured: vi.fn(),
    };

    vi.useFakeTimers();
    const { renderTradeoffHelp } = await import("./display.js");
    const promise = renderTradeoffHelp(
      "InstanceType",
      "AWS::EC2::Instance",
      testOptions,
      "low-traffic blog",
      [],
      llmClient,
    );
    await vi.advanceTimersByTimeAsync(11_000);
    await promise;
    vi.useRealTimers();

    // Should NOT have called clack.note with trade-off title
    const noteCallsWithTradeoff = vi
      .mocked(note)
      .mock.calls.filter(
        (c) => typeof c[1] === "string" && c[1].includes("Trade-off Analysis"),
      );
    expect(noteCallsWithTradeoff).toHaveLength(0);
  }, 15_000);

  it("falls back to renderDocHelp when llmClient is undefined", async () => {
    const { renderTradeoffHelp } = await import("./display.js");
    await renderTradeoffHelp(
      "InstanceType",
      "AWS::EC2::Instance",
      testOptions,
      "low-traffic blog",
      [],
      undefined,
    );

    // Should not render trade-off note (no llmClient → fallback path)
    const noteCallsWithTradeoff = vi
      .mocked(note)
      .mock.calls.filter(
        (c) => typeof c[1] === "string" && c[1].includes("Trade-off Analysis"),
      );
    expect(noteCallsWithTradeoff).toHaveLength(0);
  });

  it("falls back to renderDocHelp when generateText returns an error", async () => {
    const llmClient = {
      generateText: vi
        .fn()
        .mockResolvedValue([new Error("Bedrock throttled"), null] as const),
      generateStructured: vi.fn(),
    };

    const { renderTradeoffHelp } = await import("./display.js");
    await renderTradeoffHelp(
      "InstanceType",
      "AWS::EC2::Instance",
      testOptions,
      "low-traffic blog",
      [],
      llmClient,
    );

    expect(llmClient.generateText).toHaveBeenCalledOnce();
    // Should not render trade-off note (error → fallback path)
    const noteCallsWithTradeoff = vi
      .mocked(note)
      .mock.calls.filter(
        (c) => typeof c[1] === "string" && c[1].includes("Trade-off Analysis"),
      );
    expect(noteCallsWithTradeoff).toHaveLength(0);
  });
});
