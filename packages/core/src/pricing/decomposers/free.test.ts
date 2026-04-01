import { describe, it, expect } from "vitest";
import {
  vpcPricingDecomposer,
  subnetPricingDecomposer,
  securityGroupPricingDecomposer,
  iamRolePricingDecomposer,
  internetGatewayPricingDecomposer,
  routeTablePricingDecomposer,
  routePricingDecomposer,
  ecsClusterPricingDecomposer,
} from "./free.js";

const freeDecomposers = [
  {
    name: "vpcPricingDecomposer",
    decomposer: vpcPricingDecomposer,
    resourceType: "AWS::EC2::VPC",
  },
  {
    name: "subnetPricingDecomposer",
    decomposer: subnetPricingDecomposer,
    resourceType: "AWS::EC2::Subnet",
  },
  {
    name: "securityGroupPricingDecomposer",
    decomposer: securityGroupPricingDecomposer,
    resourceType: "AWS::EC2::SecurityGroup",
  },
  {
    name: "iamRolePricingDecomposer",
    decomposer: iamRolePricingDecomposer,
    resourceType: "AWS::IAM::Role",
  },
  {
    name: "internetGatewayPricingDecomposer",
    decomposer: internetGatewayPricingDecomposer,
    resourceType: "AWS::EC2::InternetGateway",
  },
  {
    name: "routeTablePricingDecomposer",
    decomposer: routeTablePricingDecomposer,
    resourceType: "AWS::EC2::RouteTable",
  },
  {
    name: "routePricingDecomposer",
    decomposer: routePricingDecomposer,
    resourceType: "AWS::EC2::Route",
  },
  {
    name: "ecsClusterPricingDecomposer",
    decomposer: ecsClusterPricingDecomposer,
    resourceType: "AWS::ECS::Cluster",
  },
] as const;

describe("free pricing decomposers", () => {
  for (const { name, decomposer, resourceType } of freeDecomposers) {
    describe(name, () => {
      it(`has resourceType ${resourceType}`, () => {
        expect(decomposer.resourceType).toBe(resourceType);
      });

      it("returns empty array for {} desiredState", () => {
        expect(decomposer.decompose({})).toEqual([]);
      });

      it("returns empty array for desiredState with random properties", () => {
        expect(
          decomposer.decompose({
            Foo: "bar",
            Count: 42,
            Enabled: true,
          }),
        ).toEqual([]);
      });
    });
  }
});
