import { describe, it, expect } from "vitest";
import { sqsPricingStrategy } from "./sqs.js";

describe("sqsPricingStrategy", () => {
  describe("estimateLocal", () => {
    // Tier S #1: pre-fix the destroy summary always said
    // "Per-request pricing (standard queue) saved" even when a FIFO queue
    // was being destroyed (observed in 2026-04-08 live smoke). The label
    // now reflects the actual queue type from FifoQueue.
    it("returns 'standard queue' label when FifoQueue is unset", () => {
      const desiredState = {
        QueueName: "my-standard-queue",
      };
      const result = sqsPricingStrategy.estimateLocal(desiredState);
      expect(result.label).toBe("Per-request pricing (standard queue)");
      expect(result.perMonth).toBeNull();
    });

    it("returns 'standard queue' label when FifoQueue is explicitly false", () => {
      const desiredState = {
        QueueName: "my-standard-queue",
        FifoQueue: false,
      };
      const result = sqsPricingStrategy.estimateLocal(desiredState);
      expect(result.label).toBe("Per-request pricing (standard queue)");
    });

    it("returns 'FIFO queue' label when FifoQueue is true (Tier S #1 fix)", () => {
      // The exact shape produced by the plan generator for FIFO queues
      const desiredState = {
        QueueName: "order-processing.fifo",
        FifoQueue: true,
      };
      const result = sqsPricingStrategy.estimateLocal(desiredState);
      expect(result.label).toBe("Per-request pricing (FIFO queue)");
      expect(result.perMonth).toBeNull();
    });

    it("falls back to 'standard queue' when desiredState is undefined", () => {
      // Backwards-compatible: existing callers that pass nothing still work
      const result = sqsPricingStrategy.estimateLocal();
      expect(result.label).toBe("Per-request pricing (standard queue)");
    });

    it("falls back to 'standard queue' when FifoQueue is a non-boolean truthy value", () => {
      // The strict `=== true` check guards against the LLM emitting "true"
      // (string) which AWS treats as false in CFN
      const desiredState = {
        QueueName: "my-queue",
        FifoQueue: "true" as unknown as boolean,
      };
      const result = sqsPricingStrategy.estimateLocal(desiredState);
      expect(result.label).toBe("Per-request pricing (standard queue)");
    });
  });

  describe("mcpConfig", () => {
    it("returns SQS service code with queue product family filter", () => {
      // mcpConfig is optional in the PricingStrategy interface; assert
      // it's actually a callable function rather than just defined.
      expect(typeof sqsPricingStrategy.mcpConfig).toBe("function");
      const config = sqsPricingStrategy.mcpConfig!();
      expect(config).not.toBeNull();
      expect(config!.serviceCode).toBe("AmazonSQS");
      expect(config!.filters).toContainEqual({
        Field: "productFamily",
        Value: "Queue",
        Type: "TERM_MATCH",
      });
    });
  });
});
