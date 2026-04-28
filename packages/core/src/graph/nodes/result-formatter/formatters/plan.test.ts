/**
 * Epic 92 Wave 4 (e92.4.a) tests — plan formatter sanitation helpers.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ExecutionMode, ExecutionStatus } from "@/index.js";
import type { AgentState } from "@/graph/graph-state.js";
import { ProcessEnvConfigAdapter } from "@/config/config-port.js";
import { sanitizeDesiredState, normalizeMemoryHints } from "./plan.js";

vi.mock("@/utils/display.js", () => ({
  renderPlanBox: vi.fn(),
  promptFixSelection: vi.fn().mockResolvedValue(null),
}));

describe("sanitizeDesiredState (Epic 92 Wave 4.a / A-19)", () => {
  it("drops rows with empty-string values", () => {
    const input = {
      InstanceType: "t3.micro",
      CPUCredits: "",
      ImageId: "ami-0abc1234def567890",
    };
    const result = sanitizeDesiredState(input);
    expect(result).toEqual({
      InstanceType: "t3.micro",
      ImageId: "ami-0abc1234def567890",
    });
  });

  it("drops rows with undefined values", () => {
    const input = { InstanceType: "t3.micro", KeyName: undefined };
    const result = sanitizeDesiredState(input);
    expect(result).toEqual({ InstanceType: "t3.micro" });
    expect(Object.prototype.hasOwnProperty.call(result, "KeyName")).toBe(false);
  });

  it("drops rows with null values", () => {
    const input = { InstanceType: "t3.micro", SubnetId: null };
    expect(sanitizeDesiredState(input)).toEqual({ InstanceType: "t3.micro" });
  });

  it("preserves boolean false (deliberate disabled flag)", () => {
    const input = { EbsOptimized: false, Monitoring: true };
    expect(sanitizeDesiredState(input)).toEqual(input);
  });

  it("preserves numeric zero", () => {
    const input = { MinCount: 0, VolumeSize: 8 };
    expect(sanitizeDesiredState(input)).toEqual(input);
  });

  it("preserves empty arrays and empty objects", () => {
    const input = { Tags: [], BlockDeviceMappings: [], Metadata: {} };
    expect(sanitizeDesiredState(input)).toEqual(input);
  });

  it("returns empty object when input is an empty object", () => {
    expect(sanitizeDesiredState({})).toEqual({});
  });

  it("returns undefined when input is undefined", () => {
    expect(sanitizeDesiredState(undefined)).toBeUndefined();
  });

  it("handles mixed values in a single pass", () => {
    const input = {
      InstanceType: "t3.micro",
      CPUCredits: "",
      Monitoring: false,
      SubnetId: null,
      Tags: [],
      KeyName: undefined,
      ImageId: "ami-0abc1234def567890",
    };
    expect(sanitizeDesiredState(input)).toEqual({
      InstanceType: "t3.micro",
      Monitoring: false,
      Tags: [],
      ImageId: "ami-0abc1234def567890",
    });
  });
});

describe("normalizeMemoryHints (Epic 92 Wave 4.a / A-19 / D-35)", () => {
  it("collapses duplicate /month suffix on S3 GB-month hints", () => {
    expect(
      normalizeMemoryHints([
        "Previous provision of this type: $0.0230/GB-month/month (run abc, 4/15/2026).",
      ]),
    ).toEqual([
      "Previous provision of this type: $0.0230/GB-month (run abc, 4/15/2026).",
    ]);
  });

  it("collapses duplicate /mo suffix on Lambda monthly hints", () => {
    expect(normalizeMemoryHints(["Previous provision: $3.00/mo/mo"])).toEqual([
      "Previous provision: $3.00/mo",
    ]);
  });

  it("collapses mixed /month/mo (first wins)", () => {
    expect(normalizeMemoryHints(["Previous provision: $5/month/mo"])).toEqual([
      "Previous provision: $5/month",
    ]);
  });

  it("collapses mixed /mo/month (first wins)", () => {
    expect(normalizeMemoryHints(["Previous provision: $5/mo/month"])).toEqual([
      "Previous provision: $5/mo",
    ]);
  });

  it("collapses triple-repeat $N/mo/mo/mo via repeated passes", () => {
    expect(normalizeMemoryHints(["$7.50/mo/mo/mo"])).toEqual(["$7.50/mo"]);
  });

  it("passes already-clean lines through unchanged", () => {
    const input = [
      "Previous provision: $3.00/mo",
      "Previous provision: $0.0230/GB-month",
      "Previous provision: Free",
    ];
    expect(normalizeMemoryHints(input)).toEqual(input);
  });

  it("preserves the comma/period/paren trailing punctuation", () => {
    expect(normalizeMemoryHints(["$0.0230/GB-month/month, run abc."])).toEqual([
      "$0.0230/GB-month, run abc.",
    ]);
  });

  it("does not touch URL-like paths (no whitespace boundary)", () => {
    const input = ["See https://example.com/month/api for details"];
    expect(normalizeMemoryHints(input)).toEqual(input);
  });

  it("leaves single /month / /mo suffixes intact", () => {
    const input = ["Previous provision: $3.00/month"];
    expect(normalizeMemoryHints(input)).toEqual(input);
  });

  it("returns undefined for undefined input", () => {
    expect(normalizeMemoryHints(undefined)).toBeUndefined();
  });

  it("returns empty array for empty input", () => {
    expect(normalizeMemoryHints([])).toEqual([]);
  });

  it("normalizes each hint in a multi-hint array", () => {
    expect(
      normalizeMemoryHints([
        "$1.00/mo/mo",
        "Failures: 2 in last 24h",
        "$0.0230/GB-month/month",
      ]),
    ).toEqual(["$1.00/mo", "Failures: 2 in last 24h", "$0.0230/GB-month"]);
  });
});

describe("formatPlanResult JSON output (Epic 92 Wave 4.a)", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let stdoutSpy: any;
  let captured: string;

  beforeEach(() => {
    captured = "";
    stdoutSpy = vi
      .spyOn(process.stdout, "write")
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .mockImplementation((chunk: any) => {
        captured += String(chunk);
        return true;
      });
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
  });

  function makeState(overrides: Partial<AgentState> = {}): AgentState {
    return {
      userIntent: "create an ec2 instance",
      runId: "e92-4a-test-run",
      executionMode: ExecutionMode.PLAN,
      executionStatus: ExecutionStatus.PENDING,
      outputFormat: "json",
      resourceType: "AWS::EC2::Instance",
      preflightPassed: false,
      preflightErrors: [],
      preflightMode: "local",
      messages: [],
      // RW4b-3: ConfigPort threaded through state — buildPlanJsonPayload
      // reads `state.config` for region resolution.
      config: new ProcessEnvConfigAdapter(),
      ...overrides,
    } as AgentState;
  }

  it("strips empty-valued rows from desiredState in JSON payload (A-19)", async () => {
    const { formatPlanResult } = await import("./plan.js");
    await formatPlanResult(
      makeState({
        desiredState: {
          InstanceType: "t3.micro",
          CPUCredits: "",
          ImageId: "ami-0abc1234def567890",
          KeyName: undefined,
        },
      }),
    );
    const payload = JSON.parse(captured.trim()) as {
      desiredState: Record<string, unknown>;
    };
    expect(payload.desiredState).toEqual({
      InstanceType: "t3.micro",
      ImageId: "ami-0abc1234def567890",
    });
  });

  it("preserves boolean false and numeric zero in JSON payload", async () => {
    const { formatPlanResult } = await import("./plan.js");
    await formatPlanResult(
      makeState({
        desiredState: {
          InstanceType: "t3.micro",
          EbsOptimized: false,
          MinCount: 0,
        },
      }),
    );
    const payload = JSON.parse(captured.trim()) as {
      desiredState: Record<string, unknown>;
    };
    expect(payload.desiredState).toEqual({
      InstanceType: "t3.micro",
      EbsOptimized: false,
      MinCount: 0,
    });
  });

  it("emits null for desiredState when state has no desiredState", async () => {
    const { formatPlanResult } = await import("./plan.js");
    await formatPlanResult(makeState({ desiredState: undefined }));
    const payload = JSON.parse(captured.trim()) as { desiredState: unknown };
    expect(payload.desiredState).toBeNull();
  });
});
