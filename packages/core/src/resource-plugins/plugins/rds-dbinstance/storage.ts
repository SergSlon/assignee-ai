import {
  CfnKey,
  ResourceDefault,
  AwsDefault,
  SizeLabel,
} from "@/config/cfn-keys.js";
import type { ResourcePlugin } from "../../types.js";
import { TAGS_VALIDATE, TAGS_HINT } from "../../shared-fields.js";
import { FieldLabel } from "../../field-labels.js";

/** HA + storage + access + tagging fields (common-tier). */
export const storageAndAccessFields: ResourcePlugin["commonFields"] = [
  {
    name: CfnKey.MULTI_AZ,
    question: {
      type: "boolean",
      label: "Enable Multi-AZ deployment?",
      initialValue: true,
      hint: "Doubles cost. Provides high availability with automatic failover. Best for production.",
    },
  },
  {
    name: CfnKey.DELETION_PROTECTION,
    question: {
      type: "boolean",
      label: "Enable deletion protection?",
      initialValue: true,
      hint: "When enabled, the database cannot be deleted via API or console until protection is removed. Strongly recommended for production to prevent accidental data loss. No cost impact.",
    },
  },
  {
    name: CfnKey.STORAGE_TYPE,
    question: {
      type: "enum",
      label: "Storage type",
      hint: "gp3 is the best price-performance for most workloads. io1 is for high-IOPS needs (thousands of transactions/sec). gp2 is legacy -- prefer gp3 for new databases. Run `assignee cost` for live Pricing-MCP rates.",
      options: [
        {
          value: AwsDefault.EBS_VOLUME_TYPE,
          label: "gp3 (General Purpose SSD v3)",
          fitHint: SizeLabel.BEST_PRICE_PERFORMANCE,
          recommended: true,
        },
        {
          value: "gp2",
          label: "gp2 (General Purpose SSD v2)",
          fitHint: "Legacy, prefer gp3",
        },
        {
          value: "io1",
          label: "io1 (Provisioned IOPS SSD)",
          fitHint: "High-IOPS workloads (per-IOPS charges apply)",
        },
      ],
      initialValue: ResourceDefault.EBS_VOLUME_TYPE,
    },
  },
  {
    name: CfnKey.ALLOCATED_STORAGE,
    question: {
      type: "enum",
      label: "Storage size (GB)",
      hint: "Minimum 20 GB for gp3/gp2. Storage cannot be decreased after creation. Run `assignee cost` for live per-GB-month rates from the Pricing MCP.",
      options: [
        {
          value: "20",
          label: "20 GB",
          fitHint: "Dev/test minimum",
          recommended: true,
        },
        { value: "50", label: "50 GB", fitHint: SizeLabel.SMALL_PRODUCTION },
        { value: "100", label: "100 GB", fitHint: SizeLabel.MEDIUM_PRODUCTION },
        { value: "200", label: "200 GB", fitHint: "Large production" },
      ],
      initialValue: "20",
    },
    toCfn: (v: unknown) => (v ? parseInt(String(v), 10) : undefined),
  },
  {
    name: CfnKey.PUBLICLY_ACCESSIBLE,
    question: {
      type: "boolean",
      label: "Publicly Accessible",
      initialValue: false,
      hint: "Set to false for production databases. Place in private subnet with VPN/bastion access.",
    },
  },
  {
    name: CfnKey.TAGS,
    question: {
      type: "string",
      label: FieldLabel.TAGS,
      placeholder: "env:production, team:backend",
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
];
