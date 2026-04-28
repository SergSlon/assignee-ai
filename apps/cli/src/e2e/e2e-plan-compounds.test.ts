// E2E plan tests for compound resource patterns (multi-resource apply+destroy).
// Extracted from e2e-plan.test.ts during the M-018 cluster-D split (2026-04-28).
// The monolith remains in place until the lead step replaces it with a 5-line redirect.

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
// A10 follow-up (2026-04-09): efs-with-vpc compound apply + destroy e2e.
//
// Before this test, `efs-with-vpc` had unit coverage of the static pattern
// shape (pattern-templates/patterns/efs-with-vpc.test.ts) and an E2E
// plan-mode smoke (see "E2E: EFS FileSystem plan" above), but NO apply +
// destroy exercise against real AWS. That left the compound's runtime
// correctness unverified for:
//   - resourceQueue ordering (VPC → Subnet → SG → EFS FS → MountTargets)
//   - EFS FileSystem + MountTarget provisioning + inter-resource refs
//   - cleanup coverage — EFS MountTargets must be deleted before EFS FS,
//     EFS FS before SG, SG before subnets, subnets before VPC
//
// Mirrors the lambda-with-exec-role compound apply+destroy test
// (`E2E: lambda-with-exec-role compound apply + destroy` above). Gated on
// `RUN_E2E=1` like every other e2e test — no effect on plain `pnpm test`.
// Destroy is exercised via `planBulkDestroy` + `destroySingleResource`
// rather than a hand-rolled SDK cleanup, so the destroy pipeline ships
// with the same regression coverage.
// ─────────────────────────────────────────────────────────────────────────────
describeE2E("E2E: efs-with-vpc compound apply + destroy", () => {
  const efsSuffix = `${Date.now()}`;

  it("plans, applies, and bulk-destroys an EFS file system wired into a fresh VPC", async () => {
    const graph = createGraph(tools);
    const threadId = crypto.randomUUID();
    // efs-with-vpc produces 7+ provisionable resources inside a VPC —
    // each one runs through the full LangGraph node cycle, so the
    // default recursion limit (25) is not enough. Match the production
    // apply.ts override.
    const config = {
      configurable: { thread_id: threadId },
      recursionLimit: 1000,
    };

    await graph.invoke(
      {
        // Phrasing that lands on the efs-with-vpc pattern dispatcher —
        // a verified keyword combo from pattern-templates/patterns/
        // efs-with-vpc.ts (both "efs" and "vpc" mentioned together).
        userIntent: `Create an EFS file system inside a new VPC for e2e test ${efsSuffix}`,
        runId: crypto.randomUUID(),
        executionMode: ExecutionMode.APPLY,
        startedAt: Date.now(),
        noWizard: true,
        autoApprove: true,
        projectDir: process.cwd(),
      },
      config,
    );

    // Drain HITL interrupts until the graph settles.
    let graphState = await graph.getState(config);
    while (graphState.next.length > 0) {
      await graph.invoke(null, config);
      graphState = await graph.getState(config);
    }

    const finalState = graphState.values as AgentState;

    if (finalState.executionStatus !== ExecutionStatus.SUCCESS) {
      console.error("EFS-WITH-VPC COMPOUND E2E FAILED:", {
        status: finalState.executionStatus,
        error: finalState.errorMessage,
        completed: finalState.completedResources?.map(
          (c) => `${c.resourceId}(${c.resourceType})=${c.resourceArn}`,
        ),
      });
    }

    expect(finalState.executionStatus).toBe(ExecutionStatus.SUCCESS);
    expect(finalState.resourcePattern?.patternId).toBe("efs-with-vpc");

    const completed = finalState.completedResources ?? [];

    // Every first-class resource in the pattern must land with a real
    // physical ID. Minimum viable surface: a VPC, at least one Subnet,
    // a SecurityGroup that the MountTargets hang off, an EFS
    // FileSystem, and at least one MountTarget attached to it.
    const vpc = completed.find((c) => c.resourceType === "AWS::EC2::VPC");
    expect(vpc?.resourceArn).toMatch(/^vpc-[0-9a-f]{8,}$/);

    const subnets = completed.filter(
      (c) => c.resourceType === "AWS::EC2::Subnet",
    );
    expect(subnets.length).toBeGreaterThanOrEqual(1);
    for (const s of subnets) {
      expect(s.resourceArn).toMatch(/^subnet-[0-9a-f]{8,}$/);
    }

    const securityGroup = completed.find(
      (c) => c.resourceType === "AWS::EC2::SecurityGroup",
    );
    expect(securityGroup?.resourceArn).toMatch(/^sg-[0-9a-f]{8,}$/);

    const efsFs = completed.find(
      (c) => c.resourceType === "AWS::EFS::FileSystem",
    );
    expect(efsFs?.resourceArn).toMatch(/^fs-[0-9a-f]{8,}$/);
    expect(efsFs?.executionStatus).toBe(ExecutionStatus.SUCCESS);

    const mountTargets = completed.filter(
      (c) => c.resourceType === "AWS::EFS::MountTarget",
    );
    // The pattern provisions at least one MountTarget per subnet — the
    // minimum is 1. Without this, the EFS file system would not be
    // reachable from any workload, which is the whole point of the
    // compound.
    expect(mountTargets.length).toBeGreaterThanOrEqual(1);
    for (const mt of mountTargets) {
      expect(mt.resourceArn).toMatch(/^fsmt-[0-9a-f]{8,}$/);
      expect(mt.executionStatus).toBe(ExecutionStatus.SUCCESS);
    }

    // ── Destroy pipeline exercise ───────────────────────────────────
    // Exercises the real bulk-destroy pipeline instead of a hand-rolled
    // SDK teardown: discovers the resources by tag, orders them by
    // DESTROY_TIER, and runs destroySingleResource() on each. That's
    // exactly what `assignee destroy --all` does in production, so
    // this is the test that catches dependency-order regressions
    // (EFS MountTargets must go before the FileSystem, the FileSystem
    // before the SecurityGroup, the SG before the Subnets, etc.).
    await destroyAndAssert(completed);
    // Destroy assertions are inside destroyAndAssert().
  }, 900_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// A10 follow-up (2026-04-09): scheduled-lambda compound apply + destroy e2e.
//
// Mirrors the efs-with-vpc test above for the 8th compound pattern —
// EventBridge Rule + IAM Role + Lambda Function (+ optional Lambda
// Permission + LogGroup companions). The pattern was shipped in A8 but
// only had plan-mode coverage. This test locks in:
//   - resourceQueue ordering (Role → Lambda → Rule; Rule depends on
//     Lambda ARN, Lambda depends on Role ARN)
//   - Events::Rule Targets[] must reference the Lambda ARN after the
//     marker-resolver substitution
//   - destroy ordering — Rule first, then the target Lambda, then the
//     Role (detach boundary) — the inverse of the create order
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

describeE2E("E2E: scheduled-lambda compound apply + destroy", () => {
  const schedSuffix = `${Date.now()}`;

  it("plans, applies, and bulk-destroys a scheduled Lambda wired to an EventBridge rule", async () => {
    const graph = createGraph(tools);
    const threadId = crypto.randomUUID();
    const config = {
      configurable: { thread_id: threadId },
      recursionLimit: 1000,
    };

    await graph.invoke(
      {
        // Phrasing that routes into the scheduled-lambda compound —
        // both "scheduled" and "lambda" mentioned, matching the
        // pattern's keyword set (see packages/core/src/pattern-templates/
        // patterns/scheduled-lambda.ts).
        userIntent: `Create a scheduled lambda that runs every hour for e2e test ${schedSuffix}`,
        runId: crypto.randomUUID(),
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
      console.error("SCHEDULED-LAMBDA COMPOUND E2E FAILED:", {
        status: finalState.executionStatus,
        error: finalState.errorMessage,
        completed: finalState.completedResources?.map(
          (c) => `${c.resourceId}(${c.resourceType})=${c.resourceArn}`,
        ),
      });
    }

    expect(finalState.executionStatus).toBe(ExecutionStatus.SUCCESS);
    expect(finalState.resourcePattern?.patternId).toBe("scheduled-lambda");

    const completed = finalState.completedResources ?? [];

    // Minimum surface: IAM Role, Lambda Function, Events::Rule all
    // created with real physical IDs.
    const role = completed.find((c) => c.resourceType === "AWS::IAM::Role");
    expect(typeof role?.resourceArn).toBe("string");
    expect(role?.resourceArn?.length ?? 0).toBeGreaterThan(0);
    expect(role?.executionStatus).toBe(ExecutionStatus.SUCCESS);

    const lambda = completed.find(
      (c) => c.resourceType === "AWS::Lambda::Function",
    );
    // Compound completedResources stores bare function name, not full ARN
    expect(typeof lambda?.resourceArn).toBe("string");
    expect(lambda?.resourceArn!.length).toBeGreaterThan(0);
    expect(lambda?.executionStatus).toBe(ExecutionStatus.SUCCESS);

    const rule = completed.find((c) => c.resourceType === "AWS::Events::Rule");
    // Events::Rule primaryIdentifier is /properties/Arn (readOnly) —
    // the provisioner captures the ARN from the CCAPI create response.
    expect(rule?.resourceArn).toMatch(/^arn:aws:events:[a-z0-9-]+:\d+:rule\//);
    expect(rule?.executionStatus).toBe(ExecutionStatus.SUCCESS);

    // ── Destroy pipeline exercise ───────────────────────────────────
    await destroyAndAssert(completed);
    // The Events::Rule destroy MUST happen before (or tolerate) the
    // Lambda target destroy, otherwise the rule will sit with a dangling
    // target reference. If the Rule destroy strategy doesn't first
    // RemoveTargets, the test surfaces a CCAPI DependencyViolation here.
    // Destroy assertions handled by destroyAndAssert() or inline above.
  }, 900_000);
});

// ═════════════════════════════════════════════════════════════════════════════
// Item 3d RUN_E2E ratchet (2026-04-10) — 4 previously-uncovered compounds.
// Each block is gated by RUN_E2E=1 like every other e2e test in this file and
// contributes zero runtime to plain `pnpm test`. The nightly GitHub Actions
// workflow at .github/workflows/nightly-e2e.yml runs the full suite against a
// dedicated test account at 03:00 UTC, so these blocks ship as documentation
// of the expected surface and become live coverage on the next nightly run.
//
// Covered by this ratchet:
//   1. serverless-api     (8 resources: IAM, Lambda, LogGroup, ApiGw V2,
//                          Integration, Route, Stage, Permission)
//   2. message-processing (5 resources: DLQ + MainQueue + DynamoDB +
//                          Lambda role + Processor Lambda)
//   3. container-service  (5 resources: ECR + Task role + SG + ECS Cluster +
//                          ALB)
//   4. three-tier-web     (6 resources: ALB SG + App SG + Instance profile
//                          role + ALB + EC2 + RDS)
//
// Assertions follow the reference template established by the existing
// static-website + scheduled-lambda blocks:
//   - invoke graph → poll until terminal → assert SUCCESS + patternId
//   - assert the hero resources of each compound carry real physical ARNs
//   - exercise the bulk-destroy pipeline end-to-end and assert zero
//     failures, which catches cleanup ordering bugs (parent-before-child
//     deletion, dangling dependency references).
//
// Timeouts are set generously because some compounds have long-poll
// resources: ALB provisioning can take ~5 min, RDS up to ~15 min.
// ═════════════════════════════════════════════════════════════════════════════

describeE2E("E2E: serverless-api compound apply + destroy", () => {
  const apiSuffix = `${Date.now()}`;

  it("plans, applies, and bulk-destroys a serverless API (Lambda + API Gateway V2)", async () => {
    const graph = createGraph(tools);
    const threadId = crypto.randomUUID();
    const config = {
      configurable: { thread_id: threadId },
      recursionLimit: 1000,
    };

    await graph.invoke(
      {
        userIntent: `Create a serverless api for e2e test ${apiSuffix}`,
        runId: crypto.randomUUID(),
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
      console.error("SERVERLESS-API COMPOUND E2E FAILED:", {
        status: finalState.executionStatus,
        error: finalState.errorMessage,
        completed: finalState.completedResources?.map(
          (c) => `${c.resourceId}(${c.resourceType})=${c.resourceArn}`,
        ),
      });
    }

    expect(finalState.executionStatus).toBe(ExecutionStatus.SUCCESS);
    expect(finalState.resourcePattern?.patternId).toBe("serverless-api");

    const completed = finalState.completedResources ?? [];

    // Hero resources: IAM role + Lambda + API Gateway V2 Api.
    // Lambda Permission is display-only (CCAPI routes it through the
    // flaky AWS::Lambda::PermissionPolicy path), so it may land as
    // display-only without a full ARN — do not assert its presence here.
    const role = completed.find((c) => c.resourceType === "AWS::IAM::Role");
    expect(typeof role?.resourceArn).toBe("string");
    expect(role?.executionStatus).toBe(ExecutionStatus.SUCCESS);

    const fn = completed.find(
      (c) => c.resourceType === "AWS::Lambda::Function",
    );
    // Compound completedResources stores bare function name, not full ARN
    expect(typeof fn?.resourceArn).toBe("string");
    expect(fn?.resourceArn!.length).toBeGreaterThan(0);
    expect(fn?.executionStatus).toBe(ExecutionStatus.SUCCESS);

    // API Gateway V2 Api is provisionable:false (companion resource) —
    // it is NOT provisioned via CCAPI and may not appear in
    // completedResources at all. The serverless-api pattern's hero
    // resources are IAM Role + Lambda + LogGroup (provisionable:true).
    // Assert those are present; the API Gateway is plan-display-only.
    const logGroup = completed.find(
      (c) => c.resourceType === "AWS::Logs::LogGroup",
    );
    expect(typeof logGroup?.resourceArn).toBe("string");
    expect(logGroup?.executionStatus).toBe(ExecutionStatus.SUCCESS);

    // ── Destroy pipeline exercise ───────────────────────────────────
    // API Gateway deletion must cascade through routes/stages/integrations
    // before the Api itself can be removed. bulk-destroy tier ordering
    // handles the dependency graph; if it ever regresses, the
    // DependencyViolation surfaces here.
    await destroyAndAssert(completed);
    // Destroy assertions handled by destroyAndAssert() or inline above.
  }, 900_000);
});

describeE2E("E2E: message-processing compound apply + destroy", () => {
  const mpSuffix = `${Date.now()}`;

  it("plans, applies, and bulk-destroys an SQS→Lambda→DynamoDB message processing pipeline", async () => {
    const graph = createGraph(tools);
    const threadId = crypto.randomUUID();
    const config = {
      configurable: { thread_id: threadId },
      recursionLimit: 1000,
    };

    await graph.invoke(
      {
        userIntent: `Create a message processing pipeline for e2e test ${mpSuffix}`,
        runId: crypto.randomUUID(),
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
      console.error("MESSAGE-PROCESSING COMPOUND E2E FAILED:", {
        status: finalState.executionStatus,
        error: finalState.errorMessage,
        completed: finalState.completedResources?.map(
          (c) => `${c.resourceId}(${c.resourceType})=${c.resourceArn}`,
        ),
      });
    }

    expect(finalState.executionStatus).toBe(ExecutionStatus.SUCCESS);
    expect(finalState.resourcePattern?.patternId).toBe("message-processing");

    const completed = finalState.completedResources ?? [];

    // Compound produces exactly 5 resources: DLQ, main queue, DynamoDB
    // table, IAM role, and the processor Lambda. All must land with
    // physical identifiers.
    const queues = completed.filter(
      (c) => c.resourceType === "AWS::SQS::Queue",
    );
    expect(queues.length).toBe(2); // DLQ + main queue
    for (const q of queues) {
      expect(typeof q.resourceArn).toBe("string");
      expect(q.executionStatus).toBe(ExecutionStatus.SUCCESS);
    }

    const table = completed.find(
      (c) => c.resourceType === "AWS::DynamoDB::Table",
    );
    expect(typeof table?.resourceArn).toBe("string");
    expect(table?.executionStatus).toBe(ExecutionStatus.SUCCESS);

    const fn = completed.find(
      (c) => c.resourceType === "AWS::Lambda::Function",
    );
    // Compound completedResources stores bare function name, not full ARN
    expect(typeof fn?.resourceArn).toBe("string");
    expect(fn?.resourceArn!.length).toBeGreaterThan(0);
    expect(fn?.executionStatus).toBe(ExecutionStatus.SUCCESS);

    // ── Destroy pipeline exercise ───────────────────────────────────
    // DynamoDB requires DeletionProtection=false before delete;
    // destroy-service.ts has a dedicated hook for this. If the hook
    // ever regresses, the failures array surfaces it.
    await destroyAndAssert(completed);
    // Destroy assertions handled by destroyAndAssert() or inline above.
  }, 900_000);
});

// 2026-04-13: container-service pattern now embeds a public-only VPC
// (9 resources: VPC + 2 subnets + IGW + attachment + RT + route + 2 assocs)
// plus ALB_SG, wiring the ALB Subnets + SecurityGroups. Total: 15 resources.
describeE2E("E2E: container-service compound apply + destroy", () => {
  const csSuffix = `${Date.now()}`;

  it("plans, applies, and bulk-destroys an ECS Fargate container service with ALB", async () => {
    const graph = createGraph(tools);
    const threadId = crypto.randomUUID();
    const config = {
      configurable: { thread_id: threadId },
      recursionLimit: 1000,
    };

    await graph.invoke(
      {
        userIntent: `Create a container service with ecs fargate for e2e test ${csSuffix}`,
        runId: crypto.randomUUID(),
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
      console.error("CONTAINER-SERVICE COMPOUND E2E FAILED:", {
        status: finalState.executionStatus,
        error: finalState.errorMessage,
        completed: finalState.completedResources?.map(
          (c) => `${c.resourceId}(${c.resourceType})=${c.resourceArn}`,
        ),
      });
    }

    expect(finalState.executionStatus).toBe(ExecutionStatus.SUCCESS);
    expect(finalState.resourcePattern?.patternId).toBe("container-service");

    const completed = finalState.completedResources ?? [];

    // 15 resources: 9 VPC + ALB_SG + ECR + Task Role + ECS_SG + Cluster + ALB.
    // QA WARNING W2: assert exact count so a future pattern change that
    // drops or adds a resource trips the test instead of passing
    // silently. Per-type coverage is verified below.
    expect(completed.length).toBe(15);

    // VPC foundation
    const vpc = completed.find((c) => c.resourceType === "AWS::EC2::VPC");
    expect(typeof vpc?.resourceArn).toBe("string");
    expect(vpc?.executionStatus).toBe(ExecutionStatus.SUCCESS);

    const subnets = completed.filter(
      (c) => c.resourceType === "AWS::EC2::Subnet",
    );
    expect(subnets.length).toBeGreaterThanOrEqual(2);

    // Hero resources: ECR repository, IAM task role, ECS cluster, ALB.
    const ecr = completed.find(
      (c) => c.resourceType === "AWS::ECR::Repository",
    );
    expect(typeof ecr?.resourceArn).toBe("string");
    expect(ecr?.executionStatus).toBe(ExecutionStatus.SUCCESS);

    const role = completed.find((c) => c.resourceType === "AWS::IAM::Role");
    expect(typeof role?.resourceArn).toBe("string");
    expect(role?.executionStatus).toBe(ExecutionStatus.SUCCESS);

    const sgs = completed.filter(
      (c) => c.resourceType === "AWS::EC2::SecurityGroup",
    );
    expect(sgs.length).toBeGreaterThanOrEqual(2); // ALB_SG + ECS_SG

    const cluster = completed.find(
      (c) => c.resourceType === "AWS::ECS::Cluster",
    );
    expect(typeof cluster?.resourceArn).toBe("string");
    expect(cluster?.executionStatus).toBe(ExecutionStatus.SUCCESS);

    const alb = completed.find(
      (c) => c.resourceType === "AWS::ElasticLoadBalancingV2::LoadBalancer",
    );
    expect(alb?.resourceArn).toMatch(
      /^arn:aws:elasticloadbalancing:[a-z0-9-]+:\d+:loadbalancer\/app\//,
    );
    expect(alb?.executionStatus).toBe(ExecutionStatus.SUCCESS);

    // ── Destroy pipeline exercise ───────────────────────────────────
    // VPC compound destroy follows the same IGW-detach / RT-disassociate
    // pre-delete hooks as the vpc-networking E2E. ALB provisioning can
    // take ~5 min; destroy is usually quick. ECR repositories reject
    // delete if images are present but our E2E never pushes images.
    await destroyAndAssert(completed);
  }, 1_500_000);

  afterAll(async () => {
    if (!RUN_E2E) return;
    if (skipIfNoCreds()) return;

    const region = process.env["AWS_REGION"] ?? "us-east-1";
    const creds = operatorCreds();

    // Best-effort cleanup of container-service compound resources.
    // Runs even when the test fails so we don't leak AWS resources.

    // 1. Delete ALBs matching assignee-alb-*
    try {
      const {
        ElasticLoadBalancingV2Client,
        DescribeLoadBalancersCommand,
        DeleteLoadBalancerCommand,
      } = await import("@aws-sdk/client-elastic-load-balancing-v2");
      const elbv2 = new ElasticLoadBalancingV2Client({
        region,
        credentials: creds,
      });
      const lbs = await elbv2.send(new DescribeLoadBalancersCommand({}));
      // Only clean up recent ALBs (< 2 hours old) to avoid processing
      // orphans from prior days/runs which slow the afterAll to a crawl.
      const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
      for (const lb of lbs.LoadBalancers ?? []) {
        const lbCreated = lb.CreatedTime?.getTime() ?? 0;
        if (
          lb.LoadBalancerName?.startsWith("assignee-alb-") &&
          lb.LoadBalancerArn &&
          lbCreated > twoHoursAgo
        ) {
          try {
            await elbv2.send(
              new DeleteLoadBalancerCommand({
                LoadBalancerArn: lb.LoadBalancerArn,
              }),
            );
            console.log(`E2E cleanup: deleted ALB ${lb.LoadBalancerName}`);
          } catch (err) {
            console.warn(
              `E2E ALB cleanup failed for ${lb.LoadBalancerName}: ${String(err)}`,
            );
          }
        }
      }
      // Wait for ALB ENIs to drain before VPC cleanup
      await new Promise((r) => setTimeout(r, 60_000));
    } catch (err) {
      console.warn(`E2E ALB cleanup import failure: ${String(err)}`);
    }

    // 2. Delete ECS clusters matching assignee-*
    try {
      const { ECSClient, ListClustersCommand, DeleteClusterCommand } =
        await import("@aws-sdk/client-ecs");
      const ecs = new ECSClient({ region, credentials: creds });
      const clusters = await ecs.send(new ListClustersCommand({}));
      for (const arn of clusters.clusterArns ?? []) {
        if (arn.includes("assignee-")) {
          try {
            await ecs.send(new DeleteClusterCommand({ cluster: arn }));
            console.log(`E2E cleanup: deleted ECS cluster ${arn}`);
          } catch (err) {
            console.warn(`E2E ECS cleanup failed for ${arn}: ${String(err)}`);
          }
        }
      }
    } catch (err) {
      console.warn(`E2E ECS cleanup import failure: ${String(err)}`);
    }

    // 3. Delete ECR repos matching assignee-*
    try {
      const {
        ECRClient,
        DescribeRepositoriesCommand,
        DeleteRepositoryCommand,
      } = await import("@aws-sdk/client-ecr");
      const ecr = new ECRClient({ region, credentials: creds });
      const repos = await ecr.send(new DescribeRepositoriesCommand({}));
      for (const repo of repos.repositories ?? []) {
        if (repo.repositoryName?.startsWith("assignee-")) {
          try {
            await ecr.send(
              new DeleteRepositoryCommand({
                repositoryName: repo.repositoryName,
                force: true,
              }),
            );
            console.log(`E2E cleanup: deleted ECR repo ${repo.repositoryName}`);
          } catch (err) {
            console.warn(
              `E2E ECR cleanup failed for ${repo.repositoryName}: ${String(err)}`,
            );
          }
        }
      }
    } catch (err) {
      console.warn(`E2E ECR cleanup import failure: ${String(err)}`);
    }

    // 4. Delete IAM Roles matching assignee-task-role-*
    try {
      const {
        IAMClient,
        ListAttachedRolePoliciesCommand,
        DetachRolePolicyCommand,
        DeleteRoleCommand,
      } = await import("@aws-sdk/client-iam");
      const { ListRolesCommand } = await import("@aws-sdk/client-iam");
      const iam = new IAMClient({ region, credentials: creds });
      const roles = await iam.send(new ListRolesCommand({}));
      for (const role of roles.Roles ?? []) {
        if (role.RoleName?.startsWith("assignee-task-role-")) {
          try {
            // Detach all managed policies before deletion
            const attached = await iam.send(
              new ListAttachedRolePoliciesCommand({
                RoleName: role.RoleName,
              }),
            );
            for (const p of attached.AttachedPolicies ?? []) {
              if (p.PolicyArn) {
                await iam
                  .send(
                    new DetachRolePolicyCommand({
                      RoleName: role.RoleName,
                      PolicyArn: p.PolicyArn,
                    }),
                  )
                  .catch(() => {});
              }
            }
            await iam.send(new DeleteRoleCommand({ RoleName: role.RoleName }));
            console.log(`E2E cleanup: deleted IAM Role ${role.RoleName}`);
          } catch (err) {
            const errName = (err as { name?: string })?.name ?? "";
            if (errName === "NoSuchEntityException") continue;
            console.warn(
              `E2E IAM Role cleanup failed for ${role.RoleName}: ${String(err)}`,
            );
          }
        }
      }
    } catch (err) {
      console.warn(`E2E IAM cleanup import failure: ${String(err)}`);
    }

    // 5. Delete Security Groups matching assignee-* (non-default)
    try {
      const {
        EC2Client,
        DescribeSecurityGroupsCommand,
        DeleteSecurityGroupCommand,
      } = await import("@aws-sdk/client-ec2");
      const ec2 = new EC2Client({ region, credentials: creds });
      const sgs = await ec2.send(
        new DescribeSecurityGroupsCommand({
          Filters: [{ Name: "tag:Name", Values: ["assignee-*"] }],
        }),
      );
      for (const sg of sgs.SecurityGroups ?? []) {
        if (sg.GroupId && sg.GroupName !== "default") {
          await ec2
            .send(new DeleteSecurityGroupCommand({ GroupId: sg.GroupId }))
            .catch(() => {});
        }
      }
    } catch {
      // best-effort
    }

    // 6. VPC cleanup (same pattern as the vpc-networking afterAll)
    try {
      const {
        EC2Client,
        DescribeVpcsCommand,
        DescribeSubnetsCommand,
        DeleteSubnetCommand,
        DescribeInternetGatewaysCommand,
        DetachInternetGatewayCommand,
        DeleteInternetGatewayCommand,
        DescribeRouteTablesCommand,
        DisassociateRouteTableCommand,
        DeleteRouteTableCommand,
        DeleteVpcCommand,
      } = await import("@aws-sdk/client-ec2");
      const ec2 = new EC2Client({ region, credentials: creds });

      const vpcs = await ec2.send(
        new DescribeVpcsCommand({
          Filters: [{ Name: "tag:Name", Values: ["assignee-vpc-*"] }],
        }),
      );
      for (const vpc of vpcs.Vpcs ?? []) {
        const vpcId = vpc.VpcId;
        if (!vpcId) continue;
        try {
          // Subnets
          const subnets = await ec2.send(
            new DescribeSubnetsCommand({
              Filters: [{ Name: "vpc-id", Values: [vpcId] }],
            }),
          );
          for (const s of subnets.Subnets ?? []) {
            if (s.SubnetId) {
              await ec2
                .send(new DeleteSubnetCommand({ SubnetId: s.SubnetId }))
                .catch(() => {});
            }
          }
          // Route tables: disassociate non-main associations, then delete
          const rts = await ec2.send(
            new DescribeRouteTablesCommand({
              Filters: [{ Name: "vpc-id", Values: [vpcId] }],
            }),
          );
          for (const rt of rts.RouteTables ?? []) {
            const isMain = rt.Associations?.some((a) => a.Main);
            if (rt.RouteTableId && !isMain) {
              // Disassociate all non-main associations first
              for (const assoc of rt.Associations ?? []) {
                if (assoc.RouteTableAssociationId && !assoc.Main) {
                  await ec2
                    .send(
                      new DisassociateRouteTableCommand({
                        AssociationId: assoc.RouteTableAssociationId,
                      }),
                    )
                    .catch(() => {});
                }
              }
              await ec2
                .send(
                  new DeleteRouteTableCommand({
                    RouteTableId: rt.RouteTableId,
                  }),
                )
                .catch(() => {});
            }
          }
          // IGW detach + delete
          const igws = await ec2.send(
            new DescribeInternetGatewaysCommand({
              Filters: [{ Name: "attachment.vpc-id", Values: [vpcId] }],
            }),
          );
          for (const igw of igws.InternetGateways ?? []) {
            if (igw.InternetGatewayId) {
              await ec2
                .send(
                  new DetachInternetGatewayCommand({
                    InternetGatewayId: igw.InternetGatewayId,
                    VpcId: vpcId,
                  }),
                )
                .catch(() => {});
              await ec2
                .send(
                  new DeleteInternetGatewayCommand({
                    InternetGatewayId: igw.InternetGatewayId,
                  }),
                )
                .catch(() => {});
            }
          }
          // VPC
          await ec2
            .send(new DeleteVpcCommand({ VpcId: vpcId }))
            .catch((err) => {
              console.warn(
                `E2E VPC cleanup: DeleteVpc ${vpcId} failed: ${String(err)}`,
              );
            });
          console.log(`E2E cleanup: deleted VPC ${vpcId}`);
        } catch (err) {
          console.warn(`E2E VPC cleanup failed for ${vpcId}: ${String(err)}`);
        }
      }
    } catch (err) {
      console.warn(`E2E VPC cleanup import failure: ${String(err)}`);
    }
  }, 300_000);
});

// 2026-04-13: three-tier-web now embeds a full VPC (public + private subnets,
// no NAT) with 3 SGs, DBSubnetGroup, ALB wired to public subnets, EC2 with
// AMI resolution, and RDS with DBSubnetGroup + VPC SG. Total: 22 resources.
describeE2E("E2E: three-tier-web compound apply + destroy", () => {
  const ttSuffix = `${Date.now()}`;

  it("plans, applies, and bulk-destroys a three-tier web app (ALB + EC2 + RDS)", async () => {
    const graph = createGraph(tools);
    const threadId = crypto.randomUUID();
    const config = {
      configurable: { thread_id: threadId },
      recursionLimit: 1000,
    };

    await graph.invoke(
      {
        userIntent: `Create a three tier web application with alb ec2 rds for e2e test ${ttSuffix}`,
        runId: crypto.randomUUID(),
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
      console.error("THREE-TIER-WEB COMPOUND E2E FAILED:", {
        status: finalState.executionStatus,
        error: finalState.errorMessage,
        completed: finalState.completedResources?.map(
          (c) => `${c.resourceId}(${c.resourceType})=${c.resourceArn}`,
        ),
      });
    }

    expect(finalState.executionStatus).toBe(ExecutionStatus.SUCCESS);
    expect(finalState.resourcePattern?.patternId).toBe("three-tier-web");

    const completed = finalState.completedResources ?? [];

    // 22 resources: 14 VPC + 3 SGs + Role + DBSubnetGroup + ALB + EC2 + RDS.
    // QA WARNING W2: assert exact count (see container-service above for
    // rationale). Per-type coverage is verified below.
    expect(completed.length).toBe(22);

    // VPC foundation
    const vpc = completed.find((c) => c.resourceType === "AWS::EC2::VPC");
    expect(typeof vpc?.resourceArn).toBe("string");
    expect(vpc?.executionStatus).toBe(ExecutionStatus.SUCCESS);

    const subnets = completed.filter(
      (c) => c.resourceType === "AWS::EC2::Subnet",
    );
    expect(subnets.length).toBeGreaterThanOrEqual(4); // 2 public + 2 private

    // Security groups: ALB + App + DB
    const sgs = completed.filter(
      (c) => c.resourceType === "AWS::EC2::SecurityGroup",
    );
    expect(sgs.length).toBeGreaterThanOrEqual(3);
    for (const sg of sgs) {
      expect(typeof sg.resourceArn).toBe("string");
      expect(sg.executionStatus).toBe(ExecutionStatus.SUCCESS);
    }

    const role = completed.find((c) => c.resourceType === "AWS::IAM::Role");
    expect(typeof role?.resourceArn).toBe("string");
    expect(role?.executionStatus).toBe(ExecutionStatus.SUCCESS);

    // DB Subnet Group
    const dbSubnetGroup = completed.find(
      (c) => c.resourceType === "AWS::RDS::DBSubnetGroup",
    );
    expect(typeof dbSubnetGroup?.resourceArn).toBe("string");
    expect(dbSubnetGroup?.executionStatus).toBe(ExecutionStatus.SUCCESS);

    const alb = completed.find(
      (c) => c.resourceType === "AWS::ElasticLoadBalancingV2::LoadBalancer",
    );
    expect(alb?.resourceArn).toMatch(
      /^arn:aws:elasticloadbalancing:[a-z0-9-]+:\d+:loadbalancer\/app\//,
    );
    expect(alb?.executionStatus).toBe(ExecutionStatus.SUCCESS);

    const ec2 = completed.find((c) => c.resourceType === "AWS::EC2::Instance");
    expect(ec2?.resourceArn).toMatch(/^i-[0-9a-f]+$|^arn:aws:ec2:/);
    expect(ec2?.executionStatus).toBe(ExecutionStatus.SUCCESS);

    const rds = completed.find(
      (c) => c.resourceType === "AWS::RDS::DBInstance",
    );
    expect(typeof rds?.resourceArn).toBe("string");
    expect(rds?.executionStatus).toBe(ExecutionStatus.SUCCESS);

    // ── Destroy pipeline exercise ───────────────────────────────────
    // RDS + ALB are the long-poll resources. DBSubnetGroup must be
    // destroyed AFTER RDS (tier 4 vs tier 3). VPC compound destroy
    // follows the IGW-detach / RT-disassociate pre-delete hooks.
    await destroyAndAssert(completed);
  }, 2_400_000);

  afterAll(async () => {
    if (!RUN_E2E) return;
    if (skipIfNoCreds()) return;

    const region = process.env["AWS_REGION"] ?? "us-east-1";
    const creds = operatorCreds();

    // Best-effort cleanup of three-tier-web resources.

    // 1. Delete RDS instances (SkipFinalSnapshot, disable DeletionProtection)
    try {
      const {
        RDSClient,
        DescribeDBInstancesCommand,
        ModifyDBInstanceCommand,
        DeleteDBInstanceCommand,
      } = await import("@aws-sdk/client-rds");
      const rds = new RDSClient({ region, credentials: creds });
      const instances = await rds.send(new DescribeDBInstancesCommand({}));
      for (const db of instances.DBInstances ?? []) {
        if (
          db.DBInstanceIdentifier?.startsWith("assignee-") &&
          db.DBInstanceStatus !== "deleting"
        ) {
          try {
            // Disable deletion protection if enabled
            if (db.DeletionProtection) {
              await rds.send(
                new ModifyDBInstanceCommand({
                  DBInstanceIdentifier: db.DBInstanceIdentifier,
                  DeletionProtection: false,
                }),
              );
            }
            await rds.send(
              new DeleteDBInstanceCommand({
                DBInstanceIdentifier: db.DBInstanceIdentifier,
                SkipFinalSnapshot: true,
                DeleteAutomatedBackups: true,
              }),
            );
            console.log(`E2E cleanup: deleting RDS ${db.DBInstanceIdentifier}`);
          } catch (err) {
            console.warn(
              `E2E RDS cleanup failed for ${db.DBInstanceIdentifier}: ${String(err)}`,
            );
          }
        }
      }
      // Poll until all assignee-* RDS instances are fully deleted before
      // proceeding to DB Subnet Group cleanup (RDS deletion takes 5-15 min).
      const rdsIdsToWait = (instances.DBInstances ?? [])
        .filter(
          (db) =>
            db.DBInstanceIdentifier?.startsWith("assignee-") &&
            db.DBInstanceStatus !== "deleted",
        )
        .map((db) => db.DBInstanceIdentifier!);

      if (rdsIdsToWait.length > 0) {
        const {
          RDSClient: RDSPollClient,
          DescribeDBInstancesCommand: DescDBCmd,
        } = await import("@aws-sdk/client-rds");
        const rdsPoll = new RDSPollClient({ region, credentials: creds });
        const maxPolls = 80; // 80 * 15s = 20 min max
        const pollIntervalMs = 15_000;

        for (const dbId of rdsIdsToWait) {
          console.log(
            `E2E cleanup: polling for RDS ${dbId} deletion (max 20 min)...`,
          );
          for (let i = 0; i < maxPolls; i++) {
            await new Promise((r) => setTimeout(r, pollIntervalMs));
            try {
              const resp = await rdsPoll.send(
                new DescDBCmd({
                  DBInstanceIdentifier: dbId,
                }),
              );
              const status = resp.DBInstances?.[0]?.DBInstanceStatus;
              if (status === "deleting") {
                if (i % 4 === 0) {
                  console.log(
                    `E2E cleanup: RDS ${dbId} still deleting (${(i + 1) * 15}s)...`,
                  );
                }
                continue;
              }
              // Any other status means something unexpected — break out
              console.warn(
                `E2E cleanup: RDS ${dbId} unexpected status "${status}" — proceeding`,
              );
              break;
            } catch (pollErr) {
              const errName = (pollErr as { name?: string })?.name ?? "";
              if (
                errName === "DBInstanceNotFoundFault" ||
                errName === "DBInstanceNotFoundException"
              ) {
                console.log(`E2E cleanup: RDS ${dbId} confirmed deleted`);
                break;
              }
              // Transient error — keep polling
              console.warn(
                `E2E cleanup: RDS poll error for ${dbId}: ${String(pollErr)}`,
              );
            }
          }
        }
      }
    } catch (err) {
      console.warn(`E2E RDS cleanup import failure: ${String(err)}`);
    }

    // 2. Delete DB Subnet Groups
    try {
      const {
        RDSClient,
        DescribeDBSubnetGroupsCommand,
        DeleteDBSubnetGroupCommand,
      } = await import("@aws-sdk/client-rds");
      const rds = new RDSClient({ region, credentials: creds });
      const groups = await rds.send(new DescribeDBSubnetGroupsCommand({}));
      for (const g of groups.DBSubnetGroups ?? []) {
        if (g.DBSubnetGroupName?.startsWith("assignee-")) {
          try {
            await rds.send(
              new DeleteDBSubnetGroupCommand({
                DBSubnetGroupName: g.DBSubnetGroupName,
              }),
            );
            console.log(
              `E2E cleanup: deleted DB Subnet Group ${g.DBSubnetGroupName}`,
            );
          } catch (err) {
            console.warn(
              `E2E DB Subnet Group cleanup failed for ${g.DBSubnetGroupName}: ${String(err)}`,
            );
          }
        }
      }
    } catch (err) {
      console.warn(
        `E2E DB Subnet Group cleanup import failure: ${String(err)}`,
      );
    }

    // 3. Delete ALBs
    try {
      const {
        ElasticLoadBalancingV2Client,
        DescribeLoadBalancersCommand,
        DeleteLoadBalancerCommand,
      } = await import("@aws-sdk/client-elastic-load-balancing-v2");
      const elbv2 = new ElasticLoadBalancingV2Client({
        region,
        credentials: creds,
      });
      const lbs = await elbv2.send(new DescribeLoadBalancersCommand({}));
      // Only clean up recent ALBs (< 2 hours old) to avoid processing
      // orphans from prior days/runs which slow the afterAll to a crawl.
      const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
      for (const lb of lbs.LoadBalancers ?? []) {
        const lbCreated = lb.CreatedTime?.getTime() ?? 0;
        if (
          lb.LoadBalancerName?.startsWith("assignee-alb-") &&
          lb.LoadBalancerArn &&
          lbCreated > twoHoursAgo
        ) {
          try {
            await elbv2.send(
              new DeleteLoadBalancerCommand({
                LoadBalancerArn: lb.LoadBalancerArn,
              }),
            );
            console.log(`E2E cleanup: deleted ALB ${lb.LoadBalancerName}`);
          } catch (err) {
            console.warn(
              `E2E ALB cleanup failed for ${lb.LoadBalancerName}: ${String(err)}`,
            );
          }
        }
      }
      await new Promise((r) => setTimeout(r, 60_000));
    } catch (err) {
      console.warn(`E2E ALB cleanup import failure: ${String(err)}`);
    }

    // 4. Terminate EC2 instances
    try {
      const { EC2Client, DescribeInstancesCommand, TerminateInstancesCommand } =
        await import("@aws-sdk/client-ec2");
      const ec2 = new EC2Client({ region, credentials: creds });
      const reservations = await ec2.send(
        new DescribeInstancesCommand({
          Filters: [
            { Name: "tag:Name", Values: ["assignee-*"] },
            {
              Name: "instance-state-name",
              Values: ["running", "stopped", "pending"],
            },
          ],
        }),
      );
      const instanceIds: string[] = [];
      for (const r of reservations.Reservations ?? []) {
        for (const i of r.Instances ?? []) {
          if (i.InstanceId) instanceIds.push(i.InstanceId);
        }
      }
      if (instanceIds.length > 0) {
        await ec2.send(
          new TerminateInstancesCommand({ InstanceIds: instanceIds }),
        );
        console.log(
          `E2E cleanup: terminated instances ${instanceIds.join(", ")}`,
        );
        // Wait for instances to terminate before SG/subnet cleanup
        await new Promise((r) => setTimeout(r, 60_000));
      }
    } catch (err) {
      console.warn(`E2E EC2 instance cleanup failure: ${String(err)}`);
    }

    // 5. Delete IAM Roles matching assignee-instance-profile-role-*
    try {
      const {
        IAMClient,
        ListRolesCommand,
        ListAttachedRolePoliciesCommand,
        DetachRolePolicyCommand,
        DeleteRoleCommand,
      } = await import("@aws-sdk/client-iam");
      const iam = new IAMClient({ region, credentials: creds });
      const roles = await iam.send(new ListRolesCommand({}));
      for (const role of roles.Roles ?? []) {
        if (role.RoleName?.startsWith("assignee-instance-profile-role-")) {
          try {
            // Detach all managed policies before deletion
            const attached = await iam.send(
              new ListAttachedRolePoliciesCommand({
                RoleName: role.RoleName,
              }),
            );
            for (const p of attached.AttachedPolicies ?? []) {
              if (p.PolicyArn) {
                await iam
                  .send(
                    new DetachRolePolicyCommand({
                      RoleName: role.RoleName,
                      PolicyArn: p.PolicyArn,
                    }),
                  )
                  .catch(() => {});
              }
            }
            await iam.send(new DeleteRoleCommand({ RoleName: role.RoleName }));
            console.log(`E2E cleanup: deleted IAM Role ${role.RoleName}`);
          } catch (err) {
            const errName = (err as { name?: string })?.name ?? "";
            if (errName === "NoSuchEntityException") continue;
            console.warn(
              `E2E IAM Role cleanup failed for ${role.RoleName}: ${String(err)}`,
            );
          }
        }
      }
    } catch (err) {
      console.warn(`E2E IAM cleanup import failure: ${String(err)}`);
    }

    // 6. Security groups, VPC cleanup (same pattern as container-service)
    try {
      const {
        EC2Client,
        DescribeSecurityGroupsCommand,
        DeleteSecurityGroupCommand,
      } = await import("@aws-sdk/client-ec2");
      const ec2 = new EC2Client({ region, credentials: creds });
      const sgs = await ec2.send(
        new DescribeSecurityGroupsCommand({
          Filters: [{ Name: "tag:Name", Values: ["assignee-*"] }],
        }),
      );
      for (const sg of sgs.SecurityGroups ?? []) {
        if (sg.GroupId && sg.GroupName !== "default") {
          await ec2
            .send(new DeleteSecurityGroupCommand({ GroupId: sg.GroupId }))
            .catch(() => {});
        }
      }
    } catch {
      // best-effort
    }

    // 7. VPC cleanup
    try {
      const {
        EC2Client,
        DescribeVpcsCommand,
        DescribeSubnetsCommand,
        DeleteSubnetCommand,
        DescribeInternetGatewaysCommand,
        DetachInternetGatewayCommand,
        DeleteInternetGatewayCommand,
        DescribeRouteTablesCommand,
        DisassociateRouteTableCommand,
        DeleteRouteTableCommand,
        DeleteVpcCommand,
      } = await import("@aws-sdk/client-ec2");
      const ec2 = new EC2Client({ region, credentials: creds });

      const vpcs = await ec2.send(
        new DescribeVpcsCommand({
          Filters: [{ Name: "tag:Name", Values: ["assignee-vpc-*"] }],
        }),
      );
      for (const vpc of vpcs.Vpcs ?? []) {
        const vpcId = vpc.VpcId;
        if (!vpcId) continue;
        try {
          const subnets = await ec2.send(
            new DescribeSubnetsCommand({
              Filters: [{ Name: "vpc-id", Values: [vpcId] }],
            }),
          );
          for (const s of subnets.Subnets ?? []) {
            if (s.SubnetId) {
              await ec2
                .send(new DeleteSubnetCommand({ SubnetId: s.SubnetId }))
                .catch(() => {});
            }
          }
          // Route tables: disassociate non-main associations, then delete
          const rts = await ec2.send(
            new DescribeRouteTablesCommand({
              Filters: [{ Name: "vpc-id", Values: [vpcId] }],
            }),
          );
          for (const rt of rts.RouteTables ?? []) {
            const isMain = rt.Associations?.some((a) => a.Main);
            if (rt.RouteTableId && !isMain) {
              // Disassociate all non-main associations first
              for (const assoc of rt.Associations ?? []) {
                if (assoc.RouteTableAssociationId && !assoc.Main) {
                  await ec2
                    .send(
                      new DisassociateRouteTableCommand({
                        AssociationId: assoc.RouteTableAssociationId,
                      }),
                    )
                    .catch(() => {});
                }
              }
              await ec2
                .send(
                  new DeleteRouteTableCommand({
                    RouteTableId: rt.RouteTableId,
                  }),
                )
                .catch(() => {});
            }
          }
          const igws = await ec2.send(
            new DescribeInternetGatewaysCommand({
              Filters: [{ Name: "attachment.vpc-id", Values: [vpcId] }],
            }),
          );
          for (const igw of igws.InternetGateways ?? []) {
            if (igw.InternetGatewayId) {
              await ec2
                .send(
                  new DetachInternetGatewayCommand({
                    InternetGatewayId: igw.InternetGatewayId,
                    VpcId: vpcId,
                  }),
                )
                .catch(() => {});
              await ec2
                .send(
                  new DeleteInternetGatewayCommand({
                    InternetGatewayId: igw.InternetGatewayId,
                  }),
                )
                .catch(() => {});
            }
          }
          await ec2
            .send(new DeleteVpcCommand({ VpcId: vpcId }))
            .catch((err) => {
              console.warn(
                `E2E VPC cleanup: DeleteVpc ${vpcId} failed: ${String(err)}`,
              );
            });
          console.log(`E2E cleanup: deleted VPC ${vpcId}`);
        } catch (err) {
          console.warn(`E2E VPC cleanup failed for ${vpcId}: ${String(err)}`);
        }
      }
    } catch (err) {
      console.warn(`E2E VPC cleanup import failure: ${String(err)}`);
    }
  }, 1_500_000);
});
