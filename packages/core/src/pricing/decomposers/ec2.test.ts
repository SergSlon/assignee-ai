/**
 * Tests for EC2 pricing decomposer (Story 23.1).
 * Verifies line item generation for compute, EBS, public IPv4, and data transfer.
 */

import { describe, it, expect } from "vitest";
import { ec2PricingDecomposer } from "./ec2.js";

describe("ec2PricingDecomposer", () => {
  it("has correct resourceType", () => {
    expect(ec2PricingDecomposer.resourceType).toBe("AWS::EC2::Instance");
  });

  it("returns compute + data transfer for minimal desiredState", () => {
    const items = ec2PricingDecomposer.decompose({});

    // Compute always present
    const compute = items.find((i) => i.label === "Compute");
    expect(compute).toBeDefined();
    expect(compute!.serviceCode).toBe("AmazonEC2");
    expect(compute!.kind).toBe("fixed");
    expect(compute!.priceUnit).toBe("/hr");
    // Default instance type when not specified
    expect(compute!.description).toBe("t3.micro");
    expect(compute!.filters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ Field: "instanceType", Value: "t3.micro" }),
        expect.objectContaining({ Field: "operatingSystem", Value: "Linux" }),
      ]),
    );

    // Data transfer always present
    const dt = items.find((i) => i.label === "Data transfer out");
    expect(dt).toBeDefined();
    expect(dt!.kind).toBe("usage_based");
    expect(dt!.quantity).toBe(0);
    expect(dt!.serviceCode).toBe("AWSDataTransfer");

    // No EBS storage without BlockDeviceMappings
    const storage = items.find((i) => i.label === "Storage");
    expect(storage).toBeUndefined();

    // No public IPv4 without AssociatePublicIpAddress
    const ipv4 = items.find((i) => i.label === "Public IPv4");
    expect(ipv4).toBeUndefined();
  });

  it("uses specified InstanceType", () => {
    const items = ec2PricingDecomposer.decompose({
      InstanceType: "m5.large",
    });

    const compute = items.find((i) => i.label === "Compute")!;
    expect(compute.description).toBe("m5.large");
    expect(compute.filters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ Field: "instanceType", Value: "m5.large" }),
      ]),
    );
  });

  it("includes EBS storage when BlockDeviceMappings present", () => {
    const items = ec2PricingDecomposer.decompose({
      InstanceType: "t3.micro",
      BlockDeviceMappings: [
        {
          Ebs: {
            VolumeType: "gp3",
            VolumeSize: 50,
            Encrypted: true,
          },
        },
      ],
    });

    const storage = items.find((i) => i.label === "Storage");
    expect(storage).toBeDefined();
    expect(storage!.quantity).toBe(50);
    expect(storage!.unit).toBe("GB");
    expect(storage!.serviceCode).toBe("AmazonEC2");
    expect(storage!.description).toBe("50 GB gp3");
    expect(storage!.priceUnit).toBe("/GB-mo");
    expect(storage!.filters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ Field: "productFamily", Value: "Storage" }),
        expect.objectContaining({ Field: "volumeApiName", Value: "gp3" }),
      ]),
    );
  });

  it("defaults EBS to gp3/8GB when Ebs exists without details", () => {
    const items = ec2PricingDecomposer.decompose({
      BlockDeviceMappings: [{ Ebs: {} }],
    });

    const storage = items.find((i) => i.label === "Storage");
    expect(storage).toBeDefined();
    expect(storage!.quantity).toBe(8);
    expect(storage!.description).toBe("8 GB gp3");
  });

  it("includes public IPv4 when AssociatePublicIpAddress is true", () => {
    const items = ec2PricingDecomposer.decompose({
      InstanceType: "t3.micro",
      AssociatePublicIpAddress: true,
    });

    const ipv4 = items.find((i) => i.label === "Public IPv4");
    expect(ipv4).toBeDefined();
    expect(ipv4!.serviceCode).toBe("AmazonVPC");
    expect(ipv4!.kind).toBe("fixed");
    expect(ipv4!.priceUnit).toBe("/hr");
    expect(ipv4!.filters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          Field: "productFamily",
          Value: "IP Address",
        }),
        expect.objectContaining({ Field: "group", Value: "ElasticIP:Address" }),
      ]),
    );
  });

  it("does NOT include public IPv4 when AssociatePublicIpAddress is false/absent", () => {
    const items = ec2PricingDecomposer.decompose({
      AssociatePublicIpAddress: false,
    });

    const ipv4 = items.find((i) => i.label === "Public IPv4");
    expect(ipv4).toBeUndefined();
  });

  it("full EC2 config returns compute + storage + IPv4 + data transfer", () => {
    const items = ec2PricingDecomposer.decompose({
      InstanceType: "m5.xlarge",
      BlockDeviceMappings: [
        { Ebs: { VolumeType: "io2", VolumeSize: 100, Encrypted: true } },
      ],
      AssociatePublicIpAddress: true,
    });

    expect(items).toHaveLength(4);
    expect(items.map((i) => i.label)).toEqual([
      "Compute",
      "Storage",
      "Public IPv4",
      "Data transfer out",
    ]);
  });

  it("skips storage line item when BlockDeviceMappings is empty array", () => {
    const items = ec2PricingDecomposer.decompose({
      BlockDeviceMappings: [],
    });

    const storage = items.find((i) => i.label === "Storage");
    expect(storage).toBeUndefined();
  });

  it("compute line item has extended timeout", () => {
    const items = ec2PricingDecomposer.decompose({});
    const compute = items.find((i) => i.label === "Compute")!;
    expect(compute.timeoutMs).toBe(8000);
  });
});
