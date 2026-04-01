import { RESOURCE_TYPES } from "../../config/resource-types.js";
import type { ResourcePlugin } from "../types.js";
import { TAGS_VALIDATE } from "../shared-fields.js";

/**
 * Parses a compact ingress/egress rule string into a CloudFormation rule object.
 * Format: "protocol:port:cidr" (e.g. "tcp:443:0.0.0.0/0")
 * Port can be a range ("tcp:1024-65535:10.0.0.0/8") or -1 for all traffic.
 */
function parseRuleString(
  rule: string,
  direction: "ingress" | "egress",
): Record<string, unknown> | undefined {
  const parts = rule.trim().split(":");
  if (parts.length < 3) return undefined;

  const [protocol, port, ...cidrParts] = parts;
  const cidr = cidrParts.join(":"); // rejoin in case IPv6

  const result: Record<string, unknown> = {
    IpProtocol: protocol === "all" ? "-1" : protocol,
  };

  if (protocol !== "all" && port !== "-1") {
    if (port!.includes("-")) {
      const [from, to] = port!.split("-");
      result["FromPort"] = parseInt(from!, 10);
      result["ToPort"] = parseInt(to!, 10);
    } else {
      result["FromPort"] = parseInt(port!, 10);
      result["ToPort"] = parseInt(port!, 10);
    }
  }

  const isIpv6 = cidr.includes(":");
  const cidrKey = isIpv6 ? "CidrIpv6" : "CidrIp";
  result[cidrKey] = cidr;

  return result;
}

/**
 * Validates a compact ingress/egress rule string.
 * Returns an error string if invalid, undefined if valid.
 */
function validateRuleString(rule: string): string | undefined {
  const parts = rule.trim().split(":");
  if (parts.length < 3)
    return `Invalid rule format: "${rule.trim()}" — expected "protocol:port:cidr"`;

  const [protocol, port, ...cidrParts] = parts;
  const cidr = cidrParts.join(":");

  if (protocol !== "all" && port !== "-1") {
    if (port!.includes("-")) {
      const [fromStr, toStr] = port!.split("-");
      const from = parseInt(fromStr!, 10);
      const to = parseInt(toStr!, 10);
      if (isNaN(from) || isNaN(to) || from < 1 || to > 65535)
        return `Port range must be between 1 and 65535, got "${port}"`;
      if (from > to) return `fromPort (${from}) must be <= toPort (${to})`;
    } else {
      const p = parseInt(port!, 10);
      if (isNaN(p) || p < 1 || p > 65535)
        return `Port must be between 1 and 65535, got "${port}"`;
    }
  }

  // Warn (non-blocking) for SSH open to the internet — returned as hint-style prefix
  if (
    protocol === "tcp" &&
    port === "22" &&
    (cidr === "0.0.0.0/0" || cidr === "::/0")
  ) {
    return "WARNING: SSH (port 22) open to the entire internet (0.0.0.0/0) is a security risk. Restrict to specific IPs.";
  }

  return undefined;
}

function parseRules(
  answer: unknown,
  direction: "ingress" | "egress",
): unknown[] | undefined {
  if (typeof answer !== "string" || !answer.trim()) return undefined;
  const rules = answer
    .split(",")
    .map((r) => parseRuleString(r, direction))
    .filter(Boolean);
  return rules.length > 0 ? rules : undefined;
}

export const securityGroupPlugin: ResourcePlugin = {
  resourceType: RESOURCE_TYPES.EC2_SECURITY_GROUP,
  commonFields: [
    {
      name: "GroupDescription",
      required: true,
      question: {
        type: "string",
        label: "Security Group description",
        placeholder: "Web server security group",
        hint: "A human-readable description. Required by AWS and cannot be changed after creation.",
        validate: (value: unknown) => {
          if (!value || !String(value).trim())
            return "Group description is required";
          const s = String(value);
          if (s.length > 255)
            return "Group description must be 255 characters or fewer";
          return undefined;
        },
      },
    },
    {
      name: "VpcId",
      question: {
        type: "enum",
        label: "VPC",
        hint: "The VPC this security group belongs to. If omitted, the default VPC is used.",
        options: [],
        fetcher: "discover-vpcs",
      },
    },
    {
      name: "Tags",
      question: {
        type: "string",
        label: "Tags",
        placeholder: "env:production, team:backend",
        hint: "Comma-separated Key:Value pairs for cost tracking and organization.",
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
  advancedFields: [
    {
      name: "SecurityGroupIngress",
      question: {
        type: "string",
        label: "Ingress rules (protocol:port:source)",
        placeholder: "tcp:443:0.0.0.0/0, tcp:22:10.0.0.0/8",
        hint: 'Comma-separated inbound rules. Format: "protocol:port:cidr". Ports must be 1-65535. Use "all:-1:0.0.0.0/0" for all traffic. Default: SSH from private range + HTTPS from anywhere.',
        validate: (value: unknown) => {
          if (!value || !String(value).trim()) return undefined;
          const rules = String(value)
            .split(",")
            .map((r) => r.trim())
            .filter(Boolean);
          for (const rule of rules) {
            const err = validateRuleString(rule);
            if (err) return err;
          }
          return undefined;
        },
      },
      toCfn: (answer: unknown) => parseRules(answer, "ingress"),
    },
    {
      name: "SecurityGroupEgress",
      question: {
        type: "string",
        label: "Egress rules (protocol:port:destination)",
        placeholder: "all:-1:0.0.0.0/0",
        hint: 'Comma-separated outbound rules. Format: "protocol:port:cidr". Ports must be 1-65535. Default: all outbound traffic allowed.',
        validate: (value: unknown) => {
          if (!value || !String(value).trim()) return undefined;
          const rules = String(value)
            .split(",")
            .map((r) => r.trim())
            .filter(Boolean);
          for (const rule of rules) {
            const err = validateRuleString(rule);
            if (err) return err;
          }
          return undefined;
        },
      },
      toCfn: (answer: unknown) => parseRules(answer, "egress"),
    },
  ],
  defaults: {
    SecurityGroupIngress: [
      { IpProtocol: "tcp", FromPort: 443, ToPort: 443, CidrIp: "0.0.0.0/0" },
    ],
    SecurityGroupEgress: [{ IpProtocol: "-1", CidrIp: "0.0.0.0/0" }],
  },
  configHints: [
    "SecurityGroup GroupDescription: REQUIRED. Cannot be changed after creation. Must be a meaningful description.",
    "SecurityGroup VpcId: if the user did not provide a VPC, OMIT VpcId — the default VPC will be used.",
    "SecurityGroup Ingress: Default allows HTTPS (443) from anywhere only. SSH must be explicitly added with a restricted CIDR. NEVER open SSH to 0.0.0.0/0.",
    "SecurityGroup Egress: Default allows all outbound traffic. Restrict if the workload has known egress patterns.",
  ],
};
