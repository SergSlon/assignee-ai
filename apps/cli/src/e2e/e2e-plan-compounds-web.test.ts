// E2E plan tests for static-website compound pattern (S3+OAC+CloudFront apply+destroy).
// Split from e2e-plan-compounds.test.ts during the M-β-015 split (2026-04-29).

import { it, expect, afterAll } from "vitest";
import {
  describeE2E,
  tools,
  operatorCreds,
  skipIfNoCreds,
  destroyAndAssert,
  RUN_E2E,
} from "./e2e-plan-shared.js";
import { createGraph } from "../services/graph.js";
import { ExecutionMode, ExecutionStatus } from "@assignee/core";
import type { AgentState } from "../services/graph-state.js";

// ─────────────────────────────────────────────────────────────────────────────
// (f) 2026-04-09 Task 4b: the static-website compound migrated off
// the SDK post-provision path (cloudfront-setup.ts) to fully CCAPI.
// This spec exercises the 4-resource compound end-to-end: S3 bucket
// -> OAC -> CloudFront Distribution -> S3 BucketPolicy, then bulk
// destroys the whole lot. CloudFront propagation can take 5-15
// minutes so the destroy needs a generous timeout; we set 20 minutes
// and rely on the bulk-destroy tier ordering (CLOUDFRONT_DISTRIBUTION
// must be disabled + deleted BEFORE the bucket is emptied).
//
// 2026-04-13: static-website now has graph-level CloudFront S3 retry —
// status_poller detects the transient S3 origin DNS failure and routes
// back to resource_provisioner with a 30s delay per retry (max 3).
// Pattern schema is correct; the retry handles AWS infrastructure timing.
// ─────────────────────────────────────────────────────────────────────────────
describeE2E("E2E: static-website compound apply + destroy", () => {
  const staticSuffix = `${Date.now()}`;
  // QA WARNING W3 from qa-expert-e2e-fixes.md: the afterAll used to
  // match OACs via `staticSuffix.slice(-8)`, but the plan-generator
  // actually injects `state.runId.slice(0, 8)` into OAC names
  // (plan-generator.ts:749 + :786). Those two values are unrelated —
  // the match never fired, so afterAll never reliably cleaned up OACs
  // from failed runs. Capture the runId up-front and expose its short
  // form to afterAll so the scoping matches what the plan-generator
  // actually writes.
  let capturedRunId: string | undefined;

  it("plans, applies, and bulk-destroys a CCAPI static-website (S3 + OAC + CF + BucketPolicy)", async () => {
    const graph = createGraph(tools);
    const threadId = crypto.randomUUID();
    capturedRunId = crypto.randomUUID();
    const config = {
      configurable: { thread_id: threadId },
      recursionLimit: 1000,
    };

    await graph.invoke(
      {
        userIntent: `Create a static website with CloudFront CDN for e2e test ${staticSuffix}`,
        runId: capturedRunId,
        executionMode: ExecutionMode.APPLY,
        startedAt: Date.now(),
        noWizard: true,
        autoApprove: true,
        projectDir: process.cwd(),
      },
      config,
    );

    let graphState = await graph.getState(config);
    while (graphState.next.length > 0) {
      await graph.invoke(null, config);
      graphState = await graph.getState(config);
    }

    const finalState = graphState.values as AgentState;

    if (finalState.executionStatus !== ExecutionStatus.SUCCESS) {
      console.error("STATIC-WEBSITE COMPOUND E2E FAILED:", {
        status: finalState.executionStatus,
        error: finalState.errorMessage,
        completed: finalState.completedResources?.map(
          (c) => `${c.resourceId}(${c.resourceType})=${c.resourceArn}`,
        ),
      });
    }

    expect(finalState.executionStatus).toBe(ExecutionStatus.SUCCESS);
    expect(finalState.resourcePattern?.patternId).toBe("static-website");

    const completed = finalState.completedResources ?? [];

    // All four resources must land with physical identifiers.
    const bucket = completed.find((c) => c.resourceType === "AWS::S3::Bucket");
    expect(typeof bucket?.resourceArn).toBe("string");
    expect(bucket?.executionStatus).toBe(ExecutionStatus.SUCCESS);

    const oac = completed.find(
      (c) => c.resourceType === "AWS::CloudFront::OriginAccessControl",
    );
    expect(typeof oac?.resourceArn).toBe("string");
    expect(oac?.executionStatus).toBe(ExecutionStatus.SUCCESS);

    const distribution = completed.find(
      (c) => c.resourceType === "AWS::CloudFront::Distribution",
    );
    expect(typeof distribution?.resourceArn).toBe("string");
    expect(distribution?.executionStatus).toBe(ExecutionStatus.SUCCESS);

    const policy = completed.find(
      (c) => c.resourceType === "AWS::S3::BucketPolicy",
    );
    expect(typeof policy?.resourceArn).toBe("string");
    expect(policy?.executionStatus).toBe(ExecutionStatus.SUCCESS);

    // ── Destroy pipeline exercise ───────────────────────────────────
    // CloudFront requires Disabled=true + propagation wait before the
    // distribution can be deleted. The bulk-destroy strategy handles
    // the two-step flow; we give it a generous timeout.
    await destroyAndAssert(completed);
    // Must succeed end-to-end. The BucketPolicy deletes must happen
    // before the Bucket delete (otherwise S3 rejects with
    // BucketNotEmpty-style errors); the Distribution must be
    // disabled + deleted before the OAC (CloudFront rejects OAC
    // deletion when an attached distribution is still active); and
    // the OAC must be deleted before the BucketPolicy (stale OAC
    // reference).
    // Destroy assertions handled by destroyAndAssert() or inline above.
  }, 2_400_000);

  afterAll(async () => {
    if (!RUN_E2E) return;
    if (skipIfNoCreds()) return;

    const region = process.env["AWS_REGION"] ?? "us-east-1";
    const creds = operatorCreds();

    // Best-effort cleanup of static-website resources.

    // 1. Disable + delete CloudFront distributions matching assignee-*
    try {
      const {
        CloudFrontClient,
        ListDistributionsCommand,
        GetDistributionCommand,
        UpdateDistributionCommand,
        DeleteDistributionCommand,
      } = await import("@aws-sdk/client-cloudfront");
      const cf = new CloudFrontClient({
        region: "us-east-1", // CloudFront is global
        credentials: creds,
      });
      const dists = await cf.send(new ListDistributionsCommand({}));
      for (const d of dists.DistributionList?.Items ?? []) {
        // Match ONLY this test run's distribution (scoped by staticSuffix).
        // Previous failed runs may leak distributions; those require manual
        // cleanup via `assignee destroy`. The afterAll is NOT a global sweep.
        const hasThisRunOrigin = d.Origins?.Items?.some((o) =>
          o.DomainName?.includes(`assignee-website-bucket-${staticSuffix}`),
        );
        if (!hasThisRunOrigin || !d.Id) continue;
        try {
          const getResp = await cf.send(
            new GetDistributionCommand({ Id: d.Id }),
          );
          const config = getResp.Distribution?.DistributionConfig;
          const etag = getResp.ETag;
          if (!config || !etag) continue;

          if (config.Enabled) {
            config.Enabled = false;
            await cf.send(
              new UpdateDistributionCommand({
                Id: d.Id,
                DistributionConfig: config,
                IfMatch: etag,
              }),
            );
            // Wait for disable to propagate (up to 10 min)
            for (let i = 0; i < 120; i++) {
              await new Promise((r) => setTimeout(r, 5000));
              const status = await cf.send(
                new GetDistributionCommand({ Id: d.Id }),
              );
              if (status.Distribution?.Status === "Deployed") {
                await cf.send(
                  new DeleteDistributionCommand({
                    Id: d.Id,
                    IfMatch: status.ETag!,
                  }),
                );
                console.log(`E2E cleanup: deleted CloudFront ${d.Id}`);
                break;
              }
            }
          } else {
            await cf.send(
              new DeleteDistributionCommand({ Id: d.Id, IfMatch: etag }),
            );
            console.log(`E2E cleanup: deleted CloudFront ${d.Id}`);
          }
        } catch (err) {
          console.warn(
            `E2E CloudFront cleanup failed for ${d.Id}: ${String(err)}`,
          );
        }
      }
    } catch (err) {
      console.warn(`E2E CloudFront cleanup import failure: ${String(err)}`);
    }

    // 2. Delete OACs matching assignee-*
    try {
      const {
        CloudFrontClient,
        ListOriginAccessControlsCommand,
        GetOriginAccessControlCommand,
        DeleteOriginAccessControlCommand,
      } = await import("@aws-sdk/client-cloudfront");
      const cf = new CloudFrontClient({
        region: "us-east-1",
        credentials: creds,
      });
      const oacs = await cf.send(new ListOriginAccessControlsCommand({}));
      for (const oac of oacs.OriginAccessControlList?.Items ?? []) {
        // Scope to THIS run's OAC only. plan-generator.ts injects
        // `state.runId.slice(0, 8)` into the OAC name at line 786
        // (`assignee-<resourceId>-<shortId>`). Match on that exact
        // 8-char prefix of the captured runId; if capturedRunId is
        // undefined (apply threw before setting it) the match is
        // impossible by design — afterAll becomes a no-op rather
        // than accidentally deleting other runs' OACs.
        const runIdSuffix = capturedRunId?.slice(0, 8).toLowerCase();
        if (runIdSuffix && oac.Name?.includes(runIdSuffix) && oac.Id) {
          try {
            const getResp = await cf.send(
              new GetOriginAccessControlCommand({ Id: oac.Id }),
            );
            await cf.send(
              new DeleteOriginAccessControlCommand({
                Id: oac.Id,
                IfMatch: getResp.ETag!,
              }),
            );
            console.log(`E2E cleanup: deleted OAC ${oac.Name}`);
          } catch (err) {
            console.warn(
              `E2E OAC cleanup failed for ${oac.Name}: ${String(err)}`,
            );
          }
        }
      }
    } catch (err) {
      console.warn(`E2E OAC cleanup import failure: ${String(err)}`);
    }

    // 3. Empty and delete S3 buckets matching assignee-*
    try {
      const {
        S3Client,
        ListBucketsCommand,
        ListObjectVersionsCommand,
        DeleteObjectsCommand,
        DeleteBucketPolicyCommand,
        DeleteBucketCommand,
      } = await import("@aws-sdk/client-s3");
      const s3 = new S3Client({ region, credentials: creds });
      const { Buckets } = await s3.send(new ListBucketsCommand({}));
      for (const b of Buckets ?? []) {
        // Scope to THIS run only (staticSuffix). Previous runs' buckets
        // are handled by manual `assignee destroy` or pre-sweep.
        if (!b.Name?.includes(staticSuffix)) continue;
        try {
          // Delete bucket policy first
          await s3
            .send(new DeleteBucketPolicyCommand({ Bucket: b.Name }))
            .catch(() => {});

          // Empty bucket (all versions + delete markers)
          let isTruncated = true;
          let keyMarker: string | undefined;
          let versionIdMarker: string | undefined;
          while (isTruncated) {
            const versions = await s3.send(
              new ListObjectVersionsCommand({
                Bucket: b.Name,
                KeyMarker: keyMarker,
                VersionIdMarker: versionIdMarker,
              }),
            );
            const objects = [
              ...(versions.Versions ?? []).map((v) => ({
                Key: v.Key!,
                VersionId: v.VersionId,
              })),
              ...(versions.DeleteMarkers ?? []).map((m) => ({
                Key: m.Key!,
                VersionId: m.VersionId,
              })),
            ].filter((o) => o.Key);
            if (objects.length > 0) {
              await s3.send(
                new DeleteObjectsCommand({
                  Bucket: b.Name,
                  Delete: { Objects: objects },
                }),
              );
            }
            isTruncated = versions.IsTruncated ?? false;
            keyMarker = versions.NextKeyMarker;
            versionIdMarker = versions.NextVersionIdMarker;
            if (isTruncated && !keyMarker && !versionIdMarker) break;
          }

          await s3.send(new DeleteBucketCommand({ Bucket: b.Name }));
          console.log(`E2E cleanup: deleted S3 bucket ${b.Name}`);
        } catch (err) {
          console.warn(`E2E S3 cleanup failed for ${b.Name}: ${String(err)}`);
        }
      }
    } catch (err) {
      console.warn(`E2E S3 cleanup import failure: ${String(err)}`);
    }
  }, 900_000);
});
