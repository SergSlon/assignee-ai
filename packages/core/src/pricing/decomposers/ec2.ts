/**
 * EC2 Pricing Decomposer — breaks an EC2 instance into billable components:
 * compute, EBS storage, public IPv4, and data transfer.
 *
 * @see Story 23.1
 */

import { CfnKey, ResourceDefault } from "../../config/cfn-keys.js";
import { RESOURCE_TYPES } from "../../config/resource-types.js";
import type {
  PricingDecomposer,
  PricingLineItem,
} from "../decomposer-types.js";
import { EXTENDED_TIMEOUT_MS } from "../constants.js";
import {
  PricingField as F,
  PricingKind as K,
  PricingMatchType as M,
  PricingProductFamily as PF,
  PricingServiceCode as SC,
} from "../filter-constants.js";

export const ec2PricingDecomposer: PricingDecomposer = {
  resourceType: RESOURCE_TYPES.EC2_INSTANCE,

  decompose(desiredState: Record<string, unknown>): PricingLineItem[] {
    const items: PricingLineItem[] = [];
    const instanceType =
      (desiredState[CfnKey.INSTANCE_TYPE] as string | undefined) ?? "t3.micro";

    // 1. Compute (instance hourly rate)
    items.push({
      label: "Compute",
      quantity: 1,
      unit: "instance",
      serviceCode: SC.EC2,
      filters: [
        {
          Field: F.PRODUCT_FAMILY,
          Value: PF.COMPUTE_INSTANCE,
          Type: M.TERM_MATCH,
        },
        { Field: F.INSTANCE_TYPE, Value: instanceType, Type: M.TERM_MATCH },
        { Field: F.OPERATING_SYSTEM, Value: "Linux", Type: M.TERM_MATCH },
        { Field: F.TENANCY, Value: "Shared", Type: M.TERM_MATCH },
        { Field: F.CAPACITY_STATUS, Value: "Used", Type: M.TERM_MATCH },
        { Field: F.PRE_INSTALLED_SW, Value: "NA", Type: M.TERM_MATCH },
      ],
      kind: K.FIXED,
      description: instanceType,
      priceUnit: "/hr",
      timeoutMs: EXTENDED_TIMEOUT_MS,
    });

    // 2. EBS Storage — iterate ALL volumes, not just the first
    const bdm = desiredState[CfnKey.BLOCK_DEVICE_MAPPINGS];
    if (Array.isArray(bdm) && bdm.length > 0) {
      for (let idx = 0; idx < bdm.length; idx++) {
        const vol = bdm[idx] as Record<string, unknown> | undefined;
        const ebs = vol?.[CfnKey.EBS] as Record<string, unknown> | undefined;
        if (ebs) {
          const volumeType = String(
            ebs[CfnKey.VOLUME_TYPE] ?? ResourceDefault.EBS_VOLUME_TYPE,
          );
          const volumeSize = Number(ebs[CfnKey.VOLUME_SIZE] ?? 8);
          const volumeApiName = mapVolumeType(volumeType);
          const volLabel =
            bdm.length > 1 ? `Storage (vol ${idx + 1})` : "Storage";

          items.push({
            label: volLabel,
            quantity: volumeSize,
            unit: "GB",
            serviceCode: SC.EC2,
            filters: [
              {
                Field: F.PRODUCT_FAMILY,
                Value: PF.STORAGE,
                Type: M.TERM_MATCH,
              },
              {
                Field: F.VOLUME_API_NAME,
                Value: volumeApiName,
                Type: M.TERM_MATCH,
              },
            ],
            kind: K.FIXED,
            description: `${volumeSize} GB ${volumeType}`,
            priceUnit: "/GB-mo",
          });
        }
      }
    }

    // 3. Public IPv4 — only if explicitly requested via AssociatePublicIpAddress
    const hasPublicIp = desiredState[CfnKey.ASSOCIATE_PUBLIC_IP] === true;

    if (hasPublicIp) {
      items.push({
        label: "Public IPv4",
        quantity: 1,
        unit: "address",
        serviceCode: SC.VPC,
        filters: [
          { Field: F.PRODUCT_FAMILY, Value: PF.IP_ADDRESS, Type: M.TERM_MATCH },
          { Field: F.GROUP, Value: "ElasticIP:Address", Type: M.TERM_MATCH },
        ],
        kind: K.FIXED,
        description: "1 address",
        priceUnit: "/hr",
      });
    }

    // 4. Data transfer out (usage-based)
    items.push({
      label: "Data transfer out",
      quantity: 0,
      unit: "GB",
      serviceCode: SC.DATA_TRANSFER,
      filters: [
        {
          Field: F.PRODUCT_FAMILY,
          Value: PF.DATA_TRANSFER,
          Type: M.TERM_MATCH,
        },
        {
          Field: F.FROM_LOCATION_TYPE,
          Value: "AWS Region",
          Type: M.TERM_MATCH,
        },
        { Field: F.TO_LOCATION_TYPE, Value: "External", Type: M.TERM_MATCH },
        { Field: F.TRANSFER_TYPE, Value: "AWS Outbound", Type: M.TERM_MATCH },
      ],
      kind: K.USAGE_BASED,
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
  return map[volumeType] ?? ResourceDefault.EBS_VOLUME_TYPE;
}
