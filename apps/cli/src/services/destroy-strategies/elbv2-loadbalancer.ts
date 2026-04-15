/**
 * ELBv2 LoadBalancer destroy strategy — uses ARN identifier, is slow,
 * and runs a postDestroy ENI-drain poll after CCAPI reports SUCCESS.
 *
 * AWS takes 30-120s to fully release an ALB/NLB/GWLB's ENIs and
 * public IPs after DeleteLoadBalancer succeeds. Subsequent tier-4
 * destroys (IGW detach, SecurityGroup delete, Subnet delete) fail
 * with DependencyViolation if the ENIs are still in-use. Poll
 * DescribeNetworkInterfaces until no ALB-related ENIs remain, or
 * timeout after 120s.
 *
 * ELBv2 ENIs carry a description of the form
 *   "ELB <scheme>/<name>/<hex>"
 * where <scheme> is "app" (ALB), "net" (NLB) or "gwy" (GWLB).
 * Architect WARNING #9 invariant: match ALL three schemes. A prior
 * regex only matched "app/" and silently fell through to a 60s blind
 * sleep for NLB/GWLB.
 *
 * Edge-hunter M3: unknown scheme → emit `elbv2_scheme_unknown` WARN
 * so an unhandled variant is observable (not silently skipped).
 *
 * @see Wave-6 F1b
 */

import { RESOURCE_TYPES } from "@assignee/core";
// Hoisted (was inside a hot loop in destroy-service.ts): the ALB ENI
// drain used to `await import("@aws-sdk/client-ec2")` on every poll
// iteration, blocking the loop ~10-30ms per iteration on module
// resolution. Static import pays the cost once at module load.
import {
  EC2Client,
  DescribeNetworkInterfacesCommand,
} from "@aws-sdk/client-ec2";
import type { DestroyStrategy } from "./types.js";
import { requireAssigneeCredentials } from "../../config/aws-credentials.js";
import { AWS_REGION } from "../../config/constants.js";
import { warnDestroy } from "./helpers.js";

/**
 * ALB post-delete ENI drain parameters.
 * 24 × 5s = 120s total wall-clock cap.
 */
const ALB_ENI_DRAIN_MAX_ATTEMPTS = 24;
const ALB_ENI_DRAIN_POLL_INTERVAL_MS = 5000;

export const elbv2LoadBalancerStrategy: DestroyStrategy = {
  resourceType: RESOURCE_TYPES.ELBV2_LOAD_BALANCER,
  usesArnIdentifier: true,
  isSlow: true,
  async postDestroy(ctx) {
    const { resource, awsConfig, onProgress } = ctx;
    try {
      const ec2 = new EC2Client({
        region: awsConfig.region ?? AWS_REGION,
        credentials: requireAssigneeCredentials("operator"),
      });

      // Match all three ELBv2 schemes (app|net|gwy).
      const lbNameMatch =
        resource.arn.match(/loadbalancer\/(?:app|net|gwy)\/([^/]+)\//) ??
        resource.identifier.match(/^(?:app|net|gwy)\/([^/]+)\//);
      const lbName = lbNameMatch?.[1];
      const schemeMatch =
        resource.arn.match(/loadbalancer\/(app|net|gwy)\//) ??
        resource.identifier.match(/^(app|net|gwy)\//);
      // Edge-hunter M3: null scheme skips the drain poll and falls
      // through to the 60s blind-sleep fallback below. Emit WARN so
      // an unknown scheme is observable.
      const scheme = schemeMatch?.[1] ?? null;
      if (scheme === null) {
        warnDestroy("elbv2_scheme_unknown", {
          identifier: resource.identifier,
          arn: resource.arn,
          hint: "ELBv2 scheme regex matched neither app|net|gwy — falling through to 60s blind-sleep fallback. Add the new scheme to the regex in elbv2-loadbalancer.ts.",
        });
      }

      if (lbName && scheme) {
        for (let attempt = 0; attempt < ALB_ENI_DRAIN_MAX_ATTEMPTS; attempt++) {
          const enis = await ec2.send(
            new DescribeNetworkInterfacesCommand({
              Filters: [
                {
                  Name: "description",
                  // Filter on the detected scheme so NLB/GWLB ENIs
                  // also match instead of falling through to the
                  // 60s blind sleep fallback.
                  Values: [`ELB ${scheme}/${lbName}/*`],
                },
              ],
            }),
          );

          const remaining = enis.NetworkInterfaces?.length ?? 0;
          if (remaining === 0) {
            if (attempt > 0) {
              onProgress?.(
                `ALB ENI drain complete after ${(attempt * ALB_ENI_DRAIN_POLL_INTERVAL_MS) / 1000}s`,
              );
            }
            return;
          }

          onProgress?.(
            `Waiting for ${remaining} ALB ENI(s) to release (${((attempt + 1) * ALB_ENI_DRAIN_POLL_INTERVAL_MS) / 1000}s / ${(ALB_ENI_DRAIN_MAX_ATTEMPTS * ALB_ENI_DRAIN_POLL_INTERVAL_MS) / 1000}s max)...`,
          );
          await new Promise((r) =>
            setTimeout(r, ALB_ENI_DRAIN_POLL_INTERVAL_MS),
          );
        }
      } else {
        // Cannot extract LB name — fall back to a conservative 60s wait
        onProgress?.(
          "Waiting 60s for ALB ENI release (cannot determine LB name)...",
        );
        await new Promise((r) => setTimeout(r, 60_000));
      }
    } catch (err) {
      // Non-fatal: if ENI polling fails, log and continue. The downstream
      // tier 4 deletes may still succeed if AWS has released the ENIs, or
      // they'll surface their own DependencyViolation error.
      warnDestroy("alb_eni_drain_failed", {
        identifier: resource.identifier,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },
};
