/**
 * Dedicated unit tests for `loadProvisionData` (Story 50-6).
 *
 * The loader reads `~/.assignee/memory/provisions.json` — a JSON array
 * of `ProvisionLogEntry`. Both CLI `list` and MCP
 * `list_managed_resources` rely on it for cost + timestamp decoration.
 * This suite pins:
 *
 *   - missing file → returns empty maps silently (new-user case)
 *   - corrupt JSON → emits a single stderr warning, returns empty maps
 *   - ARN keys populate costMap + timestampMap
 *   - name-suffix indexing for QueueUrl-style fallback matches
 *   - missing optional fields (cost only / timestamp only) do not clobber
 *   - array → repeated entries: last write wins for the same ARN
 *   - non-array top-level (e.g. `{}`): silently returns empty maps
 *     (matches observed code path: `Array.isArray(entries)` is false).
 *
 * Tests redirect `os.homedir()` to a per-test temp directory so they
 * never touch the developer's real `~/.assignee/memory/provisions.json`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { loadProvisionData, PROVISIONS_FILE } from "./provision-log.js";
import { ASSIGNEE_DIR } from "../config/cfn-keys.js";
import type { ProvisionLogEntry } from "./types.js";

let tmpHome: string = "";
let stderrWrites: string[] = [];
let originalHome: string | undefined;
let originalUserProfile: string | undefined;

const memoryDir = () => path.join(tmpHome, ASSIGNEE_DIR, "memory");
const provisionsPath = () => path.join(memoryDir(), PROVISIONS_FILE);

const writeEntries = (raw: string): void => {
  fs.mkdirSync(memoryDir(), { recursive: true });
  fs.writeFileSync(provisionsPath(), raw);
};

const writeArray = (entries: ProvisionLogEntry[]): void => {
  writeEntries(JSON.stringify(entries));
};

// `os.homedir()` is a sealed ESM export so we cannot `vi.spyOn` it; we
// redirect the value by setting HOME (and USERPROFILE on Windows) —
// which is exactly how os.homedir() resolves per the Node docs — and
// restore the prior value in afterEach.
beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "assignee-prov-log-"));
  originalHome = process.env["HOME"];
  originalUserProfile = process.env["USERPROFILE"];
  process.env["HOME"] = tmpHome;
  process.env["USERPROFILE"] = tmpHome;

  stderrWrites = [];
  vi.spyOn(process.stderr, "write").mockImplementation(
    (chunk: string | Uint8Array) => {
      stderrWrites.push(
        typeof chunk === "string"
          ? chunk
          : Buffer.from(chunk as Uint8Array).toString("utf-8"),
      );
      return true;
    },
  );
});

afterEach(() => {
  if (originalHome === undefined) delete process.env["HOME"];
  else process.env["HOME"] = originalHome;
  if (originalUserProfile === undefined) delete process.env["USERPROFILE"];
  else process.env["USERPROFILE"] = originalUserProfile;
  if (tmpHome) {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

describe("loadProvisionData — PROVISIONS_FILE constant", () => {
  it("is the expected filename (stable on-disk path)", () => {
    expect(PROVISIONS_FILE).toBe("provisions.json");
  });
});

describe("loadProvisionData — missing file (new-user case)", () => {
  it("returns empty maps and writes NOTHING to stderr", () => {
    const result = loadProvisionData();
    expect(result.costMap.size).toBe(0);
    expect(result.timestampMap.size).toBe(0);
    expect(stderrWrites).toEqual([]);
  });
});

describe("loadProvisionData — corrupt file", () => {
  it("emits exactly one stderr warning and returns empty maps", () => {
    writeEntries("not-valid-json {{{");
    const result = loadProvisionData();
    expect(result.costMap.size).toBe(0);
    expect(result.timestampMap.size).toBe(0);
    expect(stderrWrites).toHaveLength(1);
    expect(stderrWrites[0]).toContain("Provision log is corrupted");
    expect(stderrWrites[0]).toContain("assignee clean --memory");
  });
});

describe("loadProvisionData — non-array top-level", () => {
  it("returns empty maps when the file is an object (not an array)", () => {
    writeEntries(JSON.stringify({ version: 1, entries: [] }));
    const result = loadProvisionData();
    expect(result.costMap.size).toBe(0);
    expect(result.timestampMap.size).toBe(0);
    // Parsed successfully → no stderr warning.
    expect(stderrWrites).toEqual([]);
  });
});

describe("loadProvisionData — valid entries", () => {
  it("populates costMap + timestampMap keyed by full ARN", () => {
    const entry: ProvisionLogEntry = {
      runId: "run-2026-04-16T10:00:00Z",
      resourceType: "AWS::S3::Bucket",
      resourceArn: "arn:aws:s3:::assignee-dev-logs-20260416",
      region: "us-east-1",
      estimatedMonthlyCost: "$0.23",
      timestamp: "2026-04-16T10:00:00Z",
    };
    writeArray([entry]);
    const result = loadProvisionData();
    expect(result.costMap.get(entry.resourceArn!)).toBe("$0.23");
    expect(result.timestampMap.get(entry.resourceArn!)).toBe(
      "2026-04-16T10:00:00Z",
    );
  });

  it("indexes by '/'-split tail for slash-form ARNs (DynamoDB-style)", () => {
    // DynamoDB ARN has 'table/<name>' — slash split picks up "<name>".
    const entry: ProvisionLogEntry = {
      resourceArn:
        "arn:aws:dynamodb:us-east-1:123456789012:table/assignee-orders",
      estimatedMonthlyCost: "$5.12",
      timestamp: "2026-04-16T10:00:00Z",
    };
    writeArray([entry]);
    const result = loadProvisionData();
    // Full ARN key
    expect(result.costMap.get(entry.resourceArn!)).toBe("$5.12");
    // Slash-tail suffix key (useful for RGTA matches against `table/...`).
    expect(result.costMap.get("assignee-orders")).toBe("$5.12");
    expect(result.timestampMap.get("assignee-orders")).toBe(
      "2026-04-16T10:00:00Z",
    );
  });

  it("indexes '/'-less ARNs by the last colon segment (QueueUrl-style fallback not tripped)", () => {
    // Observed behaviour: for "arn:aws:sqs:<region>:<account>:<name>" there
    // is no '/', so `split("/").pop()` returns the full ARN unchanged.
    // That means the nameSuffix key is the SAME as the ARN key, so the
    // map ends up with ONE entry per field, not two. This test pins the
    // current behaviour so a refactor that changes it surfaces here.
    const entry: ProvisionLogEntry = {
      resourceArn: "arn:aws:sqs:us-east-1:123456789012:assignee-jobs",
      estimatedMonthlyCost: "$1.10",
    };
    writeArray([entry]);
    const result = loadProvisionData();
    expect(result.costMap.get(entry.resourceArn!)).toBe("$1.10");
    // Bare queue name is NOT a separate key — current code sets the
    // suffix to the full ARN (string.split('/').pop() on a string with
    // no '/'). Exposed here intentionally so downstream callers can't
    // drift their assumptions silently.
    expect(result.costMap.has("assignee-jobs")).toBe(false);
    expect(result.costMap.size).toBe(1);
  });

  it("skips entries with missing resourceArn silently", () => {
    writeArray([
      { estimatedMonthlyCost: "$99.00" } as ProvisionLogEntry,
      {
        resourceArn:
          "arn:aws:dynamodb:us-east-1:123456789012:table/assignee-alerts",
        estimatedMonthlyCost: "$0.01",
      },
    ]);
    const result = loadProvisionData();
    // Second entry gets TWO keys: the full ARN + the slash-tail suffix.
    // The "no resourceArn" entry is skipped entirely.
    expect(result.costMap.size).toBe(2);
    expect(
      result.costMap.get(
        "arn:aws:dynamodb:us-east-1:123456789012:table/assignee-alerts",
      ),
    ).toBe("$0.01");
    expect(result.costMap.get("assignee-alerts")).toBe("$0.01");
  });

  it("handles entries that have cost but no timestamp (cost-only decoration)", () => {
    writeArray([
      {
        resourceArn: "arn:aws:s3:::assignee-cost-only",
        estimatedMonthlyCost: "$2.50",
      },
    ]);
    const result = loadProvisionData();
    expect(result.costMap.get("arn:aws:s3:::assignee-cost-only")).toBe("$2.50");
    expect(result.timestampMap.size).toBe(0);
  });

  it("handles entries that have timestamp but no cost", () => {
    writeArray([
      {
        resourceArn: "arn:aws:s3:::assignee-no-cost",
        timestamp: "2026-04-10T00:00:00Z",
      },
    ]);
    const result = loadProvisionData();
    expect(result.costMap.size).toBe(0);
    expect(result.timestampMap.get("arn:aws:s3:::assignee-no-cost")).toBe(
      "2026-04-10T00:00:00Z",
    );
  });

  it("later entry wins when two entries share the same ARN", () => {
    writeArray([
      {
        resourceArn: "arn:aws:s3:::dup",
        estimatedMonthlyCost: "$1.00",
        timestamp: "2026-01-01T00:00:00Z",
      },
      {
        resourceArn: "arn:aws:s3:::dup",
        estimatedMonthlyCost: "$5.00",
        timestamp: "2026-04-16T10:00:00Z",
      },
    ]);
    const result = loadProvisionData();
    expect(result.costMap.get("arn:aws:s3:::dup")).toBe("$5.00");
    expect(result.timestampMap.get("arn:aws:s3:::dup")).toBe(
      "2026-04-16T10:00:00Z",
    );
  });

  it("handles mixed partitions (aws / aws-cn / aws-us-gov) in the same file", () => {
    writeArray([
      {
        resourceArn: "arn:aws:s3:::commercial-bucket",
        estimatedMonthlyCost: "$1.00",
      },
      {
        resourceArn: "arn:aws-cn:s3:::cn-bucket",
        estimatedMonthlyCost: "$1.10",
      },
      {
        resourceArn:
          "arn:aws-us-gov:lambda:us-gov-west-1:123456789012:function:gov-fn",
        estimatedMonthlyCost: "$2.00",
      },
    ]);
    const result = loadProvisionData();
    expect(result.costMap.get("arn:aws:s3:::commercial-bucket")).toBe("$1.00");
    expect(result.costMap.get("arn:aws-cn:s3:::cn-bucket")).toBe("$1.10");
    expect(
      result.costMap.get(
        "arn:aws-us-gov:lambda:us-gov-west-1:123456789012:function:gov-fn",
      ),
    ).toBe("$2.00");
  });
});
