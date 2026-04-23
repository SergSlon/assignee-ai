import { RESOURCE_TYPES } from "../../config/resource-types.js";
import { CfnKey } from "../../config/cfn-keys.js";
import type { ResourcePlugin } from "../types.js";
import { TAGS_VALIDATE, TAGS_HINT } from "../shared-fields.js";
import { FieldLabel } from "../field-labels.js";

/**
 * ResourcePlugin for AWS::EC2::EIP.
 *
 * e98.W5.N5 (B-03) — promoted from COMPANION_RESOURCE_TYPES to a
 * first-class supported type. Previously EIP was only emitted inline
 * by the vpc-networking compound's NAT Gateway sub-plan (with
 * `provisionable: false` so the resource-provisioner auto-allocates
 * via `EIP_AUTO_ALLOCATE`). Epic 97 B-03 found that:
 *
 *   - A standalone `Create an Elastic IP` intent had no route — the
 *     LLM could hallucinate an AWS::EC2::EIP plan, but there was no
 *     plugin wiring it to the plan pipeline, no help-hints grid entry,
 *     and no pricing decomposer entry.
 *   - The COMPANION_RESOURCE_TYPES.EC2_EIP alias is retained so that
 *     existing nat-gateway companion callers continue to work
 *     unchanged — both constants resolve to the same
 *     `"AWS::EC2::EIP"` string.
 *
 * CCAPI schema (AWS::EC2::EIP):
 *   - required: [] (every property is optional; account-scoped EIP
 *     pool supplies the address)
 *   - createOnly: [Domain, NetworkBorderGroup, InstanceId,
 *                  TransferAddress, Address, IpamPoolId]
 *   - primaryIdentifier: [/properties/AllocationId]
 *   - tagging.taggable = true
 *
 * Pricing: EIPs are free while attached to a running resource (EC2
 * instance, NAT Gateway). Unattached EIPs bill at ~$0.005/hour. The
 * generic-decomposer fallback reports a conservative "up to $3.60/mo
 * if unattached" estimate — `BP-EIP-001` (if/when seeded) would gate
 * the attach contract.
 */
export const ec2EipPlugin: ResourcePlugin = {
  resourceType: RESOURCE_TYPES.EC2_EIP,
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
  defaults: {
    // Domain=vpc is the only operationally-meaningful default. The
    // legacy EC2-Classic `standard` domain was retired in 2022; every
    // EIP on a modern account is vpc-scoped. Paired with the W3.A1
    // mergePluginDefaults allowlist (if EIP is added there later),
    // this survives LLM drift that omits the Domain key.
    [CfnKey.DOMAIN]: "vpc",
  },
  configHints: [
    "Elastic IPs are FREE while attached to a running EC2 instance or NAT Gateway. Unattached EIPs bill at ~$0.005/hour (roughly $3.60/month). Always pair an EIP with its intended target — either AssociationId pointing at a running resource, or emit it as part of a compound that also creates the attach target.",
    "Domain defaults to 'vpc' — the only valid value on modern accounts. EC2-Classic (the legacy `standard` domain) was retired in 2022.",
    "EIPs are regional resources — a us-east-1 EIP cannot be associated with an us-west-2 resource.",
    "Releasing a destroyed EIP frees it from the account's pool; until then it counts against the default 5-per-region quota.",
    "When creating an EIP for a NAT Gateway, prefer the `nat-gateway` or `vpc-networking` compound pattern — the EIP is auto-allocated with `provisionable:false` and the provisioner handles the allocation + attach in one step.",
  ],
};
