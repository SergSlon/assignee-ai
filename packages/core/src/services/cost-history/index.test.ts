/**
 * Unit tests for the cost-history scoping service (Epic 92 Wave 4.c).
 *
 * Covers the four capabilities owned by this module:
 *   1. Stable intent hashing + scope derivation.
 *   2. Negative-filter `scopeMatches` — closes F-CROSS-001 without
 *      regressing backward-compat for legacy records.
 *   3. The sidecar join (`CostHistoryStore` + `joinWithScope`) that
 *      threads `intentHash / projectDir / desiredName` into canonical
 *      provision + failure reads without modifying their Zod schemas.
 *   4. The F-D-34 helpers: name extraction (state + error message)
 *      and the AWS SDK metadata scrub.
 *
 * Fixtures mirror the F-CROSS-001 leak observed during Epic 92
 * dogfooding (`_bmad-output/implementation-artifacts/epic-92-findings-d.md`):
 * a slice-A provision of `dogfood-e92-a-s3-1776800919` bleeding into a
 * slice-D plan in a different projectDir.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { MemoryService } from "@/services/memory.js";
import { RESOURCE_TYPES } from "@/index.js";
import type { ProvisionRecord, FailureRecord } from "@/schema/memory.js";
import type { AgentState } from "@/graph/graph-state.js";
import {
  computeIntentHash,
  scopeOfState,
  scopeMatches,
  joinWithScope,
  CostHistoryStore,
  readScopedProvisions,
  readScopedFailures,
  readScopedProvisionHintLine,
  scrubEmptyErrorMetadata,
  extractDesiredNameFromState,
  extractDesiredNameFromErrorMessage,
  type ScopeIndexEntry,
} from "./index.js";

// ── Fixtures ───────────────────────────────────────────────────────────────

function makeState(overrides: Partial<AgentState> = {}): AgentState {
  return {
    userIntent: "Create an S3 bucket named payments-prod",
    runId: "550e8400-e29b-41d4-a716-446655440000",
    resourceType: RESOURCE_TYPES.S3_BUCKET,
    projectDir: "/home/user/slice-d",
    desiredState: undefined,
    ...overrides,
  } as unknown as AgentState;
}

function makeProvision(
  overrides: Partial<ProvisionRecord> = {},
): ProvisionRecord {
  return {
    runId: "550e8400-e29b-41d4-a716-446655440000",
    resourceType: RESOURCE_TYPES.S3_BUCKET,
    resourceArn: "arn:aws:s3:::payments-prod",
    region: "us-east-1",
    desiredStateHash: "abc123",
    estimatedMonthlyCost: "$0.023/GB-month",
    timestamp: "2026-04-18T10:00:00.000Z",
    ...overrides,
  };
}

function makeFailure(overrides: Partial<FailureRecord> = {}): FailureRecord {
  return {
    runId: "660e8400-e29b-41d4-a716-446655440001",
    resourceType: RESOURCE_TYPES.S3_BUCKET,
    errorCode: "AlreadyExists",
    errorMessage:
      "dogfood-e92-a-s3-1776800919 already exists (Service: S3, Status Code: 0, Request ID: null)",
    suggestedFix: "Use a different bucket name",
    timestamp: "2026-04-18T12:00:00.000Z",
    ...overrides,
  };
}

function makeSidecarEntry(
  overrides: Partial<ScopeIndexEntry> = {},
): ScopeIndexEntry {
  return {
    runId: "550e8400-e29b-41d4-a716-446655440000",
    resourceType: RESOURCE_TYPES.S3_BUCKET,
    intentHash: "intent-a",
    projectDir: "/home/user/slice-a",
    desiredName: "dogfood-e92-a-s3-1776800919",
    timestamp: "2026-04-18T10:00:00.000Z",
    ...overrides,
  };
}

let storeDir: string;
let memoryDir: string;
let memory: MemoryService;
let store: CostHistoryStore;

beforeEach(async () => {
  storeDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "assignee-cost-history-store-"),
  );
  memoryDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "assignee-cost-history-mem-"),
  );
  memory = new MemoryService(memoryDir);
  store = new CostHistoryStore(storeDir);
});

afterEach(async () => {
  await fs.rm(storeDir, { recursive: true, force: true });
  await fs.rm(memoryDir, { recursive: true, force: true });
});

// ── computeIntentHash ──────────────────────────────────────────────────────

describe("computeIntentHash", () => {
  it("returns a stable sha256 hex digest for the same normalised intent", () => {
    const a = computeIntentHash("Create an S3 bucket");
    const b = computeIntentHash("  CREATE AN S3 BUCKET  ");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("returns different hashes for materially different intents", () => {
    const a = computeIntentHash("Create an S3 bucket named foo");
    const b = computeIntentHash("Create an S3 bucket named bar");
    expect(a).not.toBe(b);
  });

  it("returns empty string for undefined / empty / whitespace intents", () => {
    expect(computeIntentHash(undefined)).toBe("");
    expect(computeIntentHash("")).toBe("");
    expect(computeIntentHash("   ")).toBe("");
    expect(computeIntentHash("\n\t")).toBe("");
  });
});

// ── scopeOfState ───────────────────────────────────────────────────────────

describe("scopeOfState", () => {
  it("derives both axes when userIntent + projectDir are set", () => {
    const scope = scopeOfState(
      makeState({
        userIntent: "Create bucket",
        projectDir: "/home/user/proj",
      }),
    );
    expect(scope.intentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(scope.projectDir).toBe("/home/user/proj");
  });

  it("returns undefined intentHash when userIntent is empty", () => {
    const scope = scopeOfState(makeState({ userIntent: "" }));
    expect(scope.intentHash).toBeUndefined();
  });

  it("returns undefined projectDir when state.projectDir is undefined", () => {
    const scope = scopeOfState(makeState({ projectDir: undefined }));
    expect(scope.projectDir).toBeUndefined();
  });
});

// ── scopeMatches (negative filter) ─────────────────────────────────────────

describe("scopeMatches (negative-filter: exclude only on contradiction)", () => {
  it("rejects when both sides have projectDir set and they differ (F-CROSS-001)", () => {
    expect(
      scopeMatches(
        { intentHash: "sliceA", projectDir: "/slice-a" },
        { intentHash: "sliceD", projectDir: "/slice-d" },
      ),
    ).toBe(false);
  });

  it("rejects when both sides have intentHash set and they differ (projectDir absent)", () => {
    // Both projectDirs undefined → falls through to intentHash
    // mismatch → reject. This is the "CLI invoked outside any
    // project" fallback that still prevents different-intent
    // leakage.
    expect(
      scopeMatches({ intentHash: "createFoo" }, { intentHash: "createBar" }),
    ).toBe(false);
  });

  it("accepts when projectDirs match even if intentHashes differ (shared-project cost history)", () => {
    // Same project, sibling intents — cost-per-GB for S3 is the
    // same across both plans, so sharing the hint is desirable.
    // projectDir takes precedence over intentHash.
    expect(
      scopeMatches(
        { intentHash: "aaa", projectDir: "/same" },
        { intentHash: "bbb", projectDir: "/same" },
      ),
    ).toBe(true);
  });

  it("rejects when projectDirs differ even if intentHashes match (F-CROSS-001)", () => {
    // The F-CROSS-001 leak axis: different projects are different
    // contexts. Even identical intent text in two different
    // project dirs must not share history.
    expect(
      scopeMatches(
        { intentHash: "deadbeef", projectDir: "/a" },
        { intentHash: "deadbeef", projectDir: "/b" },
      ),
    ).toBe(false);
  });

  it("accepts a legacy record with no scope fields (backward compat)", () => {
    expect(scopeMatches({}, { intentHash: "x", projectDir: "/y" })).toBe(true);
  });

  it("accepts when scope has no axes (e.g. CLI invoked outside a project)", () => {
    expect(scopeMatches({ intentHash: "x", projectDir: "/y" }, {})).toBe(true);
  });

  it("accepts when record has one axis but scope does not have that axis", () => {
    expect(
      scopeMatches({ projectDir: "/slice-a" }, { intentHash: "anything" }),
    ).toBe(true);
  });
});

// ── joinWithScope ──────────────────────────────────────────────────────────

describe("joinWithScope", () => {
  it("threads sidecar fields onto records with matching runId", () => {
    const p = makeProvision({ runId: "run-1" });
    const entry = makeSidecarEntry({
      runId: "run-1",
      intentHash: "h",
      projectDir: "/p",
    });
    const enriched = joinWithScope([p], [entry]);
    expect(enriched).toHaveLength(1);
    expect(enriched[0]!.intentHash).toBe("h");
    expect(enriched[0]!.projectDir).toBe("/p");
  });

  it("leaves records unchanged when no sidecar entry matches (legacy)", () => {
    const p = makeProvision({ runId: "legacy-run" });
    const enriched = joinWithScope([p], []);
    expect(enriched).toHaveLength(1);
    expect(enriched[0]!.intentHash).toBeUndefined();
    expect(enriched[0]!.projectDir).toBeUndefined();
  });

  it("short-circuits to identity when sidecar is empty", () => {
    const records = [makeProvision()];
    expect(joinWithScope(records, [])).toBe(records);
  });
});

// ── CostHistoryStore ───────────────────────────────────────────────────────

describe("CostHistoryStore", () => {
  it("round-trips sidecar entries through the filesystem", async () => {
    const entry = makeSidecarEntry();
    await store.appendEntry(entry);
    const read = await store.readEntries();
    expect(read).toHaveLength(1);
    expect(read[0]!.runId).toBe(entry.runId);
    expect(read[0]!.intentHash).toBe(entry.intentHash);
  });

  it("returns empty array when sidecar file does not exist", async () => {
    expect(await store.readEntries()).toEqual([]);
  });

  it("returns empty array for corrupt JSON (graceful degradation)", async () => {
    await fs.mkdir(storeDir, { recursive: true });
    await fs.writeFile(
      path.join(storeDir, "cost-history-scope.json"),
      "{not json",
      "utf-8",
    );
    expect(await store.readEntries()).toEqual([]);
  });

  it("drops structurally invalid rows during read", async () => {
    await fs.mkdir(storeDir, { recursive: true });
    await fs.writeFile(
      path.join(storeDir, "cost-history-scope.json"),
      JSON.stringify([
        makeSidecarEntry(),
        { runId: 42 }, // invalid — runId must be string
        { resourceType: "x" }, // missing runId + timestamp
      ]),
      "utf-8",
    );
    const read = await store.readEntries();
    expect(read).toHaveLength(1);
  });
});

// ── readScopedProvisions / readScopedFailures / HintLine ──────────────────

const OLD_RUN_UUID = "11111111-1111-4111-8111-111111111111";
const NEW_RUN_UUID = "22222222-2222-4222-8222-222222222222";
const SLICE_A_UUID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SLICE_D_UUID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const OWN_RUN_UUID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

describe("readScopedProvisions", () => {
  it("returns scoped provisions newest-first when sidecar matches", async () => {
    const state = makeState({
      userIntent: "Create bucket in slice-d",
      projectDir: "/home/user/slice-d",
    });
    const scope = scopeOfState(state);
    await memory.appendProvision(
      makeProvision({
        runId: OLD_RUN_UUID,
        timestamp: "2026-04-15T10:00:00.000Z",
      }),
    );
    await memory.appendProvision(
      makeProvision({
        runId: NEW_RUN_UUID,
        timestamp: "2026-04-18T10:00:00.000Z",
      }),
    );
    await store.appendEntry(
      makeSidecarEntry({
        runId: OLD_RUN_UUID,
        intentHash: scope.intentHash,
        projectDir: scope.projectDir,
        timestamp: "2026-04-15T10:00:00.000Z",
      }),
    );
    await store.appendEntry(
      makeSidecarEntry({
        runId: NEW_RUN_UUID,
        intentHash: scope.intentHash,
        projectDir: scope.projectDir,
        timestamp: "2026-04-18T10:00:00.000Z",
      }),
    );
    const scoped = await readScopedProvisions(state, memory, store);
    expect(scoped).toHaveLength(2);
    expect(scoped[0]!.runId).toBe(NEW_RUN_UUID);
  });

  it("drops cross-project provisions (F-CROSS-001 repro)", async () => {
    const state = makeState({
      userIntent: "Create slice-d bucket",
      projectDir: "/home/user/slice-d",
    });
    await memory.appendProvision(makeProvision({ runId: SLICE_A_UUID }));
    await store.appendEntry(
      makeSidecarEntry({
        runId: SLICE_A_UUID,
        intentHash: "sliceA",
        projectDir: "/home/user/slice-a",
      }),
    );
    expect(await readScopedProvisions(state, memory, store)).toHaveLength(0);
  });

  it("keeps legacy provisions without sidecar entries (backward compat)", async () => {
    const state = makeState({
      userIntent: "Create bucket",
      projectDir: "/home/user/p",
    });
    await memory.appendProvision(makeProvision());
    const scoped = await readScopedProvisions(state, memory, store);
    expect(scoped).toHaveLength(1);
  });
});

describe("readScopedFailures", () => {
  it("drops failures from a different project (F-CROSS-001 surface)", async () => {
    const state = makeState({
      userIntent: "Create fresh slice-d bucket",
      projectDir: "/home/user/slice-d",
    });
    const scope = scopeOfState(state);
    await memory.appendFailure(
      makeFailure({
        runId: SLICE_A_UUID,
        errorMessage:
          "dogfood-e92-a-s3-1776800919 already exists (Service: S3, Status Code: 0, Request ID: null)",
      }),
    );
    await store.appendEntry(
      makeSidecarEntry({
        runId: SLICE_A_UUID,
        intentHash: "sliceA",
        projectDir: "/home/user/slice-a",
      }),
    );
    await memory.appendFailure(
      makeFailure({ runId: SLICE_D_UUID, errorMessage: "slice-d-own-error" }),
    );
    await store.appendEntry(
      makeSidecarEntry({
        runId: SLICE_D_UUID,
        intentHash: scope.intentHash,
        projectDir: scope.projectDir,
      }),
    );
    const scoped = await readScopedFailures(state, memory, store);
    expect(scoped).toHaveLength(1);
    expect(scoped[0]!.errorMessage).toBe("slice-d-own-error");
  });
});

describe("readScopedProvisionHintLine", () => {
  it("formats the hint line when a scoped provision exists", async () => {
    const state = makeState({
      userIntent: "Create bucket",
      projectDir: "/home/user/p",
    });
    const scope = scopeOfState(state);
    await memory.appendProvision(
      makeProvision({
        runId: OWN_RUN_UUID,
        estimatedMonthlyCost: "$0.023/GB-month",
      }),
    );
    await store.appendEntry(
      makeSidecarEntry({
        runId: OWN_RUN_UUID,
        intentHash: scope.intentHash,
        projectDir: scope.projectDir,
      }),
    );
    const line = await readScopedProvisionHintLine(state, memory, store);
    expect(line).toContain("$0.023/GB-month/month");
    expect(line).toContain("Previous provision of this type");
  });

  it("returns '' when scope contradicts every provision", async () => {
    const state = makeState({
      userIntent: "Create bucket in slice-d",
      projectDir: "/home/user/slice-d",
    });
    await memory.appendProvision(makeProvision({ runId: SLICE_A_UUID }));
    await store.appendEntry(
      makeSidecarEntry({
        runId: SLICE_A_UUID,
        intentHash: "sliceA",
        projectDir: "/home/user/slice-a",
      }),
    );
    expect(await readScopedProvisionHintLine(state, memory, store)).toBe("");
  });
});

// ── extractDesiredNameFromState ────────────────────────────────────────────

describe("extractDesiredNameFromState", () => {
  it("pulls BucketName from desiredState when present", () => {
    expect(
      extractDesiredNameFromState({
        desiredState: { BucketName: "payments-prod" },
      }),
    ).toBe("payments-prod");
  });

  it("pulls FunctionName when BucketName is absent", () => {
    expect(
      extractDesiredNameFromState({
        desiredState: { FunctionName: "process-orders" },
      }),
    ).toBe("process-orders");
  });

  it("parses 'named <token>' from userIntent when desiredState is empty", () => {
    expect(
      extractDesiredNameFromState({
        userIntent: "Create an S3 bucket named payments-prod",
      }),
    ).toBe("payments-prod");
  });

  it("parses 'called <token>' variant from userIntent", () => {
    expect(
      extractDesiredNameFromState({
        userIntent: "Make a Lambda called process-orders please",
      }),
    ).toBe("process-orders");
  });

  it("ignores too-short name tokens (3 char minimum)", () => {
    expect(
      extractDesiredNameFromState({ userIntent: "Create bucket named ab" }),
    ).toBeUndefined();
  });

  it("returns undefined when no desiredState and no name pattern in intent", () => {
    expect(
      extractDesiredNameFromState({ userIntent: "Create an S3 bucket" }),
    ).toBeUndefined();
  });

  it("returns undefined on missing input", () => {
    expect(extractDesiredNameFromState({})).toBeUndefined();
  });

  it("prefers desiredState over userIntent when both are populated", () => {
    expect(
      extractDesiredNameFromState({
        desiredState: { BucketName: "actual-name" },
        userIntent: "Create an S3 bucket named intent-name",
      }),
    ).toBe("actual-name");
  });
});

// ── extractDesiredNameFromErrorMessage ─────────────────────────────────────

describe("extractDesiredNameFromErrorMessage", () => {
  it("parses leading identifier token (F-CROSS-001 repro)", () => {
    const msg =
      "dogfood-e92-a-s3-1776800919 already exists (Service: S3, Status Code: 0, Request ID: null)";
    expect(extractDesiredNameFromErrorMessage(msg)).toBe(
      "dogfood-e92-a-s3-1776800919",
    );
  });

  it("parses 'with name <name>' variant", () => {
    expect(
      extractDesiredNameFromErrorMessage(
        "Role with name my-test-role already exists",
      ),
    ).toBe("my-test-role");
  });

  it("parses colon-delimited trailing name", () => {
    expect(
      extractDesiredNameFromErrorMessage(
        "Table already exists: orders-prod-2026",
      ),
    ).toBe("orders-prod-2026");
  });

  it("skips common-prefix words like 'Error' / 'Bucket'", () => {
    expect(
      extractDesiredNameFromErrorMessage("Bucket already exists"),
    ).toBeUndefined();
    expect(
      extractDesiredNameFromErrorMessage("Error occurred while provisioning"),
    ).toBeUndefined();
  });

  it("returns undefined for empty / undefined input", () => {
    expect(extractDesiredNameFromErrorMessage(undefined)).toBeUndefined();
    expect(extractDesiredNameFromErrorMessage("")).toBeUndefined();
  });
});

// ── scrubEmptyErrorMetadata ────────────────────────────────────────────────

describe("scrubEmptyErrorMetadata", () => {
  it("strips the full (Service, Status Code: 0, Request ID: null) parenthetical (F-D-34 repro)", () => {
    const raw =
      "dogfood-e92-a-s3-1776800919 already exists (Service: S3, Status Code: 0, Request ID: null)";
    const clean = scrubEmptyErrorMetadata(raw);
    expect(clean).toBe("dogfood-e92-a-s3-1776800919 already exists");
  });

  it("strips Status Code: 0 when mid-message", () => {
    const raw = "Failed, Status Code: 0, please retry";
    expect(scrubEmptyErrorMetadata(raw)).not.toContain("Status Code: 0");
  });

  it("strips Request ID: null and Request ID: undefined variants", () => {
    expect(
      scrubEmptyErrorMetadata("Bucket already exists Request ID: null"),
    ).not.toContain("Request ID");
    expect(
      scrubEmptyErrorMetadata("Bucket already exists Request ID: undefined"),
    ).not.toContain("Request ID");
  });

  it("preserves a real Request ID (hex-like token)", () => {
    const raw = "Bucket already exists Request ID: 1A2B3C4D5E";
    expect(scrubEmptyErrorMetadata(raw)).toContain("Request ID: 1A2B3C4D5E");
  });

  it("preserves non-zero Status Code values", () => {
    const raw = "Throttled (Service: S3, Status Code: 429)";
    expect(scrubEmptyErrorMetadata(raw)).toContain("Status Code: 429");
  });

  it("collapses multiple spaces left behind by scrubs", () => {
    const raw = "Error happened    (Service: S3, Status Code: 0)";
    expect(scrubEmptyErrorMetadata(raw)).toBe("Error happened");
  });

  it("handles empty input defensively", () => {
    expect(scrubEmptyErrorMetadata("")).toBe("");
  });
});
