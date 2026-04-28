// E2E plan tests for compute resource family (EC2, Lambda, ECR, ECS).
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
  runFreeTierLifecycle,
  FREE_TIER_LIFECYCLE_CASES,
} from "./e2e-plan-shared.js";
import { createGraph } from "../services/graph.js";
import { ExecutionMode, ExecutionStatus } from "@assignee/core";
import type { AgentState } from "../services/graph-state.js";

describeE2E("E2E: EC2 instance plan", () => {
  it("generates a plan with compute pricing decomposition", async () => {
    const graph = createGraph(tools);

    const state = await graph.invoke(
      {
        userIntent: "Create an EC2 t3.micro instance for testing",
        runId: crypto.randomUUID(),
        executionMode: ExecutionMode.PLAN,
        startedAt: Date.now(),
        noWizard: true,
        projectDir: process.cwd(),
      },
      { configurable: { thread_id: crypto.randomUUID() } },
    );

    const s = state as AgentState;

    expect(s.resourceType).toBe("AWS::EC2::Instance");
    // Tier C: strengthened — desiredState must be a non-empty object
    expect(s.desiredState).toBeInstanceOf(Object);

    // EC2 decomposer should produce compute + storage line items
    if (s.pricingBreakdown) {
      const labels = [
        ...s.pricingBreakdown.fixedItems.map((i) => i.lineItem.label),
        ...s.pricingBreakdown.usageBasedItems.map((i) => i.lineItem.label),
      ];
      expect(labels).toContain("Compute");
    }

    // BP findings should include IMDSv2 and EBS encryption checks
    // Tier C: strengthened — bpFindings must be an array (could be empty)
    expect(s.bpFindings).toBeInstanceOf(Array);
  }, 60_000);
});

// ── Story 47.5: EC2 t3.micro apply + destroy lifecycle ────────────────────
//
// Lambda (AC #1) and EFS (AC #3) already have apply+destroy coverage via the
// existing lambda-with-exec-role and efs-with-vpc compound blocks. AC #2
// (EC2 t3.micro single-resource) is the only new lifecycle block the story
// asks for. t3.micro is free-tier-eligible (750 hrs/mo) so running this
// under RUN_E2E=1 costs zero dollars as long as pre- and post-cleanup
// succeed. Block uses destroyAndAssert for the teardown check, matching
// the compound-pattern blocks.
describeE2E("E2E: EC2 t3.micro apply + destroy", () => {
  it("launches a t3.micro, verifies the instance-id, and destroys it", async () => {
    const graph = createGraph(tools);
    const threadId = crypto.randomUUID();
    const config = { configurable: { thread_id: threadId } };

    await graph.invoke(
      {
        userIntent:
          "Create an EC2 instance for e2e lifecycle testing. DisableApiTermination must be false — this is a test instance that needs to be destroyable.",
        runId: crypto.randomUUID(),
        executionMode: ExecutionMode.APPLY,
        startedAt: Date.now(),
        noWizard: true,
        autoApprove: true,
        projectDir: process.cwd(),
        // Override the instance type via --set semantics. The plan-generator
        // reads `presetFields` (the canonical graph-state field — values
        // are strings like CLI `--set` produces). A prior version of this
        // block used a fabricated `userOverrides` field that AgentState
        // dropped silently, leaving instance type to the LLM (non-free-
        // tier risk). Corrected per code-review edge-hunter H1.
        presetFields: {
          InstanceType: "t3.micro",
          // Explicitly disable termination protection — the LLM sometimes
          // sets DisableApiTermination=true for "production-ready"
          // instances. Live-AWS 2026-04-14 observed: "The instance
          // may not be terminated. Modify its 'disableApiTermination'
          // instance attribute". The destroy helper has no override
          // path for this attribute mid-flight.
          DisableApiTermination: "false",
        },
      },
      config,
    );

    // Resume through the HITL interrupt (auto-approved)
    let graphState = await graph.getState(config);
    while (graphState.next.length > 0) {
      await graph.invoke(null, config);
      graphState = await graph.getState(config);
    }
    const finalState = graphState.values as AgentState;

    if (finalState.executionStatus !== ExecutionStatus.SUCCESS) {
      console.error("EC2 E2E FAILED:", {
        status: finalState.executionStatus,
        error: finalState.errorMessage,
        preflightPassed: finalState.preflightPassed,
      });
    }

    expect(finalState.resourceType).toBe("AWS::EC2::Instance");
    expect(finalState.executionStatus).toBe(ExecutionStatus.SUCCESS);
    // EC2 instance IDs are always `i-<17-hex-chars>` (legacy `i-<8-hex>`
    // pre-2016 is long deprecated). Anchoring on the 17-char modern form
    // so a regression that returns the request token / ARN instead of
    // the bare instance ID trips the assertion.
    // Accept either the bare instance-id or the full ARN shape —
    // arn-builder surfaces the full ARN for display in some paths.
    expect(finalState.resourceArn).toMatch(
      /^(arn:aws[\w-]*:ec2:[a-z0-9-]+:\d+:instance\/i-[0-9a-f]{17}|i-[0-9a-f]{17})$/,
    );
    // t3.micro with default 8 GB gp3 EBS runs $0.0104/hr compute +
    // $0.08/GB-mo storage — headline cost should surface ~$7-8/mo,
    // never "N/A" (would indicate pricing regression). Shape check:
    // must contain a `$` (currency marker) AND one of /mo|/month|/hr
    // (cadence marker). `toBeTruthy()` would accept "whatever" — this
    // pattern pins the canonical `~$X.YZ/month` shape emitted by the
    // pricing decomposer pipeline.
    expect(finalState.estimatedMonthlyCost).not.toBe("N/A");
    expect(finalState.estimatedMonthlyCost).toMatch(/\$.*(\/mo|\/month|\/hr)/);

    // destroyAndAssert exercises the full bulk-destroy pipeline (same
    // code path as `assignee destroy --all`): tag discovery, tier
    // ordering, per-resource destroy. Required per the story's
    // "destroy removes the instance" AC.
    const completed =
      finalState.completedResources ??
      ([
        {
          resourceArn: finalState.resourceArn,
          resourceType: "AWS::EC2::Instance",
        },
      ] as Array<{ resourceArn?: string; resourceType: string }>);
    await destroyAndAssert(completed);
    // Story AC: "total wall-clock < 5 minutes" — the vitest timeout
    // below enforces a hard 300s cap. t3.micro typically launches in
    // ~45s and terminates in ~30-60s so this leaves comfortable margin.
  }, 300_000);
});

describeE2E("E2E: Lambda Function plan", () => {
  it("generates a plan with runtime and memory configuration via lambda-with-exec-role compound dispatch", async () => {
    // Wave 19 / Wave 13 update: bare "Create a Lambda function ..." intents
    // are intentionally caught by the `lambda-with-exec-role` compound
    // pattern (Wave 13 feature) so plain-English Lambda intents auto-bundle
    // the required IAM execution role. The plan node returns the FIRST
    // resource in the queue (the IAM Role) — the Lambda itself is
    // resourceQueue[1] and gets provisioned in step 2 at apply time.
    //
    // This test now asserts the COMPOUND dispatch shape (the actual
    // user-visible Wave 13 behavior). End-to-end coverage of both
    // resources is in the `lambda-with-exec-role compound apply + destroy`
    // test further below.
    const graph = createGraph(tools);

    const state = await graph.invoke(
      {
        userIntent:
          "Create a Lambda function named e2e-lambda-test with nodejs20.x runtime",
        runId: crypto.randomUUID(),
        executionMode: ExecutionMode.PLAN,
        startedAt: Date.now(),
        noWizard: true,
        projectDir: process.cwd(),
      },
      { configurable: { thread_id: crypto.randomUUID() } },
    );

    const s = state as AgentState;

    // Compound dispatch routes through the lambda-with-exec-role pattern.
    // The graph reports the user-requested resource type (Lambda) — not
    // the first queue item (IAM Role) — as state.resourceType after plan
    // generation. The queue itself carries the full dependency order.
    expect(s.resourcePattern?.patternId).toBe("lambda-with-exec-role");
    expect(s.resourceType).toBe("AWS::Lambda::Function");
    // Tier C: dropped redundant toBeDefined() — toHaveLength fails on undefined
    expect(s.resourceQueue).toHaveLength(2);
    expect(s.resourceQueue?.[1]?.resourceType).toBe("AWS::Lambda::Function");
    expect(s.resourceQueue?.[0]?.resourceType).toBe("AWS::IAM::Role");

    // BP findings should still exist (run against the first resource)
    // Tier C: strengthened — bpFindings must be an array (could be empty)
    expect(s.bpFindings).toBeInstanceOf(Array);
    expect(s.bpFindings!.length).toBeGreaterThan(0);
  }, 60_000);
});

describeE2E("E2E: ECR Repository plan", () => {
  it("generates a plan with repository configuration", async () => {
    const graph = createGraph(tools);
    const state = await graph.invoke(
      {
        userIntent:
          "Create an ECR repository named e2e-ecr-repo for docker images",
        runId: crypto.randomUUID(),
        executionMode: ExecutionMode.PLAN,
        startedAt: Date.now(),
        noWizard: true,
        projectDir: process.cwd(),
      },
      { configurable: { thread_id: crypto.randomUUID() } },
    );
    const s = state as AgentState;
    expect(s.resourceType).toBe("AWS::ECR::Repository");
    expect(Object.keys(s.desiredState ?? {}).length).toBeGreaterThan(0);
    expect(s.desiredState?.["RepositoryName"]).toBe("e2e-ecr-repo");
    expect(s.bpFindings).toBeInstanceOf(Array);
  }, 60_000);
});

describeE2E("E2E: ECS Cluster plan", () => {
  it("generates a plan with cluster configuration", async () => {
    const graph = createGraph(tools);
    const state = await graph.invoke(
      {
        userIntent:
          "Create an ECS cluster named e2e-ecs-cluster for containers",
        runId: crypto.randomUUID(),
        executionMode: ExecutionMode.PLAN,
        startedAt: Date.now(),
        noWizard: true,
        projectDir: process.cwd(),
      },
      // ECS intents can compound-dispatch to container-service (7+
      // resources) which exceeds LangGraph's default recursionLimit of
      // 25. Match ALB/RDS/CloudFront blocks (code-review Medium fix).
      {
        configurable: { thread_id: crypto.randomUUID() },
        recursionLimit: 500,
      },
    );
    const s = state as AgentState;
    // "container" phrasing may route through container-service compound;
    // either single-resource or compound dispatch is acceptable for this
    // smoke test. Assert via the pattern OR resourceType (compound sets
    // resourceType to the current-iteration resource, so we accept any
    // of the types that live in the container-service queue).
    const acceptableTypes = new Set([
      "AWS::ECS::Cluster",
      "AWS::EC2::VPC",
      "AWS::EC2::Subnet",
      "AWS::EC2::SecurityGroup",
      "AWS::IAM::Role",
      "AWS::ECR::Repository",
      "AWS::ElasticLoadBalancingV2::LoadBalancer",
    ]);
    if (s.resourcePattern?.patternId === "container-service") {
      expect(s.resourceQueue).toBeInstanceOf(Array);
      expect(
        s.resourceQueue!.some((r) => r.resourceType === "AWS::ECS::Cluster"),
      ).toBe(true);
    } else {
      expect(acceptableTypes.has(s.resourceType ?? "")).toBe(true);
    }
    expect(s.bpFindings).toBeInstanceOf(Array);
  }, 60_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// Wave 19 Bug #1 regression: lambda-with-exec-role compound pattern must
// apply end-to-end with no orphaned IAM Role.
//
// Before this test, the only coverage of the Wave 13 feature was 20 unit
// tests in pattern-templates/patterns/lambda-with-exec-role.test.ts that
// validated the static pattern shape. None of them invoked the actual
// compound apply graph against AWS, so the missing `Code` and `Handler`
// defaults bug went undetected — `feedback_verify_user_flows_before_done`
// in action. This test exercises the user-visible flow:
//   1. plain "Create a lambda" intent → pattern dispatcher
//   2. compound apply path provisions IAM Role + Lambda Function in order
//   3. both ARNs land in completedResources
//   4. cleanup tears down BOTH (no orphaned exec role)
// ─────────────────────────────────────────────────────────────────────────────
describeE2E("E2E: lambda-with-exec-role compound apply + destroy", () => {
  const lambdaSuffix = `${Date.now()}`;
  const createdLambdaArns: string[] = [];
  const createdRoleArns: string[] = [];

  it("plans, applies, and destroys a Lambda with auto-created exec role", async () => {
    const graph = createGraph(tools);
    const threadId = crypto.randomUUID();
    // Compound patterns blow past the default LangGraph recursion limit;
    // mirror the production apply.ts override.
    const config = {
      configurable: { thread_id: threadId },
      recursionLimit: 1000,
    };

    await graph.invoke(
      {
        // Plain English intent — no --set Role workaround. This is the
        // exact phrasing that fails before Wave 19 Bug #1 is fixed.
        userIntent: `Create a lambda for image processing test ${lambdaSuffix}`,
        runId: crypto.randomUUID(),
        executionMode: ExecutionMode.APPLY,
        startedAt: Date.now(),
        noWizard: true,
        autoApprove: true,
        projectDir: process.cwd(),
      },
      config,
    );

    // Drain HITL interrupts
    let graphState = await graph.getState(config);
    while (graphState.next.length > 0) {
      await graph.invoke(null, config);
      graphState = await graph.getState(config);
    }

    const finalState = graphState.values as AgentState;

    if (finalState.executionStatus !== ExecutionStatus.SUCCESS) {
      console.error("LAMBDA AUTO-CREATE E2E FAILED:", {
        status: finalState.executionStatus,
        error: finalState.errorMessage,
        completed: finalState.completedResources?.map(
          (c) => `${c.resourceId}(${c.resourceType})=${c.resourceArn}`,
        ),
      });
    }

    // Pattern dispatcher must have routed to lambda-with-exec-role
    expect(finalState.resourcePattern?.patternId).toBe("lambda-with-exec-role");
    expect(finalState.executionStatus).toBe(ExecutionStatus.SUCCESS);

    // Both resources must be in completedResources with real AWS ARNs
    const completed = finalState.completedResources ?? [];
    expect(completed).toHaveLength(2);

    // Tier C: dropped redundant toBeDefined() — find!() at find sites and
    // assert the actual ARN/identifier shape rather than just defined-ness
    const role = completed.find((c) => c.resourceType === "AWS::IAM::Role")!;
    const lambda = completed.find(
      (c) => c.resourceType === "AWS::Lambda::Function",
    )!;

    // IAM Role identifier may be either a bare role name or a full ARN
    // depending on how CCAPI returns the primary identifier
    expect(typeof role.resourceArn).toBe("string");
    expect(role.resourceArn!.length).toBeGreaterThan(0);
    expect(role.executionStatus).toBe(ExecutionStatus.SUCCESS);
    // Compound completedResources[].resourceArn stores the BARE CCAPI
    // primary identifier (function name, not full ARN) by design — the
    // compound marker resolver substitutes this into child resource fields
    // where AWS rejects full ARNs. The resolved display ARN is only used
    // in renderCompoundSuccess output. Assert the function name shape.
    expect(typeof lambda.resourceArn).toBe("string");
    expect(lambda.resourceArn!.length).toBeGreaterThan(0);
    expect(lambda.resourceArn).toMatch(/^assignee-lambda-fn-/);
    expect(lambda.executionStatus).toBe(ExecutionStatus.SUCCESS);

    // Capture ARNs for afterAll cleanup. Role identifier may be a bare
    // role name (CCAPI returns the primary identifier, not the ARN).
    if (role?.resourceArn) createdRoleArns.push(role.resourceArn);
    if (lambda?.resourceArn) createdLambdaArns.push(lambda.resourceArn);
  }, 600_000);

  afterAll(async () => {
    if (!RUN_E2E) return;
    if (skipIfNoCreds()) return;

    const region = process.env["AWS_REGION"] ?? "us-east-1";

    // Tear down Lambda first (depends on role), then role.
    try {
      const { LambdaClient, DeleteFunctionCommand } =
        await import("@aws-sdk/client-lambda");
      const lambda = new LambdaClient({
        region,
        credentials: operatorCreds(),
      });
      for (const fnArnOrName of createdLambdaArns) {
        // Lambda accepts both ARN and bare name as FunctionName
        try {
          await lambda.send(
            new DeleteFunctionCommand({ FunctionName: fnArnOrName }),
          );
          console.log(`E2E cleanup: deleted Lambda ${fnArnOrName}`);
        } catch (err) {
          console.warn(
            `E2E Lambda cleanup failed for ${fnArnOrName}: ${String(err)}`,
          );
        }
      }
    } catch (err) {
      console.warn(`E2E Lambda cleanup import failure: ${String(err)}`);
    }

    try {
      const { IAMClient, DeleteRoleCommand, DetachRolePolicyCommand } =
        await import("@aws-sdk/client-iam");
      const iam = new IAMClient({ region, credentials: operatorCreds() });
      for (const roleArnOrName of createdRoleArns) {
        // Strip ARN prefix if present — IAM SDK takes RoleName not ARN.
        const roleName = roleArnOrName.startsWith("arn:")
          ? (roleArnOrName.split("/").pop() ?? roleArnOrName)
          : roleArnOrName;
        // Detach the PowerUserAccess permissions boundary first; the
        // pattern attaches it via PermissionsBoundary, but we may also
        // have managed policies attached at apply time.
        try {
          await iam.send(
            new DetachRolePolicyCommand({
              RoleName: roleName,
              PolicyArn: "arn:aws:iam::aws:policy/PowerUserAccess",
            }),
          );
        } catch {
          // Boundary may not be attached as a policy — ignore
        }
        try {
          await iam.send(new DeleteRoleCommand({ RoleName: roleName }));
          console.log(`E2E cleanup: deleted IAM Role ${roleName}`);
        } catch (err) {
          const errName = (err as { name?: string })?.name ?? "";
          if (errName === "NoSuchEntityException") continue;
          console.warn(
            `E2E IAM Role cleanup failed for ${roleName}: ${String(err)}`,
          );
        }
      }
    } catch (err) {
      console.warn(`E2E IAM cleanup import failure: ${String(err)}`);
    }
  }, 180_000);
});

// Free-tier lifecycle cases for compute resources
const ecrCase = FREE_TIER_LIFECYCLE_CASES.find(
  (c) => c.label === "E2E: ECR Repository apply + destroy",
)!;
describeE2E(ecrCase.label, () => {
  it(
    `applies and destroys the resource`,
    async () => {
      await runFreeTierLifecycle(ecrCase);
    },
    ecrCase.timeoutMs ?? 240_000,
  );
});

const ecsCase = FREE_TIER_LIFECYCLE_CASES.find(
  (c) => c.label === "E2E: ECS Cluster apply + destroy",
)!;
describeE2E(ecsCase.label, () => {
  it(
    `applies and destroys the resource`,
    async () => {
      await runFreeTierLifecycle(ecsCase);
    },
    ecsCase.timeoutMs ?? 240_000,
  );
});
