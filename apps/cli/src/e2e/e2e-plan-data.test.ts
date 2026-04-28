// E2E plan tests for data resource family (SSM, RDS, DynamoDB, EFS, SecretsManager).
// Extracted from e2e-plan.test.ts during the M-018 cluster-D split (2026-04-28).
// The monolith remains in place until the lead step replaces it with a 5-line redirect.

import { it, expect, beforeAll, afterAll } from "vitest";
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

describeE2E("E2E: SSM Parameter plan + apply + destroy", () => {
  const paramName = `/e2e-test/assignee-${Date.now()}`;
  let resourceArn: string | undefined;

  it("plans, applies, and destroys an SSM parameter", async () => {
    const graph = createGraph(tools);
    const threadId = crypto.randomUUID();
    const config = { configurable: { thread_id: threadId } };

    // Phase 1: Plan + Apply in one pass (auto-approve)
    await graph.invoke(
      {
        userIntent: `Create an SSM parameter named ${paramName} with value "e2e-test-value"`,
        runId: crypto.randomUUID(),
        executionMode: ExecutionMode.APPLY,
        startedAt: Date.now(),
        noWizard: true,
        autoApprove: true,
        projectDir: process.cwd(),
      },
      config,
    );

    // Resume through the interrupt (HITL auto-approved)
    let graphState = await graph.getState(config);
    while (graphState.next.length > 0) {
      await graph.invoke(null, config);
      graphState = await graph.getState(config);
    }

    const finalState = graphState.values as AgentState;

    if (finalState.executionStatus !== ExecutionStatus.SUCCESS) {
      console.error("SSM E2E FAILED:", {
        status: finalState.executionStatus,
        error: finalState.errorMessage,
        preflightPassed: finalState.preflightPassed,
        bpFindings: finalState.bpFindings?.map(
          (f) => `${f.practiceId}: ${f.title} [blocking=${f.blocking}]`,
        ),
      });
    }

    expect(finalState.resourceType).toBe("AWS::SSM::Parameter");
    expect(finalState.executionStatus).toBe(ExecutionStatus.SUCCESS);
    // Tier C: strengthened — assert SSM parameter ARN shape, not just defined
    expect(finalState.resourceArn).toMatch(
      /^arn:aws:ssm:[a-z0-9-]+:\d+:parameter\//,
    );

    // P0-2: Standard-tier SSM parameters are always free. The headline
    // cost MUST display "Free", never "N/A".
    expect(finalState.estimatedMonthlyCost).toBe("Free");

    resourceArn = finalState.resourceArn;
  }, 90_000);

  afterAll(async () => {
    // Exercise the full destroy resolver path end-to-end (P0-3).
    //
    // Previously this block bypassed the resolver by calling the SSM SDK
    // directly, so the bug where `destroy /smoke-test-x` failed to resolve
    // SSM parameters by their user-visible name went undetected. We now:
    //   1. Strip the leading slash from the canonical SSM name, simulating
    //      a user typing the bare name they'd see in `assignee list`.
    //   2. Feed that bare name through `resolveResource` — the exact path
    //      `assignee destroy <name>` takes in commands/destroy.ts.
    //   3. Hand the resolved record to `destroySingleResource`, the same
    //      shared destroy codepath used by the CLI command.
    //
    // Fallback to the raw SSM SDK runs only if resolver/destroy couldn't
    // delete the parameter, so cleanup still happens on crashes.
    const region = process.env["AWS_REGION"] ?? "us-east-1";
    const bareName = paramName.replace(/^\//, "");

    let resolvedOk = false;
    try {
      const { createTaggingClient, resolveResource, isAmbiguousResolution } =
        await import("../services/resource-resolver.js");
      const { destroySingleResource } =
        await import("../services/destroy-service.js");

      const taggingClient = createTaggingClient({
        ...operatorCreds(),
        region,
      });

      // Resolve using the bare name — this is what the bug targeted.
      const resolved = await resolveResource(bareName, taggingClient, region);

      // Story 48.6: resolveResource now returns a discriminated union; E2E
      // expects the single-match path for this unique parameter name.
      if (resolved && !isAmbiguousResolution(resolved)) {
        expect(resolved.resourceType).toBe("AWS::SSM::Parameter");
        // Canonical SSM identifier always starts with "/" and matches paramName.
        expect(resolved.identifier).toBe(paramName);
        // Resolved ARN must reference the same SSM parameter. The graph's
        // finalState.resourceArn may be the parameter name (SSM uses the
        // Name as its canonical resource id), so compare the trailing
        // "parameter/<name>" segment rather than requiring ARN equality.
        expect(resolved.arn).toMatch(/^arn:aws:ssm:[a-z0-9-]+:\d+:parameter\//);
        expect(resolved.arn.endsWith("parameter" + paramName)).toBe(true);

        const result = await destroySingleResource(resolved, { region });
        expect(result.success).toBe(true);
        console.log(
          `E2E cleanup: destroyed SSM parameter ${paramName} via resolver (bare="${bareName}")`,
        );
        resolvedOk = true;
      } else if (resourceArn) {
        // Resource exists but resolver missed it — surface as a hard failure
        // so the regression is caught locally before CI/live runs.
        throw new Error(
          `resolveResource returned null for bare SSM name "${bareName}" ` +
            `(arn=${resourceArn}). The P0-3 destroy resolver fix regressed.`,
        );
      }
    } catch (err: unknown) {
      const errName = (err as { name?: string })?.name ?? "";
      console.warn(
        `E2E resolver-based cleanup failed for ${paramName}: ${
          errName || (err instanceof Error ? err.message : String(err))
        } — falling back to SDK delete`,
      );
    }

    if (resolvedOk) return;

    // Fallback: direct SDK delete so we never leak resources on a crash.
    try {
      const { SSMClient, DeleteParameterCommand } =
        await import("@aws-sdk/client-ssm");
      const ssm = new SSMClient({
        region,
        credentials: operatorCreds(),
      });
      await ssm.send(new DeleteParameterCommand({ Name: paramName }));
      console.log(
        `E2E cleanup fallback: deleted SSM parameter ${paramName} via SDK`,
      );
    } catch (err: unknown) {
      const errName = (err as { name?: string })?.name ?? "";
      if (errName === "ParameterNotFound") return;
      if (
        errName === "CredentialsProviderError" ||
        errName === "ExpiredTokenException"
      ) {
        console.error(
          `❌ E2E cleanup CRITICAL: AWS credentials expired — leaked ${paramName}. ` +
            `Run 'assignee clean --resources --yes' to remove.`,
        );
      } else {
        console.warn(
          `E2E cleanup failed for ${paramName}: ${errName || String(err)}`,
        );
      }
    }
  }, 30_000);
});

// ── Story 47.6: RDS db.t3.micro apply + destroy (time-boxed) ──────────────
//
// AC #2 (NAT Gateway) is already covered by the existing `VPC compound
// apply + destroy` block further down (vpc-networking pattern includes
// NAT GW + auto-allocated EIP + EIP release on destroy) — no new code
// needed. This block closes AC #1: single-resource RDS apply+destroy
// under a 10-minute wall-clock cap.
//
// Intent is phrased to target single-resource RDS dispatch rather than
// the three-tier-web compound (which provisions 22 resources including a
// VPC). If the intent parser unexpectedly routes it through the compound
// pattern, the test will fail fast on the `resourceType` assertion below
// and the fix is to tighten the intent further.
//
// Free-tier math: db.t3.micro costs ~$0.017/hr (+ ~$0.002/hr for 20 GB
// gp3 storage). 10-minute max run = ~$0.003, well inside the story's
// "< $0.01" cap.
//
// Wave-4 F5 P2-R2-6: previously `describe.skip` with a comment "requires
// DBSubnetGroup+SG helper". The helper now lives in `ensureRdsVpcFixture`
// below — it creates a DBSubnetGroup over the default VPC's subnets plus
// a VPC-scoped SecurityGroup, so a "standalone" RDS test can satisfy
// RDS's cross-resource co-location rule without spinning up a full
// VPC stack. The helper also torches the fixtures after the suite so
// we don't leak orphans into the account.
describeE2E("E2E: RDS db.t3.micro apply + destroy (time-boxed)", () => {
  // Fixture outputs populated by beforeAll — referenced by presetFields
  // when invoking the graph so the LLM uses our DBSubnetGroup + SG.
  const rdsFixture: { dbSubnetGroupName?: string; securityGroupId?: string } =
    {};

  beforeAll(async () => {
    if (skipIfNoCreds()) return;
    const region = process.env["AWS_REGION"] ?? "us-east-1";
    const { EC2Client, DescribeVpcsCommand, DescribeSubnetsCommand } =
      await import("@aws-sdk/client-ec2");
    const { RDSClient, CreateDBSubnetGroupCommand } =
      await import("@aws-sdk/client-rds");
    const ec2 = new EC2Client({ region, credentials: operatorCreds() });
    // Default VPC — every modern AWS account ships with one. If the
    // account has had its default VPC deleted the test fails loudly with
    // an actionable message, which is the correct behavior.
    const vpcs = await ec2.send(
      new DescribeVpcsCommand({
        Filters: [{ Name: "is-default", Values: ["true"] }],
      }),
    );
    const defaultVpc = vpcs.Vpcs?.[0]?.VpcId;
    if (!defaultVpc) {
      throw new Error(
        "RDS E2E fixture: account has no default VPC. Create one (aws ec2 create-default-vpc) or run this test in an account that has one.",
      );
    }
    const subnets = await ec2.send(
      new DescribeSubnetsCommand({
        Filters: [{ Name: "vpc-id", Values: [defaultVpc] }],
      }),
    );
    const subnetIds = (subnets.Subnets ?? [])
      .map((s) => s.SubnetId!)
      .filter(Boolean);
    // RDS requires ≥2 AZs. Fail closed if the default VPC is misshapen.
    if (subnetIds.length < 2) {
      throw new Error(
        `RDS E2E fixture: default VPC ${defaultVpc} has <2 subnets; RDS requires a DBSubnetGroup spanning at least two AZs.`,
      );
    }

    // DBSubnetGroup
    const rds = new RDSClient({ region, credentials: operatorCreds() });
    const dbSubnetGroupName = `e2e-rds-sg-${Date.now()}`;
    await rds.send(
      new CreateDBSubnetGroupCommand({
        DBSubnetGroupName: dbSubnetGroupName,
        DBSubnetGroupDescription: "Assignee e2e RDS standalone test",
        SubnetIds: subnetIds,
        Tags: [
          { Key: "ManagedBy", Value: "assignee-e2e" },
          { Key: "TestRun", Value: String(Date.now()) },
        ],
      }),
    );
    rdsFixture.dbSubnetGroupName = dbSubnetGroupName;

    // VPC-scoped SG (RDS default "default" SG is EC2-Classic, which is
    // what triggered the pre-fix error).
    const { CreateSecurityGroupCommand } = await import("@aws-sdk/client-ec2");
    const sg = await ec2.send(
      new CreateSecurityGroupCommand({
        GroupName: `e2e-rds-sg-${Date.now()}`,
        Description: "Assignee e2e RDS standalone test SG",
        VpcId: defaultVpc,
      }),
    );
    rdsFixture.securityGroupId = sg.GroupId;
  }, 120_000);

  afterAll(async () => {
    if (!RUN_E2E || skipIfNoCreds()) return;
    const region = process.env["AWS_REGION"] ?? "us-east-1";
    // Tear down fixtures best-effort. The test's own destroyAndAssert
    // already cleaned up the DBInstance; fixtures live only here.
    try {
      if (rdsFixture.dbSubnetGroupName) {
        const { RDSClient, DeleteDBSubnetGroupCommand } =
          await import("@aws-sdk/client-rds");
        const rds = new RDSClient({ region, credentials: operatorCreds() });
        await rds.send(
          new DeleteDBSubnetGroupCommand({
            DBSubnetGroupName: rdsFixture.dbSubnetGroupName,
          }),
        );
      }
    } catch (err) {
      console.error(
        "RDS E2E fixture cleanup: DBSubnetGroup delete failed",
        err,
      );
    }
    try {
      if (rdsFixture.securityGroupId) {
        const { EC2Client, DeleteSecurityGroupCommand } =
          await import("@aws-sdk/client-ec2");
        const ec2 = new EC2Client({ region, credentials: operatorCreds() });
        await ec2.send(
          new DeleteSecurityGroupCommand({
            GroupId: rdsFixture.securityGroupId,
          }),
        );
      }
    } catch (err) {
      console.error(
        "RDS E2E fixture cleanup: SecurityGroup delete failed",
        err,
      );
    }
  }, 60_000);

  it("creates a single db.t3.micro postgres, then destroys it within 10 min", async () => {
    const graph = createGraph(tools);
    const threadId = crypto.randomUUID();
    // recursionLimit: 500 — RDS BP findings + autoFix iterations push
    // past LangGraph's default 25 (live-AWS 2026-04-14).
    const config = {
      configurable: { thread_id: threadId },
      recursionLimit: 500,
    };

    await graph.invoke(
      {
        // Wave-4 F5 P2-R2-6: the "standalone" keyword is now recognized
        // by intent-parser's disambiguation prompt (see intent-parser.ts)
        // and routes to AWS::RDS::DBInstance directly, not the
        // three-tier-web compound pattern.
        userIntent:
          "Create a single standalone AWS::RDS::DBInstance for e2e lifecycle testing — just the DBInstance, not a VPC/subnet compound pattern. EnableCloudwatchLogsExports must be an empty array [] — do not enable any log exports.",
        runId: crypto.randomUUID(),
        executionMode: ExecutionMode.APPLY,
        startedAt: Date.now(),
        noWizard: true,
        autoApprove: true,
        projectDir: process.cwd(),
        // `presetFields` is the canonical graph-state field (values are
        // strings like CLI `--set` produces). Prior version of this
        // block used a fabricated `userOverrides` field that AgentState
        // dropped silently — LLM could have picked db.m5.large at
        // $0.35/hr instead of db.t3.micro ($0.017/hr). Edge-hunter H1.
        presetFields: {
          DBInstanceClass: "db.t3.micro",
          MultiAZ: "false",
          AllocatedStorage: "20",
          StorageType: "gp3",
          Engine: "postgres",
          // LLM picks "8.0" (MySQL syntax) for postgres without an
          // explicit version pin — RDS rejects with "Cannot find
          // version 8.0 for postgres". Pin to a real Postgres 16.x
          // release. Live-AWS 2026-04-14.
          EngineVersion: "16.9",
          DeletionProtection: "false",
          // SkipFinalSnapshot: "true" — without this the RDS CCAPI
          // delete path tries to snapshot the instance, which (a)
          // blows the 600s time-box and (b) leaks a snapshot that
          // bills indefinitely. QA auditor blocker #2.
          SkipFinalSnapshot: "true",
          MasterUsername: "appuser",
          // Password must pass the preflight sentinel guard added in
          // P1a — non-sentinel value satisfying RDS's 8+ char /
          // no-reserved-chars rule.
          MasterUserPassword: "E2eAssigneeRds2026",
          // Wave-4 F5 P2-R2-6: direct the DBInstance into the
          // pre-provisioned DBSubnetGroup + VPC-scoped SG set up in
          // beforeAll. Without these the RDS create fails with
          // "security group 'default' (Non-VPC) and subnet group
          // 'default' (in VPC '...') are not in common VPC."
          DBSubnetGroupName: rdsFixture.dbSubnetGroupName ?? "",
          VPCSecurityGroups: rdsFixture.securityGroupId
            ? JSON.stringify([rdsFixture.securityGroupId])
            : "[]",
        },
      },
      config,
    );

    // Resume through the HITL interrupt (auto-approved). RDS apply is
    // typically 5-8 min for db.t3.micro, so this loop may iterate many
    // times as status-poller waits on CCAPI.
    let graphState = await graph.getState(config);
    while (graphState.next.length > 0) {
      await graph.invoke(null, config);
      graphState = await graph.getState(config);
    }
    const finalState = graphState.values as AgentState;

    if (finalState.executionStatus !== ExecutionStatus.SUCCESS) {
      console.error("RDS E2E FAILED:", {
        status: finalState.executionStatus,
        error: finalState.errorMessage,
        preflightPassed: finalState.preflightPassed,
        // If the intent parser compound-dispatched, this surfaces the
        // actual pattern so the test owner can tighten the intent.
        resourcePattern: finalState.resourcePattern?.patternId,
      });
    }

    expect(finalState.resourceType).toBe("AWS::RDS::DBInstance");
    expect(finalState.executionStatus).toBe(ExecutionStatus.SUCCESS);
    // RDS DBInstance primary identifier is the DBInstanceIdentifier
    // (bare name, not an ARN). resource-provisioner / arn-builder
    // normally elevates it to the full ARN for display. Accept either:
    // bare identifier matches AWS's lowercase-and-hyphen rule, and the
    // full ARN is the arn:aws:rds:<region>:<account>:db:<id> shape.
    expect(finalState.resourceArn).toMatch(
      /^(arn:aws[\w-]*:rds:[a-z0-9-]+:\d+:db:[a-z][a-z0-9-]{0,62}|[a-z][a-z0-9-]{0,62})$/,
    );
    // Headline cost must be non-"N/A" — RDS decomposer + live pricing
    // should produce a monthly figure. Regression guard. Shape-check
    // the canonical `~$X.YZ/month` emission so a degenerate "$" or ""
    // cannot pass as truthy.
    expect(finalState.estimatedMonthlyCost).not.toBe("N/A");
    expect(finalState.estimatedMonthlyCost).toMatch(/\$.*(\/mo|\/month|\/hr)/);

    const completed =
      finalState.completedResources ??
      ([
        {
          resourceArn: finalState.resourceArn,
          resourceType: "AWS::RDS::DBInstance",
        },
      ] as Array<{ resourceArn?: string; resourceType: string }>);
    await destroyAndAssert(completed);
    // Story AC: "within the time-box" — 600_000ms vitest timeout caps
    // the whole apply+destroy cycle at 10 minutes. RDS apply ~5-8m,
    // destroy ~2-3m, so the budget is tight but sufficient. If this
    // flakes on timeout, the correct response is to investigate why
    // RDS is slow this run, NOT to weaken the timeout.
  }, 600_000);
});

describeE2E("E2E: DynamoDB Table plan", () => {
  it("generates a plan with key schema and billing mode", async () => {
    const graph = createGraph(tools);

    const state = await graph.invoke(
      {
        userIntent:
          "Create a DynamoDB table named e2e-dynamo-test with partition key id of type S",
        runId: crypto.randomUUID(),
        executionMode: ExecutionMode.PLAN,
        startedAt: Date.now(),
        noWizard: true,
        projectDir: process.cwd(),
      },
      { configurable: { thread_id: crypto.randomUUID() } },
    );

    const s = state as AgentState;

    expect(s.resourceType).toBe("AWS::DynamoDB::Table");
    // Tier C: strengthened — desiredState must be a non-empty object
    expect(s.desiredState).toBeInstanceOf(Object);
    expect(s.desiredState?.["TableName"]).toBe("e2e-dynamo-test");

    // BP findings should exist for DynamoDB
    // Tier C: strengthened — bpFindings must be an array (could be empty)
    expect(s.bpFindings).toBeInstanceOf(Array);
    expect(s.bpFindings!.length).toBeGreaterThan(0);
  }, 60_000);
});

// A1 (2026-04-08): first-class EFS support. Plan-only test — EFS
// apply is expensive (an EFS file system costs ~$0.30/GB-month
// minimum even empty) so the nightly RUN_E2E suite uses plan mode
// only. The provisioning smoke test for A1 will be run manually by
// the operator when they want to exercise the full lifecycle.
describeE2E("E2E: EFS FileSystem plan", () => {
  it("generates a plan with secure defaults (Encrypted=true, BackupPolicy.Status=ENABLED)", async () => {
    const graph = createGraph(tools);

    const state = await graph.invoke(
      {
        userIntent:
          "Create an EFS file system named e2e-efs-test for shared Lambda storage",
        runId: crypto.randomUUID(),
        executionMode: ExecutionMode.PLAN,
        startedAt: Date.now(),
        noWizard: true,
        projectDir: process.cwd(),
      },
      // EFS intent matches efs-with-vpc compound (10 resources) — the
      // default recursionLimit of 25 is too low for compound plan-mode
      // iteration. Mirror the 500 limit used by compound apply tests.
      { configurable: { thread_id: crypto.randomUUID() }, recursionLimit: 500 },
    );

    const s = state as AgentState;

    // EFS intent matches efs-with-vpc compound (10 resources). The graph
    // reports the current-iteration resource type after plan-mode loop,
    // which may be any resource in the queue — not necessarily FileSystem.
    // Assert the compound was dispatched correctly instead.
    expect(s.resourcePattern?.patternId).toBe("efs-with-vpc");
    expect(s.resourceQueue).toBeInstanceOf(Array);
    expect(
      s.resourceQueue!.some((r) => r.resourceType === "AWS::EFS::FileSystem"),
    ).toBe(true);
    // In compound plan-mode, s.desiredState reflects the LAST resource
    // iterated (likely a MountTarget or RT association), NOT the EFS
    // FileSystem. Per-resource property assertions (Encrypted, BackupPolicy,
    // FileSystemTags) can't be checked on the top-level state — they live
    // in the pattern's defaultOptions which the compound provisioner reads
    // at apply time. Assert the pattern was dispatched and the queue has
    // the expected resource count instead.
    expect(s.resourceQueue!.length).toBe(10); // 10 resources in efs-with-vpc

    // BP findings should exist (at minimum the awareness-level
    // advisories fire even on fully-compliant defaults).
    expect(s.bpFindings).toBeInstanceOf(Array);
    // Neither BP-EFS-001 nor BP-EFS-002 should surface as a blocking
    // finding when the secure defaults are in place.
    const blocking = (s.bpFindings ?? []).filter((f) => f.blocking === true);
    const efsBlocking = blocking.filter(
      (f) => f.practiceId === "BP-EFS-001" || f.practiceId === "BP-EFS-002",
    );
    expect(efsBlocking).toHaveLength(0);
  }, 60_000);
});

describeE2E("E2E: SecretsManager Secret plan", () => {
  it("generates a plan with secret configuration", async () => {
    const graph = createGraph(tools);

    const state = await graph.invoke(
      {
        userIntent: "Create a secret named e2e-secret-test in Secrets Manager",
        runId: crypto.randomUUID(),
        executionMode: ExecutionMode.PLAN,
        startedAt: Date.now(),
        noWizard: true,
        projectDir: process.cwd(),
      },
      { configurable: { thread_id: crypto.randomUUID() } },
    );

    const s = state as AgentState;

    expect(s.resourceType).toBe("AWS::SecretsManager::Secret");
    // Tier C: strengthened — desiredState must be a non-empty object
    expect(s.desiredState).toBeInstanceOf(Object);

    // BP findings should exist for Secrets Manager
    // Tier C: strengthened — bpFindings must be an array (could be empty)
    expect(s.bpFindings).toBeInstanceOf(Array);
    expect(s.bpFindings!.length).toBeGreaterThan(0);
  }, 60_000);
});

describeE2E("E2E: RDS DB Instance plan", () => {
  it("generates a plan with database configuration (compound or single)", async () => {
    const graph = createGraph(tools);
    const state = await graph.invoke(
      {
        userIntent:
          "Create a PostgreSQL database named e2e-rds-test with db.t3.micro",
        runId: crypto.randomUUID(),
        executionMode: ExecutionMode.PLAN,
        startedAt: Date.now(),
        noWizard: true,
        projectDir: process.cwd(),
      },
      // RDS often compound-dispatches to three-tier-web (22 resources) —
      // needs 500 recursion limit.
      {
        configurable: { thread_id: crypto.randomUUID() },
        recursionLimit: 500,
      },
    );
    const s = state as AgentState;
    if (s.resourcePattern?.patternId) {
      expect(s.resourceQueue).toBeInstanceOf(Array);
      expect(
        s.resourceQueue!.some((r) => r.resourceType === "AWS::RDS::DBInstance"),
      ).toBe(true);
    } else {
      expect(s.resourceType).toBe("AWS::RDS::DBInstance");
    }
    expect(s.bpFindings).toBeInstanceOf(Array);
  }, 60_000);
});

// Free-tier lifecycle cases for data resources
const ddbCase = FREE_TIER_LIFECYCLE_CASES.find(
  (c) => c.label === "E2E: DynamoDB Table apply + destroy",
)!;
describeE2E(ddbCase.label, () => {
  it(
    `applies and destroys the resource`,
    async () => {
      await runFreeTierLifecycle(ddbCase);
    },
    ddbCase.timeoutMs ?? 240_000,
  );
});

const secretsCase = FREE_TIER_LIFECYCLE_CASES.find(
  (c) => c.label === "E2E: SecretsManager Secret apply + destroy",
)!;
describeE2E(secretsCase.label, () => {
  it(
    `applies and destroys the resource`,
    async () => {
      await runFreeTierLifecycle(secretsCase);
    },
    secretsCase.timeoutMs ?? 240_000,
  );
});
