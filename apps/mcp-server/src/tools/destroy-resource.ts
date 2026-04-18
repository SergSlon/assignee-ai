/**
 * destroy_resource MCP tool — safely destroys a managed AWS resource.
 *
 * Resolves the resource by ARN or name via the Resource Groups Tagging API,
 * then deletes it via the CloudControl API and polls for completion.
 *
 * Safety mechanism: requires `confirmed: true` to proceed — same pattern as apply_plan.
 * The agent must present resource details to the user and get explicit approval first.
 *
 * SOLID refactor (Wave 6b F5a + Story 53-it1-09): this entrypoint is a
 * thin MCP tool handler that composes sub-modules under `./destroy-resource/`:
 *   - resolve.ts         — RGTA lookup + ARN tag verification
 *   - sts-cache.ts       — operator account-id cache (poison-proof per Wave 4)
 *   - dispatcher.ts      — poll + NotFound classification + pre-destroy hook
 *   - error-envelope.ts  — MCP response shape
 *   - credentials.ts     — operator credential bootstrap + RGTA client init
 *   - handler-steps.ts   — phase helpers (resolve / guard / pre-destroy /
 *                          TOCTOU / dispatch / error-classify) so the handler
 *                          body stays a flat sequence of early-return steps
 *   - audit.ts           — single audit-log surface (`logDestroyAudit`) used
 *                          by every outcome branch
 *
 * @see Story 18.5 (CLI destroy), Epic 20 (MCP tools), Story 53-it1-09 (handler refactor)
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { CloudControlClient } from "@aws-sdk/client-cloudcontrol";
import { DEFAULT_AWS_REGION } from "@assignee/core";
import { bootstrapOperatorCredentials } from "./destroy-resource/credentials.js";
import {
  arnToResourceType as resolveArnToResourceType,
  extractIdentifierFromArn as resolveExtractIdentifierFromArn,
} from "./destroy-resource/resolve.js";
import {
  getOperatorAccountId,
  resetOperatorAccountCache,
} from "./destroy-resource/sts-cache.js";
import {
  buildCcClient,
  classifyDestroyError,
  dispatchDeleteAndPoll,
  dryRunResponse,
  guardUnsupportedTypes,
  resolveStep,
  runPreDestroyStep,
  toctouReverifyStep,
} from "./destroy-resource/handler-steps.js";

// ── Public re-exports (preserve the pre-refactor import surface) ────────────
// Existing tests import these from `../tools/destroy-resource.js`.
export { resolveArnToResourceType as arnToResourceType };
export { resolveExtractIdentifierFromArn as extractIdentifierFromArn };

/** @internal test-only: resets the STS account cache between tests. */
export function __resetOperatorAccountCacheForTests(): void {
  resetOperatorAccountCache();
}

/** @internal exported for unit tests — see P1-R2-1 cache-poison regression. */
export async function __getOperatorAccountIdForTests(
  region: string,
): Promise<string | undefined> {
  return getOperatorAccountId(region);
}

// ── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_REGION = process.env["AWS_REGION"] ?? DEFAULT_AWS_REGION;

// ── Zod schema ───────────────────────────────────────────────────────────────

export const destroyResourceParams = {
  resource_identifier: z
    .string()
    .describe(
      "ARN or name of the resource to destroy. Must be a resource managed by assignee.ai (tagged managed-by=assignee-ai).",
    ),
  confirmed: z
    .boolean()
    .describe(
      "Safety gate — must be true to proceed with destruction. Set to false for a dry-run check that resolves the resource without deleting it.",
    ),
};

// ── Tool registration ────────────────────────────────────────────────────────

export function registerDestroyResource(server: McpServer): void {
  server.tool(
    "destroy_resource",
    "Destroy a managed AWS resource by ARN or name. REQUIRES confirmed: true as a safety mechanism — the AI agent must present resource details and get explicit user approval before destroying.",
    destroyResourceParams,
    async ({ resource_identifier, confirmed }) => {
      const region = DEFAULT_REGION;
      const bootstrap = bootstrapOperatorCredentials(region);
      if (!bootstrap.ok) return bootstrap.error;
      const { operatorCreds, taggingClient } = bootstrap.result;
      // Story 49.3: SDK client lifecycle. Tracked clients destroyed in
      // the outer `finally` regardless of which early-return branch
      // we take — long-running MCP server must never leak sockets.
      let ccClientRef: CloudControlClient | undefined;
      try {
        // Capture start time before resolve so the TOCTOU SECURITY log line
        // reflects the full resolve→delete window observed by the operator.
        const resolveStartMs = Date.now();

        const resolvedStep = await resolveStep(
          resource_identifier,
          taggingClient,
          region,
        );
        if (resolvedStep.kind === "done") return resolvedStep.response;
        const resolved = resolvedStep.context;

        // ── Dry-run: return resource details without deleting ─────────────
        if (!confirmed) return dryRunResponse(resolved);

        // ── Reject redirect / SDK-fallback resource types ─────────────────
        const unsupported = guardUnsupportedTypes(
          resolved,
          resource_identifier,
        );
        if (unsupported.kind === "done") return unsupported.response;

        // ── Initialize CloudControl client in the resource's region ───────
        const cc = buildCcClient(resolved, operatorCreds);
        if (cc.kind === "done") return cc.response;
        ccClientRef = cc.context;

        // ── Pre-delete hooks (IGW/RouteTable etc via strategy registry) ──
        const preHook = await runPreDestroyStep(resolved);
        if (preHook.kind === "done") return preHook.response;

        // ── TOCTOU mitigation: re-verify managed-by tag before dispatch ──
        const toctou = await toctouReverifyStep(
          resolved,
          taggingClient,
          resolveStartMs,
        );
        if (toctou.kind === "done") return toctou.response;

        // ── Delete via CloudControl API + poll + audit ────────────────────
        try {
          return await dispatchDeleteAndPoll(ccClientRef, resolved);
        } catch (err) {
          return await classifyDestroyError(err, resolved);
        }
      } finally {
        // Story 49.3: dispose the CCAPI + tagging clients even when
        // an early branch returned. `.destroy()` is idempotent in
        // AWS SDK v3 so calling it on already-disposed refs is safe.
        ccClientRef?.destroy();
        taggingClient.destroy();
      }
    },
  );
}
