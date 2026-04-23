/**
 * Epic 96 W3.N2 — BP-SG-004 narrowing. Closes Epic 95 B-01 / B-04
 * HIGH NEW.
 *
 * Before W3.N2 the "high-risk ports" rule lived under id BP-SG-007 and
 * carried `check_type: awareness`; the awareness filter treats every
 * awareness-tagged rule as always-fire, so every SecurityGroup plan
 * surfaced a HIGH finding with DB-focused copy regardless of which
 * ports the user actually opened. Port 443 (HTTPS LB) was the canonical
 * false positive — the copy said "restrict database traffic" but the
 * intent was HTTPS on a public load balancer.
 *
 * After W3.N2:
 *   - Rule renumbered BP-SG-007 → BP-SG-004 to fill the "DB/admin ports"
 *     slot in the BP-SG-* sequence (001 CIDR, 002 SSH, 004 DB, 005 RDP).
 *   - Severity lifted HIGH → CRITICAL to match the RDP/SSH siblings —
 *     false positives are gone, so every remaining hit is genuine.
 *   - check_type: sg_high_risk_public_exposure with expected_value
 *     `"0.0.0.0/0:20,21,1433,1434,1521,3306,3389,4333,5432,5439,5500,
 *     6379,9200,27017"` — Trusted Advisor HCP4007jGY catalogue unioned
 *     with Oracle 1521, Aurora Postgres (shared 5432), Redshift 5439,
 *     MongoDB 27017, Redis 6379, Elasticsearch 9200.
 *   - HTTPS 443, HTTP 80, and any non-listed port → no finding.
 *
 * All fixtures use real CFN-shaped ingress elements as they come off
 * intent-parser.extractSgIngress — no placeholder/dummy values.
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
const BP_SG_004_PATH = resolve(__dirname, "../ec2/BP-SG-004.yaml");

function loadBpSg004(): BestPractice {
  const raw = readFileSync(BP_SG_004_PATH, "utf-8");
  return parseYaml(raw) as BestPractice;
}

function ctx(ingress: Array<Record<string, unknown>>): EvalContext {
  return {
    resourceType: "AWS::EC2::SecurityGroup",
    desiredState: { SecurityGroupIngress: ingress },
  };
}

describe("BP-SG-004 YAML manifest", () => {
  it("declares id BP-SG-004 (renamed from the legacy SG-007 slot)", () => {
    const bp = loadBpSg004();
    expect(bp.id).toBe("BP-SG-004");
  });

  it("declares `check_type: sg_high_risk_public_exposure` (no longer awareness)", () => {
    const bp = loadBpSg004();
    expect(bp.check_type).toBe("sg_high_risk_public_exposure");
  });

  it("declares the full Trusted-Advisor + DB port set keyed on 0.0.0.0/0", () => {
    const bp = loadBpSg004();
    expect(bp.expected_value).toBe(
      "0.0.0.0/0:20,21,1433,1434,1521,3306,3389,4333,5432,5439,5500,6379,9200,27017",
    );
  });

  it("escalates to CRITICAL severity (false-positives are gone; every hit is genuine)", () => {
    const bp = loadBpSg004();
    expect(bp.severity).toBe("CRITICAL");
    expect(bp.category).toBe("security");
  });

  it("carries an interactive fix option so users can scope the CIDR instead of ignoring the finding", () => {
    const bp = loadBpSg004();
    expect(bp.fixType).toBe("interactive");
    expect(Array.isArray(bp.interactiveOptions)).toBe(true);
    expect(bp.interactiveOptions?.[0]?.action).toBe("prompt_value");
  });
});

describe("BP-SG-004 evaluateTriggers — ports outside the DB/admin set must NOT fire", () => {
  const bp = loadBpSg004();
  const practices = [bp];

  it("does NOT fire on a port-443-only SG (HTTPS LB — the B-01/B-04 regression)", () => {
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
    expect(findings.find((f) => f.practiceId === "BP-SG-004")).toBeUndefined();
  });

  it("does NOT fire on a port-80-only SG (HTTP LB)", () => {
    const findings = evaluateTriggers(
      ctx([
        { IpProtocol: "tcp", FromPort: 80, ToPort: 80, CidrIp: "0.0.0.0/0" },
      ]),
      practices,
    );
    expect(findings.find((f) => f.practiceId === "BP-SG-004")).toBeUndefined();
  });

  it("does NOT fire on a combined 80+443 public ingress (typical web SG)", () => {
    const findings = evaluateTriggers(
      ctx([
        { IpProtocol: "tcp", FromPort: 80, ToPort: 80, CidrIp: "0.0.0.0/0" },
        {
          IpProtocol: "tcp",
          FromPort: 443,
          ToPort: 443,
          CidrIp: "0.0.0.0/0",
        },
      ]),
      practices,
    );
    expect(findings.find((f) => f.practiceId === "BP-SG-004")).toBeUndefined();
  });

  it("does NOT fire on a zero-ingress SG (bare default security group)", () => {
    const findings = evaluateTriggers(ctx([]), practices);
    expect(findings.find((f) => f.practiceId === "BP-SG-004")).toBeUndefined();
  });

  it("does NOT fire when the desiredState has no SecurityGroupIngress property", () => {
    const findings = evaluateTriggers(
      { resourceType: "AWS::EC2::SecurityGroup", desiredState: {} },
      practices,
    );
    expect(findings.find((f) => f.practiceId === "BP-SG-004")).toBeUndefined();
  });

  it("does NOT fire on a malformed ingress element (string junk)", () => {
    const findings = evaluateTriggers(
      {
        resourceType: "AWS::EC2::SecurityGroup",
        desiredState: {
          SecurityGroupIngress: [
            "garbage" as unknown as Record<string, unknown>,
          ],
        },
      },
      practices,
    );
    expect(findings.find((f) => f.practiceId === "BP-SG-004")).toBeUndefined();
  });
});

describe("BP-SG-004 evaluateTriggers — DB/admin ports must fire CRITICAL", () => {
  const bp = loadBpSg004();
  const practices = [bp];

  it.each([
    ["FTP-data", 20],
    ["FTP-control", 21],
    ["MSSQL-server", 1433],
    ["MSSQL-monitor", 1434],
    ["Oracle", 1521],
    ["MySQL / Aurora MySQL", 3306],
    ["RDP", 3389],
    ["IBM-rdb", 4333],
    ["Postgres / Aurora Postgres", 5432],
    ["Redshift", 5439],
    ["VNC", 5500],
    ["Redis", 6379],
    ["Elasticsearch", 9200],
    ["MongoDB", 27017],
  ])("DOES fire CRITICAL when %s (port %i) is open to 0.0.0.0/0", (_, port) => {
    const findings = evaluateTriggers(
      ctx([
        {
          IpProtocol: "tcp",
          FromPort: port,
          ToPort: port,
          CidrIp: "0.0.0.0/0",
        },
      ]),
      practices,
    );
    const hit = findings.find((f) => f.practiceId === "BP-SG-004");
    expect(hit).toBeDefined();
    expect(hit?.severity).toBe("CRITICAL");
  });

  it("does NOT fire when a DB port is open to a private CIDR (10.0.0.0/8)", () => {
    const findings = evaluateTriggers(
      ctx([
        {
          IpProtocol: "tcp",
          FromPort: 3306,
          ToPort: 3306,
          CidrIp: "10.0.0.0/8",
        },
      ]),
      practices,
    );
    expect(findings.find((f) => f.practiceId === "BP-SG-004")).toBeUndefined();
  });

  it("DOES fire on a port-range 3300-3400 + 0.0.0.0/0 (covers 3306 and 3389)", () => {
    const findings = evaluateTriggers(
      ctx([
        {
          IpProtocol: "tcp",
          FromPort: 3300,
          ToPort: 3400,
          CidrIp: "0.0.0.0/0",
        },
      ]),
      practices,
    );
    expect(findings.find((f) => f.practiceId === "BP-SG-004")).toBeDefined();
  });

  it("does NOT fire on a port-range that dodges every DB port (8000-8999)", () => {
    const findings = evaluateTriggers(
      ctx([
        {
          IpProtocol: "tcp",
          FromPort: 8000,
          ToPort: 8999,
          CidrIp: "0.0.0.0/0",
        },
      ]),
      practices,
    );
    expect(findings.find((f) => f.practiceId === "BP-SG-004")).toBeUndefined();
  });

  it("DOES fire on an all-traffic rule (IpProtocol:-1, no port bounds) from 0.0.0.0/0", () => {
    const findings = evaluateTriggers(
      ctx([{ IpProtocol: "-1", CidrIp: "0.0.0.0/0" }]),
      practices,
    );
    expect(findings.find((f) => f.practiceId === "BP-SG-004")).toBeDefined();
  });

  it("DOES fire when a multi-rule SG has one safe (443) and one unsafe (3306) rule", () => {
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
          FromPort: 3306,
          ToPort: 3306,
          CidrIp: "0.0.0.0/0",
        },
      ]),
      practices,
    );
    expect(findings.find((f) => f.practiceId === "BP-SG-004")).toBeDefined();
  });
});
