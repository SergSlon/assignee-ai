import { describe, it, expect } from "vitest";
import { injectMandatoryTags, type CfnTag } from "./tags.js";

function getTags(result: Record<string, unknown>): CfnTag[] {
  return result["Tags"] as CfnTag[];
}

function findTag(tags: CfnTag[], key: string): CfnTag | undefined {
  return tags.find((t) => t.Key === key);
}

describe("injectMandatoryTags", () => {
  const runId = "test-run-id-123";

  describe("AWS::SSM::Parameter — flat map format", () => {
    it("produces Tags as flat { key: value } map", () => {
      const result = injectMandatoryTags(
        { Name: "/poc/test/greeting", Value: "hello", Type: "String" },
        runId,
        "AWS::SSM::Parameter",
      );
      const tags = result["Tags"] as Record<string, string>;
      expect(Array.isArray(tags)).toBe(false);
      expect(tags["managed-by"]).toBe("assignee-ai");
      expect(tags["assignee-run-id"]).toBe(runId);
      expect(tags["environment"]).toBe("poc");
    });

    it("merges existing flat map tags, mandatory overwrite duplicates", () => {
      const result = injectMandatoryTags(
        { Name: "/x", Tags: { team: "platform", environment: "staging" } },
        runId,
        "AWS::SSM::Parameter",
      );
      const tags = result["Tags"] as Record<string, string>;
      expect(tags["team"]).toBe("platform");
      expect(tags["environment"]).toBe("poc"); // mandatory overwrites
    });
  });

  it("adds all 3 mandatory tags in [{Key, Value}] CloudFormation format", () => {
    const result = injectMandatoryTags({ BucketName: "my-bucket" }, runId);
    const tags = getTags(result);
    expect(findTag(tags, "managed-by")?.Value).toBe("assignee-ai");
    expect(findTag(tags, "assignee-run-id")?.Value).toBe(runId);
    expect(findTag(tags, "environment")?.Value).toBe("poc");
  });

  it("preserves custom user tags that are not mandatory", () => {
    const result = injectMandatoryTags(
      { Tags: [{ Key: "team", Value: "platform" }] },
      runId,
    );
    const tags = getTags(result);
    expect(findTag(tags, "team")?.Value).toBe("platform");
  });

  it("mandatory tags overwrite user-supplied tags with the same Key (no duplicates)", () => {
    const result = injectMandatoryTags(
      {
        Tags: [
          { Key: "environment", Value: "staging" },
          { Key: "managed-by", Value: "other" },
        ],
      },
      runId,
    );
    const tags = getTags(result);
    const envTags = tags.filter((t) => t.Key === "environment");
    expect(envTags).toHaveLength(1);
    expect(envTags[0]!.Value).toBe("poc");
    expect(findTag(tags, "managed-by")?.Value).toBe("assignee-ai");
  });

  it("produces correct format when no existing Tags in desiredState", () => {
    const result = injectMandatoryTags({ BucketName: "x" }, runId);
    const tags = getTags(result);
    expect(Array.isArray(tags)).toBe(true);
    expect(tags.every((t) => "Key" in t && "Value" in t)).toBe(true);
  });

  it("does not mutate the input desiredState", () => {
    const input = {
      BucketName: "immutable",
      Tags: [{ Key: "Environment", Value: "production" }],
    };
    injectMandatoryTags(input, runId);
    expect((input.Tags as CfnTag[]).length).toBe(1);
    expect(input.Tags[0]).toEqual({ Key: "Environment", Value: "production" });
  });

  it("preserves non-Tags fields in desiredState", () => {
    const result = injectMandatoryTags(
      { BucketName: "keep-me", AccessControl: "Private" },
      runId,
    );
    expect(result["BucketName"]).toBe("keep-me");
    expect(result["AccessControl"]).toBe("Private");
  });
});
