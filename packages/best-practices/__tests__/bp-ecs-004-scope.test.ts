/**
 * Epic 98 W4.B1 — BP-ECS-004 MISLABELED closure (CRITICAL).
 *
 * Before W4.B1 the rule was marked `check_type: awareness` with
 * property_path `ContainerDefinitions[0].Secrets` and expected_value
 * `true`. Because the awareness filter treats every awareness-tagged
 * check as always-fire, every ECS task definition surfaced the rule
 * regardless of whether the Environment array actually carried any
 * secret-looking identifiers — training users to ignore CRITICAL
 * severity.
 *
 * After W4.B1:
 *   - New generic `check_type: nested_array_predicate` handles the
 *     "any element of an inner array inside every element of an outer
 *     array matches a regex" shape. See
 *     `src/evaluate/predicates/nested-array-predicate.ts`.
 *   - BP-ECS-004 migrates to that check_type with property_path
 *     `ContainerDefinitions` and expected_value
 *     `Environment[?(@.Name=~/^(password|secret|api[_-]?key|token|connection[_-]?string)$/i)] does not exist`.
 *   - Rule fires ONLY when a container has a secret-like plaintext
 *     Environment entry. Safe env vars (LOG_LEVEL, PORT, etc.) →
 *     no finding.
 *   - Severity CRITICAL unchanged (every remaining hit is genuine).
 *
 * All fixtures use real CFN-shaped ECS task definitions as they come
 * off plan_generator — no placeholder/dummy values.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { evaluateTriggers } from "../src/evaluate.js";
import type { EvalContext } from "../src/evaluate.js";
import type { BestPractice } from "../src/types.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const BP_ECS_004_PATH = resolve(__dirname, "../ecs/BP-ECS-004.yaml");

function loadBpEcs004(): BestPractice {
  const raw = readFileSync(BP_ECS_004_PATH, "utf-8");
  return parseYaml(raw) as BestPractice;
}

function ctx(
  containerDefinitions: Array<Record<string, unknown>>,
): EvalContext {
  return {
    resourceType: "AWS::ECS::TaskDefinition",
    desiredState: { ContainerDefinitions: containerDefinitions },
  };
}

describe("BP-ECS-004 YAML manifest", () => {
  it("declares id BP-ECS-004", () => {
    const bp = loadBpEcs004();
    expect(bp.id).toBe("BP-ECS-004");
  });

  it("declares `check_type: nested_array_predicate` (no longer awareness)", () => {
    const bp = loadBpEcs004();
    expect(bp.check_type).toBe("nested_array_predicate");
  });

  it("points property_path at ContainerDefinitions (outer array)", () => {
    const bp = loadBpEcs004();
    expect(bp.property_path).toBe("ContainerDefinitions");
  });

  it("declares the secret-family regex in the predicate grammar", () => {
    const bp = loadBpEcs004();
    expect(bp.expected_value).toBe(
      "Environment[?(@.Name=~/^(password|secret|api[_-]?key|token|connection[_-]?string)$/i)] does not exist",
    );
  });

  it("keeps severity CRITICAL (false-positives are gone; every hit is genuine)", () => {
    const bp = loadBpEcs004();
    expect(bp.severity).toBe("CRITICAL");
    expect(bp.category).toBe("security");
  });
});

describe("BP-ECS-004 evaluateTriggers — safe container configurations MUST NOT fire", () => {
  const bp = loadBpEcs004();
  const practices = [bp];

  it("does NOT fire on a container with only a LOG_LEVEL env var (no-fire baseline)", () => {
    const findings = evaluateTriggers(
      ctx([
        {
          Name: "app",
          Image: "myrepo/myapp:latest",
          Environment: [{ Name: "LOG_LEVEL", Value: "debug" }],
        },
      ]),
      practices,
    );
    expect(findings.find((f) => f.practiceId === "BP-ECS-004")).toBeUndefined();
  });

  it("does NOT fire on a container with only PORT + APP_ENV (typical web app)", () => {
    const findings = evaluateTriggers(
      ctx([
        {
          Name: "web",
          Environment: [
            { Name: "PORT", Value: "8080" },
            { Name: "APP_ENV", Value: "production" },
          ],
        },
      ]),
      practices,
    );
    expect(findings.find((f) => f.practiceId === "BP-ECS-004")).toBeUndefined();
  });

  it("does NOT fire when secrets are referenced properly via Secrets array", () => {
    const findings = evaluateTriggers(
      ctx([
        {
          Name: "app",
          Environment: [{ Name: "LOG_LEVEL", Value: "info" }],
          Secrets: [
            {
              Name: "DB_PASSWORD",
              ValueFrom:
                "arn:aws:secretsmanager:us-east-1:210987654321:secret:db/password",
            },
          ],
        },
      ]),
      practices,
    );
    expect(findings.find((f) => f.practiceId === "BP-ECS-004")).toBeUndefined();
  });

  it("does NOT fire on near-miss env names (SECRET_ARN, TOKEN_ENDPOINT, PASSWORDLESS_MODE)", () => {
    // Anchored regex `^...$` — env names that contain but do not equal
    // the secret tokens are intentionally ignored. Guards against the
    // over-enthusiastic substring match that Epic 94 canvassed.
    const findings = evaluateTriggers(
      ctx([
        {
          Name: "app",
          Environment: [
            { Name: "SECRET_ARN", Value: "arn:aws:secretsmanager:..." },
            { Name: "TOKEN_ENDPOINT", Value: "https://..." },
            { Name: "PASSWORDLESS_MODE", Value: "true" },
          ],
        },
      ]),
      practices,
    );
    expect(findings.find((f) => f.practiceId === "BP-ECS-004")).toBeUndefined();
  });

  it("does NOT fire on an empty ContainerDefinitions array", () => {
    const findings = evaluateTriggers(ctx([]), practices);
    expect(findings.find((f) => f.practiceId === "BP-ECS-004")).toBeUndefined();
  });

  it("does NOT fire when ContainerDefinitions is absent", () => {
    const findings = evaluateTriggers(
      { resourceType: "AWS::ECS::TaskDefinition", desiredState: {} },
      practices,
    );
    expect(findings.find((f) => f.practiceId === "BP-ECS-004")).toBeUndefined();
  });
});

describe("BP-ECS-004 evaluateTriggers — secret-like plaintext env MUST fire CRITICAL", () => {
  const bp = loadBpEcs004();
  const practices = [bp];

  it.each([
    ["PASSWORD", "hunter2"],
    ["password", "hunter2"],
    ["SECRET", "db-secret"],
    ["API_KEY", "sk-abc123"],
    ["API-KEY", "sk-abc123"],
    ["APIKEY", "sk-abc123"],
    ["TOKEN", "ghp_xxxxxxxx"],
    ["CONNECTION_STRING", "postgres://user:pass@host/db"],
    ["CONNECTION-STRING", "postgres://user:pass@host/db"],
    ["CONNECTIONSTRING", "postgres://user:pass@host/db"],
  ])(
    "DOES fire CRITICAL when env contains %s=<value> (plaintext secret)",
    (name, value) => {
      const findings = evaluateTriggers(
        ctx([
          {
            Name: "app",
            Environment: [{ Name: name, Value: value }],
          },
        ]),
        practices,
      );
      const hit = findings.find((f) => f.practiceId === "BP-ECS-004");
      expect(hit).toBeDefined();
      expect(hit?.severity).toBe("CRITICAL");
    },
  );

  it("DOES fire on a two-container def where one container is clean and the other has SECRET (multi-container scan)", () => {
    // Canonical probe variation: first container is clean, second
    // container leaks. The rule must scan EVERY ContainerDefinitions
    // element — a naïve index-0 property_path would let the dirty
    // container through.
    const findings = evaluateTriggers(
      ctx([
        {
          Name: "sidecar-clean",
          Environment: [{ Name: "LOG_LEVEL", Value: "info" }],
        },
        {
          Name: "main-dirty",
          Environment: [{ Name: "SECRET", Value: "leaked-value" }],
        },
      ]),
      practices,
    );
    const hit = findings.find((f) => f.practiceId === "BP-ECS-004");
    expect(hit).toBeDefined();
    expect(hit?.severity).toBe("CRITICAL");
  });

  it("DOES fire when env uses the `Name=CONNECTION_STRING` shape with a real Postgres URL", () => {
    const findings = evaluateTriggers(
      ctx([
        {
          Name: "app",
          Environment: [
            {
              Name: "CONNECTION_STRING",
              Value:
                "postgres://appuser:supersecret@db.internal:5432/appdb?sslmode=require",
            },
          ],
        },
      ]),
      practices,
    );
    expect(findings.find((f) => f.practiceId === "BP-ECS-004")).toBeDefined();
  });
});

describe("BP-ECS-004 evaluateTriggers — malformed input defensive behaviour", () => {
  const bp = loadBpEcs004();
  const practices = [bp];

  it("does NOT fire when Environment entries have non-string Name (plan garbage)", () => {
    const findings = evaluateTriggers(
      ctx([
        {
          Name: "app",
          Environment: [
            { Name: 12345, Value: "suspicious-number-as-name" },
            { Name: null, Value: "null-name" },
          ],
        },
      ]),
      practices,
    );
    expect(findings.find((f) => f.practiceId === "BP-ECS-004")).toBeUndefined();
  });

  it("does NOT fire on a wholly malformed ContainerDefinitions (array of strings)", () => {
    const findings = evaluateTriggers(
      {
        resourceType: "AWS::ECS::TaskDefinition",
        desiredState: {
          ContainerDefinitions: [
            "garbage" as unknown as Record<string, unknown>,
            42 as unknown as Record<string, unknown>,
          ],
        },
      },
      practices,
    );
    expect(findings.find((f) => f.practiceId === "BP-ECS-004")).toBeUndefined();
  });
});
