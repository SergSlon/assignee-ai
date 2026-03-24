import { describe, it, expect } from "vitest";
import { lambdaFunctionPlugin } from "./lambda-function.js";
import { ecsClusterPlugin } from "./ecs-cluster.js";
import { logGroupPlugin } from "./logs-loggroup.js";
import {
  collectCompanionResources,
  type PlannedResource,
} from "../companion-resources.js";

// ── Lambda co-provisioning ─────────────────────────────────────────────────

describe("Lambda LogGroup co-provisioning", () => {
  it("returns a LogGroup with /aws/lambda/<FunctionName> naming", () => {
    const companions = lambdaFunctionPlugin.companionResources!({
      FunctionName: "my-api-handler",
      Runtime: "nodejs22.x",
    });

    expect(companions).toHaveLength(1);
    expect(companions[0]!.type).toBe("AWS::Logs::LogGroup");
    expect(companions[0]!.properties["LogGroupName"]).toBe(
      "/aws/lambda/my-api-handler",
    );
  });

  it("sets RetentionInDays to 14 by default", () => {
    const companions = lambdaFunctionPlugin.companionResources!({
      FunctionName: "my-func",
    });

    expect(companions[0]!.properties["RetentionInDays"]).toBe(14);
  });

  it("uses user-configured RetentionInDays when provided", () => {
    const companions = lambdaFunctionPlugin.companionResources!({
      FunctionName: "my-func",
      LogRetentionInDays: 90,
    });

    expect(companions[0]!.properties["RetentionInDays"]).toBe(90);
  });

  it("generates a valid logicalId from FunctionName", () => {
    const companions = lambdaFunctionPlugin.companionResources!({
      FunctionName: "my-api-handler",
    });

    // Hyphens stripped: "myapihandlerLogGroup"
    expect(companions[0]!.logicalId).toBe("myapihandlerLogGroup");
  });

  it("returns empty array when FunctionName is missing", () => {
    const companions = lambdaFunctionPlugin.companionResources!({});
    expect(companions).toHaveLength(0);
  });

  it("returns empty array when FunctionName is not a string", () => {
    const companions = lambdaFunctionPlugin.companionResources!({
      FunctionName: 123,
    });
    expect(companions).toHaveLength(0);
  });
});

// ── ECS co-provisioning ────────────────────────────────────────────────────

describe("ECS LogGroup co-provisioning", () => {
  it("returns a LogGroup with /ecs/<ClusterName> naming", () => {
    const companions = ecsClusterPlugin.companionResources!({
      ClusterName: "web-cluster",
    });

    expect(companions).toHaveLength(1);
    expect(companions[0]!.type).toBe("AWS::Logs::LogGroup");
    expect(companions[0]!.properties["LogGroupName"]).toBe("/ecs/web-cluster");
  });

  it("sets RetentionInDays to 14 by default", () => {
    const companions = ecsClusterPlugin.companionResources!({
      ClusterName: "web-cluster",
    });

    expect(companions[0]!.properties["RetentionInDays"]).toBe(14);
  });

  it("uses user-configured RetentionInDays when provided", () => {
    const companions = ecsClusterPlugin.companionResources!({
      ClusterName: "web-cluster",
      LogRetentionInDays: 365,
    });

    expect(companions[0]!.properties["RetentionInDays"]).toBe(365);
  });

  it("generates a valid logicalId from ClusterName", () => {
    const companions = ecsClusterPlugin.companionResources!({
      ClusterName: "web-cluster",
    });

    expect(companions[0]!.logicalId).toBe("webclusterLogGroup");
  });

  it("returns empty array when ClusterName is missing", () => {
    const companions = ecsClusterPlugin.companionResources!({});
    expect(companions).toHaveLength(0);
  });

  it("returns empty array when ClusterName is not a string", () => {
    const companions = ecsClusterPlugin.companionResources!({
      ClusterName: 42,
    });
    expect(companions).toHaveLength(0);
  });
});

// ── collectCompanionResources (deduplication + opt-out) ────────────────────

describe("collectCompanionResources", () => {
  it("collects LogGroup companions from Lambda and ECS together", () => {
    const planned: PlannedResource[] = [
      {
        plugin: lambdaFunctionPlugin,
        desiredState: { FunctionName: "func-a" },
      },
      {
        plugin: ecsClusterPlugin,
        desiredState: { ClusterName: "cluster-b" },
      },
    ];

    const result = collectCompanionResources(planned);
    expect(result).toHaveLength(2);

    const logGroupNames = result.map((r) => r.properties["LogGroupName"]);
    expect(logGroupNames).toContain("/aws/lambda/func-a");
    expect(logGroupNames).toContain("/ecs/cluster-b");
  });

  it("deduplicates when user explicitly adds a matching LogGroup", () => {
    const planned: PlannedResource[] = [
      {
        plugin: logGroupPlugin,
        desiredState: { LogGroupName: "/aws/lambda/my-func" },
      },
      {
        plugin: lambdaFunctionPlugin,
        desiredState: { FunctionName: "my-func" },
      },
    ];

    const result = collectCompanionResources(planned);
    // The Lambda companion should be skipped — LogGroup already in plan
    expect(result).toHaveLength(0);
  });

  it("does not deduplicate when user LogGroup has a different name", () => {
    const planned: PlannedResource[] = [
      {
        plugin: logGroupPlugin,
        desiredState: { LogGroupName: "/custom/other-group" },
      },
      {
        plugin: lambdaFunctionPlugin,
        desiredState: { FunctionName: "my-func" },
      },
    ];

    const result = collectCompanionResources(planned);
    // User's LogGroup has a different name, so companion should still be generated
    expect(result).toHaveLength(1);
    expect(result[0]!.properties["LogGroupName"]).toBe("/aws/lambda/my-func");
  });

  it("deduplicates companion LogGroups across multiple Lambda functions with same name", () => {
    const planned: PlannedResource[] = [
      {
        plugin: lambdaFunctionPlugin,
        desiredState: { FunctionName: "shared-func" },
      },
      {
        plugin: lambdaFunctionPlugin,
        desiredState: { FunctionName: "shared-func" },
      },
    ];

    const result = collectCompanionResources(planned);
    // Only one LogGroup should be generated despite two Lambdas with same name
    expect(result).toHaveLength(1);
    expect(result[0]!.properties["LogGroupName"]).toBe(
      "/aws/lambda/shared-func",
    );
  });

  it("returns empty array when disabled (--no-log-group opt-out)", () => {
    const planned: PlannedResource[] = [
      {
        plugin: lambdaFunctionPlugin,
        desiredState: { FunctionName: "func-a" },
      },
      {
        plugin: ecsClusterPlugin,
        desiredState: { ClusterName: "cluster-b" },
      },
    ];

    const result = collectCompanionResources(planned, { disabled: true });
    expect(result).toHaveLength(0);
  });

  it("skips plugins without companionResources method", () => {
    const planned: PlannedResource[] = [
      {
        plugin: logGroupPlugin, // logGroupPlugin has no companionResources
        desiredState: { LogGroupName: "/custom/group" },
      },
    ];

    const result = collectCompanionResources(planned);
    expect(result).toHaveLength(0);
  });

  it("handles empty planned array", () => {
    const result = collectCompanionResources([]);
    expect(result).toHaveLength(0);
  });
});
