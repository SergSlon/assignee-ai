/**
 * E2E-only bulk resource sweeper.
 *
 * Story 50-3 removed the production `planBulkDestroy` + `services/bulk-destroy`
 * subtree (the safety-allowlist's existence was tacit admission bulk destroy
 * was too dangerous for v1). The e2e test harness still needs a way to
 * enumerate every assignee-tagged resource in the account and destroy them
 * one-by-one after a compound-apply test — so the bare minimum enumeration
 * logic lives here, scoped to the e2e/ subtree only.
 *
 * This file is intentionally simple and **not** exported from the CLI
 * build; it is only imported from e2e-plan.test.ts.
 */

import {
  ResourceGroupsTaggingAPIClient,
  GetResourcesCommand,
} from "@aws-sdk/client-resource-groups-tagging-api";
import { operatorCredentials } from "../config/operator-credentials.js";

export interface SweepResource {
  arn: string;
  resourceType: string;
  identifier: string;
  region: string;
  /**
   * Approximate tier (lower = delete first). Kept as a single constant
   * here because tier ordering was the CLI bulk-destroy's feature; e2e
   * tests simply need to iterate every resource so an explicit ordering
   * is handled at test-call-site when it matters.
   */
  tier: number;
}

/**
 * Enumerate every assignee-tagged resource in the caller's account via
 * the AWS Resource Groups Tagging API.
 *
 * Filter: resources tagged with `managed-by=assignee-ai` (the single
 * tag this CLI applies on create in every plugin). No IAM — e2e tests
 * stick to taggable constructs.
 */
export async function planBulkSweep(opts: {
  region: string;
}): Promise<{ resources: SweepResource[] }> {
  const creds = operatorCredentials();
  const client = new ResourceGroupsTaggingAPIClient({
    region: opts.region,
    credentials: {
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
    },
  });

  const resources: SweepResource[] = [];
  let paginationToken: string | undefined;
  do {
    const page = await client.send(
      new GetResourcesCommand({
        TagFilters: [{ Key: "managed-by", Values: ["assignee-ai"] }],
        ...(paginationToken ? { PaginationToken: paginationToken } : {}),
      }),
    );
    for (const r of page.ResourceTagMappingList ?? []) {
      const arn = r.ResourceARN;
      if (!arn) continue;
      // RGTA ARN format: arn:aws:<service>:<region>:<account>:<resource>
      // Normalize resourceType to "AWS::<Service>::<Resource>"-ish shape —
      // sufficient for e2e assertions; precise type mapping lives in the
      // destroy service itself and is not needed here.
      const parts = arn.split(":");
      const svc = parts[2] ?? "";
      const resourceSegment = parts[5] ?? "";
      const resourcePart = resourceSegment.split("/").pop() ?? resourceSegment;
      resources.push({
        arn,
        resourceType: `AWS::${svc.toUpperCase()}::Unknown`,
        identifier: resourcePart,
        region: parts[3] || opts.region,
        tier: 5,
      });
    }
    paginationToken = page.PaginationToken;
  } while (paginationToken && paginationToken.length > 0);

  return { resources };
}
