// E2E plan tests for container-service compound pattern
// (ECS Fargate + ALB + VPC apply+destroy).
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
