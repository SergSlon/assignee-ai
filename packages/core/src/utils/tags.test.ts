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

  // ── ALTERNATE_TAG_KEY_TYPES — EFS FileSystemTags (2026-04-11 fix) ──
  //
  // EFS::FileSystem rejects `Tags` with `extraneous key [Tags] is not
  // permitted` because its CCAPI schema uses FileSystemTags. These tests
  // pin the alternate-key path that injectMandatoryTags takes for EFS.
  describe("AWS::EFS::FileSystem — alternate FileSystemTags key", () => {
    it("writes mandatory tags to FileSystemTags, not Tags", () => {
      const result = injectMandatoryTags(
        {
          Encrypted: true,
          ThroughputMode: "elastic",
        },
        runId,
        "AWS::EFS::FileSystem",
      );
      // FileSystemTags must be an array containing all 3 mandatory tags.
      const fsTags = result["FileSystemTags"] as CfnTag[];
      expect(Array.isArray(fsTags)).toBe(true);
      expect(findTag(fsTags, "managed-by")?.Value).toBe("assignee-ai");
      expect(findTag(fsTags, "assignee-run-id")?.Value).toBe(runId);
      expect(findTag(fsTags, "environment")?.Value).toBe("poc");
      // Top-level "Tags" must be completely absent — its presence would
      // trigger the CCAPI `extraneous key [Tags]` rejection that caused
      // the efs-with-vpc nightly failure.
      expect(result["Tags"]).toBeUndefined();
      expect("Tags" in result).toBe(false);
    });

    it("migrates a stray Tags array into FileSystemTags then deletes Tags", () => {
      const result = injectMandatoryTags(
        {
          Encrypted: true,
          Tags: [{ Key: "team", Value: "platform" }],
        },
        runId,
        "AWS::EFS::FileSystem",
      );
      const fsTags = result["FileSystemTags"] as CfnTag[];
      // User's "team" tag must be preserved via migration from Tags.
      expect(findTag(fsTags, "team")?.Value).toBe("platform");
      // Mandatory tags present alongside user tag.
      expect(findTag(fsTags, "managed-by")?.Value).toBe("assignee-ai");
      // Stray Tags key is stripped.
      expect(result["Tags"]).toBeUndefined();
    });

    it("merges existing FileSystemTags with mandatory — keeps user-entered Name tag", () => {
      const result = injectMandatoryTags(
        {
          Encrypted: true,
          // The EFS plugin's Name field writes directly to FileSystemTags
          // via `name: CfnKey.FILE_SYSTEM_TAGS`. This pre-existing tag
          // array must not be clobbered by the tag injection.
          FileSystemTags: [{ Key: "Name", Value: "shared-efs" }],
        },
        runId,
        "AWS::EFS::FileSystem",
      );
      const fsTags = result["FileSystemTags"] as CfnTag[];
      expect(findTag(fsTags, "Name")?.Value).toBe("shared-efs");
      expect(findTag(fsTags, "managed-by")?.Value).toBe("assignee-ai");
      expect(findTag(fsTags, "assignee-run-id")?.Value).toBe(runId);
    });

    it("merges both existing FileSystemTags AND stray Tags into a single deduped array", () => {
      const result = injectMandatoryTags(
        {
          Encrypted: true,
          FileSystemTags: [{ Key: "Name", Value: "hybrid-efs" }],
          Tags: [{ Key: "env", Value: "prod" }],
        },
        runId,
        "AWS::EFS::FileSystem",
      );
      const fsTags = result["FileSystemTags"] as CfnTag[];
      // Both inputs landed in FileSystemTags.
      expect(findTag(fsTags, "Name")?.Value).toBe("hybrid-efs");
      expect(findTag(fsTags, "env")?.Value).toBe("prod");
      // Mandatory tags also merged.
      expect(findTag(fsTags, "managed-by")?.Value).toBe("assignee-ai");
      // No duplicate entries for any key.
      const keys = fsTags.map((t) => t.Key);
      expect(new Set(keys).size).toBe(keys.length);
      // Stray Tags key stripped.
      expect(result["Tags"]).toBeUndefined();
    });

    it("mandatory tags overwrite user-supplied mandatory-key duplicates", () => {
      const result = injectMandatoryTags(
        {
          FileSystemTags: [
            { Key: "managed-by", Value: "someone-else" },
            { Key: "environment", Value: "staging" },
          ],
        },
        runId,
        "AWS::EFS::FileSystem",
      );
      const fsTags = result["FileSystemTags"] as CfnTag[];
      // Mandatory precedence — user's attempt to set managed-by is
      // overridden by the runtime's assignee-ai value.
      expect(findTag(fsTags, "managed-by")?.Value).toBe("assignee-ai");
      expect(findTag(fsTags, "environment")?.Value).toBe("poc");
    });
  });
});
