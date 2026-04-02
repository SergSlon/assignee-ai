import { RESOURCE_TYPES } from "../../config/resource-types.js";
import { CfnKey, AwsDefault } from "../../config/cfn-keys.js";
import type { ResourcePlugin } from "../types.js";
import { TAGS_VALIDATE } from "../shared-fields.js";
import { FieldLabel } from "../field-labels.js";

/**
 * ResourcePlugin for AWS::ElasticLoadBalancingV2::LoadBalancer.
 * Supports Application (ALB) and Network (NLB) load balancers.
 */
export const elbv2LoadBalancerPlugin: ResourcePlugin = {
  resourceType: RESOURCE_TYPES.ELBV2_LOAD_BALANCER,
  commonFields: [
    {
      name: CfnKey.NAME,
      question: {
        type: "string",
        label: "Load balancer name",
        placeholder: "my-alb",
        hint: "Must be 1-32 chars: letters, numbers, hyphens. Cannot start or end with a hyphen. Must be unique within the region.",
        validate: (value: unknown) => {
          if (!value) return "Load balancer name is required";
          const s = String(value);
          if (s.length > 32) return "Name must be 1-32 characters";
          if (!/^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(s))
            return "Must contain only letters, numbers, hyphens, and cannot start/end with a hyphen";
          return undefined;
        },
      },
      required: true,
    },
    {
      name: CfnKey.TYPE,
      question: {
        type: "enum",
        label: "Load balancer type",
        options: [
          {
            value: AwsDefault.LB_TYPE_APPLICATION,
            label: "Application (ALB) — HTTP/HTTPS",
            recommended: true,
            fitHint: "Best for web apps, APIs, microservices",
          },
          {
            value: "network",
            label: "Network (NLB) — TCP/UDP/TLS",
            fitHint:
              "Best for extreme performance, static IPs, non-HTTP protocols",
          },
        ],
        initialValue: AwsDefault.LB_TYPE_APPLICATION,
        hint: "ALB operates at Layer 7 (HTTP) with path/host routing, WAF support, and WebSocket. NLB operates at Layer 4 (TCP) with ultra-low latency and static IPs.",
      },
    },
    {
      name: CfnKey.SCHEME,
      question: {
        type: "enum",
        label: "Scheme",
        options: [
          {
            value: AwsDefault.LB_SCHEME_INTERNET_FACING,
            label: "Internet-facing (public)",
            fitHint: "Accessible from the internet",
          },
          {
            value: "internal",
            label: "Internal (private)",
            fitHint: "Only accessible within your VPC",
          },
        ],
        initialValue: AwsDefault.LB_SCHEME_INTERNET_FACING,
        hint: "Internet-facing receives traffic from the internet. Internal is only reachable within your VPC. Cannot be changed after creation.",
      },
    },
    {
      name: CfnKey.SUBNETS,
      question: {
        type: "multi",
        label: "Subnets",
        options: [],
        hint: "AWS recommends subnets in at least 2 Availability Zones for high availability. Internet-facing ALBs require public subnets. Internal ALBs use private subnets.",
        fetcher: "discover-subnets",
        validate: (value: unknown) => {
          if (!value) return "At least 2 subnets are required";
          const arr = Array.isArray(value) ? value : [value];
          if (arr.length < 2)
            return "At least 2 subnets in different Availability Zones are required";
          return undefined;
        },
      },
      required: true,
    },
    {
      name: CfnKey.TAGS,
      question: {
        type: "string",
        label: FieldLabel.TAGS,
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
      name: CfnKey.SECURITY_GROUPS,
      question: {
        type: "multi",
        label: "Security groups",
        options: [],
        hint: "Security groups control inbound/outbound traffic. Required for ALBs. Typically allow ports 80/443 inbound.",
        showIf: { field: CfnKey.TYPE, value: AwsDefault.LB_TYPE_APPLICATION },
        fetcher: "discover-security-groups",
        validate: (value: unknown) => {
          if (!value || (Array.isArray(value) && value.length === 0))
            return "At least one security group is required for Application Load Balancers";
          return undefined;
        },
      },
    },
    {
      name: CfnKey.IP_ADDRESS_TYPE,
      question: {
        type: "enum",
        label: "IP address type",
        options: [
          { value: "ipv4", label: "IPv4 only" },
          { value: "dualstack", label: "Dual-stack (IPv4 + IPv6)" },
        ],
        initialValue: "ipv4",
        hint: "Dual-stack enables IPv6 support alongside IPv4. Use if your clients need IPv6 connectivity.",
      },
    },
    {
      name: CfnKey.DELETION_PROTECTION,
      question: {
        type: "boolean",
        label: "Enable deletion protection?",
        initialValue: true,
        hint: "Prevents accidental deletion via API/Console. Must be disabled before the load balancer can be deleted. Recommended for production.",
      },
      toCfn: (answer: unknown) => [
        {
          Key: "deletion_protection.enabled",
          Value: String(Boolean(answer)),
        },
      ],
    },
  ],
  defaults: {
    [CfnKey.TYPE]: AwsDefault.LB_TYPE_APPLICATION,
    [CfnKey.SCHEME]: AwsDefault.LB_SCHEME_INTERNET_FACING,
    [CfnKey.IP_ADDRESS_TYPE]: "ipv4",
  },
};
