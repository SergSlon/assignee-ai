import { describe, it, expect } from "vitest";
import { securityGroupPlugin } from "./security-group.js";

describe("securityGroupPlugin", () => {
  it("has the correct resourceType", () => {
    expect(securityGroupPlugin.resourceType).toBe("AWS::EC2::SecurityGroup");
  });

  it("commonFields count is ≤10", () => {
    expect(securityGroupPlugin.commonFields.length).toBeLessThanOrEqual(10);
  });

  it("commonFields count is 3", () => {
    expect(securityGroupPlugin.commonFields.length).toBe(3);
  });

  it("GroupDescription is required", () => {
    const field = securityGroupPlugin.commonFields.find(
      (f) => f.name === "GroupDescription",
    );
    expect(field).toBeDefined();
    expect(field?.required).toBe(true);
    expect(field?.question.type).toBe("string");
  });

  it("VpcId is an enum with discover-vpcs fetcher", () => {
    const field = securityGroupPlugin.commonFields.find(
      (f) => f.name === "VpcId",
    );
    expect(field).toBeDefined();
    expect(field?.question.type).toBe("enum");
    expect(field?.question.fetcher).toBe("discover-vpcs");
  });

  it("Tags field has toCfn transform", () => {
    const field = securityGroupPlugin.commonFields.find(
      (f) => f.name === "Tags",
    );
    expect(field).toBeDefined();
    expect(field?.toCfn).toBeDefined();
  });

  describe("Tags toCfn transform", () => {
    const field = securityGroupPlugin.commonFields.find(
      (f) => f.name === "Tags",
    )!;

    it("converts comma-separated Key:Value pairs", () => {
      expect(field.toCfn!("env:prod, team:backend")).toEqual([
        { Key: "env", Value: "prod" },
        { Key: "team", Value: "backend" },
      ]);
    });

    it("returns undefined for empty string", () => {
      expect(field.toCfn!("")).toBeUndefined();
    });
  });

  it("advancedFields contains ingress and egress rules", () => {
    const names = securityGroupPlugin.advancedFields.map((f) => f.name);
    expect(names).toContain("SecurityGroupIngress");
    expect(names).toContain("SecurityGroupEgress");
  });

  describe("IngressRules toCfn transform", () => {
    const field = securityGroupPlugin.advancedFields.find(
      (f) => f.name === "SecurityGroupIngress",
    )!;

    it("parses protocol:port:cidr format", () => {
      expect(field.toCfn!("tcp:443:0.0.0.0/0")).toEqual([
        { IpProtocol: "tcp", FromPort: 443, ToPort: 443, CidrIp: "0.0.0.0/0" },
      ]);
    });

    it("parses port range", () => {
      expect(field.toCfn!("tcp:1024-65535:10.0.0.0/8")).toEqual([
        {
          IpProtocol: "tcp",
          FromPort: 1024,
          ToPort: 65535,
          CidrIp: "10.0.0.0/8",
        },
      ]);
    });

    it("parses all traffic rule", () => {
      expect(field.toCfn!("all:-1:0.0.0.0/0")).toEqual([
        { IpProtocol: "-1", CidrIp: "0.0.0.0/0" },
      ]);
    });

    it("parses multiple comma-separated rules", () => {
      const result = field.toCfn!("tcp:443:0.0.0.0/0, tcp:22:10.0.0.0/8");
      expect(result).toHaveLength(2);
    });

    it("returns undefined for empty string", () => {
      expect(field.toCfn!("")).toBeUndefined();
    });
  });

  it("defaults include HTTPS from anywhere and all egress (no SSH)", () => {
    expect(securityGroupPlugin.defaults).toEqual({
      SecurityGroupIngress: [
        { IpProtocol: "tcp", FromPort: 443, ToPort: 443, CidrIp: "0.0.0.0/0" },
      ],
      SecurityGroupEgress: [{ IpProtocol: "-1", CidrIp: "0.0.0.0/0" }],
    });
  });

  it("has configHints", () => {
    expect(securityGroupPlugin.configHints).toBeDefined();
    expect(securityGroupPlugin.configHints!.length).toBeGreaterThan(0);
  });
});
