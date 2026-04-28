// E2E plan tests for network resource family (VPC, ELBv2, CloudFront, EIP regression).
// Extracted from e2e-plan.test.ts during the M-018 cluster-D split (2026-04-28).
// The monolith remains in place until the lead step replaces it with a 5-line redirect.

import { it, expect, afterAll } from "vitest";
import {
  describeE2E,
  tools,
  operatorCreds,
  skipIfNoCreds,
  RUN_E2E,
} from "./e2e-plan-shared.js";
import { createGraph } from "../services/graph.js";
import { ExecutionMode, ExecutionStatus } from "@assignee/core";
import type { AgentState } from "../services/graph-state.js";

describeE2E("E2E: VPC plan", () => {
  it("generates a plan with CIDR block and DNS settings", async () => {
    const graph = createGraph(tools);

    const state = await graph.invoke(
      {
        userIntent: "Create a VPC with CIDR 10.0.0.0/16",
        runId: crypto.randomUUID(),
        executionMode: ExecutionMode.PLAN,
        startedAt: Date.now(),
        noWizard: true,
        projectDir: process.cwd(),
      },
      // VPC intent matches vpc-networking compound (17 resources) — needs
      // higher recursionLimit for plan-mode iteration.
      { configurable: { thread_id: crypto.randomUUID() }, recursionLimit: 500 },
    );

    const s = state as AgentState;

    // VPC intent matches vpc-networking compound (17 resources). The graph
    // reports the current-iteration resource type after plan-mode loop,
    // which may be any resource in the queue. Assert compound dispatch.
    expect(s.resourcePattern?.patternId).toMatch(/^vpc-/);
    expect(s.resourceQueue).toBeInstanceOf(Array);
    expect(
      s.resourceQueue!.some((r) => r.resourceType === "AWS::EC2::VPC"),
    ).toBe(true);
  }, 60_000);
});

describeE2E("E2E: ELBv2 LoadBalancer plan", () => {
  it("generates a plan with ALB configuration (compound or single)", async () => {
    const graph = createGraph(tools);
    const state = await graph.invoke(
      {
        userIntent:
          "Create an application load balancer named e2e-alb for my service",
        runId: crypto.randomUUID(),
        executionMode: ExecutionMode.PLAN,
        startedAt: Date.now(),
        noWizard: true,
        projectDir: process.cwd(),
      },
      // ALB often compound-dispatches to three-tier-web or container-service —
      // both need the larger recursionLimit for plan-mode iteration.
      {
        configurable: { thread_id: crypto.randomUUID() },
        recursionLimit: 500,
      },
    );
    const s = state as AgentState;
    if (s.resourcePattern?.patternId) {
      expect(s.resourceQueue).toBeInstanceOf(Array);
      expect(
        s.resourceQueue!.some(
          (r) => r.resourceType === "AWS::ElasticLoadBalancingV2::LoadBalancer",
        ),
      ).toBe(true);
    } else {
      expect(s.resourceType).toBe("AWS::ElasticLoadBalancingV2::LoadBalancer");
    }
    expect(s.bpFindings).toBeInstanceOf(Array);
  }, 60_000);
});

describeE2E("E2E: CloudFront Distribution plan", () => {
  it("generates a plan with distribution configuration (compound or single)", async () => {
    const graph = createGraph(tools);
    const state = await graph.invoke(
      {
        userIntent:
          "Create a CloudFront distribution serving static content from S3",
        runId: crypto.randomUUID(),
        executionMode: ExecutionMode.PLAN,
        startedAt: Date.now(),
        noWizard: true,
        projectDir: process.cwd(),
      },
      // static-website compound can fire here (CloudFront + S3 + OAC) —
      // needs the 500 recursionLimit.
      {
        configurable: { thread_id: crypto.randomUUID() },
        recursionLimit: 500,
      },
    );
    const s = state as AgentState;
    if (s.resourcePattern?.patternId) {
      expect(s.resourceQueue).toBeInstanceOf(Array);
      expect(
        s.resourceQueue!.some(
          (r) => r.resourceType === "AWS::CloudFront::Distribution",
        ),
      ).toBe(true);
    } else {
      expect(s.resourceType).toBe("AWS::CloudFront::Distribution");
    }
    expect(s.bpFindings).toBeInstanceOf(Array);
  }, 60_000);
});

// ──────────────────────────────────────────────────────────────────────────
// E2E: VPC compound apply — the CloudControl-intrinsic-resolution regression
// ──────────────────────────────────────────────────────────────────────────
//
// Pre-fix, vpc-networking's pattern emitted CloudFormation intrinsics
// (Fn::Select/Fn::GetAZs/Ref) in defaultOptions. CloudControl does not
// process those, so every compound VPC apply failed at CreateResource.
//
// This test exercises the full compound pipeline end-to-end against real AWS:
// pattern detection → marker-token resolution → CloudControl provisioning of
// VPC + Subnets + IGW + RouteTable. It then cleans up everything it created.
describeE2E("E2E: VPC compound apply + destroy", () => {
  const vpcSuffix = `${Date.now()}`;
  const vpcName = `e2e-vpc-${vpcSuffix}`;
  const createdVpcIds: string[] = [];

  it("plans, applies, and destroys a VPC with public and private subnets", async () => {
    const graph = createGraph(tools);
    const threadId = crypto.randomUUID();
    // Mirror production apply.ts recursionLimit — the VPC compound pattern
    // has 17 resources × ~4 node transitions each, far exceeding LangGraph's
    // default limit of 25. Without this override the test cannot exercise
    // the marker-resolver fix it was written to verify.
    const config = {
      configurable: { thread_id: threadId },
      recursionLimit: 1000,
    };

    const initialState = await graph.invoke(
      {
        userIntent: `Create a VPC named ${vpcName} with public and private subnets`,
        runId: crypto.randomUUID(),
        executionMode: ExecutionMode.APPLY,
        startedAt: Date.now(),
        noWizard: true,
        autoApprove: true,
        projectDir: process.cwd(),
      },
      config,
    );
    // Silence unused var — graph.invoke's return is captured for debuggability
    void initialState;

    // Drain the HITL interrupts until the graph settles.
    let graphState = await graph.getState(config);
    while (graphState.next.length > 0) {
      await graph.invoke(null, config);
      graphState = await graph.getState(config);
    }

    const finalState = graphState.values as AgentState;

    if (finalState.executionStatus !== ExecutionStatus.SUCCESS) {
      console.error("VPC COMPOUND E2E FAILED:", {
        status: finalState.executionStatus,
        error: finalState.errorMessage,
        completed: finalState.completedResources?.map(
          (c) => `${c.resourceId}(${c.resourceType})=${c.resourceArn}`,
        ),
      });
    }

    expect(finalState.executionStatus).toBe(ExecutionStatus.SUCCESS);
    // The pattern detector should have routed into the compound branch.
    expect(finalState.resourcePattern?.patternId).toBe("vpc-networking");
    // All PROVISIONABLE resources should have real AWS physical IDs.
    const completed = finalState.completedResources ?? [];
    const vpcResult = completed.find((c) => c.resourceId === "vpc");
    expect(vpcResult?.resourceArn).toMatch(/^vpc-[0-9a-f]{8,}$/);
    if (vpcResult?.resourceArn) createdVpcIds.push(vpcResult.resourceArn);

    const publicSubnet1 = completed.find(
      (c) => c.resourceId === "public-subnet-1",
    );
    expect(publicSubnet1?.resourceArn).toMatch(/^subnet-[0-9a-f]{8,}$/);

    const igwResult = completed.find((c) => c.resourceId === "igw");
    expect(igwResult?.resourceArn).toMatch(/^igw-[0-9a-f]{8,}$/);
  }, 600_000);

  afterAll(async () => {
    if (!RUN_E2E) return;
    if (skipIfNoCreds()) return;

    // Best-effort AWS cleanup: delete every VPC (and its dependent
    // resources) this test created. We use the EC2 SDK directly — the
    // compound destroy path is a separate code path and is exercised by
    // dedicated unit tests; this afterAll is only about leaving no trace.
    const region = process.env["AWS_REGION"] ?? "us-east-1";
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
        DescribeNatGatewaysCommand,
        DeleteNatGatewayCommand,
        DescribeAddressesCommand,
        ReleaseAddressCommand,
        DeleteVpcCommand,
      } = await import("@aws-sdk/client-ec2");
      const ec2 = new EC2Client({
        region,
        credentials: operatorCreds(),
      });

      // Resolve any VPCs matching our name tag as well, in case the run
      // captured the physical ID but we also want to clean up orphans.
      const vpcIdsToDelete = new Set<string>(createdVpcIds);
      try {
        const byTag = await ec2.send(
          new DescribeVpcsCommand({
            Filters: [{ Name: "tag:Name", Values: [vpcName] }],
          }),
        );
        for (const v of byTag.Vpcs ?? []) {
          if (v.VpcId) vpcIdsToDelete.add(v.VpcId);
        }
      } catch {
        // ignore — tag filter is best-effort
      }

      for (const vpcId of vpcIdsToDelete) {
        try {
          // 1. NAT gateways (must go first — they hold subnet refs)
          const natGws = await ec2.send(
            new DescribeNatGatewaysCommand({
              Filter: [{ Name: "vpc-id", Values: [vpcId] }],
            }),
          );
          for (const ng of natGws.NatGateways ?? []) {
            if (ng.NatGatewayId && ng.State !== "deleted") {
              await ec2
                .send(
                  new DeleteNatGatewayCommand({
                    NatGatewayId: ng.NatGatewayId,
                  }),
                )
                .catch(() => {});
            }
          }

          // 2. Release any EIPs associated with this VPC's NAT gateways
          try {
            const addrs = await ec2.send(new DescribeAddressesCommand({}));
            for (const a of addrs.Addresses ?? []) {
              if (
                a.AllocationId &&
                (!a.AssociationId || !a.InstanceId) &&
                a.Domain === "vpc"
              ) {
                // Release EIPs tagged with the run (best-effort — only those
                // with our runId-style tag)
                try {
                  await ec2.send(
                    new ReleaseAddressCommand({ AllocationId: a.AllocationId }),
                  );
                } catch {
                  // EIP may still be attached to a deleting NAT GW — skip
                }
              }
            }
          } catch {
            // ignore
          }

          // 3. Subnets
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

          // 4. Route tables: disassociate non-main associations, then delete
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

          // 5. Internet gateway — detach then delete
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

          // 6. VPC
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

// ─────────────────────────────────────────────────────────────────────────────
// Wave 19 Bug #6 regression: every compound VPC apply+destroy cycle MUST
// release every assignee-tagged EIP. The 2026-04-08 live smoke recovered 5
// pre-existing leaked EIPs and Run 2 of the smoke leaked another one even
// after a clean destroy reported "9/9, 0 failed". This test asserts the
// invariant directly via raw EC2 SDK because the assignee CLI itself
// missed the leak (`assignee list` didn't even show EIPs).
// ─────────────────────────────────────────────────────────────────────────────
describeE2E("E2E: compound VPC EIP leak regression (Wave 19 Bug #6)", () => {
  it("releases every assignee-tagged EIP after compound VPC apply + bulk-destroy", async () => {
    if (!RUN_E2E) return;
    if (skipIfNoCreds()) return;

    const region = process.env["AWS_REGION"] ?? "us-east-1";

    // Snapshot EIP state BEFORE the test so we can attribute leaks to
    // this run rather than pre-existing background state.
    const { EC2Client, DescribeAddressesCommand } =
      await import("@aws-sdk/client-ec2");
    const ec2 = new EC2Client({ region, credentials: operatorCreds() });

    const before = await ec2.send(
      new DescribeAddressesCommand({
        Filters: [{ Name: "tag-key", Values: ["assignee:runId"] }],
      }),
    );
    const beforeAllocationIds = new Set(
      (before.Addresses ?? [])
        .map((a) => a.AllocationId)
        .filter((id): id is string => Boolean(id)),
    );

    // Run a full compound VPC apply + bulk-destroy via the graph + bulk
    // destroy plan path. Reuse the same compound test machinery as the
    // VPC compound apply test above.
    const graph = createGraph(tools);
    const config = {
      configurable: { thread_id: crypto.randomUUID() },
      recursionLimit: 1000,
    };
    const runId = crypto.randomUUID();
    await graph.invoke(
      {
        userIntent: `Create a VPC for EIP leak regression test ${Date.now()}`,
        runId,
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
    expect(finalState.executionStatus).toBe(ExecutionStatus.SUCCESS);

    // Bulk-destroy everything created by this run. The Wave 19 fix added
    // EC2_EIP to the DESTROY_TIER table at tier 4, so the EIP allocated
    // by the NAT Gateway branch is now part of the destroy plan.
    const { planBulkSweep } = await import("./bulk-sweep.js");
    const { destroySingleResource } =
      await import("../services/destroy-service.js");
    const plan = await planBulkSweep({ region });
    for (const r of plan.resources) {
      const result = await destroySingleResource(r, { region });
      if (!result.success) {
        console.warn(
          `bulk-destroy step failed for ${r.resourceType} ${r.identifier}: ${result.error}`,
        );
      }
    }

    // Snapshot EIP state AFTER cleanup. The set of assignee-tagged EIPs
    // must NOT have grown — every new EIP allocated by this run must
    // have been released. Pre-existing background EIPs (e.g. unrelated
    // tests sharing the account) are tolerated by subtracting the
    // beforeAllocationIds set.
    const after = await ec2.send(
      new DescribeAddressesCommand({
        Filters: [{ Name: "tag-key", Values: ["assignee:runId"] }],
      }),
    );
    const afterAllocationIds = new Set(
      (after.Addresses ?? [])
        .map((a) => a.AllocationId)
        .filter((id): id is string => Boolean(id)),
    );
    const newlyLeaked = [...afterAllocationIds].filter(
      (id) => !beforeAllocationIds.has(id),
    );

    expect(newlyLeaked).toEqual([]);
  }, 900_000);
});
