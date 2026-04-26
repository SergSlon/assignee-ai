import { describe, it, expect } from "vitest";
import { RESOURCE_TYPES, ResourceDefault, CfnKey } from "../index.js";
import { getIntentDefaults, applyIntentOverrides } from "./intent-defaults.js";
import type { ResourceField, ResolvedFieldConfig } from "../index.js";
import { applyFieldGates } from "../graph/nodes/option-elicitor/field-gates.js";
import { FieldPolicy } from "../constants/field-policy.js";

describe("getIntentDefaults", () => {
  // ── Task 3.1 / AC #3: Lambda API handler defaults ─────────────────────

  it('returns MemorySize=512 and Timeout=30 for "api handler" intent', () => {
    const overrides = getIntentDefaults(
      "I need an api handler for my REST service",
      RESOURCE_TYPES.LAMBDA_FUNCTION,
    );
    expect(overrides).toContainEqual(
      expect.objectContaining({ fieldName: "MemorySize", value: "512" }),
    );
    expect(overrides).toContainEqual(
      expect.objectContaining({ fieldName: "Timeout", value: "30" }),
    );
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
    expect(overrides).toContainEqual(
      expect.objectContaining({ fieldName: "Timeout", value: "300" }),
    );
  });

  it('returns Timeout=300 for "worker" intent', () => {
    const overrides = getIntentDefaults(
      "create a worker function",
      RESOURCE_TYPES.LAMBDA_FUNCTION,
    );
    expect(overrides).toContainEqual(
      expect.objectContaining({ fieldName: "Timeout", value: "300" }),
    );
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
    expect(overrides).toContainEqual(
      expect.objectContaining({ fieldName: "MultiAZ", value: false }),
    );
  });

  it('returns MultiAZ=false for "dev db"', () => {
    const overrides = getIntentDefaults(
      "I need a dev db",
      RESOURCE_TYPES.RDS_DB_INSTANCE,
    );
    expect(overrides).toContainEqual(
      expect.objectContaining({ fieldName: "MultiAZ", value: false }),
    );
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
    // Tier C: dropped redundant toBeDefined() — find!()
    const keyNameOverride = overrides.find(
      (o) => o.fieldName === CfnKey.KEY_NAME,
    )!;
    const publicIpOverride = overrides.find(
      (o) => o.fieldName === CfnKey.ASSOCIATE_PUBLIC_IP,
    )!;
    expect(keyNameOverride.value).toBe(ResourceDefault.SSH_KEY_PLACEHOLDER);
    expect(publicIpOverride.value).toBe(true);
    expect(publicIpOverride.reason).toContain("SSH bundle");
  });

  it('EC2 "ssh into" intent returns SSH bundle overrides', () => {
    const overrides = getIntentDefaults(
      "Create an EC2 I can ssh into",
      RESOURCE_TYPES.EC2_INSTANCE,
    );
    expect(overrides).toContainEqual(
      expect.objectContaining({
        fieldName: CfnKey.KEY_NAME,
        value: ResourceDefault.SSH_KEY_PLACEHOLDER,
      }),
    );
    expect(overrides).toContainEqual(
      expect.objectContaining({
        fieldName: CfnKey.ASSOCIATE_PUBLIC_IP,
        value: true,
      }),
    );
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
    expect(overrides).toContainEqual(
      expect.objectContaining({ fieldName: "Type", value: "SecureString" }),
    );
  });

  // ── SNS Topic: "fifo" → FifoTopic true ─────────────────────────────────

  it('SNS Topic "fifo" intent returns FifoTopic true', () => {
    const overrides = getIntentDefaults(
      "create a fifo topic",
      RESOURCE_TYPES.SNS_TOPIC,
    );
    expect(overrides).toContainEqual(
      expect.objectContaining({ fieldName: "FifoTopic", value: true }),
    );
  });

  // ── CloudWatch LogGroup: "compliance" → 365 retention ──────────────────

  it('LogGroup "compliance" intent returns 365-day retention', () => {
    const overrides = getIntentDefaults(
      "create a compliance log group",
      RESOURCE_TYPES.LOGS_LOG_GROUP,
    );
    expect(overrides).toContainEqual(
      expect.objectContaining({
        fieldName: "RetentionInDays",
        value: "365",
      }),
    );
  });

  // ── ECS Cluster: "fargate" → containerInsights enabled ─────────────────

  it('ECS Cluster "fargate" intent returns containerInsights enabled', () => {
    // wizard-interaction-matrix (2026-04-11): rule now targets the
    // user-facing ContainerInsights boolean field; the ECS plugin's
    // toCfn transform emits the ClusterSettings array shape downstream.
    const overrides = getIntentDefaults(
      "create a fargate cluster",
      RESOURCE_TYPES.ECS_CLUSTER,
    );
    expect(overrides).toContainEqual(
      expect.objectContaining({
        fieldName: "ContainerInsights",
        value: true,
      }),
    );
  });

  // ── ECR Repository: "docker" → IMMUTABLE tags + scan on push ──────────

  it('ECR Repository "docker" intent returns IMMUTABLE tags and scan on push', () => {
    const overrides = getIntentDefaults(
      "create a docker repository",
      RESOURCE_TYPES.ECR_REPOSITORY,
    );
    expect(overrides).toContainEqual(
      expect.objectContaining({
        fieldName: "ImageTagMutability",
        value: "IMMUTABLE",
      }),
    );
    expect(overrides).toContainEqual(
      expect.objectContaining({ fieldName: "ScanOnPush", value: true }),
    );
  });

  // ── ELBv2: "web" → application type ───────────────────────────────────

  it('ELBv2 "web" intent returns application type', () => {
    const overrides = getIntentDefaults(
      "create a web load balancer",
      RESOURCE_TYPES.ELBV2_LOAD_BALANCER,
    );
    expect(overrides).toContainEqual(
      expect.objectContaining({ fieldName: "Type", value: "application" }),
    );
  });

  // ── API Gateway V2: "websocket" → WEBSOCKET protocol ──────────────────

  it('API Gateway V2 "websocket" intent returns WEBSOCKET protocol', () => {
    const overrides = getIntentDefaults(
      "create a websocket api",
      RESOURCE_TYPES.APIGATEWAYV2_API,
    );
    expect(overrides).toContainEqual(
      expect.objectContaining({
        fieldName: "ProtocolType",
        value: "WEBSOCKET",
      }),
    );
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

// ── Epic 92 wave 2 — assertion suppression (C-12/C-13/B-01) ─────────────

describe("getIntentDefaults — user-asserted values suppress defaults", () => {
  it("suppresses InstanceType override when user asserts t3.micro", () => {
    // Without the assertion, "web server" intent returns t3.small default.
    const baseline = getIntentDefaults(
      "Create a web server",
      RESOURCE_TYPES.EC2_INSTANCE,
    );
    expect(baseline).toContainEqual(
      expect.objectContaining({ fieldName: "InstanceType", value: "t3.small" }),
    );

    // With an explicit t3.micro assertion, the InstanceType override drops.
    const asserted = getIntentDefaults(
      "Create a t3.micro instance for a web server",
      RESOURCE_TYPES.EC2_INSTANCE,
    );
    const instanceTypeOverride = asserted.find(
      (o) => o.fieldName === "InstanceType",
    );
    expect(instanceTypeOverride).toBeUndefined();
  });

  it("suppresses VPC CidrBlock override when user asserts a CIDR", () => {
    // The VPC plugin doesn't have an intent rule overriding CidrBlock
    // in the default ruleset, so this test asserts the negative case:
    // any future rule overriding CidrBlock would be suppressed when the
    // user has asserted a valid CIDR in their intent. Guard against
    // regression by explicitly checking the detection helper.
    const result = getIntentDefaults(
      "Create a VPC with CIDR 10.42.0.0/16",
      RESOURCE_TYPES.EC2_VPC,
    );
    // Whatever overrides exist, none should touch CidrBlock — the user
    // asserted 10.42.0.0/16 and the parser preserves it elsewhere.
    for (const override of result) {
      expect(override.fieldName).not.toBe("CidrBlock");
    }
  });

  it("leaves unrelated overrides in place when one field is asserted", () => {
    // SSH intent triggers three overrides (KeyName, AssociatePublicIp,
    // SecurityGroupIds). Asserting t3.micro should suppress only the
    // InstanceType override — the SSH bundle must survive.
    const result = getIntentDefaults(
      "Create a t3.micro instance I can ssh into",
      RESOURCE_TYPES.EC2_INSTANCE,
    );
    expect(result).toContainEqual(
      expect.objectContaining({ fieldName: CfnKey.KEY_NAME }),
    );
    expect(result).toContainEqual(
      expect.objectContaining({ fieldName: CfnKey.ASSOCIATE_PUBLIC_IP }),
    );
    expect(result.find((o) => o.fieldName === "InstanceType")).toBeUndefined();
  });

  it("does not suppress when asserted token is invalid (parser fails first)", () => {
    // Invalid tokens (e.g., t99.huge) must NOT be treated as assertions —
    // the intent-parser fails the plan before this function runs. If for
    // some reason it DID run with an invalid token, the default override
    // should still fire so behaviour degrades gracefully rather than
    // leaving the field blank.
    const result = getIntentDefaults(
      "Create a t99.huge instance for a web server",
      RESOURCE_TYPES.EC2_INSTANCE,
    );
    // The web-server rule still fires — the parser would have failed the
    // plan upstream, so this fallthrough path only matters for test
    // invariants.
    expect(result).toContainEqual(
      expect.objectContaining({ fieldName: "InstanceType", value: "t3.small" }),
    );
  });
});

// ── autoProvision flag — SSH bundle wizard skip ────────────────────────────

describe("autoProvision flag on SSH KeyName override", () => {
  it("EC2 SSH KeyName override has autoProvision: true", () => {
    const overrides = getIntentDefaults(
      "Create an EC2 with SSH",
      RESOURCE_TYPES.EC2_INSTANCE,
    );
    const keyNameOverride = overrides.find(
      (o) => o.fieldName === CfnKey.KEY_NAME,
    )!;
    expect(keyNameOverride.autoProvision).toBe(true);
  });

  it("EC2 InstanceType override does NOT have autoProvision", () => {
    const overrides = getIntentDefaults(
      "Create an EC2 for web server",
      RESOURCE_TYPES.EC2_INSTANCE,
    );
    const instanceTypeOverride = overrides.find(
      (o) => o.fieldName === "InstanceType",
    )!;
    expect(instanceTypeOverride.autoProvision).toBeUndefined();
  });

  it("EC2 AssociatePublicIpAddress override does NOT have autoProvision (it is a boolean pre-injection)", () => {
    const overrides = getIntentDefaults(
      "Create an EC2 with SSH",
      RESOURCE_TYPES.EC2_INSTANCE,
    );
    const publicIpOverride = overrides.find(
      (o) => o.fieldName === CfnKey.ASSOCIATE_PUBLIC_IP,
    )!;
    // Public IP is a boolean — injected via the boolean path, not autoProvision
    expect(publicIpOverride.autoProvision).toBeUndefined();
  });

  /**
   * Simulates the wizard gate: when the orchestrator pre-injects the SSH
   * placeholder into elicitedOptions (mimicking the autoProvision path in
   * preInjectIntentBooleans), applyFieldGates must skip the KeyName prompt.
   *
   * This is the end-to-end invariant: intent "Create a EC2 with SSH"
   * → autoProvision = true → orchestrator pre-injects SSH_KEY_PLACEHOLDER
   * → applyFieldGates sees elicitedOptions[KeyName] is set
   * → ASK_IF_NOT_SET gate fires → kind = "skip"
   * → wizard never prompts the user for KeyName.
   */
  it("wizard gate skips KeyName when SSH placeholder pre-injected into elicitedOptions", () => {
    const keyNameField: ResourceField = {
      name: CfnKey.KEY_NAME,
      question: {
        type: "enum",
        label: "EC2 Key Pair",
        hint: "Required for SSH access. Leave blank to use SSM Session Manager instead.",
        options: [],
        initialValue: ResourceDefault.SSH_KEY_PLACEHOLDER,
      },
    };
    const resolved: ResolvedFieldConfig = {
      policy: FieldPolicy.ASK_IF_NOT_SET,
      value: undefined,
      source: "plugin_default",
    };
    // Simulate preInjectIntentBooleans injecting the SSH placeholder
    const elicitedOptions: Record<string, unknown> = {
      [CfnKey.KEY_NAME]: ResourceDefault.SSH_KEY_PLACEHOLDER,
    };

    const result = applyFieldGates(
      keyNameField,
      resolved,
      elicitedOptions,
      false,
    );

    // Must skip — not proceed — so user never sees the prompt
    expect(result.kind).toBe("skip");
    // Placeholder value preserved in elicitedOptions for the provisioner
    expect(elicitedOptions[CfnKey.KEY_NAME]).toBe(
      ResourceDefault.SSH_KEY_PLACEHOLDER,
    );
  });

  /**
   * Confirms that without pre-injection (no autoProvision), the KeyName
   * field WOULD be prompted — demonstrating the original bug condition.
   */
  it("wizard gate proceeds for KeyName when elicitedOptions is empty (pre-bug baseline)", () => {
    const keyNameField: ResourceField = {
      name: CfnKey.KEY_NAME,
      question: {
        type: "enum",
        label: "EC2 Key Pair",
        hint: "Required for SSH access.",
        options: [],
        initialValue: ResourceDefault.SSH_KEY_PLACEHOLDER,
      },
    };
    const resolved: ResolvedFieldConfig = {
      policy: FieldPolicy.ASK_IF_NOT_SET,
      value: undefined,
      source: "plugin_default",
    };
    // No pre-injection — this is what happened before the fix
    const elicitedOptions: Record<string, unknown> = {};

    const result = applyFieldGates(
      keyNameField,
      resolved,
      elicitedOptions,
      false,
    );

    // Without pre-injection, the gate proceeds (original bug)
    expect(result.kind).toBe("proceed");
  });

  /**
   * End-to-end provisioner path: the SSH placeholder emitted by the wizard
   * (via autoProvision pre-injection) matches what ssh-keypair.ts expects.
   * Verifies the contract between intent-defaults and the provisioner.
   */
  it("SSH_KEY_PLACEHOLDER matches the value ssh-keypair.ts checks at provision time", () => {
    const overrides = getIntentDefaults(
      "Create a EC2 with SSH",
      RESOURCE_TYPES.EC2_INSTANCE,
    );
    const keyNameOverride = overrides.find(
      (o) => o.fieldName === CfnKey.KEY_NAME,
    )!;
    // The provisioner checks: desiredState[CfnKey.KEY_NAME] === ResourceDefault.SSH_KEY_PLACEHOLDER
    // If this value changes, ssh-keypair.ts will stop triggering auto-create.
    expect(keyNameOverride.value).toBe(ResourceDefault.SSH_KEY_PLACEHOLDER);
    expect(ResourceDefault.SSH_KEY_PLACEHOLDER).toBe("assignee-ssh-key");
  });

  // ── SubnetId autoProvision marker (R9b-CLI-bug Fix 2) ────────────────────

  it("EC2 SSH intent SubnetId override has autoProvision: true and SUBNET_PLACEHOLDER value", () => {
    const overrides = getIntentDefaults(
      "Create a EC2 with SSH",
      RESOURCE_TYPES.EC2_INSTANCE,
    );
    const subnetOverride = overrides.find(
      (o) => o.fieldName === CfnKey.SUBNET_ID,
    )!;
    expect(subnetOverride).toBeDefined();
    expect(subnetOverride.value).toBe(ResourceDefault.SUBNET_PLACEHOLDER);
    expect(subnetOverride.autoProvision).toBe(true);
    expect(subnetOverride.reason).toContain("SSH bundle");
  });

  it("EC2 SSH intent SecurityGroupIds override has autoProvision: true and empty array value", () => {
    const overrides = getIntentDefaults(
      "Create a EC2 with SSH",
      RESOURCE_TYPES.EC2_INSTANCE,
    );
    const sgOverride = overrides.find(
      (o) => o.fieldName === CfnKey.SECURITY_GROUP_IDS,
    )!;
    expect(sgOverride).toBeDefined();
    expect(sgOverride.value).toEqual([]);
    expect(sgOverride.autoProvision).toBe(true);
    expect(sgOverride.reason).toContain("SSH bundle");
  });

  it("wizard gate skips SubnetId when SUBNET_PLACEHOLDER pre-injected into elicitedOptions", () => {
    const subnetField: ResourceField = {
      name: CfnKey.SUBNET_ID,
      question: {
        type: "enum",
        label: "Subnet",
        hint: "Determines which VPC and availability zone the instance launches in.",
        options: [],
        initialValue: ResourceDefault.SUBNET_PLACEHOLDER,
      },
    };
    const resolved: ResolvedFieldConfig = {
      policy: FieldPolicy.ASK_IF_NOT_SET,
      value: undefined,
      source: "plugin_default",
    };
    // Simulate preInjectIntentBooleans injecting the subnet placeholder
    const elicitedOptions: Record<string, unknown> = {
      [CfnKey.SUBNET_ID]: ResourceDefault.SUBNET_PLACEHOLDER,
    };

    const result = applyFieldGates(
      subnetField,
      resolved,
      elicitedOptions,
      false,
    );

    // Must skip — not proceed — so user never sees the Subnet prompt
    expect(result.kind).toBe("skip");
    // Placeholder value preserved for the provisioner
    expect(elicitedOptions[CfnKey.SUBNET_ID]).toBe(
      ResourceDefault.SUBNET_PLACEHOLDER,
    );
  });

  it("wizard gate skips SecurityGroupIds when empty array pre-injected into elicitedOptions", () => {
    const sgField: ResourceField = {
      name: CfnKey.SECURITY_GROUP_IDS,
      question: {
        type: "multi",
        label: "Security Groups",
        hint: "Firewall rules controlling inbound/outbound traffic.",
        options: [],
      },
    };
    const resolved: ResolvedFieldConfig = {
      policy: FieldPolicy.ASK_IF_NOT_SET,
      value: undefined,
      source: "plugin_default",
    };
    // Simulate preInjectIntentBooleans injecting the empty array sentinel
    const elicitedOptions: Record<string, unknown> = {
      [CfnKey.SECURITY_GROUP_IDS]: [],
    };

    const result = applyFieldGates(sgField, resolved, elicitedOptions, false);

    // Must skip — empty array is not undefined so Gate 3 fires
    expect(result.kind).toBe("skip");
    expect(elicitedOptions[CfnKey.SECURITY_GROUP_IDS]).toEqual([]);
  });

  it("SUBNET_PLACEHOLDER and SG_PLACEHOLDER are distinct literal values", () => {
    expect(ResourceDefault.SUBNET_PLACEHOLDER).toBe("assignee-default-subnet");
    expect(ResourceDefault.SG_PLACEHOLDER).toBe("assignee-default-sg");
    expect(ResourceDefault.SUBNET_PLACEHOLDER).not.toBe(
      ResourceDefault.SSH_KEY_PLACEHOLDER,
    );
  });
});
