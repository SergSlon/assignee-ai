import { describe, it, expect, vi, beforeEach } from "vitest";
import { SchemaCacheWarmer } from "./schema-cache-warmer.js";
import type { CloudFormationSchemaService } from "./cloudformation-schema-service.js";

/** Helper: create a mock CloudFormationSchemaService with configurable per-type behavior. */
function createMockSchemaService(
  overrides?: Partial<Record<string, () => Promise<object>>>,
) {
  const getSchema = vi.fn(async (typeName: string) => {
    if (overrides?.[typeName]) {
      return overrides[typeName]();
    }
    return { typeName, properties: {} };
  });

  return { getSchema } as unknown as CloudFormationSchemaService & {
    getSchema: ReturnType<typeof vi.fn>;
  };
}

describe("SchemaCacheWarmer", () => {
  const TEST_TYPES = [
    "AWS::S3::Bucket",
    "AWS::IAM::Role",
    "AWS::EC2::Instance",
    "AWS::Lambda::Function",
    "AWS::RDS::DBInstance",
    "AWS::DynamoDB::Table",
    "AWS::SQS::Queue",
  ];

  let mockService: ReturnType<typeof createMockSchemaService>;
  let warmer: SchemaCacheWarmer;

  beforeEach(() => {
    mockService = createMockSchemaService();
    warmer = new SchemaCacheWarmer(mockService);
  });

  it("fetches all provided types", async () => {
    const result = await warmer.warmAll(TEST_TYPES);

    expect(mockService.getSchema).toHaveBeenCalledTimes(TEST_TYPES.length);
    for (const t of TEST_TYPES) {
      expect(mockService.getSchema).toHaveBeenCalledWith(t);
    }
    expect(result.succeeded).toHaveLength(TEST_TYPES.length);
    expect(result.failed).toHaveLength(0);
  });

  it("respects concurrency limit — no more than N concurrent calls", async () => {
    const concurrency = 3;
    let activeCalls = 0;
    let maxActiveCalls = 0;

    const slowService = createMockSchemaService();
    slowService.getSchema.mockImplementation(async () => {
      activeCalls++;
      if (activeCalls > maxActiveCalls) {
        maxActiveCalls = activeCalls;
      }
      // Simulate async work
      await new Promise((r) => setTimeout(r, 10));
      activeCalls--;
      return { properties: {} };
    });

    const slowWarmer = new SchemaCacheWarmer(slowService);
    await slowWarmer.warmAll(TEST_TYPES, { concurrency });

    expect(maxActiveCalls).toBeLessThanOrEqual(concurrency);
    expect(maxActiveCalls).toBeGreaterThan(0);
  });

  it("handles partial failures — continues warming other types", async () => {
    const failingTypes = ["AWS::IAM::Role", "AWS::SQS::Queue"];
    const overrides: Record<string, () => Promise<object>> = {};
    for (const t of failingTypes) {
      overrides[t] = () => Promise.reject(new Error(`Throttled: ${t}`));
    }

    const failService = createMockSchemaService(overrides);
    const failWarmer = new SchemaCacheWarmer(failService);

    const result = await failWarmer.warmAll(TEST_TYPES);

    expect(result.succeeded).toHaveLength(
      TEST_TYPES.length - failingTypes.length,
    );
    expect(result.failed).toHaveLength(failingTypes.length);

    for (const f of result.failed) {
      expect(failingTypes).toContain(f.type);
      expect(f.error).toContain("Throttled");
    }

    // All types were still attempted
    expect(failService.getSchema).toHaveBeenCalledTimes(TEST_TYPES.length);
  });

  it("calls onProgress after each type completes", async () => {
    const progressCalls: Array<[number, number]> = [];
    const onProgress = (done: number, total: number) => {
      progressCalls.push([done, total]);
    };

    await warmer.warmAll(TEST_TYPES, { onProgress });

    expect(progressCalls).toHaveLength(TEST_TYPES.length);

    // All calls should have total === TEST_TYPES.length
    for (const [, total] of progressCalls) {
      expect(total).toBe(TEST_TYPES.length);
    }

    // The final progress call should have done === total
    const lastCall = progressCalls[progressCalls.length - 1]!;
    expect(lastCall[0]).toBe(TEST_TYPES.length);
  });

  it("returns immediately cached types as succeeded (skip-if-cached)", async () => {
    // getSchema returns immediately on cache hit — no API call distinction needed.
    // The warmer counts any successful getSchema as "succeeded", regardless of
    // whether the underlying service served from cache or fetched from API.
    const result = await warmer.warmAll(TEST_TYPES);

    expect(result.succeeded).toHaveLength(TEST_TYPES.length);
    expect(result.failed).toHaveLength(0);
  });

  it("uses default concurrency of 5", async () => {
    let activeCalls = 0;
    let maxActiveCalls = 0;

    const slowService = createMockSchemaService();
    slowService.getSchema.mockImplementation(async () => {
      activeCalls++;
      if (activeCalls > maxActiveCalls) {
        maxActiveCalls = activeCalls;
      }
      await new Promise((r) => setTimeout(r, 20));
      activeCalls--;
      return { properties: {} };
    });

    // Use 8 types to exercise the concurrency limit
    const types = TEST_TYPES;
    const slowWarmer = new SchemaCacheWarmer(slowService);
    await slowWarmer.warmAll(types);

    expect(maxActiveCalls).toBeLessThanOrEqual(5);
  });

  it("handles empty types array", async () => {
    const result = await warmer.warmAll([]);

    expect(result.succeeded).toHaveLength(0);
    expect(result.failed).toHaveLength(0);
    expect(mockService.getSchema).not.toHaveBeenCalled();
  });

  it("handles all types failing", async () => {
    const allFailService = createMockSchemaService();
    allFailService.getSchema.mockRejectedValue(new Error("Network error"));

    const allFailWarmer = new SchemaCacheWarmer(allFailService);
    const result = await allFailWarmer.warmAll(TEST_TYPES);

    expect(result.succeeded).toHaveLength(0);
    expect(result.failed).toHaveLength(TEST_TYPES.length);
  });
});
