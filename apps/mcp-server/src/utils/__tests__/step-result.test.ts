import { describe, it, expect } from "vitest";
import {
  continueStep,
  continueVoid,
  doneStep,
  isContinue,
  isDone,
  type StepResult,
} from "../step-result.js";
import {
  buildErrorResponse,
  buildSuccessResponse,
  DESTROY_ERROR_CODES,
  type McpToolResponse,
} from "../../tools/destroy-resource/error-envelope.js";

describe("StepResult utility", () => {
  describe("continueStep", () => {
    it("returns a continue branch carrying the provided context", () => {
      const result = continueStep({ arn: "arn:aws:s3:::my-bucket" });
      expect(result.kind).toBe("continue");
      if (result.kind === "continue") {
        expect(result.context).toEqual({ arn: "arn:aws:s3:::my-bucket" });
      }
    });

    it("preserves primitive context values", () => {
      const result = continueStep(42);
      expect(result.kind).toBe("continue");
      if (result.kind === "continue") {
        expect(result.context).toBe(42);
      }
    });

    it("preserves complex object references", () => {
      const ctx = { region: "us-east-1", client: { send: () => null } };
      const result = continueStep(ctx);
      if (result.kind === "continue") {
        // Same reference — no copy
        expect(result.context).toBe(ctx);
      }
    });
  });

  describe("continueVoid", () => {
    it("returns a continue branch with undefined context", () => {
      const result = continueVoid();
      expect(result.kind).toBe("continue");
      if (result.kind === "continue") {
        expect(result.context).toBeUndefined();
      }
    });
  });

  describe("doneStep", () => {
    it("wraps an MCP error response in a done branch", () => {
      const response = buildErrorResponse("destroy refused");
      const result = doneStep(response);
      expect(result.kind).toBe("done");
      if (result.kind === "done") {
        expect(result.response).toBe(response);
        expect(result.response.isError).toBe(true);
      }
    });

    it("wraps an MCP success response in a done branch", () => {
      const response = buildSuccessResponse({
        status: "SUCCESS",
        message: "ok",
      });
      const result = doneStep(response);
      if (result.kind === "done") {
        expect(result.response).toBe(response);
        expect(result.response.isError).toBeUndefined();
      }
    });

    it("preserves structured error codes in the wrapped response", () => {
      const response = buildErrorResponse(
        "tag missing",
        "CloudTrail check needed",
        DESTROY_ERROR_CODES.TOCTOU_TAG_MISSING,
      );
      const result = doneStep(response);
      if (result.kind === "done") {
        const payload = JSON.parse(result.response.content[0].text) as {
          code: string;
          message: string;
          hint: string;
        };
        expect(payload.code).toBe(DESTROY_ERROR_CODES.TOCTOU_TAG_MISSING);
        expect(payload.message).toBe("tag missing");
        expect(payload.hint).toBe("CloudTrail check needed");
      }
    });
  });

  describe("isContinue / isDone type guards", () => {
    it("isContinue narrows to the continue branch", () => {
      const result: StepResult<string> = continueStep("hello");
      expect(isContinue(result)).toBe(true);
      expect(isDone(result)).toBe(false);
      if (isContinue(result)) {
        // Type-narrowing: compile-time check — .context is string.
        const ctx: string = result.context;
        expect(ctx).toBe("hello");
      }
    });

    it("isDone narrows to the done branch", () => {
      const response = buildErrorResponse("nope");
      const result: StepResult<string> = doneStep(response);
      expect(isDone(result)).toBe(true);
      expect(isContinue(result)).toBe(false);
      if (isDone(result)) {
        // Type-narrowing: compile-time check — .response is McpToolResponse.
        const r: McpToolResponse = result.response;
        expect(r).toBe(response);
      }
    });

    it("guards compose in a realistic pipeline shape", () => {
      function stepOne(): StepResult<number> {
        return continueStep(7);
      }
      function stepTwo(n: number): StepResult<string> {
        if (n < 0) return doneStep(buildErrorResponse("negative"));
        return continueStep(`value=${n}`);
      }

      const r1 = stepOne();
      if (isDone(r1)) throw new Error("stepOne should have continued");
      const r2 = stepTwo(r1.context);
      expect(isContinue(r2)).toBe(true);
      if (isContinue(r2)) {
        expect(r2.context).toBe("value=7");
      }
    });

    it("short-circuits on the first done in a pipeline", () => {
      const errorResp = buildErrorResponse("boom");
      function stepOne(): StepResult<number> {
        return doneStep(errorResp);
      }
      function stepTwo(_n: number): StepResult<string> {
        throw new Error("stepTwo must not run after a done step");
      }

      const r1 = stepOne();
      if (isContinue(r1)) {
        // stepTwo must NOT be invoked — the guard above protects that.
        stepTwo(r1.context);
      }
      expect(isDone(r1)).toBe(true);
      if (isDone(r1)) {
        expect(r1.response).toBe(errorResp);
      }
    });
  });

  describe("discriminated-union exhaustiveness", () => {
    it("covers all branches via switch(kind)", () => {
      function handle(r: StepResult<number>): string {
        switch (r.kind) {
          case "continue":
            return `continue:${r.context}`;
          case "done":
            return `done:${r.response.isError ? "err" : "ok"}`;
        }
      }
      expect(handle(continueStep(3))).toBe("continue:3");
      expect(handle(doneStep(buildErrorResponse("x")))).toBe("done:err");
      expect(handle(doneStep(buildSuccessResponse({ ok: true })))).toBe(
        "done:ok",
      );
    });
  });
});
