import { describe, it, expect } from "vitest";
import { scheduledLambdaPattern } from "./scheduled-lambda.js";
import { lambdaWithExecRolePattern } from "./lambda-with-exec-role.js";
import { PatternRegistry } from "../registry.js";
import { RESOURCE_TYPES } from "../../config/resource-types.js";
import { markerGetAtt, markerRef } from "../../config/marker-tokens.js";
import { ScheduledLambdaResourceId as R } from "../pattern-resource-ids.js";
import { PatternId } from "../pattern-ids.js";

/** Registry that matches the default registration order (scheduled BEFORE generic lambda). */
function buildRegistry(): PatternRegistry {
  const r = new PatternRegistry();
  r.register(scheduledLambdaPattern);
  r.register(lambdaWithExecRolePattern);
  return r;
}

describe("scheduledLambdaPattern — structure", () => {
  const pattern = scheduledLambdaPattern;

  it("has patternId 'scheduled-lambda'", () => {
    expect(pattern.patternId).toBe(PatternId.SCHEDULED_LAMBDA);
  });

  it("has at least 5 keywords for detection", () => {
    expect(pattern.keywords.length).toBeGreaterThanOrEqual(5);
  });

  it("every keyword is a non-empty lowercase string", () => {
    for (const kw of pattern.keywords) {
      expect(typeof kw).toBe("string");
      expect(kw.length).toBeGreaterThan(0);
      expect(kw).toBe(kw.toLowerCase());
    }
  });

  it("contains exactly 4 resources", () => {
    expect(pattern.resourceList).toHaveLength(4);
  });

  it("includes the expected resource types", () => {
    const types = pattern.resourceList.map((r) => r.resourceType);
    expect(types).toEqual([
      RESOURCE_TYPES.IAM_ROLE,
      RESOURCE_TYPES.LAMBDA_FUNCTION,
      RESOURCE_TYPES.EVENTS_RULE,
      "AWS::Lambda::Permission",
    ]);
  });

  it("marks the Lambda::Permission as non-provisionable (display-only)", () => {
    const permission = pattern.resourceList.find(
      (r) => r.resourceId === R.INVOKE_PERMISSION,
    )!;
    expect(permission.provisionable).toBe(false);
  });

  it("the other three resources are provisionable (provisionable undefined or true)", () => {
    const provisionable = pattern.resourceList.filter(
      (r) => r.provisionable !== false,
    );
    expect(provisionable.map((r) => r.resourceId)).toEqual([
      R.IAM_EXECUTION_ROLE,
      R.LAMBDA_FN,
      R.SCHEDULE_RULE,
    ]);
  });

  it("dependencyOrder and resourceList cover identical resourceId sets", () => {
    const depIds = new Set(pattern.dependencyOrder.flat());
    const listIds = new Set(pattern.resourceList.map((r) => r.resourceId));
    expect(depIds).toEqual(listIds);
  });

  it("every dependencyOrder id has a defaultOptions entry", () => {
    for (const id of pattern.dependencyOrder.flat()) {
      expect(pattern.defaultOptions[id]).toBeTypeOf("object");
    }
  });
});

describe("scheduledLambdaPattern — dependency ordering", () => {
  const pattern = scheduledLambdaPattern;
  const groupIndex = new Map<string, number>();
  pattern.dependencyOrder.forEach((group, i) =>
    group.forEach((id) => groupIndex.set(id, i)),
  );

  it("IAM role is in the first group", () => {
    expect(groupIndex.get(R.IAM_EXECUTION_ROLE)).toBe(0);
  });

  it("Lambda runs after the IAM role", () => {
    expect(groupIndex.get(R.LAMBDA_FN)!).toBeGreaterThan(
      groupIndex.get(R.IAM_EXECUTION_ROLE)!,
    );
  });

  it("Rule runs after the Lambda (needs Target.Arn)", () => {
    expect(groupIndex.get(R.SCHEDULE_RULE)!).toBeGreaterThan(
      groupIndex.get(R.LAMBDA_FN)!,
    );
  });

  it("Permission (display-only) runs last so plan box ordering is consistent", () => {
    const permissionGroup = groupIndex.get(R.INVOKE_PERMISSION)!;
    const allOthers = [R.IAM_EXECUTION_ROLE, R.LAMBDA_FN, R.SCHEDULE_RULE].map(
      (id) => groupIndex.get(id)!,
    );
    expect(permissionGroup).toBeGreaterThanOrEqual(Math.max(...allOthers));
  });
});

describe("scheduledLambdaPattern — marker token wiring", () => {
  const opts = scheduledLambdaPattern.defaultOptions;

  it("Lambda Role references the IAM role via markerGetAtt", () => {
    expect(opts[R.LAMBDA_FN]?.["Role"]).toBe(
      markerGetAtt(R.IAM_EXECUTION_ROLE, "Arn"),
    );
  });

  it("Lambda defaults to arm64 Graviton and 512 MB memory", () => {
    expect(opts[R.LAMBDA_FN]?.["Architectures"]).toEqual(["arm64"]);
    expect(opts[R.LAMBDA_FN]?.["MemorySize"]).toBe(512);
  });

  it("Lambda ships a placeholder ZipFile handler (user replaces post-apply)", () => {
    const code = opts[R.LAMBDA_FN]?.["Code"] as { ZipFile?: string };
    expect(code?.ZipFile).toMatch(/scheduled invocation/);
  });

  it("Rule defaults to rate(1 hour) with ENABLED state", () => {
    expect(opts[R.SCHEDULE_RULE]?.["ScheduleExpression"]).toBe("rate(1 hour)");
    expect(opts[R.SCHEDULE_RULE]?.["State"]).toBe("ENABLED");
  });

  // 2026-04-12: Targets removed from compound defaultOptions — CCAPI
  // resolves markerGetAtt(Lambda, "Arn") to the bare function name but
  // EventBridge PutTargets requires a full ARN. Targets will be added
  // via a post-apply SDK hook in a future story. The rule is created
  // target-less (valid per CCAPI) and the user adds targets manually.
  it("Rule has no inline Targets (handled via post-apply)", () => {
    expect(opts[R.SCHEDULE_RULE]?.["Targets"]).toBeUndefined();
  });

  it("Permission grants lambda:InvokeFunction to events.amazonaws.com", () => {
    expect(opts[R.INVOKE_PERMISSION]?.["Action"]).toBe("lambda:InvokeFunction");
    expect(opts[R.INVOKE_PERMISSION]?.["Principal"]).toBe(
      "events.amazonaws.com",
    );
  });

  it("Permission SourceArn references the schedule rule via markerRef", () => {
    expect(opts[R.INVOKE_PERMISSION]?.["SourceArn"]).toBe(
      markerRef(R.SCHEDULE_RULE),
    );
  });

  it("Permission FunctionName references the Lambda via markerGetAtt", () => {
    expect(opts[R.INVOKE_PERMISSION]?.["FunctionName"]).toBe(
      markerGetAtt(R.LAMBDA_FN, "Arn"),
    );
  });
});

describe("scheduledLambdaPattern — registry detection & ordering", () => {
  const registry = buildRegistry();

  const positiveCases = [
    "create a scheduled lambda",
    "cron lambda every hour",
    "nightly lambda job",
    "nightly cleanup of expired s3 objects",
    "recurring lambda task",
    "recurring job that calls our cleanup API",
    "periodic lambda",
    "timer lambda that resets counters",
    // Epic 92 wave 2.b (finding C-07) — new colloquial triggers
    "lambda that runs every 5 minutes",
    "lambda runs-every hour for cache warmup",
    "lambda every hour for log rotation",
    "lambda every day at midnight",
    "lambda on a schedule for backups",
    "lambda on-a-schedule triggered by cron",
    "hourly lambda for metric roll-up",
    "daily lambda for report generation",
    // SX-1 (2026-05-13, PH1-H-1 BLOCKER) — bare EventBridge rule phrasing
    // that previously routed to a single-resource Events::Rule with no Targets
    "Create an EventBridge rule that fires every 5 minutes",
    "Create an EventBridge rule with rate(5 minutes)",
    "trigger every 15 minutes via EventBridge",
    "fires every hour for log processing",
    "fires at cron(0 12 * * ? *) daily noon",
  ];

  for (const intent of positiveCases) {
    it(`detects "${intent}" as scheduled-lambda (not lambda-with-exec-role)`, () => {
      const detected = registry.detect(intent);
      expect(detected?.patternId).toBe(PatternId.SCHEDULED_LAMBDA);
    });
  }

  it("plain 'create a lambda' still routes to lambda-with-exec-role", () => {
    const detected = registry.detect("create a lambda");
    expect(detected?.patternId).toBe(PatternId.LAMBDA_WITH_EXEC_ROLE);
  });

  it("does not match an unrelated intent", () => {
    expect(registry.detect("create an s3 bucket")).toBeNull();
  });
});
