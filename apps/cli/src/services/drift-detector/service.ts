/**
 * DriftDetectorService — orchestrator that batches drift checks with
 * bounded concurrency and exponential-backoff retry on throttling.
 *
 * Extracted from drift-detector.ts during Wave-6c decomposition.
 *
 * @see Story 28.1 — Drift Detector Service
 * @see Story 28.6 — concurrency + retry
 */

import { DriftStatus, type DriftResult } from "@assignee/core";
import {
  DRIFT_MAX_RETRIES,
  DRIFT_RETRY_BASE_DELAY_MS,
  DRIFT_RETRY_JITTER_MS,
} from "../../config/constants.js";
import { AwsErrorName } from "../../constants/aws-errors.js";
import type { ProvisioningPort } from "../provisioning-port.js";
import { checkResource } from "./actual-fetcher.js";
import { runWithConcurrency } from "./concurrency.js";

/** Options for the drift detector. */
export interface DriftDetectorOptions {
  /** Port for fetching actual resource state. */
  provisioningPort: ProvisioningPort;
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
    const results = await runWithConcurrency(
      concurrency,
      entries,
      async (entry) => {
        const result = await this.checkResourceWithRetry(
          entry.typeName,
          entry.identifier,
          entry.desiredState,
          DRIFT_MAX_RETRIES,
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
      const result = await checkResource(
        this.port,
        typeName,
        identifier,
        desiredState,
      );

      // If throttled and we have retries left, back off and retry
      if (
        result.status === DriftStatus.ERROR &&
        result.errorMessage &&
        (result.errorMessage.includes(AwsErrorName.RATE_EXCEEDED) ||
          result.errorMessage.includes(AwsErrorName.THROTTLING_SHORT) ||
          result.errorMessage.includes(AwsErrorName.TOO_MANY_REQUESTS_SHORT))
      ) {
        if (attempt < maxRetries) {
          const baseDelay = Math.min(
            DRIFT_RETRY_BASE_DELAY_MS * Math.pow(2, attempt),
            30_000,
          );
          const jitter = Math.random() * DRIFT_RETRY_JITTER_MS;
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
   * Public method retained for callers that operate on one resource at a
   * time (e.g. `assignee drift --resource`).
   */
  async checkResource(
    typeName: string,
    identifier: string,
    desiredState?: Record<string, unknown>,
  ): Promise<DriftResult> {
    return checkResource(this.port, typeName, identifier, desiredState);
  }
}
