// E2E plan tests for three-tier-web compound pattern
// (ALB + EC2 + RDS + VPC apply+destroy).
// Split from e2e-plan-compounds.test.ts during the M-β-015 split (2026-04-29).
//
// NOTE: this file is 530 LOC — slightly above the 450 LOC target. The
// three-tier-web block is a single indivisible it+afterAll: the afterAll
// contains 7 sequential cleanup phases (RDS poll + DBSubnetGroup + ALB +
// EC2 + IAM + SG + VPC) that cannot be split across files without
// breaking the scope-capture of csSuffix / capturedRunId. Accepted as
// a single-block exception per the W19-S3 triage rule.

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
