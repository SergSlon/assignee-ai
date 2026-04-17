import { describe, it, expect } from "vitest";
import { z } from "zod";
import { MockLlmAdapter } from "./mock-llm-adapter.js";
import { LlmError } from "../errors.js";

describe("MockLlmAdapter", () => {
  describe("generateStructured", () => {
    it("returns the structured response on success", async () => {
      const data = { resourceType: "AWS::S3::Bucket" };
      const mock = new MockLlmAdapter(data);
      const schema = z.object({ resourceType: z.string() });
      const [err, result] = await mock.generateStructured("test", schema);
      expect(err).toBeNull();
      expect(result).toEqual(data);
    });

    it("returns LlmError when shouldFail is true", async () => {
      const mock = new MockLlmAdapter(undefined, "", true, "boom");
      const schema = z.string();
      const [err, result] = await mock.generateStructured("test", schema);
      expect(err).toBeInstanceOf(LlmError);
      expect(err!.message).toBe("boom");
      expect(result).toBeNull();
    });
  });

  describe("generateText", () => {
    it("returns the text response on success", async () => {
      const mock = new MockLlmAdapter(undefined, "hello world");
      const [err, result] = await mock.generateText("test");
      expect(err).toBeNull();
      expect(result).toBe("hello world");
    });

    it("returns empty string by default", async () => {
      const mock = new MockLlmAdapter();
      const [err, result] = await mock.generateText("test");
      expect(err).toBeNull();
      expect(result).toBe("");
    });

    it("returns LlmError when shouldFail is true", async () => {
      const mock = new MockLlmAdapter(undefined, "", true);
      const [err, result] = await mock.generateText("test");
      expect(err).toBeInstanceOf(LlmError);
      expect(err!.message).toBe("Mock LLM failure");
      expect(result).toBeNull();
    });
  });
});
