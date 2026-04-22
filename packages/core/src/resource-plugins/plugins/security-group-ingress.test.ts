/**
 * Epic 94 R3 (B-01) — integration regression test.
 *
 * Verifies that SG ingress rules supplied by the user in natural-language
 * intent (e.g. "allowing port 22 from 0.0.0.0/0") survive end-to-end through
 *   1. intent-parser.extractAssertedValues → elicited["SecurityGroupIngress"]
 *   2. option-elicitor.buildExpertModeOptions (--no-wizard fast path)
 * and arrive at elicitedOptions with the user-requested port — NOT the old
 * hardcoded port-443 default that the plugin used to inject.
 *
 * Real data: the same shapes the CLI produces at runtime; no mocks for the
 * domain logic itself.
 */

import { describe, it, expect } from "vitest";
import { RESOURCE_TYPES } from "../../config/resource-types.js";
import { securityGroupPlugin } from "./security-group.js";
import { extractAssertedValues } from "../../graph/nodes/intent-parser.js";
import { buildExpertModeOptions } from "../../graph/nodes/option-elicitor/expert-path.js";
import type { AgentState } from "../../graph/graph-state.js";

describe("SG ingress intent routing (Epic 94 R3)", () => {
  it("plugin.defaults no longer carries the port-443 hardcoded ingress rule", () => {
    expect(
      (securityGroupPlugin.defaults as Record<string, unknown>)[
        "SecurityGroupIngress"
      ],
    ).toBeUndefined();
  });

  describe("extractSgIngress → elicitedOptions precedence", () => {
    for (const port of [22, 3306, 3389, 80, 8080]) {
      it(`port ${port} from 0.0.0.0/0 survives buildExpertModeOptions`, () => {
        const intent = `Create a security group allowing port ${port} from 0.0.0.0/0`;
        const { elicited, errors } = extractAssertedValues(
          intent,
          RESOURCE_TYPES.EC2_SECURITY_GROUP,
        );
        expect(errors).toEqual([]);
        expect(elicited["SecurityGroupIngress"]).toEqual([
          {
            IpProtocol: "tcp",
            FromPort: port,
            ToPort: port,
            CidrIp: "0.0.0.0/0",
          },
        ]);

        // Feed the parser output into the same graph state the real CLI
        // threads through (mergeElicited writes elicited into
        // state.elicitedOptions before option-elicitor runs).
        const state = {
          resourceType: RESOURCE_TYPES.EC2_SECURITY_GROUP,
          userIntent: intent,
          elicitedOptions: elicited,
        } as unknown as AgentState;

        // Empty presetElicited simulates a CLI run without --set flags.
        const out = buildExpertModeOptions(state, {});

        // The user-requested port must survive; the old port-443 default
        // must NOT appear.
        const ingress = out["SecurityGroupIngress"] as Array<
          Record<string, unknown>
        >;
        expect(ingress).toBeDefined();
        expect(ingress).toHaveLength(1);
        expect(ingress[0]).toEqual({
          IpProtocol: "tcp",
          FromPort: port,
          ToPort: port,
          CidrIp: "0.0.0.0/0",
        });

        // Egress default still applied (plugin.defaults still carries egress).
        expect(out["SecurityGroupEgress"]).toEqual([
          { IpProtocol: "-1", CidrIp: "0.0.0.0/0" },
        ]);
      });
    }
  });

  it("presetElicited (--set) still wins over parser-asserted ingress", () => {
    const intent = "Create a security group allowing port 22 from 0.0.0.0/0";
    const { elicited } = extractAssertedValues(
      intent,
      RESOURCE_TYPES.EC2_SECURITY_GROUP,
    );

    const state = {
      resourceType: RESOURCE_TYPES.EC2_SECURITY_GROUP,
      userIntent: intent,
      elicitedOptions: elicited,
    } as unknown as AgentState;

    // Simulate `--set SecurityGroupIngress=<override>` (in practice only
    // string/boolean/number presets land here, so we emulate with a string
    // override that a caller might type-coerce downstream).
    const presetOverride = "tcp:80:0.0.0.0/0";
    const out = buildExpertModeOptions(state, {
      SecurityGroupIngress: presetOverride,
    });
    expect(out["SecurityGroupIngress"]).toBe(presetOverride);
  });

  it("omits SecurityGroupIngress entirely when the user supplies no port", () => {
    const intent = "Create a security group for web servers";
    const { elicited, errors } = extractAssertedValues(
      intent,
      RESOURCE_TYPES.EC2_SECURITY_GROUP,
    );
    expect(errors).toEqual([]);
    expect(elicited["SecurityGroupIngress"]).toBeUndefined();

    const state = {
      resourceType: RESOURCE_TYPES.EC2_SECURITY_GROUP,
      userIntent: intent,
      elicitedOptions: elicited,
    } as unknown as AgentState;

    const out = buildExpertModeOptions(state, {});
    // Neither parser nor plugin.defaults now sets SecurityGroupIngress.
    // The field stays absent — a valid CFN shape (zero ingress rules).
    expect(out["SecurityGroupIngress"]).toBeUndefined();
    // Egress default still fires.
    expect(out["SecurityGroupEgress"]).toEqual([
      { IpProtocol: "-1", CidrIp: "0.0.0.0/0" },
    ]);
  });

  it("multiple port phrases all survive (e.g. 'port 80 and port 443')", () => {
    const intent =
      "Create a security group allowing port 80 from 0.0.0.0/0 and port 443 from 0.0.0.0/0";
    const { elicited, errors } = extractAssertedValues(
      intent,
      RESOURCE_TYPES.EC2_SECURITY_GROUP,
    );
    expect(errors).toEqual([]);
    const ingress = elicited["SecurityGroupIngress"] as Array<
      Record<string, unknown>
    >;
    expect(ingress.length).toBeGreaterThanOrEqual(2);
    const ports = ingress
      .map((r) => r["FromPort"] as number)
      .sort((a, b) => a - b);
    expect(ports).toEqual([80, 443]);
  });
});
