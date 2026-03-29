/**
 * DriftDetectorService — compares desired state (from provision logs / checkpoints)
 * against actual state (from CloudControl GetResource).
 *
 * Implements deep diff with type normalization for AWS quirks.
 *
 * @see Story 28.1 — Drift Detector Service
 */

import {
  DriftStatus,
  ChangeType,
  isAutoPopulatedField,
  type DriftResult,
  type DriftedField,
  type DriftStatusType,
} from "@assignee/core";
import { DRIFT_MAX_RETRIES } from "../config/constants.js";
import {
  ProvisioningErrorKind,
  type ProvisioningPort,
} from "./provisioning-port.js";

/**
 * Recursively sort a value for order-independent comparison.
 * - Arrays of objects: sorted by canonical key (Key, FromPort, CidrIp, etc.) or JSON.stringify fallback
 * - Arrays of primitives: sorted by value
 * - Objects: keys sorted alphabetically, values recursively sorted
 * - Primitives: returned as-is
 */
export function canonicalSort(value: unknown): unknown {
  if (value === null || value === undefined) return value;

  if (Array.isArray(value)) {
    const sorted = value.map((item) => canonicalSort(item));
    sorted.sort((a, b) => {
      const aStr = stableStringify(a);
      const bStr = stableStringify(b);
      if (aStr < bStr) return -1;
      if (aStr > bStr) return 1;
      return 0;
    });
    return sorted;
  }

  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const sortedObj: Record<string, unknown> = {};
    const keys = Object.keys(obj).sort();
    for (const key of keys) {
      sortedObj[key] = canonicalSort(obj[key]);
    }
    return sortedObj;
  }

  return value;
}

/**
 * Produce a stable JSON string with sorted keys (for comparison purposes).
 */
function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return String(value);
  if (typeof value !== "object") return JSON.stringify(value);

  if (Array.isArray(value)) {
    return "[" + value.map((v) => stableStringify(v)).join(",") + "]";
  }

  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return (
    "{" +
    keys
      .map((k) => JSON.stringify(k) + ":" + stableStringify(obj[k]))
      .join(",") +
    "}"
  );
}

/**
 * Deep equality check that is independent of key ordering and array element ordering
 * within nested structures' keys.
 */
export function deepEqual(a: unknown, b: unknown): boolean {
  return (
    stableStringify(canonicalSort(a)) === stableStringify(canonicalSort(b))
  );
}

/** Options for the drift detector. */
export interface DriftDetectorOptions {
  /** Port for fetching actual resource state. */
  provisioningPort: ProvisioningPort;
}

/**
 * Normalize a value to handle AWS quirks:
 * - Stringified booleans → boolean
 * - Stringified numbers → number (only when desired is a number)
 * - null / undefined treated as equivalent
 */
export function normalizeValue(actual: unknown, desired: unknown): unknown {
  if (actual === null || actual === undefined) return undefined;
  if (desired === null || desired === undefined) return actual;

  // Coerce stringified booleans
  if (typeof actual === "string" && typeof desired === "boolean") {
    if (actual === "true") return true;
    if (actual === "false") return false;
  }

  // Coerce stringified numbers
  if (typeof actual === "string" && typeof desired === "number") {
    const num = Number(actual);
    if (!isNaN(num)) return num;
  }

  return actual;
}

/**
 * Deep diff two objects. Returns an array of drifted fields.
 *
 * @param desired - Expected state from provision log
 * @param actual - Actual state from CloudControl
 * @param resourceType - For auto-populated field exclusion
 * @param prefix - Current path prefix for nested keys
 */
export function deepDiff(
  desired: Record<string, unknown>,
  actual: Record<string, unknown>,
  resourceType: string,
  prefix = "",
): DriftedField[] {
  const fields: DriftedField[] = [];
  const allKeys = new Set([...Object.keys(desired), ...Object.keys(actual)]);

  for (const key of allKeys) {
    const fieldPath = prefix ? `${prefix}.${key}` : key;

    // Skip auto-populated fields
    if (isAutoPopulatedField(resourceType, fieldPath)) {
      continue;
    }

    const desiredVal = desired[key];
    const actualRaw = actual[key];
    const actualVal = normalizeValue(actualRaw, desiredVal);

    const desiredPresent =
      key in desired && desiredVal !== undefined && desiredVal !== null;
    const actualPresent =
      key in actual && actualRaw !== undefined && actualRaw !== null;

    // Handle null/undefined equivalence for optional fields
    if (!desiredPresent && !actualPresent) {
      continue;
    }

    // Present only in actual → added externally
    if (!desiredPresent && actualPresent) {
      fields.push({
        path: fieldPath,
        desiredValue: undefined,
        actualValue: actualVal,
        changeType: ChangeType.ADDED_EXTERNALLY,
      });
      continue;
    }

    // Present only in desired → removed
    if (desiredPresent && !actualPresent) {
      fields.push({
        path: fieldPath,
        desiredValue: desiredVal,
        actualValue: undefined,
        changeType: ChangeType.REMOVED,
      });
      continue;
    }

    // Both present — compare recursively for objects
    if (
      typeof desiredVal === "object" &&
      desiredVal !== null &&
      typeof actualVal === "object" &&
      actualVal !== null &&
      !Array.isArray(desiredVal) &&
      !Array.isArray(actualVal)
    ) {
      const nested = deepDiff(
        desiredVal as Record<string, unknown>,
        actualVal as Record<string, unknown>,
        resourceType,
        fieldPath,
      );
      fields.push(...nested);
      continue;
    }

    // Array comparison
    if (Array.isArray(desiredVal) && Array.isArray(actualVal)) {
      const arrayDiffs = diffArrays(
        desiredVal,
        actualVal,
        resourceType,
        fieldPath,
      );
      fields.push(...arrayDiffs);
      continue;
    }

    // Primitive comparison
    if (desiredVal !== actualVal) {
      // Deep equality check for non-primitive values (order-independent)
      if (
        typeof desiredVal === "object" &&
        typeof actualVal === "object" &&
        deepEqual(desiredVal, actualVal)
      ) {
        continue;
      }
      fields.push({
        path: fieldPath,
        desiredValue: desiredVal,
        actualValue: actualVal,
        changeType: ChangeType.MODIFIED,
      });
    }
  }

  return fields;
}

/**
 * Diff two arrays element-by-element.
 */
function diffArrays(
  desired: unknown[],
  actual: unknown[],
  resourceType: string,
  prefix: string,
): DriftedField[] {
  // Canonically sort both arrays to avoid false drift from ordering differences
  const sortedDesired = canonicalSort(desired) as unknown[];
  const sortedActual = canonicalSort(actual) as unknown[];

  const fields: DriftedField[] = [];
  const maxLen = Math.max(sortedDesired.length, sortedActual.length);

  for (let i = 0; i < maxLen; i++) {
    const path = `${prefix}[${i}]`;

    if (i >= sortedDesired.length) {
      // Added externally
      fields.push({
        path,
        desiredValue: undefined,
        actualValue: sortedActual[i],
        changeType: ChangeType.ADDED_EXTERNALLY,
      });
      continue;
    }

    if (i >= sortedActual.length) {
      // Removed
      fields.push({
        path,
        desiredValue: sortedDesired[i],
        actualValue: undefined,
        changeType: ChangeType.REMOVED,
      });
      continue;
    }

    const d = sortedDesired[i];
    const a = sortedActual[i];

    // If both are objects, deep diff
    if (
      typeof d === "object" &&
      d !== null &&
      typeof a === "object" &&
      a !== null &&
      !Array.isArray(d) &&
      !Array.isArray(a)
    ) {
      const nested = deepDiff(
        d as Record<string, unknown>,
        a as Record<string, unknown>,
        resourceType,
        path,
      );
      fields.push(...nested);
      continue;
    }

    const normalizedA = normalizeValue(a, d);
    if (d !== normalizedA) {
      // Order-independent deep equality check
      if (
        typeof d === "object" &&
        typeof normalizedA === "object" &&
        deepEqual(d, normalizedA)
      ) {
        continue;
      }
      fields.push({
        path,
        desiredValue: d,
        actualValue: normalizedA,
        changeType: ChangeType.MODIFIED,
      });
    }
  }

  return fields;
}

/** Batch check entry. */
export interface BatchCheckEntry {
  typeName: string;
  identifier: string;
  desiredState?: Record<string, unknown>;
}

/** Progress callback for batch operations. */
export type ProgressCallback = (
  completed: number,
  total: number,
  latestResult: DriftResult,
) => void;

/** Options for batch check. */
export interface BatchCheckOptions {
  concurrency?: number;
  onProgress?: ProgressCallback;
}

/**
 * Run tasks with a concurrency limit.
 */
async function runWithConcurrency<T, R>(
  limit: number,
  items: T[],
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let index = 0;

  async function worker(): Promise<void> {
    while (index < items.length) {
      const currentIndex = index++;
      results[currentIndex] = await fn(items[currentIndex]!);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () =>
    worker(),
  );
  await Promise.all(workers);
  return results;
}

export class DriftDetectorService {
  private readonly port: ProvisioningPort;

  constructor(options: DriftDetectorOptions) {
    this.port = options.provisioningPort;
  }

  /**
   * Check multiple resources for drift in parallel with configurable concurrency.
   * Resilient to partial failures — failed checks are recorded as ERROR results.
   *
   * @see Story 28.6
   */
  async checkAll(
    entries: BatchCheckEntry[],
    opts: BatchCheckOptions = {},
  ): Promise<DriftResult[]> {
    const concurrency = Math.min(Math.max(opts.concurrency ?? 10, 1), 50);
    let completed = 0;
    let currentConcurrency = concurrency;

    const results = await runWithConcurrency(
      currentConcurrency,
      entries,
      async (entry) => {
        const result = await this.checkResourceWithRetry(
          entry.typeName,
          entry.identifier,
          entry.desiredState,
          3, // max retries
        );
        completed++;
        opts.onProgress?.(completed, entries.length, result);
        return result;
      },
    );

    return results;
  }

  /**
   * Check a single resource with exponential backoff retry on throttling.
   */
  private async checkResourceWithRetry(
    typeName: string,
    identifier: string,
    desiredState?: Record<string, unknown>,
    maxRetries = DRIFT_MAX_RETRIES,
  ): Promise<DriftResult> {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const result = await this.checkResource(
        typeName,
        identifier,
        desiredState,
      );

      // If throttled and we have retries left, back off and retry
      if (
        result.status === DriftStatus.ERROR &&
        result.errorMessage &&
        (result.errorMessage.includes("Rate exceeded") ||
          result.errorMessage.includes("Throttling") ||
          result.errorMessage.includes("TooManyRequests"))
      ) {
        if (attempt < maxRetries) {
          const baseDelay = 200 * Math.pow(2, attempt); // 200, 400, 800
          const jitter = Math.random() * 100;
          await new Promise((resolve) =>
            setTimeout(resolve, baseDelay + jitter),
          );
          continue;
        }
      }

      return result;
    }

    // Should not reach here, but return error result as fallback
    return {
      resourceType: typeName,
      resourceId: identifier,
      status: DriftStatus.ERROR,
      driftedFields: [],
      checkedAt: new Date().toISOString(),
      errorMessage: "Max retries exceeded",
    };
  }

  /**
   * Check a single resource for drift.
   *
   * @param typeName - CloudFormation resource type
   * @param identifier - Resource identifier
   * @param desiredState - Expected state (from provision log or checkpoint)
   * @returns DriftResult with status and drifted fields
   */
  async checkResource(
    typeName: string,
    identifier: string,
    desiredState?: Record<string, unknown>,
  ): Promise<DriftResult> {
    const checkedAt = new Date().toISOString();

    // No desired state — baseline missing
    if (!desiredState) {
      return {
        resourceType: typeName,
        resourceId: identifier,
        status: DriftStatus.BASELINE_MISSING,
        driftedFields: [],
        checkedAt,
      };
    }

    // Fetch actual state
    const [error, result] = await this.port.getResource(typeName, identifier);

    if (error) {
      if (error.kind === ProvisioningErrorKind.NOT_FOUND) {
        return {
          resourceType: typeName,
          resourceId: identifier,
          status: DriftStatus.DELETED,
          driftedFields: [],
          desiredState,
          checkedAt,
        };
      }

      return {
        resourceType: typeName,
        resourceId: identifier,
        status: DriftStatus.ERROR,
        driftedFields: [],
        desiredState,
        checkedAt,
        errorMessage: error.message,
      };
    }

    // Parse actual state from CloudControl response
    let actualState: Record<string, unknown>;
    try {
      const resourceDesc = result as {
        ResourceDescription?: { Properties?: string };
      };
      const propsJson = resourceDesc?.ResourceDescription?.Properties;
      if (!propsJson) {
        return {
          resourceType: typeName,
          resourceId: identifier,
          status: DriftStatus.ERROR,
          driftedFields: [],
          desiredState,
          checkedAt,
          errorMessage: "GetResource returned no Properties",
        };
      }
      actualState = JSON.parse(propsJson) as Record<string, unknown>;
    } catch (parseErr) {
      return {
        resourceType: typeName,
        resourceId: identifier,
        status: DriftStatus.ERROR,
        driftedFields: [],
        desiredState,
        checkedAt,
        errorMessage: `Failed to parse resource properties: ${parseErr instanceof Error ? parseErr.message : "unknown"}`,
      };
    }

    // Deep diff
    const driftedFields = deepDiff(desiredState, actualState, typeName);

    const status: DriftStatusType =
      driftedFields.length > 0 ? DriftStatus.DRIFTED : DriftStatus.IN_SYNC;

    return {
      resourceType: typeName,
      resourceId: identifier,
      status,
      driftedFields,
      actualState,
      desiredState,
      checkedAt,
    };
  }
}
