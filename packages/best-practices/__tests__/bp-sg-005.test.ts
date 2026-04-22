/**
 * Epic 94 R4 (B-02) — BP-SG-005 `not_equals` re-tag coverage.
 *
 * Before R4, BP-SG-005 carried `check_type: awareness` — the
 * awareness-filter treats every awareness-tagged rule as "always fires"
 * so every SG plan surfaced a CRITICAL "RDP port 3389 open to 0.0.0.0/0"
 * finding, regardless of which ports the user actually asked for.
 * Trains users to ignore CRITICAL severity.
 *
 * After R4:
 *   - port 443 only                      → no BP-SG-005 finding
 *   - port 3389 + 0.0.0.0/0              → BP-SG-005 fires (CRITICAL)
 *   - port 3389 + 10.0.0.0/8 (private)   → no BP-SG-005 finding
 *   - port-range covering 3389 + public  → BP-SG-005 fires
 *   - all-ports (IpProtocol:-1) + public → BP-SG-005 fires (covers RDP)
 *   - empty ingress array                → no BP-SG-005 finding
 *
 * All tests use real CFN-shaped ingress elements exactly as they come
 * off intent-parser.extractSgIngress (no placeholder or dummy values).
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
const BP_SG_005_PATH = resolve(__dirname, "../ec2/BP-SG-005.yaml");

function loadBpSg005(): BestPractice {
  const raw = readFileSync(BP_SG_005_PATH, "utf-8");
  return parseYaml(raw) as BestPractice;
}

function ctx(ingress: Array<Record<string, unknown>>): EvalContext {
  return {
    resourceType: "AWS::EC2::SecurityGroup",
    desiredState: { SecurityGroupIngress: ingress },
  };
}

describe("BP-SG-005 YAML manifest", () => {
  it("declares `check_type: not_equals` (no longer awareness)", () => {
    const bp = loadBpSg005();
    expect(bp.check_type).toBe("not_equals");
  });

  it('declares `expected_value: "0.0.0.0/0:3389"` mirroring BP-SG-002', () => {
    const bp = loadBpSg005();
    expect(bp.expected_value).toBe("0.0.0.0/0:3389");
  });

  it("retains CRITICAL severity and interactive fix type", () => {
    const bp = loadBpSg005();
    expect(bp.severity).toBe("CRITICAL");
    expect(bp.fixType).toBe("interactive");
    expect(Array.isArray(bp.interactiveOptions)).toBe(true);
    expect(bp.interactiveOptions?.[0]?.action).toBe("prompt_value");
  });
});

describe("BP-SG-005 evaluateTriggers — positive / negative cases", () => {
  const bp = loadBpSg005();
  const practices = [bp];

  it("does NOT fire on a port-443-only SG (no RDP exposure)", () => {
    const findings = evaluateTriggers(
      ctx([
        {
          IpProtocol: "tcp",
          FromPort: 443,
          ToPort: 443,
          CidrIp: "0.0.0.0/0",
        },
      ]),
      practices,
    );
    expect(findings.find((f) => f.practiceId === "BP-SG-005")).toBeUndefined();
  });

  it("DOES fire on port 3389 + 0.0.0.0/0 (real RDP exposure)", () => {
    const findings = evaluateTriggers(
      ctx([
        {
          IpProtocol: "tcp",
          FromPort: 3389,
          ToPort: 3389,
          CidrIp: "0.0.0.0/0",
        },
      ]),
      practices,
    );
    const hit = findings.find((f) => f.practiceId === "BP-SG-005");
    expect(hit).toBeDefined();
    expect(hit?.severity).toBe("CRITICAL");
  });

  it("does NOT fire on port 3389 + 10.0.0.0/8 (private CIDR, not 0.0.0.0/0)", () => {
    const findings = evaluateTriggers(
      ctx([
        {
          IpProtocol: "tcp",
          FromPort: 3389,
          ToPort: 3389,
          CidrIp: "10.0.0.0/8",
        },
      ]),
      practices,
    );
    expect(findings.find((f) => f.practiceId === "BP-SG-005")).toBeUndefined();
  });

  it("DOES fire on a port-range 3000-4000 + 0.0.0.0/0 (range covers 3389)", () => {
    const findings = evaluateTriggers(
      ctx([
        {
          IpProtocol: "tcp",
          FromPort: 3000,
          ToPort: 4000,
          CidrIp: "0.0.0.0/0",
        },
      ]),
      practices,
    );
    expect(findings.find((f) => f.practiceId === "BP-SG-005")).toBeDefined();
  });

  it("does NOT fire on a port-range 3000-3388 + 0.0.0.0/0 (range stops short of 3389)", () => {
    const findings = evaluateTriggers(
      ctx([
        {
          IpProtocol: "tcp",
          FromPort: 3000,
          ToPort: 3388,
          CidrIp: "0.0.0.0/0",
        },
      ]),
      practices,
    );
    expect(findings.find((f) => f.practiceId === "BP-SG-005")).toBeUndefined();
  });

  it("DOES fire on an all-traffic rule (IpProtocol:-1, no port bounds) from 0.0.0.0/0", () => {
    // Matches the real CFN default-allow-all shape — this exposes every
    // port including 3389, so the rule must fire.
    const findings = evaluateTriggers(
      ctx([
        {
          IpProtocol: "-1",
          CidrIp: "0.0.0.0/0",
        },
      ]),
      practices,
    );
    expect(findings.find((f) => f.practiceId === "BP-SG-005")).toBeDefined();
  });

  it("does NOT fire on an empty ingress array", () => {
    const findings = evaluateTriggers(ctx([]), practices);
    expect(findings.find((f) => f.practiceId === "BP-SG-005")).toBeUndefined();
  });

  it("does NOT fire when the desiredState has no SecurityGroupIngress at all", () => {
    const findings = evaluateTriggers(
      {
        resourceType: "AWS::EC2::SecurityGroup",
        desiredState: {},
      },
      practices,
    );
    expect(findings.find((f) => f.practiceId === "BP-SG-005")).toBeUndefined();
  });

  it("does NOT fire on a malformed ingress array element (string in place of object)", () => {
    // Defensive — an upstream bug that puts junk in the array must not
    // trigger a false-CRITICAL finding.
    const findings = evaluateTriggers(
      {
        resourceType: "AWS::EC2::SecurityGroup",
        desiredState: {
          SecurityGroupIngress: ["junk" as unknown as Record<string, unknown>],
        },
      },
      practices,
    );
    expect(findings.find((f) => f.practiceId === "BP-SG-005")).toBeUndefined();
  });

  it("fires on a multi-rule SG when any rule opens 3389 to 0.0.0.0/0", () => {
    const findings = evaluateTriggers(
      ctx([
        {
          IpProtocol: "tcp",
          FromPort: 443,
          ToPort: 443,
          CidrIp: "0.0.0.0/0",
        },
        {
          IpProtocol: "tcp",
          FromPort: 3389,
          ToPort: 3389,
          CidrIp: "0.0.0.0/0",
        },
      ]),
      practices,
    );
    expect(findings.find((f) => f.practiceId === "BP-SG-005")).toBeDefined();
  });
});
