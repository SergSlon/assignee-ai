/**
 * EC2 Pricing Decomposer — breaks an EC2 instance into billable components:
 * compute, EBS storage, public IPv4, and data transfer.
 *
 * @see Story 23.1
 */

import type {
  PricingDecomposer,
  PricingLineItem,
} from "../decomposer-types.js";

const EXTENDED_TIMEOUT_MS = 8000;

export const ec2PricingDecomposer: PricingDecomposer = {
  resourceType: "AWS::EC2::Instance",

  decompose(desiredState: Record<string, unknown>): PricingLineItem[] {
    const items: PricingLineItem[] = [];
    const instanceType =
      (desiredState["InstanceType"] as string | undefined) ?? "t3.micro";

    // 1. Compute (instance hourly rate)
    items.push({
      label: "Compute",
      quantity: 1,
      unit: "instance",
      serviceCode: "AmazonEC2",
      filters: [
        {
          Field: "productFamily",
          Value: "Compute Instance",
          Type: "TERM_MATCH",
        },
        { Field: "instanceType", Value: instanceType, Type: "TERM_MATCH" },
        { Field: "operatingSystem", Value: "Linux", Type: "TERM_MATCH" },
        { Field: "tenancy", Value: "Shared", Type: "TERM_MATCH" },
        { Field: "capacitystatus", Value: "Used", Type: "TERM_MATCH" },
        { Field: "preInstalledSw", Value: "NA", Type: "TERM_MATCH" },
      ],
      kind: "fixed",
      description: instanceType,
      priceUnit: "/hr",
      timeoutMs: EXTENDED_TIMEOUT_MS,
    });

    // 2. EBS Storage — iterate ALL volumes, not just the first
    const bdm = desiredState["BlockDeviceMappings"];
    if (Array.isArray(bdm) && bdm.length > 0) {
      for (let idx = 0; idx < bdm.length; idx++) {
        const vol = bdm[idx] as Record<string, unknown> | undefined;
        const ebs = vol?.["Ebs"] as Record<string, unknown> | undefined;
        if (ebs) {
          const volumeType = String(ebs["VolumeType"] ?? "gp3");
          const volumeSize = Number(ebs["VolumeSize"] ?? 8);
          const volumeApiName = mapVolumeType(volumeType);
          const volLabel =
            bdm.length > 1 ? `Storage (vol ${idx + 1})` : "Storage";

          items.push({
            label: volLabel,
            quantity: volumeSize,
            unit: "GB",
            serviceCode: "AmazonEC2",
            filters: [
              { Field: "productFamily", Value: "Storage", Type: "TERM_MATCH" },
              {
                Field: "volumeApiName",
                Value: volumeApiName,
                Type: "TERM_MATCH",
              },
            ],
            kind: "fixed",
            description: `${volumeSize} GB ${volumeType}`,
            priceUnit: "/GB-mo",
          });
        }
      }
    }

    // 3. Public IPv4 — only if explicitly requested via AssociatePublicIpAddress
    const hasPublicIp = desiredState["AssociatePublicIpAddress"] === true;

    if (hasPublicIp) {
      items.push({
        label: "Public IPv4",
        quantity: 1,
        unit: "address",
        serviceCode: "AmazonVPC",
        filters: [
          { Field: "productFamily", Value: "IP Address", Type: "TERM_MATCH" },
          { Field: "group", Value: "ElasticIP:Address", Type: "TERM_MATCH" },
        ],
        kind: "fixed",
        description: "1 address",
        priceUnit: "/hr",
      });
    }

    // 4. Data transfer out (usage-based)
    items.push({
      label: "Data transfer out",
      quantity: 0,
      unit: "GB",
      serviceCode: "AWSDataTransfer",
      filters: [
        { Field: "productFamily", Value: "Data Transfer", Type: "TERM_MATCH" },
        { Field: "fromLocationType", Value: "AWS Region", Type: "TERM_MATCH" },
        { Field: "toLocationType", Value: "External", Type: "TERM_MATCH" },
        { Field: "transferType", Value: "AWS Outbound", Type: "TERM_MATCH" },
      ],
      kind: "usage_based",
      description: "per GB",
      priceUnit: "/GB",
    });

    return items;
  },
};

function mapVolumeType(volumeType: string): string {
  const map: Record<string, string> = {
    gp3: "gp3",
    gp2: "gp2",
    io1: "io1",
    io2: "io2",
    st1: "st1",
    sc1: "sc1",
    standard: "standard",
  };
  return map[volumeType] ?? "gp3";
}
