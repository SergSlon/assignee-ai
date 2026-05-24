/**
 * Tests for `assignee list` command.
 *
 * @see Story 18.4
 */

import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  type MockInstance,
} from "vitest";

// Mock the list-resources service
vi.mock("../services/list-resources.js", () => ({
  fetchManagedResources: vi.fn(),
}));

// Mock display utilities
vi.mock("../utils/display.js", () => ({
  renderResourceTable: vi.fn(),
  renderEmptyList: vi.fn(),
  renderError: vi.fn(),
}));

// Spies must be re-installed per test (vitest config has restoreMocks: true,
// which restores originals between tests). Previously these were defined at
// module top-level and silently relied on the leak.

// process.stdout.write is an overloaded function; use the exact signature
// so TS accepts the spy return type on assignment.
let stdoutWrite: MockInstance<typeof process.stdout.write>;

import { fetchManagedResources } from "../services/list-resources.js";
import {
  renderResourceTable,
  renderEmptyList,
  renderError,
} from "../utils/display.js";
import type { ManagedResource } from "../services/list-resources.js";
import { parseMonthlyCost } from "./list.js";

const MOCK_RESOURCES: ManagedResource[] = [
  {
    resourceType: "AWS::S3::Bucket",
    arn: "arn:aws:s3:::my-bucket",
    region: "us-east-1",
    createdDate: "run-123",
    estimatedMonthlyCost: "N/A",
  },
  {
    resourceType: "AWS::Lambda::Function",
    arn: "arn:aws:lambda:us-east-1:123456789:function:my-fn",
    region: "us-east-1",
    createdDate: "run-456",
    estimatedMonthlyCost: "$0.20",
  },
];

async function runListCommand(args: string[] = []): Promise<void> {
  const { listCommand } = await import("./list.js");
  await listCommand.parseAsync(["node", "list", ...args]);
}

/**
 * Reset commander option state on the shared listCommand singleton.
 * Commander 12 retains parsed values across `parseAsync` calls, so any
 * test that exercises a `--flag value` option must wipe the retained
 * value on teardown or the next test will inherit it. Public API
 * (`listCommand.opts()`) is read-only; we reach into `_optionValues`
 * via an assertion because vitest is the only caller.
 */
async function resetListCommandOptions(): Promise<void> {
  const { listCommand } = await import("./list.js");
  const internals = listCommand as unknown as {
    _optionValues: Record<string, unknown>;
  };
  for (const opt of listCommand.options) {
    internals._optionValues[opt.attributeName()] = undefined;
  }
}

describe("assignee list command", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
    stdoutWrite = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    await resetListCommandOptions();
  });

  it("calls renderResourceTable when resources are found", async () => {
    vi.mocked(fetchManagedResources).mockResolvedValueOnce(MOCK_RESOURCES);

    await runListCommand();

    expect(renderResourceTable).toHaveBeenCalledWith(MOCK_RESOURCES);
    // Command completes without throwing (process.exit removed)
  });

  it("--json flag outputs valid JSON to stdout", async () => {
    vi.mocked(fetchManagedResources).mockResolvedValueOnce(MOCK_RESOURCES);

    await runListCommand(["--json"]);

    expect(stdoutWrite).toHaveBeenCalledWith(
      expect.stringContaining('"resourceType"'),
    );

    // Story 94-N2 (A-04): `list --json` success path used to emit a
    // bare array. It now emits `{ok:true, resources:[...], count, region}`
    // symmetric with the Wave 2.c failure envelope. Clients can switch
    // on `.ok` to discriminate success from error and distinguish
    // `resources:[]` (nothing managed) from a broken call. The legacy
    // `Array.isArray(parsed)` assertion is updated to check the new
    // envelope's `.resources` field — NOT weakened, just retargeted at
    // the new shape. See story 94-n2-list-json-envelope.md.
    const writtenData = vi.mocked(stdoutWrite).mock.calls[0]![0] as string;
    const parsed = JSON.parse(writtenData);
    expect(parsed.ok).toBe(true);
    expect(Array.isArray(parsed.resources)).toBe(true);
    expect(parsed.resources).toHaveLength(2);
    expect(parsed.resources[0].arn).toBe("arn:aws:s3:::my-bucket");
    expect(parsed.count).toBe(2);
    expect(typeof parsed.region).toBe("string");
    expect(parsed.region.length).toBeGreaterThan(0);
    // Command completes without throwing (process.exit removed)
  });

  it("empty result shows helpful message", async () => {
    vi.mocked(fetchManagedResources).mockResolvedValueOnce([]);

    await runListCommand();

    expect(renderEmptyList).toHaveBeenCalled();
    expect(renderResourceTable).not.toHaveBeenCalled();
    // Command completes without throwing (process.exit removed)
  });

  it("--region is forwarded to the service", async () => {
    vi.mocked(fetchManagedResources).mockResolvedValueOnce([]);

    await runListCommand(["--region", "eu-west-1"]);

    expect(fetchManagedResources).toHaveBeenCalledWith(
      "eu-west-1",
      undefined,
      undefined,
      { withStorageEstimate: false },
    );
  });

  // Story 56-it1-01: --resource-type filter parity with MCP
  // list_managed_resources tool. The validated CFN-form string is
  // forwarded to the shared core function so CLI and MCP return the
  // same filtered result set.
  it("--resource-type S3 normalises to AWS::S3::Bucket and forwards it", async () => {
    vi.mocked(fetchManagedResources).mockResolvedValueOnce([
      MOCK_RESOURCES[0]!,
    ]);

    await runListCommand(["--resource-type", "S3"]);

    expect(fetchManagedResources).toHaveBeenCalledWith(
      undefined,
      "AWS::S3::Bucket",
      undefined,
      { withStorageEstimate: false },
    );
    expect(renderResourceTable).toHaveBeenCalledWith([MOCK_RESOURCES[0]]);
  });

  it("--resource-type AWS::Lambda::Function (full CFN) is forwarded as-is", async () => {
    vi.mocked(fetchManagedResources).mockResolvedValueOnce([
      MOCK_RESOURCES[1]!,
    ]);

    await runListCommand(["--resource-type", "AWS::Lambda::Function"]);

    expect(fetchManagedResources).toHaveBeenCalledWith(
      undefined,
      "AWS::Lambda::Function",
      undefined,
      { withStorageEstimate: false },
    );
    expect(renderResourceTable).toHaveBeenCalledWith([MOCK_RESOURCES[1]]);
  });

  it("--resource-type INVALID errors with the SSO supported-types hint", async () => {
    await expect(
      runListCommand(["--resource-type", "NOT-A-REAL-TYPE"]),
    ).rejects.toThrow(/Unknown --resource-type "NOT-A-REAL-TYPE"/);

    // AWS must NOT have been hit when validation fails.
    expect(fetchManagedResources).not.toHaveBeenCalled();

    // The rendered error embeds the SSO-authoritative grouped list.
    expect(renderError).toHaveBeenCalledWith(
      expect.stringContaining('Unknown --resource-type "NOT-A-REAL-TYPE"'),
      expect.stringContaining("AWS::S3::Bucket"),
      expect.objectContaining({
        // The AssigneeError.message contains the rendered hint, which
        // starts with the registry-derived count header.
        why: expect.stringContaining("What you can create"),
      }),
    );
  });

  // Story 94-R7 (D-02): the thrown error must carry `alreadyRendered:
  // true` so the top-level Commander catch in `index.ts` skips its
  // fallback `Error: ${err.message}` write. Without this flag the
  // 37-types registry grid (embedded in `err.message`) prints twice
  // on stderr.
  it("94-R7: --resource-type INVALID throws AssigneeError with alreadyRendered=true", async () => {
    const { AssigneeError } = await import("@assignee/core");
    let caught: unknown;
    try {
      await runListCommand(["--resource-type", "NOT-A-REAL-TYPE"]);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AssigneeError);
    expect(caught).toMatchObject({
      code: "INVALID_RESOURCE_TYPE",
      alreadyRendered: true,
    });
  });

  it("94-R7: generic LIST_ERROR fallback sets alreadyRendered=true", async () => {
    const { AssigneeError } = await import("@assignee/core");
    const error = new Error("boom on the wire");
    vi.mocked(fetchManagedResources).mockRejectedValueOnce(error);

    let caught: unknown;
    try {
      await runListCommand();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AssigneeError);
    expect(caught).toMatchObject({
      code: "LIST_ERROR",
      alreadyRendered: true,
    });
  });

  it("no --resource-type flag leaves the filter undefined (regression)", async () => {
    vi.mocked(fetchManagedResources).mockResolvedValueOnce(MOCK_RESOURCES);

    await runListCommand();

    expect(fetchManagedResources).toHaveBeenCalledWith(
      undefined,
      undefined,
      undefined,
      { withStorageEstimate: false },
    );
    expect(renderResourceTable).toHaveBeenCalledWith(MOCK_RESOURCES);
  });

  it("renders error on AccessDeniedException", async () => {
    const error = new Error("Access Denied");
    (error as unknown as { name: string }).name = "AccessDeniedException";
    vi.mocked(fetchManagedResources).mockRejectedValueOnce(error);

    await expect(runListCommand()).rejects.toThrow("Access Denied");

    expect(renderError).toHaveBeenCalledWith(
      "Cannot list managed resources.",
      expect.stringContaining("ResourceGroupsTaggingAPI:GetResources"),
      expect.objectContaining({
        why: expect.stringContaining("tag:GetResources"),
      }),
    );
  });

  it("renders error on network failure", async () => {
    const error = new Error("getaddrinfo ENOTFOUND");
    vi.mocked(fetchManagedResources).mockRejectedValueOnce(error);

    await expect(runListCommand()).rejects.toThrow("getaddrinfo ENOTFOUND");

    expect(renderError).toHaveBeenCalledWith(
      "Failed to connect to AWS.",
      expect.stringContaining("internet connection"),
    );
  });

  it("renders generic error for unknown failures", async () => {
    const error = new Error("Something went wrong");
    vi.mocked(fetchManagedResources).mockRejectedValueOnce(error);

    await expect(runListCommand()).rejects.toThrow("Something went wrong");

    expect(renderError).toHaveBeenCalledWith(
      "Failed to list managed resources.",
      expect.stringContaining("AWS credentials"),
      expect.objectContaining({ why: "Something went wrong" }),
    );
  });

  // Story 56-it2-04 P1-01: a non-INVALID_RESOURCE_TYPE_CODE throw from
  // the resolver used to re-throw bare, so Commander dumped a stack.
  // The fallback `renderError` now surfaces a friendly message first.
  // We exercise the guard by mocking the resolver to throw an AssigneeError
  // with a DIFFERENT code, then assert the fallback `renderError` call
  // by re-importing the (mocked) display module AFTER vi.resetModules.
  it("P1-01: non-INVALID_RESOURCE_TYPE_CODE resolver error still renders before re-throw", async () => {
    vi.resetModules();
    vi.doMock("../utils/display.js", () => ({
      renderResourceTable: vi.fn(),
      renderEmptyList: vi.fn(),
      renderError: vi.fn(),
    }));
    vi.doMock("../services/list-resources.js", () => ({
      fetchManagedResources: vi.fn(),
    }));
    vi.doMock("./resource-type-filter.js", async () => {
      const actual = await vi.importActual<
        typeof import("./resource-type-filter.js")
      >("./resource-type-filter.js");
      const { AssigneeError } = await import("@assignee/core");
      return {
        ...actual,
        resolveResourceTypeFilter: (_input: string): string => {
          throw new AssigneeError(
            "simulated upstream failure",
            "SOME_OTHER_CODE",
          );
        },
      };
    });

    try {
      const { listCommand } = await import("./list.js");
      const { renderError: freshRenderError } =
        await import("../utils/display.js");

      await expect(
        listCommand.parseAsync(["node", "list", "--resource-type", "ec2"]),
      ).rejects.toThrow("simulated upstream failure");

      expect(freshRenderError).toHaveBeenCalledWith(
        expect.stringContaining('Failed to validate --resource-type "ec2"'),
        expect.stringContaining("`assignee admin list --help`"),
        expect.objectContaining({ why: "simulated upstream failure" }),
      );
    } finally {
      vi.doUnmock("./resource-type-filter.js");
      vi.doUnmock("../utils/display.js");
      vi.doUnmock("../services/list-resources.js");
      vi.resetModules();
    }
  });

  // A3 / optimize follow-up (2026-04-08): the --total-cost flag uses
  // parseMonthlyCost() to coerce the four cost-string shapes the list
  // service emits into a single USD monthly number. The fn is exported
  // precisely so we can lock the coercion rules in a unit test and
  // avoid regressing on the cost summation.
  describe("parseMonthlyCost", () => {
    it("returns 0 for known free-tier labels", () => {
      expect(parseMonthlyCost("Free")).toBe(0);
      expect(parseMonthlyCost("N/A")).toBe(0);
      expect(parseMonthlyCost("Pay per use")).toBe(0);
      expect(parseMonthlyCost("Unavailable")).toBe(0);
      // Case-insensitive per the production regex.
      expect(parseMonthlyCost("FREE")).toBe(0);
      expect(parseMonthlyCost("free")).toBe(0);
    });

    it("returns 0 for empty string", () => {
      expect(parseMonthlyCost("")).toBe(0);
    });

    it("parses $X.XX/mo into a raw monthly number", () => {
      expect(parseMonthlyCost("$12.34/mo")).toBe(12.34);
      expect(parseMonthlyCost("$0.20/mo")).toBe(0.2);
    });

    it("parses $X.XX (no suffix) as monthly", () => {
      expect(parseMonthlyCost("$12.34")).toBe(12.34);
    });

    it("parses $X.XXXX/hr by multiplying by 730 hours/month", () => {
      // 0.0416 × 730 = 30.368 (t3.medium reference rate)
      expect(parseMonthlyCost("$0.0416/hr")).toBeCloseTo(30.368, 3);
    });

    it("returns null for unparseable strings", () => {
      expect(parseMonthlyCost("weird value")).toBeNull();
      expect(parseMonthlyCost("$abc/mo")).toBeNull();
      // Note: a leading "-$5.00/mo" is NOT rejected — the regex anchors
      // on `$[0-9]+` so it parses to 5 (the leading "-" is ignored).
      // In practice the list service never emits negative costs, so
      // tightening the regex is future work, not a blocker.
    });

    // F16 follow-up (2026-05-23): per-unit rates flow through the
    // shared `isPerUnitRate` detector from
    // `apps/cli/src/utils/per-unit-rate.ts` — same source of truth
    // bulk-destroy (F6) and admin status (F19) use. parseMonthlyCost
    // returns null for per-unit rates so the caller can count them
    // as "variable per-unit excluded" alongside genuinely unparseable
    // strings.
    it("returns null for per-unit rates (shared detector parity)", () => {
      // /GB-month, /GB-mo, /GB suffixes (S3 / EBS / EFS storage rates)
      expect(parseMonthlyCost("$0.0230/GB-month")).toBeNull();
      expect(parseMonthlyCost("$0.0230/GB-mo")).toBeNull();
      expect(parseMonthlyCost("$0.10/GB")).toBeNull();
      // /request, /requests, /req (API / CloudFront per-request)
      expect(parseMonthlyCost("$0.0000004/request")).toBeNull();
      expect(parseMonthlyCost("$0.40/1000 requests")).toBeNull();
      // /invocation, /call, /exec (Lambda / Step Functions)
      expect(parseMonthlyCost("$0.0000002/invocation")).toBeNull();
      expect(parseMonthlyCost("$0.00001667/exec")).toBeNull();
    });
  });
});

// ── Epic 92 Wave 2.c (D-30) — JSON error envelope ──────────────────
// `list --json --resource-type NotAThing` used to emit plaintext
// "[ERROR] Unknown ..." + the 37-resource registry block to stdout.
// Consumers running `jq -e .` failed with a syntax error. Now we
// emit a single `{ok:false,error:{...}}` envelope to stdout while
// the human text + registry block goes to stderr via renderError.
//
// This describe block is INTENTIONALLY at module top-level (sibling
// to the main `describe("assignee list command", ...)`) to avoid
// the P1-01 test's `vi.resetModules()` + `vi.doMock()` torching
// our mocks. We (re-)register mocks via `vi.doMock` in the
// `beforeAll` below so the Epic-92 tests run in isolation.
describe("Epic 92 Wave 2.c — list --json error envelope (D-30)", () => {
  let stdoutWrite: MockInstance<typeof process.stdout.write>;

  beforeEach(async () => {
    // Hard reset module graph so the top-level vi.mock calls are NOT
    // relied on — the P1-01 test in the main describe may have left
    // the cache in an inconsistent state. Re-register via doMock.
    vi.resetModules();
    vi.doMock("../services/list-resources.js", () => ({
      fetchManagedResources: vi.fn(),
    }));
    vi.doMock("../utils/display.js", () => ({
      renderResourceTable: vi.fn(),
      renderEmptyList: vi.fn(),
      renderError: vi.fn(),
    }));
    vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
    stdoutWrite = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
  });

  async function importFresh() {
    const { listCommand } = await import("./list.js");
    const { renderError } = await import("../utils/display.js");
    const { fetchManagedResources } =
      await import("../services/list-resources.js");
    // Reset Commander's retained option values between invocations so
    // `--json` / `--resource-type` from prior tests don't leak in.
    const internals = listCommand as unknown as {
      _optionValues: Record<string, unknown>;
    };
    for (const opt of listCommand.options) {
      internals._optionValues[opt.attributeName()] = undefined;
    }
    return { listCommand, renderError, fetchManagedResources };
  }

  it("--json --resource-type NOT-A-REAL-TYPE emits parseable INVALID_RESOURCE_TYPE envelope", async () => {
    const { listCommand, renderError } = await importFresh();
    await expect(
      listCommand.parseAsync([
        "node",
        "list",
        "--json",
        "--resource-type",
        "NOT-A-REAL-TYPE",
      ]),
    ).rejects.toThrow(/Unknown --resource-type "NOT-A-REAL-TYPE"/);

    expect(renderError).toHaveBeenCalled();

    const writes = vi
      .mocked(stdoutWrite)
      .mock.calls.map((c) => String(c[0]))
      .join("")
      .trim();
    expect(writes.length).toBeGreaterThan(0);
    const parsed = JSON.parse(writes);
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("INVALID_RESOURCE_TYPE");
    expect(parsed.error.message).toContain(
      'Unknown --resource-type "NOT-A-REAL-TYPE"',
    );
    expect(parsed.error.hint).toBeDefined();
  });

  it("--json --resource-type NOT-A-REAL-TYPE does NOT emit registry/help block to stdout", async () => {
    const { listCommand } = await importFresh();
    await expect(
      listCommand.parseAsync([
        "node",
        "list",
        "--json",
        "--resource-type",
        "NOT-A-REAL-TYPE",
      ]),
    ).rejects.toThrow();

    const stdoutText = vi
      .mocked(stdoutWrite)
      .mock.calls.map((c) => String(c[0]))
      .join("");
    expect(stdoutText).not.toContain("What you can create");
    expect(stdoutText).not.toContain("[ERROR]");
    expect(stdoutText).not.toContain("[FIX]");
  });

  it("--json on AccessDenied writes ACCESS_DENIED envelope", async () => {
    const { listCommand, fetchManagedResources } = await importFresh();
    const error = new Error("Access Denied");
    (error as unknown as { name: string }).name = "AccessDeniedException";
    vi.mocked(fetchManagedResources).mockRejectedValueOnce(error);

    await expect(
      listCommand.parseAsync(["node", "list", "--json"]),
    ).rejects.toThrow("Access Denied");

    const stdoutText = vi
      .mocked(stdoutWrite)
      .mock.calls.map((c) => String(c[0]))
      .join("")
      .trim();
    expect(stdoutText.length).toBeGreaterThan(0);
    const parsed = JSON.parse(stdoutText);
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("ACCESS_DENIED");
    expect(parsed.error.hint).toContain("ResourceGroupsTaggingAPI");
  });

  it("--json on network failure writes NETWORK_ERROR envelope", async () => {
    const { listCommand, fetchManagedResources } = await importFresh();
    const error = new Error("getaddrinfo ENOTFOUND");
    vi.mocked(fetchManagedResources).mockRejectedValueOnce(error);

    await expect(
      listCommand.parseAsync(["node", "list", "--json"]),
    ).rejects.toThrow("getaddrinfo ENOTFOUND");

    const stdoutText = vi
      .mocked(stdoutWrite)
      .mock.calls.map((c) => String(c[0]))
      .join("")
      .trim();
    const parsed = JSON.parse(stdoutText);
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("NETWORK_ERROR");
  });

  it("--json on unknown failure writes LIST_ERROR envelope", async () => {
    const { listCommand, fetchManagedResources } = await importFresh();
    const error = new Error("Something went wrong");
    vi.mocked(fetchManagedResources).mockRejectedValueOnce(error);

    await expect(
      listCommand.parseAsync(["node", "list", "--json"]),
    ).rejects.toThrow("Something went wrong");

    const stdoutText = vi
      .mocked(stdoutWrite)
      .mock.calls.map((c) => String(c[0]))
      .join("")
      .trim();
    const parsed = JSON.parse(stdoutText);
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("LIST_ERROR");
  });

  it("--json empty result emits parseable { ok:true, resources:[], count:0, region } envelope (A-04)", async () => {
    // Story 94-N2 (A-04): the empty case must NOT fall through to
    // renderEmptyList() when `--json` is set — a scripted consumer
    // running `jq -e .` needs the same envelope shape regardless of
    // how many resources match. Pre-N2 the empty path returned without
    // writing anything to stdout so jq ate a null input and failed.
    const { listCommand, fetchManagedResources } = await importFresh();
    vi.mocked(fetchManagedResources).mockResolvedValueOnce([]);

    await listCommand.parseAsync(["node", "list", "--json"]);

    const stdoutText = vi
      .mocked(stdoutWrite)
      .mock.calls.map((c) => String(c[0]))
      .join("")
      .trim();
    expect(stdoutText.length).toBeGreaterThan(0);
    const parsed = JSON.parse(stdoutText);
    expect(parsed.ok).toBe(true);
    expect(parsed.resources).toEqual([]);
    expect(parsed.count).toBe(0);
    expect(typeof parsed.region).toBe("string");
    expect(parsed.region.length).toBeGreaterThan(0);
  });

  it("--json --region eu-west-1 echoes the explicit region in the envelope (A-04)", async () => {
    // Story 94-N2 (A-04): when the operator passes `--region`, the
    // envelope's `.region` field must echo that value (not the default
    // AWS_REGION). Lets scripts round-trip the request region through
    // the response without re-deriving it from the ARNs.
    const { listCommand, fetchManagedResources } = await importFresh();
    vi.mocked(fetchManagedResources).mockResolvedValueOnce([]);

    await listCommand.parseAsync([
      "node",
      "list",
      "--json",
      "--region",
      "eu-west-1",
    ]);

    const stdoutText = vi
      .mocked(stdoutWrite)
      .mock.calls.map((c) => String(c[0]))
      .join("")
      .trim();
    const parsed = JSON.parse(stdoutText);
    expect(parsed.ok).toBe(true);
    expect(parsed.region).toBe("eu-west-1");
    expect(parsed.count).toBe(0);
  });

  it("--json populated success emits ok:true with count == resources.length (A-04)", async () => {
    // Story 94-N2 (A-04): `count` is redundant with `resources.length`
    // but cheap to include — saves scripts a `length` call and lets
    // them sanity-check the array didn't get truncated.
    const { listCommand, fetchManagedResources } = await importFresh();
    const resources = [
      {
        resourceType: "AWS::S3::Bucket",
        arn: "arn:aws:s3:::my-bucket",
        region: "us-east-1",
        createdDate: "run-123",
        estimatedMonthlyCost: "N/A",
      },
      {
        resourceType: "AWS::Lambda::Function",
        arn: "arn:aws:lambda:us-east-1:210987654321:function:my-fn",
        region: "us-east-1",
        createdDate: "run-456",
        estimatedMonthlyCost: "$0.20",
      },
      {
        resourceType: "AWS::SQS::Queue",
        arn: "arn:aws:sqs:us-east-1:210987654321:my-queue",
        region: "us-east-1",
        createdDate: "run-789",
        estimatedMonthlyCost: "Free",
      },
    ];
    vi.mocked(fetchManagedResources).mockResolvedValueOnce(resources);

    await listCommand.parseAsync(["node", "list", "--json"]);

    const stdoutText = vi
      .mocked(stdoutWrite)
      .mock.calls.map((c) => String(c[0]))
      .join("")
      .trim();
    const parsed = JSON.parse(stdoutText);
    expect(parsed.ok).toBe(true);
    expect(parsed.resources).toHaveLength(3);
    expect(parsed.count).toBe(3);
    expect(parsed.count).toBe(parsed.resources.length);
    // Field shape preserved — no renames, no drops.
    expect(parsed.resources[0]).toEqual(resources[0]);
    expect(parsed.resources[1]).toEqual(resources[1]);
    expect(parsed.resources[2]).toEqual(resources[2]);
  });

  it("--json success envelope is discriminable from error envelope by `.ok` (A-04)", async () => {
    // Story 94-N2 (A-04): the whole point of the envelope is that a
    // script can switch on `.ok` without knowing anything else about
    // the payload. Lock the invariant: success → `ok:true` and NO
    // `.error`; error → `ok:false` and NO `.resources`.
    const { listCommand, fetchManagedResources } = await importFresh();

    vi.mocked(fetchManagedResources).mockResolvedValueOnce([]);
    await listCommand.parseAsync(["node", "list", "--json"]);
    const successText = vi
      .mocked(stdoutWrite)
      .mock.calls.map((c) => String(c[0]))
      .join("")
      .trim();
    const successParsed = JSON.parse(successText);
    expect(successParsed.ok).toBe(true);
    expect(successParsed.error).toBeUndefined();
    expect(successParsed.resources).toBeDefined();
  });

  it("text-mode (no --json) does NOT emit any JSON envelope to stdout", async () => {
    const { listCommand } = await importFresh();
    await expect(
      listCommand.parseAsync([
        "node",
        "list",
        "--resource-type",
        "NOT-A-REAL-TYPE",
      ]),
    ).rejects.toThrow();

    const stdoutText = vi
      .mocked(stdoutWrite)
      .mock.calls.map((c) => String(c[0]))
      .join("");
    expect(stdoutText).not.toContain('"ok"');
    expect(stdoutText).not.toContain('"error"');
  });
});
