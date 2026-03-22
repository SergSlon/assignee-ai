import { describe, it, expect } from "vitest";
import { ec2InstancePlugin } from "./ec2-instance.js";

describe("ec2InstancePlugin", () => {
  it("has the correct resourceType", () => {
    expect(ec2InstancePlugin.resourceType).toBe("AWS::EC2::Instance");
  });

  it("commonFields count is ≤10 (AC-6)", () => {
    expect(ec2InstancePlugin.commonFields.length).toBeLessThanOrEqual(10);
  });

  it("commonFields count is 6", () => {
    expect(ec2InstancePlugin.commonFields.length).toBe(6);
  });

  it("all commonField question types are valid QuestionType values", () => {
    const validTypes = new Set(["boolean", "enum", "string", "multi"]);
    for (const field of ec2InstancePlugin.commonFields) {
      expect(validTypes.has(field.question.type)).toBe(true);
    }
  });

  it("InstanceType is enum with t3.micro default and multiple options", () => {
    const field = ec2InstancePlugin.commonFields.find(
      (f) => f.name === "InstanceType",
    );
    expect(field).toBeDefined();
    expect(field?.question.type).toBe("enum");
    expect(field?.question.initialValue).toBe("t3.micro");
    expect(field?.question.options?.length).toBeGreaterThan(0);
    const values = field?.question.options?.map((o) => o.value) ?? [];
    expect(values).toContain("t3.micro");
  });

  it("ImageId is a dynamic enum field with fetcher", () => {
    const field = ec2InstancePlugin.commonFields.find(
      (f) => f.name === "ImageId",
    );
    expect(field).toBeDefined();
    expect(field?.question.type).toBe("enum");
    expect(field?.question.fetcher).toBe("discover-amis");
  });

  it("KeyName is a dynamic enum field with fetcher", () => {
    const field = ec2InstancePlugin.commonFields.find(
      (f) => f.name === "KeyName",
    );
    expect(field).toBeDefined();
    expect(field?.question.type).toBe("enum");
    expect(field?.question.fetcher).toBe("discover-key-pairs");
  });

  it("SecurityGroupIds is a multi field", () => {
    const field = ec2InstancePlugin.commonFields.find(
      (f) => f.name === "SecurityGroupIds",
    );
    expect(field).toBeDefined();
    expect(field?.question.type).toBe("multi");
  });

  it("Tags field is multi type", () => {
    const field = ec2InstancePlugin.commonFields.find((f) => f.name === "Tags");
    expect(field).toBeDefined();
    expect(field?.question.type).toBe("multi");
  });

  it("advancedFields contains IamInstanceProfile and UserData", () => {
    const names = ec2InstancePlugin.advancedFields.map((f) => f.name);
    expect(names).toContain("IamInstanceProfile");
    expect(names).toContain("UserData");
  });

  it("defaults is empty object", () => {
    expect(ec2InstancePlugin.defaults).toEqual({});
  });
});
