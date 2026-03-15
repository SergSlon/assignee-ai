import { describe, it, expect } from "vitest";
import { injectMandatoryTags } from "./tags.js";

describe("injectMandatoryTags", () => {
  const runId = "test-run-id-123";

  it("injects all 3 mandatory tags", () => {
    const result = injectMandatoryTags({}, runId);
    expect(result["managed-by"]).toBe("assignee-ai");
    expect(result["assignee-run-id"]).toBe(runId);
    expect(result["environment"]).toBe("poc");
  });

  it("preserves custom user tags", () => {
    const result = injectMandatoryTags(
      { project: "my-project", team: "platform" },
      runId,
    );
    expect(result["project"]).toBe("my-project");
    expect(result["team"]).toBe("platform");
  });

  it("mandatory tags overwrite user-supplied keys with the same name", () => {
    const result = injectMandatoryTags(
      { "managed-by": "someone-else", environment: "prod" },
      runId,
    );
    expect(result["managed-by"]).toBe("assignee-ai");
    expect(result["environment"]).toBe("poc");
  });

  it("does not mutate the input object", () => {
    const input = { foo: "bar" };
    injectMandatoryTags(input, runId);
    expect(input).toEqual({ foo: "bar" });
  });
});
