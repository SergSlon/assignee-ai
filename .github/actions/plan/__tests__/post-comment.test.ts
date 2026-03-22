import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Import the module under test ────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-require-imports
const {
  formatPlanComment,
  findExistingComment,
  COMMENT_MARKER,
} = require("../post-comment.js");

// ── Tests ───────────────────────────────────────────────────────────────────

describe("Plan post-comment", () => {
  describe("formatPlanComment", () => {
    it("includes the HTML marker for deduplication", () => {
      const result = formatPlanComment("");
      expect(result).toContain(COMMENT_MARKER);
    });

    it("produces informative message when plan JSON is empty", () => {
      const result = formatPlanComment("");
      expect(result).toContain("No plan output was generated");
      expect(result).toContain(COMMENT_MARKER);
    });

    it("produces informative message when plan JSON is null", () => {
      const result = formatPlanComment(null);
      expect(result).toContain("No plan output was generated");
    });

    it("handles unparseable JSON gracefully", () => {
      const result = formatPlanComment("not valid json {{{");
      expect(result).toContain("Error");
      expect(result).toContain("Could not parse plan output");
      expect(result).toContain("not valid json {{{");
      expect(result).toContain(COMMENT_MARKER);
    });

    it("formats resources into a Markdown table", () => {
      const plan = {
        resources: [
          {
            resourceType: "AWS::S3::Bucket",
            action: "CREATE",
            details: "my-bucket",
          },
          {
            resourceType: "AWS::Lambda::Function",
            action: "CREATE",
            details: "my-func",
          },
        ],
      };
      const result = formatPlanComment(JSON.stringify(plan));

      expect(result).toContain("### Resources");
      expect(result).toContain("| Resource Type | Action | Details |");
      expect(result).toContain("`AWS::S3::Bucket`");
      expect(result).toContain("`AWS::Lambda::Function`");
      expect(result).toContain("my-bucket");
      expect(result).toContain("my-func");
    });

    it("formats desiredState as resources when resources key is absent", () => {
      const plan = {
        desiredState: [
          {
            type: "AWS::S3::Bucket",
            action: "CREATE",
            identifier: "test-bucket",
          },
        ],
      };
      const result = formatPlanComment(JSON.stringify(plan));

      expect(result).toContain("### Resources");
      expect(result).toContain("`AWS::S3::Bucket`");
    });

    it("formats cost estimate section", () => {
      const plan = {
        resources: [],
        costEstimate: { monthly: "$3.50/mo", freeTier: true },
      };
      const result = formatPlanComment(JSON.stringify(plan));

      expect(result).toContain("### Cost Estimate");
      expect(result).toContain("$3.50/mo");
      expect(result).toContain("Eligible");
    });

    it("formats cost as a simple string", () => {
      const plan = {
        resources: [],
        cost: "$0.00/mo (Free Tier)",
      };
      const result = formatPlanComment(JSON.stringify(plan));

      expect(result).toContain("### Cost Estimate");
      expect(result).toContain("$0.00/mo (Free Tier)");
    });

    it("formats best practice findings with severity icons", () => {
      const plan = {
        resources: [],
        bestPractices: [
          {
            ruleId: "S3-001",
            severity: "critical",
            message: "Enable versioning",
          },
          { ruleId: "S3-002", severity: "medium", message: "Enable logging" },
        ],
      };
      const result = formatPlanComment(JSON.stringify(plan));

      expect(result).toContain("### Best Practice Findings");
      expect(result).toContain("S3-001");
      expect(result).toContain("Enable versioning");
      expect(result).toContain("S3-002");
      expect(result).toContain("Enable logging");
    });

    it("formats diff section when present", () => {
      const plan = {
        resources: [],
        diff: "+ BucketName: my-bucket\n+ VersioningEnabled: true",
      };
      const result = formatPlanComment(JSON.stringify(plan));

      expect(result).toContain("### Changes");
      expect(result).toContain("```diff");
      expect(result).toContain("BucketName: my-bucket");
    });

    it("includes the assignee.ai attribution footer", () => {
      const result = formatPlanComment(JSON.stringify({ resources: [] }));
      expect(result).toContain("assignee.ai");
      expect(result).toContain("GitHub Action");
    });
  });

  describe("findExistingComment", () => {
    let mockGithub: {
      rest: {
        issues: {
          listComments: ReturnType<typeof vi.fn>;
        };
      };
    };
    const mockContext = {
      repo: { owner: "test-owner", repo: "test-repo" },
      issue: { number: 42 },
    };

    beforeEach(() => {
      mockGithub = {
        rest: {
          issues: {
            listComments: vi.fn(),
          },
        },
      };
    });

    it("returns existing comment when marker is found", async () => {
      const existingComment = {
        id: 123,
        body: `${COMMENT_MARKER}\n## Assignee Plan\nold content`,
      };
      mockGithub.rest.issues.listComments.mockResolvedValue({
        data: [
          { id: 100, body: "Some other comment" },
          existingComment,
          { id: 200, body: "Another comment" },
        ],
      });

      const result = await findExistingComment(mockGithub, mockContext);
      expect(result).toEqual(existingComment);
      expect(result!.id).toBe(123);
    });

    it("returns null when no marker comment exists", async () => {
      mockGithub.rest.issues.listComments.mockResolvedValue({
        data: [
          { id: 100, body: "Some other comment" },
          { id: 200, body: "Another comment" },
        ],
      });

      const result = await findExistingComment(mockGithub, mockContext);
      expect(result).toBeNull();
    });

    it("returns null when comment list is empty", async () => {
      mockGithub.rest.issues.listComments.mockResolvedValue({ data: [] });

      const result = await findExistingComment(mockGithub, mockContext);
      expect(result).toBeNull();
    });
  });
});
