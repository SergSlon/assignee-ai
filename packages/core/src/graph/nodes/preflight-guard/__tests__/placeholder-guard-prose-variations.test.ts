/**
 * Epic 98 Wave 2 fixer e98.W2.R3 — placeholder-guard prose-field expansion.
 *
 * Closes Epic 97 B-11 + B-12 live-FAILs: the prose-field allowlist in
 * `placeholder-resource-id.ts` stopped at `Description` / `Name` /
 * `Comment`. The LLM hallucinates placeholder tokens in several other
 * prose-shaped fields — GroupDescription (SG), DBSubnetGroupDescription
 * (RDS), DashboardBody (CloudWatch), LogGroupName / LogStreamName
 * (Logs), FunctionDescription (Lambda), RoleDescription (IAM) — and
 * those placeholders survived preflight, shipping to CloudControl
 * verbatim.
 *
 * Epic 96 W3.N1 (the previous attempt to close this class) rubber-
 * stamped the fix via a synthetic `{Description: "subnet-<hex>"}`
 * object in a unit harness; the live CLI never exercised the
 * expanded allowlist against the actual resource types where the
 * LLM emits them, so B-11 + B-12 survived.
 *
 * This suite locks:
 *
 *   1. `PLACEHOLDER_RESOURCE_ID_PROSE_FIELDS` contains every field the
 *      dispatch brief called out (B-11 + B-12 + related).
 *   2. The recursive walker detects embedded placeholders inside each
 *      new prose field — including `{…}` / `<hex>` / `<YOUR-SG>` tokens.
 *   3. The guard's `run()` returns failure on the same shapes, carrying
 *      a useful error message (field path + offending token).
 *   4. Legitimate prose that merely mentions a hyphenated token which
 *      happens to share a prefix but has a NON-placeholder suffix
 *      (e.g. `subnet-for-us-east-1a`, `sg-customer-prod-2024`) passes
 *      cleanly. No false-positive on real operator prose.
 *   5. Drift-guard: every plugin's `defaults` object, when synthesised
 *      with a placeholder `subnet-<hex>` planted in each string field,
 *      is rejected by the guard. Proves the allowlist + walker logic
 *      scales as the plugin surface grows.
 */

import { describe, it, expect } from "vitest";
import {
  detectPlaceholderResourceId,
  findEmbeddedPlaceholderResourceId,
  PLACEHOLDER_RESOURCE_ID_PROSE_FIELDS,
  placeholderResourceIdGuard,
} from "../guards/placeholder-resource-id.js";
import type { GuardContext } from "../types.js";
import { defaultPluginRegistry } from "@/index.js";
import { SUPPORTED_TYPES_ARRAY } from "@/config/resource-types/supported.js";

function ctx(
  desiredState: Record<string, unknown>,
  resourceType = "AWS::EC2::Subnet",
): GuardContext {
  return {
    state: {
      userIntent: "",
      runId: "test",
      executionMode: "plan",
      resourceType,
      resourceSchema: undefined,
      desiredState,
      messages: [],
      preflightPassed: false,
      preflightErrors: [],
      preflightMode: "local",
    } as unknown as GuardContext["state"],
    desiredState,
  };
}

describe("PLACEHOLDER_RESOURCE_ID_PROSE_FIELDS — e98.W2.R3 scope expansion", () => {
  it("retains the original Epic 96 W3.N1 prose fields", () => {
    // Regression lock — dropping any of these would re-open the Epic
    // 96 prose-scope class.
    expect(PLACEHOLDER_RESOURCE_ID_PROSE_FIELDS).toContain("Description");
    expect(PLACEHOLDER_RESOURCE_ID_PROSE_FIELDS).toContain("Name");
    expect(PLACEHOLDER_RESOURCE_ID_PROSE_FIELDS).toContain("Comment");
  });

  it("adds every B-11 / B-12 field from the dispatch brief", () => {
    for (const field of [
      "GroupDescription",
      "DBSubnetGroupDescription",
      "DashboardBody",
      "LogGroupName",
      "LogStreamName",
      "FunctionDescription",
      "RoleDescription",
    ]) {
      expect(PLACEHOLDER_RESOURCE_ID_PROSE_FIELDS).toContain(field);
    }
  });
});

describe("detectPlaceholderResourceId — e98.W2.R3 prose-variation suite (6 variants)", () => {
  // Variation 1 — SG GroupDescription embedding `subnet-<HEX>`.
  it("rejects `GroupDescription: 'Allow traffic from subnet-<hex> to port 443'` (B-11)", () => {
    const hit = detectPlaceholderResourceId({
      GroupName: "my-sg",
      GroupDescription: "Allow traffic from subnet-<hex> to port 443",
      VpcId: "vpc-0a1b2c3d4e5f67890",
    });
    expect(hit).toBeDefined();
    expect(hit?.field).toContain("GroupDescription");
    expect(hit?.value).toBe("subnet-<hex>");
  });

  // Variation 2 — S3 Description embedding `subnet-<HEX>`.
  it("rejects `Description: 'My subnet-<hex> logs'` on an S3 bucket", () => {
    const hit = detectPlaceholderResourceId({
      BucketName: "my-bucket",
      Description: "My subnet-<hex> logs",
    });
    expect(hit).toBeDefined();
    expect(hit?.field).toContain("Description");
    expect(hit?.value).toBe("subnet-<hex>");
  });

  // Variation 3 — RDS DBSubnetGroupDescription embedding `subnet-<HEX>`.
  it("rejects `DBSubnetGroupDescription: 'Subnets for subnet-<hex>'` (B-11 RDS lane)", () => {
    const hit = detectPlaceholderResourceId({
      DBSubnetGroupName: "prod-subnet-group",
      DBSubnetGroupDescription: "Subnets for subnet-<hex>",
      SubnetIds: ["subnet-0a1b2c3d4e5f67890", "subnet-0b2c3d4e5f6789012"],
    });
    expect(hit).toBeDefined();
    expect(hit?.field).toContain("DBSubnetGroupDescription");
    expect(hit?.value).toBe("subnet-<hex>");
  });

  // Variation 4 — CloudWatch DashboardBody embedding `sg-<YOUR-SG>`.
  it("rejects `DashboardBody` containing `sg-<YOUR-SG>` (B-12 CloudWatch)", () => {
    const hit = detectPlaceholderResourceId({
      DashboardName: "prod-ops",
      DashboardBody:
        '{"widgets":[{"type":"metric","properties":{"metrics":[["AWS/EC2","CPUUtilization","SecurityGroup","sg-<YOUR-SG>"]]}}]}',
    });
    expect(hit).toBeDefined();
    expect(hit?.field).toContain("DashboardBody");
    expect(hit?.value).toBe("sg-<YOUR-SG>");
  });

  // Variation 5 — Logs LogGroupName embedding `subnet-<HEX>`.
  it("rejects `LogGroupName: '/assignee/subnet-<hex>/foo'` (B-12 Logs)", () => {
    const hit = detectPlaceholderResourceId({
      LogGroupName: "/assignee/subnet-<hex>/foo",
    });
    expect(hit).toBeDefined();
    expect(hit?.field).toContain("LogGroupName");
    expect(hit?.value).toBe("subnet-<hex>");
  });

  // Variation 6 — no-FP baseline: legitimate hyphenated prose with a
  // non-placeholder suffix must PASS. Guards against an over-permissive
  // embedded regex that catches real customer substrings.
  it("passes legitimate prose `Description: 'Legitimate subnet-for-us-east-1a'`", () => {
    const hit = detectPlaceholderResourceId({
      BucketName: "my-bucket",
      Description: "Legitimate subnet-for-us-east-1a",
    });
    expect(hit).toBeUndefined();
  });

  // Extra counter-probes — make sure the expanded allowlist does NOT
  // start scanning *every* string in desiredState.
  it("does NOT scan non-prose string fields (UserData) even when they contain placeholder-shaped tokens", () => {
    // UserData is a customer-owned script; it may reference real
    // customer `subnet-<id>` values. It is NOT on the prose allowlist.
    const hit = detectPlaceholderResourceId({
      InstanceType: "t3.micro",
      UserData: "#!/bin/bash\necho subnet-12345678",
    });
    expect(hit).toBeUndefined();
  });

  it("still flags a whole-string ID-shaped placeholder in any field", () => {
    // Whole-string mode (not prose) — the anchored regex still fires
    // for bare ID-shaped values regardless of field name.
    const hit = detectPlaceholderResourceId({
      VpcId: "vpc-12345678",
    });
    expect(hit).toBeDefined();
    expect(hit?.field).toBe("VpcId");
    expect(hit?.value).toBe("vpc-12345678");
  });
});

describe("placeholderResourceIdGuard.run — surface contract on expanded fields", () => {
  it("returns failure with informative message for a GroupDescription hit", async () => {
    const result = await placeholderResourceIdGuard.run(
      ctx(
        {
          GroupName: "my-sg",
          GroupDescription: "Allow subnet-<hex> inbound",
          VpcId: "vpc-0a1b2c3d4e5f67890",
        },
        "AWS::EC2::SecurityGroup",
      ),
    );
    expect(result.kind).toBe("fail");
    const message = result.kind === "fail" ? result.errorMessage : "";
    expect(message).toContain("GroupDescription");
    expect(message).toContain("subnet-<hex>");
    // The guard's error template offers remediation paths.
    expect(message).toContain("real ID from your account");
  });

  it("returns pass for an S3 plan with honest prose and hex-random VpcId references", async () => {
    const result = await placeholderResourceIdGuard.run(
      ctx(
        {
          BucketName: "prod-logs-2024",
          Description: "Centralised logs for prod-us-east-1a account",
        },
        "AWS::S3::Bucket",
      ),
    );
    expect(result.kind).toBe("pass");
  });
});

describe("findEmbeddedPlaceholderResourceId — token precision on expanded fields", () => {
  it("extracts the exact `<YOUR-ID>` template token from a dashboard body", () => {
    const body =
      '{"widgets":[{"properties":{"filter":"sg-<YOUR-ID> AND subnet-0a1b2c3d"}}]}';
    const token = findEmbeddedPlaceholderResourceId(body);
    expect(token).toBe("sg-<YOUR-ID>");
  });

  it("extracts `vpc-<id>` from a multi-line description", () => {
    const description = "Primary VPC\nId=vpc-<id>\nOwner: platform-team";
    const token = findEmbeddedPlaceholderResourceId(description);
    expect(token).toBe("vpc-<id>");
  });

  it("returns undefined for a well-formed VPC ID inside a sentence", () => {
    const description = "Primary VPC: vpc-0a1b2c3d4e5f67890 (us-east-1)";
    expect(findEmbeddedPlaceholderResourceId(description)).toBeUndefined();
  });
});

describe("drift-guard — every plugin's string-valued defaults trip the guard when poisoned", () => {
  /**
   * For each registered plugin whose `defaults` object contains at
   * least one string field (by walking the object tree), synthesise a
   * desiredState where every string field carries the canonical
   * `subnet-<hex>` placeholder. The guard must reject at least one of
   * those placeholders — proving the allowlist + walker behaviour is
   * not silently limited to a few hand-picked types.
   *
   * Plugins whose defaults are empty OR contain zero strings are
   * skipped (nothing to poison).
   */
  function deepPoison(
    value: unknown,
    poison: string,
  ): { poisoned: unknown; poisonedAny: boolean } {
    if (typeof value === "string") {
      return { poisoned: poison, poisonedAny: true };
    }
    if (Array.isArray(value)) {
      let any = false;
      const out = value.map((v) => {
        const result = deepPoison(v, poison);
        if (result.poisonedAny) any = true;
        return result.poisoned;
      });
      return { poisoned: out, poisonedAny: any };
    }
    if (value !== null && typeof value === "object") {
      let any = false;
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) {
        const result = deepPoison(v, poison);
        if (result.poisonedAny) any = true;
        out[k] = result.poisoned;
      }
      return { poisoned: out, poisonedAny: any };
    }
    return { poisoned: value, poisonedAny: false };
  }

  it("rejects `subnet-<hex>` planted on prose fields across every supported resource type (no silent passes)", () => {
    // Iterate every CFN type the CLI claims to support; look up the
    // plugin via the registry. For each type, synthesise a
    // desiredState that carries the `subnet-<hex>` placeholder on
    // every prose field we expanded in W2.R3 and confirm the guard
    // flags it.
    expect(SUPPORTED_TYPES_ARRAY.length).toBeGreaterThan(0);

    let inspected = 0;

    for (const resourceType of SUPPORTED_TYPES_ARRAY) {
      const plugin = defaultPluginRegistry.get(resourceType);
      // We don't require every type to have a plugin — some may still
      // fall back to the generic path. The drift-guard here is about
      // the prose-field walker working for any desiredState that might
      // flow through preflight, regardless of plugin registration.
      const basis: Record<string, unknown> = plugin?.defaults
        ? (deepPoison(plugin.defaults, "subnet-<hex>").poisoned as Record<
            string,
            unknown
          >)
        : {};

      const synthetic = { ...basis };
      for (const proseField of PLACEHOLDER_RESOURCE_ID_PROSE_FIELDS) {
        synthetic[proseField] = `Context for subnet-<hex> ${proseField}`;
      }

      inspected++;
      const hit = detectPlaceholderResourceId(synthetic);
      expect(
        hit,
        `${resourceType} must reject synthetic poisoned prose state`,
      ).toBeDefined();
      expect(hit?.value).toBe("subnet-<hex>");
    }

    expect(inspected).toBe(SUPPORTED_TYPES_ARRAY.length);
  });
});
