import { describe, it, expect } from "vitest";
import { RESOURCE_TYPES, ResourceDefault, CfnKey } from "@assignee/core";
import type { IntentDefaultOverride } from "./intent-defaults.js";
import { getIntentDefaults, applyIntentOverrides } from "./intent-defaults.js";
import type { ResourceField } from "@assignee/core";

describe("getIntentDefaults", () => {
  // ── Task 3.1 / AC #3: Lambda API handler defaults ─────────────────────

  it('returns MemorySize=512 and Timeout=30 for "api handler" intent', () => {
    const overrides = getIntentDefaults(
      "I need an api handler for my REST service",
      RESOURCE_TYPES.LAMBDA_FUNCTION,
    );
    const memOverride = overrides.find((o) => o.fieldName === "MemorySize");
    const timeoutOverride = overrides.find((o) => o.fieldName === "Timeout");

    expect(memOverride).toBeDefined();
    expect(memOverride!.value).toBe("512");
    expect(timeoutOverride).toBeDefined();
    expect(timeoutOverride!.value).toBe("30");
  });

  it('returns MemorySize=512 and Timeout=30 for "api endpoint" intent', () => {
    const overrides = getIntentDefaults(
      "create an api endpoint",
      RESOURCE_TYPES.LAMBDA_FUNCTION,
    );
    expect(overrides.find((o) => o.fieldName === "MemorySize")!.value).toBe(
      "512",
    );
    expect(overrides.find((o) => o.fieldName === "Timeout")!.value).toBe("30");
  });

  // ── Task 3.1 / AC #3: Lambda background job defaults ──────────────────

  it('returns Timeout=300 for "background job" intent', () => {
    const overrides = getIntentDefaults(
      "set up a background job processor",
      RESOURCE_TYPES.LAMBDA_FUNCTION,
    );
    const timeoutOverride = overrides.find((o) => o.fieldName === "Timeout");
    expect(timeoutOverride).toBeDefined();
    expect(timeoutOverride!.value).toBe("300");
  });

  it('returns Timeout=300 for "worker" intent', () => {
    const overrides = getIntentDefaults(
      "create a worker function",
      RESOURCE_TYPES.LAMBDA_FUNCTION,
    );
    const timeoutOverride = overrides.find((o) => o.fieldName === "Timeout");
    expect(timeoutOverride).toBeDefined();
    expect(timeoutOverride!.value).toBe("300");
  });

  it("does not return MemorySize override for worker intent", () => {
    const overrides = getIntentDefaults(
      "create a worker function",
      RESOURCE_TYPES.LAMBDA_FUNCTION,
    );
    const memOverride = overrides.find((o) => o.fieldName === "MemorySize");
    expect(memOverride).toBeUndefined();
  });

  // ── Task 6.1 / AC #9: RDS production defaults ─────────────────────────

  it('returns MultiAZ, BackupRetentionPeriod, DeletionProtection for "production database"', () => {
    const overrides = getIntentDefaults(
      "set up a production database",
      RESOURCE_TYPES.RDS_DB_INSTANCE,
    );
    expect(overrides.find((o) => o.fieldName === "MultiAZ")!.value).toBe(true);
    expect(
      overrides.find((o) => o.fieldName === "BackupRetentionPeriod")!.value,
    ).toBe("7");
    expect(
      overrides.find((o) => o.fieldName === "DeletionProtection")!.value,
    ).toBe(true);
  });

  it('returns MultiAZ, BackupRetentionPeriod, DeletionProtection for "prod db"', () => {
    const overrides = getIntentDefaults(
      "I need a prod db for my app",
      RESOURCE_TYPES.RDS_DB_INSTANCE,
    );
    expect(overrides.find((o) => o.fieldName === "MultiAZ")!.value).toBe(true);
    expect(
      overrides.find((o) => o.fieldName === "DeletionProtection")!.value,
    ).toBe(true);
  });

  // ── Task 6.1 / AC #9: RDS dev defaults ────────────────────────────────

  it('returns MultiAZ=false for "dev database"', () => {
    const overrides = getIntentDefaults(
      "create a dev database",
      RESOURCE_TYPES.RDS_DB_INSTANCE,
    );
    const multiAz = overrides.find((o) => o.fieldName === "MultiAZ");
    expect(multiAz).toBeDefined();
    expect(multiAz!.value).toBe(false);
  });

  it('returns MultiAZ=false for "dev db"', () => {
    const overrides = getIntentDefaults(
      "I need a dev db",
      RESOURCE_TYPES.RDS_DB_INSTANCE,
    );
    const multiAz = overrides.find((o) => o.fieldName === "MultiAZ");
    expect(multiAz).toBeDefined();
    expect(multiAz!.value).toBe(false);
  });

  // ── Edge cases ─────────────────────────────────────────────────────────

  it("returns empty array for unrelated intent", () => {
    const overrides = getIntentDefaults(
      "something random",
      RESOURCE_TYPES.LAMBDA_FUNCTION,
    );
    expect(overrides).toEqual([]);
  });

  it("returns empty array for empty intent", () => {
    const overrides = getIntentDefaults("", RESOURCE_TYPES.LAMBDA_FUNCTION);
    expect(overrides).toEqual([]);
  });

  // ── Story 18.12: categoryHint on EC2 intent overrides ───────────────────

  it('EC2 "web server" override includes categoryHint: "burstable"', () => {
    const overrides = getIntentDefaults(
      "Create an EC2 for web server",
      RESOURCE_TYPES.EC2_INSTANCE,
    );
    expect(overrides).toHaveLength(1);
    expect(overrides[0]!.categoryHint).toBe("burstable");
  });

  it('EC2 "machine learning" override includes categoryHint: "compute"', () => {
    const overrides = getIntentDefaults(
      "Create an EC2 for machine learning",
      RESOURCE_TYPES.EC2_INSTANCE,
    );
    expect(overrides).toHaveLength(1);
    expect(overrides[0]!.categoryHint).toBe("compute");
  });

  it('EC2 "database" override includes categoryHint: "memory"', () => {
    const overrides = getIntentDefaults(
      "Create an EC2 for database",
      RESOURCE_TYPES.EC2_INSTANCE,
    );
    expect(overrides).toHaveLength(1);
    expect(overrides[0]!.categoryHint).toBe("memory");
  });

  it("S3 overrides do not have categoryHint", () => {
    const overrides = getIntentDefaults(
      "Create S3 for static website hosting",
      RESOURCE_TYPES.S3_BUCKET,
    );
    expect(overrides.length).toBeGreaterThan(0);
    for (const o of overrides) {
      expect(o.categoryHint).toBeUndefined();
    }
  });

  // ── EC2 SSH intent detection ──────────────────────────────────────────────

  it('EC2 "SSH" intent returns KeyName + PublicIP overrides (SSH bundle)', () => {
    const overrides = getIntentDefaults(
      "Create an EC2 with SSH",
      RESOURCE_TYPES.EC2_INSTANCE,
    );
    const keyNameOverride = overrides.find(
      (o) => o.fieldName === CfnKey.KEY_NAME,
    );
    const publicIpOverride = overrides.find(
      (o) => o.fieldName === CfnKey.ASSOCIATE_PUBLIC_IP,
    );
    expect(keyNameOverride).toBeDefined();
    expect(keyNameOverride!.value).toBe(ResourceDefault.SSH_KEY_PLACEHOLDER);
    expect(publicIpOverride).toBeDefined();
    expect(publicIpOverride!.value).toBe(true);
    expect(publicIpOverride!.reason).toContain("SSH bundle");
  });

  it('EC2 "ssh into" intent returns SSH bundle overrides', () => {
    const overrides = getIntentDefaults(
      "Create an EC2 I can ssh into",
      RESOURCE_TYPES.EC2_INSTANCE,
    );
    expect(
      overrides.find((o) => o.fieldName === CfnKey.KEY_NAME),
    ).toBeDefined();
    expect(
      overrides.find((o) => o.fieldName === CfnKey.ASSOCIATE_PUBLIC_IP)!.value,
    ).toBe(true);
  });

  it("EC2 intent without SSH does not return KeyName override", () => {
    const overrides = getIntentDefaults(
      "Create an EC2 web server",
      RESOURCE_TYPES.EC2_INSTANCE,
    );
    const keyNameOverride = overrides.find(
      (o) => o.fieldName === CfnKey.KEY_NAME,
    );
    expect(keyNameOverride).toBeUndefined();
  });
});

// ── applyIntentOverrides — enum option injection ──────────────────────────

describe("applyIntentOverrides", () => {
  it("injects override value into enum options when not already present", () => {
    const fields: ResourceField[] = [
      {
        name: CfnKey.KEY_NAME,
        question: {
          type: "enum" as const,
          label: "EC2 Key Pair",
          hint: "Required for SSH access.",
          options: [
            { value: "", label: "None (SSM access only)" },
            { value: "existing-key", label: "existing-key (rsa)" },
          ],
        },
      },
    ];
    const overrides = getIntentDefaults(
      "Create an EC2 with SSH",
      RESOURCE_TYPES.EC2_INSTANCE,
    );

    const result = applyIntentOverrides(fields, overrides);
    const keyField = result.find((f) => f.name === CfnKey.KEY_NAME)!;

    // Should inject the placeholder as the first option
    expect(keyField.question.options![0]).toEqual({
      value: ResourceDefault.SSH_KEY_PLACEHOLDER,
      label: `${ResourceDefault.SSH_KEY_PLACEHOLDER} (auto-create)`,
    });
    // Should set initialValue
    expect(keyField.question.initialValue).toBe(
      ResourceDefault.SSH_KEY_PLACEHOLDER,
    );
  });

  // ── SSM Parameter: "secret" → SecureString ──────────────────────────────

  it('SSM Parameter "secret" intent returns SecureString type', () => {
    const overrides = getIntentDefaults(
      "store a secret value",
      RESOURCE_TYPES.SSM_PARAMETER,
    );
    const typeOverride = overrides.find((o) => o.fieldName === "Type");
    expect(typeOverride).toBeDefined();
    expect(typeOverride!.value).toBe("SecureString");
  });

  // ── SNS Topic: "fifo" → FifoTopic true ─────────────────────────────────

  it('SNS Topic "fifo" intent returns FifoTopic true', () => {
    const overrides = getIntentDefaults(
      "create a fifo topic",
      RESOURCE_TYPES.SNS_TOPIC,
    );
    const fifoOverride = overrides.find((o) => o.fieldName === "FifoTopic");
    expect(fifoOverride).toBeDefined();
    expect(fifoOverride!.value).toBe(true);
  });

  // ── CloudWatch LogGroup: "compliance" → 365 retention ──────────────────

  it('LogGroup "compliance" intent returns 365-day retention', () => {
    const overrides = getIntentDefaults(
      "create a compliance log group",
      RESOURCE_TYPES.LOGS_LOG_GROUP,
    );
    const retentionOverride = overrides.find(
      (o) => o.fieldName === "RetentionInDays",
    );
    expect(retentionOverride).toBeDefined();
    expect(retentionOverride!.value).toBe("365");
  });

  // ── ECS Cluster: "fargate" → containerInsights enabled ─────────────────

  it('ECS Cluster "fargate" intent returns containerInsights enabled', () => {
    const overrides = getIntentDefaults(
      "create a fargate cluster",
      RESOURCE_TYPES.ECS_CLUSTER,
    );
    const settingsOverride = overrides.find(
      (o) => o.fieldName === "ClusterSettings",
    );
    expect(settingsOverride).toBeDefined();
    expect(settingsOverride!.value).toEqual([
      { Name: "containerInsights", Value: "enabled" },
    ]);
  });

  // ── ECR Repository: "docker" → IMMUTABLE tags + scan on push ──────────

  it('ECR Repository "docker" intent returns IMMUTABLE tags and scan on push', () => {
    const overrides = getIntentDefaults(
      "create a docker repository",
      RESOURCE_TYPES.ECR_REPOSITORY,
    );
    const tagMutability = overrides.find(
      (o) => o.fieldName === "ImageTagMutability",
    );
    const scanOnPush = overrides.find((o) => o.fieldName === "ScanOnPush");
    expect(tagMutability).toBeDefined();
    expect(tagMutability!.value).toBe("IMMUTABLE");
    expect(scanOnPush).toBeDefined();
    expect(scanOnPush!.value).toBe(true);
  });

  // ── ELBv2: "web" → application type ───────────────────────────────────

  it('ELBv2 "web" intent returns application type', () => {
    const overrides = getIntentDefaults(
      "create a web load balancer",
      RESOURCE_TYPES.ELBV2_LOAD_BALANCER,
    );
    const typeOverride = overrides.find((o) => o.fieldName === "Type");
    expect(typeOverride).toBeDefined();
    expect(typeOverride!.value).toBe("application");
  });

  // ── API Gateway V2: "websocket" → WEBSOCKET protocol ──────────────────

  it('API Gateway V2 "websocket" intent returns WEBSOCKET protocol', () => {
    const overrides = getIntentDefaults(
      "create a websocket api",
      RESOURCE_TYPES.APIGATEWAYV2_API,
    );
    const protocolOverride = overrides.find(
      (o) => o.fieldName === "ProtocolType",
    );
    expect(protocolOverride).toBeDefined();
    expect(protocolOverride!.value).toBe("WEBSOCKET");
  });

  it("does not duplicate option if override value already in options", () => {
    const fields: ResourceField[] = [
      {
        name: CfnKey.KEY_NAME,
        question: {
          type: "enum" as const,
          label: "EC2 Key Pair",
          options: [
            { value: "", label: "None (SSM access only)" },
            {
              value: ResourceDefault.SSH_KEY_PLACEHOLDER,
              label: "assignee-ssh-key (rsa)",
            },
          ],
        },
      },
    ];
    const overrides = getIntentDefaults(
      "Create an EC2 with SSH",
      RESOURCE_TYPES.EC2_INSTANCE,
    );

    const result = applyIntentOverrides(fields, overrides);
    const keyField = result.find((f) => f.name === CfnKey.KEY_NAME)!;

    // Should not add duplicate — original 2 options remain
    expect(keyField.question.options).toHaveLength(2);
    expect(keyField.question.initialValue).toBe(
      ResourceDefault.SSH_KEY_PLACEHOLDER,
    );
  });
});
