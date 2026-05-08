/**
 * Shared provision-log loader. Reads
 * `~/.assignee/memory/provisions.json` and returns lookup maps keyed
 * by resource ARN (plus resource-name suffix fallbacks so callers can
 * match both `ARN` and `QueueUrl`-style identifiers).
 *
 * Shared by CLI `list` (costs + timestamps) and the MCP
 * `list_managed_resources` tool (costs only).
 *
 * @see Story 49.2 — extraction from the duplicated per-app copies.
 * @see Story 19.3 — provision log design
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { ASSIGNEE_DIR } from "../config/cfn-keys.js";
import type { ProvisionLogEntry } from "./types.js";

/** Provision log filename under `~/.assignee/memory/`. */
export const PROVISIONS_FILE = "provisions.json";

/** Provision-log data indexed both by ARN and by name suffix. */
export interface ProvisionLookup {
  costMap: Map<string, string>;
  timestampMap: Map<string, string>;
  /**
   * bug-s3-bucket-policy-attach-failure-observability — `arn → outcome`
   * lookup so `fetchManagedResources` can surface a warning for S3
   * buckets where the apply-time `attachCompensatingBucketPolicy` call
   * failed. Indexed by both full ARN and name-suffix to mirror the
   * existing cost/timestamp maps. Only entries where the field is
   * present in the provision record appear in this map.
   */
  compensatingPolicyMap: Map<string, { attached: boolean; reason?: string }>;
}

/**
 * Reads the provision log and returns maps of ARN → estimated monthly
 * cost and ARN → timestamp. Each entry is also indexed by its
 * name-suffix (`arn.split("/").pop()` / `arn.split(":").pop()`) so
 * callers can match RGTA ARNs against provision-log QueueUrl-style
 * entries.
 *
 * Missing file is normal for new users — returns empty maps silently.
 * Corrupt file emits a single stderr warning and returns empty maps.
 */
export function loadProvisionData(): ProvisionLookup {
  const costMap = new Map<string, string>();
  const timestampMap = new Map<string, string>();
  const compensatingPolicyMap = new Map<
    string,
    { attached: boolean; reason?: string }
  >();
  const provisionLogPath = path.join(
    os.homedir(),
    ASSIGNEE_DIR,
    "memory",
    PROVISIONS_FILE,
  );

  try {
    const raw = fs.readFileSync(provisionLogPath, "utf-8");
    const entries: ProvisionLogEntry[] = JSON.parse(raw);

    if (Array.isArray(entries)) {
      for (const entry of entries) {
        if (!entry.resourceArn) continue;
        const key = entry.resourceArn;
        const nameSuffix = key.split("/").pop() ?? key.split(":").pop() ?? "";
        if (entry.estimatedMonthlyCost) {
          costMap.set(key, entry.estimatedMonthlyCost);
          if (nameSuffix) costMap.set(nameSuffix, entry.estimatedMonthlyCost);
        }
        if (entry.timestamp) {
          timestampMap.set(key, entry.timestamp);
          if (nameSuffix) timestampMap.set(nameSuffix, entry.timestamp);
        }
        // bug-s3-bucket-policy-attach-failure-observability — index the
        // S3 compensating-policy outcome by full ARN AND name-suffix so
        // the fetch-managed-resources merge step can match it against
        // RGTA results regardless of which form RGTA returned.
        if (entry.compensatingPolicyAttached !== undefined) {
          const outcome = {
            attached: entry.compensatingPolicyAttached,
            ...(entry.compensatingPolicyError
              ? { reason: entry.compensatingPolicyError }
              : {}),
          };
          compensatingPolicyMap.set(key, outcome);
          if (nameSuffix) compensatingPolicyMap.set(nameSuffix, outcome);
        }
      }
    }
  } catch (err: unknown) {
    const isNotFound =
      err instanceof Error &&
      "code" in err &&
      (err as NodeJS.ErrnoException).code === "ENOENT";
    if (!isNotFound) {
      process.stderr.write(
        "⚠ Warning: Provision log is corrupted or unreadable. Run 'assignee clean --memory' to reset.\n",
      );
    }
  }

  return { costMap, timestampMap, compensatingPolicyMap };
}
