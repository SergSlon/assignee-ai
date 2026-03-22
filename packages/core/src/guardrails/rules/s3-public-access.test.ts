import { describe, it, expect } from "vitest";
import { s3PublicAccessRule } from "./s3-public-access.js";

describe("s3PublicAccessRule — Story 18.9 boolean/object dual-format", () => {
  const evaluate = (desiredState: Record<string, unknown>) =>
    s3PublicAccessRule.evaluate("AWS::S3::Bucket", desiredState);

  it("returns null (no finding) when PublicAccessBlockConfiguration is boolean true", () => {
    expect(evaluate({ PublicAccessBlockConfiguration: true })).toBeNull();
  });

  it("returns critical finding when PublicAccessBlockConfiguration is boolean false", () => {
    const result = evaluate({ PublicAccessBlockConfiguration: false });
    expect(result).not.toBeNull();
    expect(result!.severity).toBe("critical");
    expect(result!.message).toContain("set to false");
  });

  it("returns null when PublicAccessBlockConfiguration is a proper object with all fields true", () => {
    expect(
      evaluate({
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          BlockPublicPolicy: true,
          IgnorePublicAcls: true,
          RestrictPublicBuckets: true,
        },
      }),
    ).toBeNull();
  });

  it("returns critical finding when PublicAccessBlockConfiguration object has some fields false", () => {
    const result = evaluate({
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: false,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
    expect(result).not.toBeNull();
    expect(result!.severity).toBe("critical");
    expect(result!.message).toContain("BlockPublicPolicy");
  });

  it("returns critical finding when PublicAccessBlockConfiguration is missing", () => {
    const result = evaluate({});
    expect(result).not.toBeNull();
    expect(result!.severity).toBe("critical");
    expect(result!.message).toContain("missing");
  });
});
