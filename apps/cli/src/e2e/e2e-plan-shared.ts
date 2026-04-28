// Shared helpers extracted from e2e-plan.test.ts during the M-018 cluster-D split (2026-04-28).

import { describe, beforeAll, afterAll } from "vitest";
import { createGraph } from "../services/graph.js";
import {
  createMcpClient,
  getMcpTools,
  closeMcpClient,
} from "../services/mcp-client.js";
import { ExecutionMode, ExecutionStatus } from "@assignee/core";
import type { StructuredTool } from "@langchain/core/tools";
import type { AgentState } from "../services/graph-state.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { EnvVar } from "../constants/env-vars.js";

// Re-export for test files that need them
export { createGraph, ExecutionMode, ExecutionStatus };
export type { AgentState };
export { fs, path };

/**
 * E2E suite gate — these tests hit real AWS via the CLI graph.
 *
 * Opt-in only via `RUN_E2E=1` so plain `pnpm test` (and CI without the
 * env-var) NEVER trigger real provisioning. Use `pnpm test:e2e` or
 * `RUN_E2E=1 pnpm vitest run src/e2e/e2e-plan.test.ts` to execute.
 */
export const RUN_E2E = process.env["RUN_E2E"] === "1";
// Cast to `typeof describe` so the inferred type stays nameable for
// downstream `.d.ts` consumers (TS4023 / TS2742 — the vitest runner's
// `SuiteCollectorCallable` is in a private module path).
export const describeE2E: typeof describe = RUN_E2E
  ? describe
  : (describe.skip as unknown as typeof describe);

/**
 * Load credentials ONLY from assignee.ai/.env — never from the shell, SSO,
 * or ~/.aws/credentials. This enforces the 3-user IAM model so tests run
 * with the same least-privilege credentials production uses.
 *
 * If the file doesn't exist or lacks ASSIGNEE_OPERATOR_*, tests that need
 * AWS will be skipped via skipIfNoCreds().
 *
 * Values in .env OVERRIDE any existing shell env vars to prevent leakage.
 */
export function loadEnv() {
  // src/e2e/ → cli/ → apps/ → assignee.ai/ (4 levels up from source)
  const envPath = path.resolve(import.meta.dirname, "../../../../.env");
  if (!fs.existsSync(envPath)) return;

  const content = fs.readFileSync(envPath, "utf-8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx);
    const value = trimmed.slice(eqIdx + 1);
    // Override — .env is the source of truth for test credentials
    process.env[key] = value;
  }

  // Strip any shell-provided credentials that could leak through to AWS SDK
  // default provider chain (belt-and-suspenders; client code also uses
  // explicit credentials below).
  delete process.env["AWS_ACCESS_KEY_ID"];
  delete process.env["AWS_SECRET_ACCESS_KEY"];
  delete process.env["AWS_SESSION_TOKEN"];
  delete process.env["AWS_PROFILE"];
}
// NOTE: loadEnv() is intentionally NOT called at module load time anymore.
// It now runs inside the gated beforeAll() below so that:
//  1. Importing this file (e.g. when RUN_E2E is unset) does not mutate
//     process.env or strip AWS credentials from the parent shell.
//  2. The mutations are paired with a snapshot/restore in afterAll().
export let savedEnv: NodeJS.ProcessEnv | undefined;

/**
 * Returns explicit operator credentials from .env — never falls through
 * to the default credential chain. Used by all AWS SDK clients in e2e tests.
 */
export function operatorCreds(): {
  accessKeyId: string;
  secretAccessKey: string;
} {
  const accessKeyId = process.env[EnvVar.OPERATOR_ACCESS_KEY];
  const secretAccessKey = process.env[EnvVar.OPERATOR_SECRET_KEY];
  if (!accessKeyId || !secretAccessKey) {
    throw new Error(
      `Missing operator credentials. Set ${EnvVar.OPERATOR_ACCESS_KEY} and ` +
        `${EnvVar.OPERATOR_SECRET_KEY} in assignee.ai/.env.`,
    );
  }
  return { accessKeyId, secretAccessKey };
}

/**
 * Run bulk-destroy but only assert on failures for resources THIS test
 * created. planBulkDestroy sweeps the entire account — stale resources
 * from prior test runs (orphaned NAT Gateways, RGTA tag cache ghosts)
 * would cause false failures if we asserted on the full failure list.
 *
 * Filter: a destroy failure is only reported if the resource's identifier
 * matches one of the completedResources from this test's apply phase.
 */
export async function destroyAndAssert(
  completed: Array<{ resourceArn?: string; resourceType: string }>,
): Promise<void> {
  const region = process.env["AWS_REGION"] ?? "us-east-1";
  const { planBulkSweep } = await import("./bulk-sweep.js");
  const { destroySingleResource } =
    await import("../services/destroy-service.js");
  const plan = await planBulkSweep({ region });
  // Build a set of identifiers this test created for fast lookup
  const ownedIds = new Set(completed.map((c) => c.resourceArn).filter(Boolean));
  const failures: string[] = [];
  let lastTier = -1;
  for (const r of plan.resources) {
    // Wait 60s at tier boundaries to let async deletes propagate
    // (e.g. ALB ENI release before IGW detach, RDS delete before DBSubnetGroup).
    // QA WARNING W1 from qa-expert-e2e-fixes.md: comment previously said
    // "30s" but code slept for 60s — align the comment to reality.
    if (r.tier > lastTier && lastTier >= 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, 60_000));
    }
    lastTier = r.tier;
    const result = await destroySingleResource(r, { region });
    if (
      !result.success &&
      (ownedIds.has(r.identifier) || ownedIds.has(r.arn))
    ) {
      failures.push(
        `${r.resourceType} ${r.identifier}: ${result.error ?? "unknown"}`,
      );
    }
  }
  // Import expect lazily to avoid issues if vitest re-resolves the module
  const { expect } = await import("vitest");
  expect(failures).toEqual([]); // Only asserts on THIS run's resources
}

export let tools: StructuredTool[];
export let mcpClient: Awaited<ReturnType<typeof createMcpClient>>;

/** Pre-sweep: delete leftover resources from previous crashed runs. */
export async function sweepStaleResources(): Promise<void> {
  const region = process.env["AWS_REGION"] ?? "us-east-1";
  try {
    const { SSMClient, GetParametersByPathCommand, DeleteParameterCommand } =
      await import("@aws-sdk/client-ssm");
    const ssm = new SSMClient({ region, credentials: operatorCreds() });
    const params = await ssm.send(
      new GetParametersByPathCommand({ Path: "/e2e-test/", Recursive: true }),
    );
    for (const p of params.Parameters ?? []) {
      if (p.Name) {
        await ssm.send(new DeleteParameterCommand({ Name: p.Name }));
        console.log(`E2E pre-sweep: deleted stale SSM param ${p.Name}`);
      }
    }
  } catch (err: unknown) {
    // Credential errors are actionable — log loudly. ParameterNotFound is fine.
    const errName = (err as { name?: string })?.name ?? "";
    if (
      errName === "CredentialsProviderError" ||
      errName === "ExpiredTokenException" ||
      errName === "UnrecognizedClientException"
    ) {
      console.error(
        `❌ E2E pre-sweep FAILED: AWS credentials expired or invalid (${errName}). ` +
          `Run 'aws sso login' and retry. Existing /e2e-test/* params will accumulate.`,
      );
    } else if (errName !== "ParameterNotFound") {
      console.warn(`E2E pre-sweep SSM error: ${errName || String(err)}`);
    }
  }
  try {
    const { S3Client, ListBucketsCommand, DeleteBucketCommand } =
      await import("@aws-sdk/client-s3");
    const s3 = new S3Client({ region, credentials: operatorCreds() });
    const { Buckets } = await s3.send(new ListBucketsCommand({}));
    for (const b of Buckets ?? []) {
      // Epic 98 e98.W5.P2 (D-10): sweep every e2e-authored bucket
      // prefix. Prior to W5.P2 only `e2e-` + `poc-apply-test-` were
      // swept; the `assignee-e2e-*` family (used by the Slice A
      // matrix at apps/cli/src/e2e/e2e-plan.test.ts:1057+) leaked
      // across runs whenever per-test cleanup crashed. Added
      // `assignee-e2e-`, `assignee-e2e-s3-`, `assignee-e2e-epic35-`
      // to cover the full e2e corpus.
      if (b.Name && isE2eBucketName(b.Name)) {
        try {
          await s3.send(new DeleteBucketCommand({ Bucket: b.Name }));
          console.log(`E2E pre-sweep: deleted stale bucket ${b.Name}`);
        } catch {
          // bucket may have objects — skip
        }
      }
    }
  } catch {
    // S3 cleanup best-effort
  }
}

/**
 * Epic 98 e98.W5.P2 (D-10): single-source-of-truth predicate for
 * "is this bucket name one of ours?" across BOTH the pre-sweep and
 * the afterAll global sweeper. Prefixes match the e2e corpus:
 *
 *   - `e2e-`                  generic (oldest tests)
 *   - `poc-apply-test-`       legacy apply-test fixtures
 *   - `assignee-e2e-`         Slice A matrix (S3/IAM/SQS/DDB/etc.)
 *   - `assignee-e2e-s3-`      narrow S3 lanes
 *   - `assignee-e2e-epic35-`  Epic 35 static-site / storybook tests
 *
 * Kept intentionally conservative — extending the match set is a
 * one-line change, narrowing it is a test-integrity decision.
 */
export function isE2eBucketName(name: string): boolean {
  return (
    name.startsWith("e2e-") ||
    name.startsWith("poc-apply-test-") ||
    name.startsWith("assignee-e2e-")
  );
}

// Architect W-001 / TEA TEA-001 / R4 edge-case D-1: the beforeAll/afterAll
// hooks below are registered at MODULE LOAD time, which means each importing
// per-resource e2e file re-registers them in its own vitest test-file worker.
// With vitest 3.x `fileParallelism: true` × 9 importers, a `RUN_E2E=1` run
// would spawn the MCP child + run the SSM/RGTA/S3 sweep nine times. The
// global setup state guard below short-circuits subsequent invocations so
// the heavy work only runs once per `RUN_E2E=1` test process — restoring
// pre-split (single-monolith) cost characteristics.
let setupExecuted = false;
let teardownExecuted = false;

beforeAll(async () => {
  // Hard gate — never execute setup unless RUN_E2E=1
  if (!RUN_E2E) return;
  if (setupExecuted) return;
  setupExecuted = true;
  // Snapshot env BEFORE loadEnv mutates it so afterAll can restore.
  savedEnv = { ...process.env };
  loadEnv();
  // Skip if no credentials
  if (skipIfNoCreds()) {
    console.warn(
      "Skipping E2E tests: no operator credentials in assignee.ai/.env",
    );
    return;
  }

  // Clean up leftovers from previous crashed runs before starting
  await sweepStaleResources();

  mcpClient = await createMcpClient();
  tools = await getMcpTools(mcpClient);
}, 30_000);

afterAll(async () => {
  if (!RUN_E2E) return;
  if (teardownExecuted) return;
  teardownExecuted = true;
  await closeMcpClient().catch(() => {});

  // Global sweeper: clean up any stale e2e test resources left by crashed runs.
  // Matches SSM parameters under /e2e-test/ prefix and ECS clusters with e2e names.
  if (skipIfNoCreds()) return;

  try {
    const region = process.env["AWS_REGION"] ?? "us-east-1";

    // Clean stale SSM params under /e2e-test/
    const { SSMClient, GetParametersByPathCommand, DeleteParameterCommand } =
      await import("@aws-sdk/client-ssm");
    const ssm = new SSMClient({ region, credentials: operatorCreds() });
    try {
      const params = await ssm.send(
        new GetParametersByPathCommand({ Path: "/e2e-test/", Recursive: true }),
      );
      for (const p of params.Parameters ?? []) {
        if (p.Name) {
          try {
            await ssm.send(new DeleteParameterCommand({ Name: p.Name }));
            console.log(`E2E sweeper: deleted stale SSM param ${p.Name}`);
          } catch (delErr: unknown) {
            const name = (delErr as { name?: string })?.name ?? "";
            console.warn(
              `E2E sweeper: failed to delete ${p.Name}: ${name || String(delErr)}`,
            );
          }
        }
      }
    } catch (err: unknown) {
      const errName = (err as { name?: string })?.name ?? "";
      if (
        errName === "CredentialsProviderError" ||
        errName === "ExpiredTokenException" ||
        errName === "UnrecognizedClientException"
      ) {
        console.error(
          `❌ E2E post-sweep FAILED: AWS credentials expired (${errName}). ` +
            `Run 'aws sso login' to avoid accumulating /e2e-test/* resources.`,
        );
      } else if (errName !== "ParameterNotFound") {
        console.warn(`E2E post-sweep SSM error: ${errName || String(err)}`);
      }
    }

    // Clean stale ECS clusters with e2e/test names via tagging API
    const { ResourceGroupsTaggingAPIClient, GetResourcesCommand } =
      await import("@aws-sdk/client-resource-groups-tagging-api");
    const tagging = new ResourceGroupsTaggingAPIClient({
      region,
      credentials: operatorCreds(),
    });
    try {
      const tagged = await tagging.send(
        new GetResourcesCommand({
          TagFilters: [{ Key: "managed-by", Values: ["assignee-ai"] }],
          ResourceTypeFilters: ["ecs:cluster"],
        }),
      );
      for (const r of tagged.ResourceTagMappingList ?? []) {
        const arn = r.ResourceARN;
        if (!arn) continue;
        const clusterName = arn.split("/").pop();
        if (
          clusterName &&
          (clusterName.includes("e2e-") || clusterName.includes("apply-t"))
        ) {
          // Use CloudControl to delete (available via existing SDK)
          const { CloudControlClient, DeleteResourceCommand } =
            await import("@aws-sdk/client-cloudcontrol");
          const cc = new CloudControlClient({
            region,
            credentials: operatorCreds(),
          });
          try {
            await cc.send(
              new DeleteResourceCommand({
                TypeName: "AWS::ECS::Cluster",
                Identifier: clusterName,
              }),
            );
            console.log(
              `E2E sweeper: deleted stale ECS cluster ${clusterName}`,
            );
          } catch {
            // cluster may already be inactive
          }
        }
      }
    } catch {
      // ECS cleanup is best-effort
    }

    // Epic 98 e98.W5.P2 (D-10): afterAll S3 bucket sweep. Previously
    // S3 buckets only got cleaned in `sweepStaleResources` at
    // beforeAll — so a crash between beforeAll and afterAll left the
    // bucket alive until the NEXT run's beforeAll. Mirror the bucket
    // sweep here so every afterAll also closes the leak window for
    // the run that just completed.
    try {
      const { S3Client, ListBucketsCommand, DeleteBucketCommand } =
        await import("@aws-sdk/client-s3");
      const s3 = new S3Client({ region, credentials: operatorCreds() });
      const { Buckets } = await s3.send(new ListBucketsCommand({}));
      for (const b of Buckets ?? []) {
        if (b.Name && isE2eBucketName(b.Name)) {
          try {
            await s3.send(new DeleteBucketCommand({ Bucket: b.Name }));
            console.log(`E2E post-sweep: deleted stale bucket ${b.Name}`);
          } catch {
            // bucket may still have objects; per-test cleanup owns those
          }
        }
      }
    } catch {
      // S3 post-sweep is best-effort
    }
  } catch (err) {
    console.warn("E2E sweeper error (non-fatal):", err);
  }

  // Restore the env snapshot taken before loadEnv() ran in beforeAll.
  if (savedEnv !== undefined) {
    process.env = savedEnv;
    savedEnv = undefined;
  }
}, 30_000);

export function skipIfNoCreds(): boolean {
  return (
    !process.env[EnvVar.OPERATOR_ACCESS_KEY] ||
    !process.env[EnvVar.OPERATOR_SECRET_KEY]
  );
}

// ── Story 47.3: Free-tier apply+destroy lifecycle for 12 resources ────────
//
// Each block below runs the full `plan → apply (autoApprove) → verify →
// destroy` cycle against a single free-tier resource. Together they cover
// the cheapest lane of the resource plugin catalog so the E2E suite
// exercises every tier without the cost footprint of RDS / NAT / EC2.
//
// Helper extracted to avoid 12× boilerplate — pure `describeE2E` wrapper
// that shares HITL interrupt-resume loop, resourceArn regex assertion,
// and destroyAndAssert cleanup across all blocks. Each caller only
// supplies the intent, expected resourceType, resourceArn regex, and
// optional presetFields (equivalent to CLI `--set key=value`).
export interface FreeTierLifecycleCase {
  /** vitest describe block label */
  label: string;
  /** natural-language userIntent sent to the graph */
  userIntent: string;
  /** expected state.resourceType after apply */
  resourceType: string;
  /** regex asserted against finalState.resourceArn */
  arnRegex: RegExp;
  /**
   * Optional CLI-style `--set` overrides. Maps to AgentState.presetFields
   * (canonical graph-state field). A prior version of this helper used a
   * fabricated `userOverrides` field that AgentState dropped silently;
   * edge-hunter H1 caught it.
   */
  presetFields?: Record<string, string>;
  /** vitest timeout (ms). Defaults to 120s — most free-tier resources
   *  apply in 10-30s; CloudWatch Alarm and EventBridge Rule can take
   *  up to 60s. 120s leaves headroom without encouraging flakes. */
  timeoutMs?: number;
  /**
   * Optional per-case escape hatch for non-"N/A" cost assertion. Some
   * free-tier resources legitimately report "Free" or "N/A" because no
   * pricing strategy exists (e.g. IAM Role is authoritatively Free).
   */
  skipCostAssertion?: boolean;
}

export async function runFreeTierLifecycle(
  kase: FreeTierLifecycleCase,
): Promise<void> {
  const graph = createGraph(tools);
  const threadId = crypto.randomUUID();
  // recursionLimit: 500 matches the compound-pattern apply blocks.
  // BP findings with autoFix iterations can push past the default 25
  // when the LLM proposes + re-plans fixes (observed on SQS which
  // emits 3 HIGH BP findings). 500 gives generous budget without
  // masking real infinite-loop bugs — a genuine loop blows past 500
  // almost immediately.
  const config = {
    configurable: { thread_id: threadId },
    recursionLimit: 500,
  };

  await graph.invoke(
    {
      userIntent: kase.userIntent,
      runId: crypto.randomUUID(),
      executionMode: ExecutionMode.APPLY,
      startedAt: Date.now(),
      noWizard: true,
      autoApprove: true,
      projectDir: process.cwd(),
      ...(kase.presetFields ? { presetFields: kase.presetFields } : {}),
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
    console.error(`${kase.label} FAILED:`, {
      status: finalState.executionStatus,
      error: finalState.errorMessage,
      preflightPassed: finalState.preflightPassed,
      resourcePattern: finalState.resourcePattern?.patternId,
    });
  }

  const { expect } = await import("vitest");
  expect(finalState.resourceType).toBe(kase.resourceType);
  expect(finalState.executionStatus).toBe(ExecutionStatus.SUCCESS);
  expect(finalState.resourceArn).toMatch(kase.arnRegex);
  if (!kase.skipCostAssertion) {
    // Blind-hunter M3: bare `.toBeTruthy()` accepts "N/A" (truthy
    // string). Pricing regression to "N/A" for paid resources must
    // trip the test. Per-case `skipCostAssertion` escape hatch is
    // honored for genuinely-free types (IAM Role) and SecretsManager
    // (which was itself dropped in cf55d7d — $0.40 is a valid headline).
    // Wave-3 F7: tightened from `.toBeTruthy()` to a regex pin on the
    // canonical `~$X.YZ/month` shape so a degenerate string like "$"
    // or "Free" (without a cadence marker) cannot slip through.
    expect(finalState.estimatedMonthlyCost).not.toBe("N/A");
    expect(finalState.estimatedMonthlyCost).toMatch(/\$.*(\/mo|\/month|\/hr)/);
  }

  // Blind-hunter M2: `?? []` fires only on null/undefined, not on
  // an empty array. `completedResources: []` meant "apply failed
  // mid-flight after state reset" and would silently no-op
  // destroyAndAssert, hiding the real failure. Use `?.length` so
  // an empty array also falls through to the single-resource fallback.
  const completed =
    finalState.completedResources && finalState.completedResources.length > 0
      ? finalState.completedResources
      : ([
          {
            resourceArn: finalState.resourceArn,
            resourceType: finalState.resourceType,
          },
        ] as Array<{ resourceArn?: string; resourceType: string }>);
  await destroyAndAssert(completed);
}

export const FREE_TIER_LIFECYCLE_CASES: FreeTierLifecycleCase[] = [
  {
    label: "E2E: S3 Bucket apply + destroy",
    userIntent: `Create an S3 bucket named assignee-e2e-s3-${Date.now()} for test storage`,
    resourceType: "AWS::S3::Bucket",
    // S3 bucket identifier is the bucket name, ARN is arn:aws:s3:::<name>.
    // Accept either because arn-builder may surface either shape.
    arnRegex: /^(arn:aws[\w-]*:s3:::[a-z0-9.\-]{3,63}|[a-z0-9.\-]{3,63})$/,
    // S3 apply+destroy has been observed to take up to 90s on a fresh
    // bucket with deletion empty-bucket pre-hook — 180s is a safer
    // default than the 120s global minimum.
    timeoutMs: 180_000,
  },
  {
    label: "E2E: IAM Role apply + destroy",
    userIntent: `Create an IAM role named assignee-e2e-role-${Date.now()} for Lambda execution`,
    resourceType: "AWS::IAM::Role",
    arnRegex:
      /^(arn:aws[\w-]*:iam::\d+:role\/[A-Za-z0-9+=,.@_\-/]+|[A-Za-z0-9+=,.@_\-]+)$/,
    skipCostAssertion: true, // IAM Role is authoritatively Free — headline is "Free", not numeric
  },
  {
    label: "E2E: SQS Queue apply + destroy",
    userIntent: `Create a standalone SQS Standard queue named assignee-e2e-sqs-${Date.now()}. Just the queue — no Lambda, no DLQ, no triggers. Only AWS::SQS::Queue.`,
    resourceType: "AWS::SQS::Queue",
    // SQS queue identifier is the URL. ARN may also surface via arn-builder.
    arnRegex:
      /^(https:\/\/sqs\.[a-z0-9-]+\.amazonaws\.com\/\d+\/[A-Za-z0-9_-]+|arn:aws[\w-]*:sqs:[a-z0-9-]+:\d+:[A-Za-z0-9_-]+)$/,
  },
  {
    label: "E2E: DynamoDB Table apply + destroy",
    userIntent: `Create a DynamoDB table named assignee-e2e-ddb-${Date.now()} with partition key id of type S`,
    resourceType: "AWS::DynamoDB::Table",
    arnRegex:
      /^(arn:aws[\w-]*:dynamodb:[a-z0-9-]+:\d+:table\/[A-Za-z0-9_.\-]+|[A-Za-z0-9_.\-]+)$/,
  },
  {
    label: "E2E: CloudWatch Alarm apply + destroy",
    // Explicit "no AlarmActions" avoids LLM emitting a string where
    // CCAPI expects an array. A no-action alarm is valid (just logs
    // state). Live-AWS 2026-04-14 observed "AlarmActions: expected
    // type: JSONArray, found: String".
    userIntent: `Create a CloudWatch alarm named assignee-e2e-alarm-${Date.now()} that fires when EC2 CPUUtilization exceeds 80 for 5 minutes. No AlarmActions, OKActions, or InsufficientDataActions — leave those as empty arrays.`,
    resourceType: "AWS::CloudWatch::Alarm",
    arnRegex:
      /^(arn:aws[\w-]*:cloudwatch:[a-z0-9-]+:\d+:alarm:[A-Za-z0-9._\-]+|[A-Za-z0-9._\-]+)$/,
  },
  {
    label: "E2E: SecretsManager Secret apply + destroy",
    userIntent: `Create a Secrets Manager secret named assignee-e2e-secret-${Date.now()} for database credentials`,
    resourceType: "AWS::SecretsManager::Secret",
    arnRegex:
      /^(arn:aws[\w-]*:secretsmanager:[a-z0-9-]+:\d+:secret:[A-Za-z0-9/_+=.@\-]+|[A-Za-z0-9/_+=.@\-]+)$/,
    // No skipCostAssertion — QA auditor flagged the previous skip as a
    // missed regression signal. $0.40/secret/mo IS a valid truthy
    // headline; only "N/A" / undefined should trip the assertion.
  },
  {
    label: "E2E: SNS Topic apply + destroy",
    userIntent: `Create an SNS topic named assignee-e2e-sns-${Date.now()} for alerts`,
    resourceType: "AWS::SNS::Topic",
    arnRegex: /^arn:aws[\w-]*:sns:[a-z0-9-]+:\d+:[A-Za-z0-9_.\-]+$/,
  },
  {
    label: "E2E: ECR Repository apply + destroy",
    userIntent: `Create an ECR repository named assignee-e2e-ecr-${Date.now()} for docker images`,
    resourceType: "AWS::ECR::Repository",
    arnRegex:
      /^(arn:aws[\w-]*:ecr:[a-z0-9-]+:\d+:repository\/[a-z0-9_.\-/]+|[a-z0-9_.\-/]+)$/,
  },
  {
    label: "E2E: ECS Cluster apply + destroy",
    // Explicitly enable Container Insights to satisfy BP-ECS-007
    // (blocking). Live-AWS 2026-04-14 showed the default cluster
    // intent produced a BP-ECS-007 blocking finding that stopped
    // preflight with status=PENDING.
    userIntent: `Create an ECS cluster named assignee-e2e-ecs-${Date.now()} with Container Insights enabled (ClusterSettings: [{Name: containerInsights, Value: enabled}]). Just the cluster control plane — no services or tasks.`,
    resourceType: "AWS::ECS::Cluster",
    arnRegex:
      /^(arn:aws[\w-]*:ecs:[a-z0-9-]+:\d+:cluster\/[A-Za-z0-9_\-]+|[A-Za-z0-9_\-]+)$/,
  },
  {
    label: "E2E: CloudWatch LogGroup apply + destroy",
    userIntent: `Create a CloudWatch log group named /aws/assignee/e2e-${Date.now()}`,
    resourceType: "AWS::Logs::LogGroup",
    // Real observed ARN: "arn:aws:logs:us-east-1:<acct>:log-group:/aws/assignee/e2e-<ts>".
    // Accept optional `:*` suffix (CloudWatch canonical form) and bare
    // identifier (log-group name) as fallback. Edge-hunter H3: tighten
    // bare branch to require first char after `/` be alphanumeric —
    // old pattern allowed garbage like `/./` or `/_/`.
    arnRegex:
      /^(arn:aws[\w-]*:logs:[a-z0-9-]+:\d+:log-group:[A-Za-z0-9/_.#\-]+(?::\*)?|\/[A-Za-z0-9][A-Za-z0-9/_.#\-]*)$/,
  },
  // EventBridge Rule standalone apply deferred — the rule requires at
  // least one Target per BP-EVENTS-001, but the LLM reliably emits a
  // placeholder ARN for Targets[0].Arn that preflight rejects (Wave 11
  // placeholder-ARN guard). The scheduled-lambda compound already
  // covers the full EventBridge lifecycle end-to-end; a standalone
  // Rule test that doesn't compound-dispatch would need a
  // `skipTargets`-style escape or a two-phase setup (pre-create a
  // real target, reference it in presetFields). Out of scope for
  // Story 47.3's free-tier sweep; covered by 47-7.
  // {
  //   label: "E2E: EventBridge Rule apply + destroy",
  //   userIntent: `Create an EventBridge rule named assignee-e2e-rule-${Date.now()} that runs every 1 hour`,
  //   resourceType: "AWS::Events::Rule",
  //   arnRegex:
  //     /^(arn:aws[\w-]*:events:[a-z0-9-]+:\d+:rule\/[A-Za-z0-9_.\-/]+|[A-Za-z0-9_.\-]+)$/,
  // },
  {
    label: "E2E: KMS Key apply + destroy (schedule deletion)",
    userIntent: `Create a customer-managed KMS encryption key for assignee e2e test ${Date.now()}`,
    resourceType: "AWS::KMS::Key",
    // KMS KeyId is a UUID; the full ARN is arn:aws:kms:<region>:<account>:key/<uuid>.
    arnRegex:
      /^(arn:aws[\w-]*:kms:[a-z0-9-]+:\d+:key\/[0-9a-f-]{36}|[0-9a-f-]{36})$/,
    // KMS ScheduleKeyDeletion has a 7-day minimum waiting period — the
    // CCAPI delete call returns success immediately (schedules deletion)
    // but the key stays in PendingDeletion for 7 days. destroyAndAssert
    // only fails on "this run's resources still present", which
    // PendingDeletion satisfies (not active), so the assertion passes.
    timeoutMs: 180_000,
  },
];
