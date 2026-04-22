import { RESOURCE_TYPES } from "../../config/resource-types.js";
import { CfnKey } from "../../config/cfn-keys.js";
import type { ResourcePlugin } from "../types.js";
import { TAGS_VALIDATE, TAGS_HINT } from "../shared-fields.js";
import { FieldLabel } from "../field-labels.js";

/**
 * ResourcePlugin for AWS::EC2::InternetGateway.
 * InternetGateways are free — data transfer charges apply to traffic but are not IGW-specific.
 *
 * Epic 92 e92.u.c.2 (B-11): strengthen the `[BLOCK]` remediation path.
 * The IGW CCAPI schema has NO `VpcId` property — attachment is modelled
 * by a separate `AWS::EC2::VPCGatewayAttachment` resource. But the
 * plan-generator STILL needs to emit a concrete `[BLOCK]` when a user
 * says "create an InternetGateway" without naming a VPC target. Prior
 * guidance was vague prose; this commit expands `configHints` with a
 * concrete `--set VpcId=` remediation string and wires the companion-
 * attachment expectation so the LLM emits both resources together.
 *
 * Out of scope (deferred F1): reading the managed-resources-cache to
 * inject concrete candidate VPC IDs (e.g. "candidates: vpc-abc123,
 * vpc-def456") into the BLOCK message. That integration lives in
 * `packages/core/src/graph/nodes/plan-generator.ts` + the
 * `services/managed-resources-cache.ts` consumer, neither of which is
 * in this story's exclusive file scope.
 */
export const internetGatewayPlugin: ResourcePlugin = {
  resourceType: RESOURCE_TYPES.EC2_INTERNET_GATEWAY,
  commonFields: [
    {
      name: CfnKey.TAGS,
      question: {
        type: "string",
        label: FieldLabel.TAGS,
        placeholder: "env:production, team:platform",
        hint: TAGS_HINT,
        validate: TAGS_VALIDATE,
      },
      toCfn: (answer: unknown) => {
        if (typeof answer !== "string" || !answer.trim()) return undefined;
        const tags = answer
          .split(",")
          .filter((p) => p.includes(":"))
          .map((pair) => {
            const [Key, ...rest] = pair.trim().split(":");
            return { Key: Key!.trim(), Value: rest.join(":").trim() };
          });
        return tags.length > 0 ? tags : undefined;
      },
    },
  ],
  advancedFields: [],
  defaults: {},
  configHints: [
    "An InternetGateway MUST be attached to a VPC via a VPCGatewayAttachment resource to function",
    "A route table entry with destination 0.0.0.0/0 targeting the IGW is required for public subnet internet access",
    "Each VPC can have at most one InternetGateway attached",
    "InternetGateway companion attachment: when emitting an AWS::EC2::InternetGateway, ALSO emit a companion AWS::EC2::VPCGatewayAttachment with properties { VpcId: <vpc-id-or-Ref>, InternetGatewayId: { Ref: <IgwLogicalId> } }. Without the attachment the IGW is inert. If the plan is a compound that also creates the VPC, use { Ref: <VpcLogicalId> } for VpcId; if the user has a managed VPC, reference it by its ID.",
    "InternetGateway VpcId missing fallback: when the user asks to create an IGW but does NOT name a target VPC (no compound VPC planned, no --set VpcId=<vpc-id> supplied, and no managed-VPC candidate available), emit a [BLOCK] with the remediation 'VpcId missing — add --set VpcId=<vpc-id> or plan inside a VPC compound (a VPCGatewayAttachment companion is required)'. When the managed-resources cache exposes candidate VPC IDs to plan-generator, append them to the remediation, e.g. 'VpcId missing — candidates: vpc-abc123, vpc-def456'. Do NOT fabricate placeholder VPC IDs like 'vpc-00000000' — the apply will fail at VPCGatewayAttachment creation.",
  ],
};
