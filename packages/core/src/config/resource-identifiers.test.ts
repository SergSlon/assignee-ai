import { describe, it, expect } from "vitest";
import {
  RESOURCE_IDENTIFIER_KEYS,
  getPrimaryIdentifier,
} from "./resource-identifiers.js";
import { RESOURCE_TYPES } from "./resource-types.js";

describe("RESOURCE_IDENTIFIER_KEYS", () => {
  it("maps S3_BUCKET to BucketName", () => {
    expect(RESOURCE_IDENTIFIER_KEYS[RESOURCE_TYPES.S3_BUCKET]).toBe(
      "BucketName",
    );
  });

  it("maps EC2_INSTANCE to InstanceId", () => {
    expect(RESOURCE_IDENTIFIER_KEYS[RESOURCE_TYPES.EC2_INSTANCE]).toBe(
      "InstanceId",
    );
  });

  it("maps RDS_DB_INSTANCE to DBInstanceIdentifier", () => {
    expect(RESOURCE_IDENTIFIER_KEYS[RESOURCE_TYPES.RDS_DB_INSTANCE]).toBe(
      "DBInstanceIdentifier",
    );
  });
});

describe("getPrimaryIdentifier", () => {
  it("extracts identifier value from desiredState", () => {
    const result = getPrimaryIdentifier(RESOURCE_TYPES.S3_BUCKET, {
      BucketName: "my-bucket",
    });
    expect(result).toBe("my-bucket");
  });

  it("returns undefined when key is missing from desiredState", () => {
    const result = getPrimaryIdentifier(RESOURCE_TYPES.S3_BUCKET, {
      OtherProp: "value",
    });
    expect(result).toBeUndefined();
  });

  it("returns undefined when value is not a string", () => {
    const result = getPrimaryIdentifier(RESOURCE_TYPES.S3_BUCKET, {
      BucketName: 12345,
    });
    expect(result).toBeUndefined();
  });

  it("returns undefined for an unknown resource type", () => {
    const result = getPrimaryIdentifier("AWS::Unknown::Type" as any, {
      Name: "test",
    });
    expect(result).toBeUndefined();
  });

  it("works for LAMBDA_FUNCTION with FunctionName", () => {
    const result = getPrimaryIdentifier(RESOURCE_TYPES.LAMBDA_FUNCTION, {
      FunctionName: "my-fn",
    });
    expect(result).toBe("my-fn");
  });
});
