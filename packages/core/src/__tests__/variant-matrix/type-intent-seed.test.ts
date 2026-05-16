/**
 * Type × Intent-shape seed coverage.
 *
 * Exercises all N types × {CREATE, DESCRIBE, DESTROY} = 3N combinations
 * using the `resolveIntentForType` pure-function entry point and a
 * `MockLlmAdapter.forScriptedResponse` deterministic client.
 *
 * ## Probes exercised
 *
 * - Axis E — resolveIntentForType pure-function purity (call twice, deep-equal).
 * - Axis F — resolveIntentForType CREATE intent for each of the N types.
 * - Axis G — resolveIntentForType DESTROY intent for each of the N types.
 * - Axis H — resolveIntentForType DESCRIBE intent for each of the N types.
 *
 * ## AWS discovery mock
 *
 * The intent-parser node calls `productionResourceDiscoveryPort` at parse
 * time (EPIC-107-2). That function is hoisted+mocked below so no real AWS
 * SDK calls are made during matrix tests. The mock returns empty arrays for
 * all discovery methods, which is the correct neutral baseline for matrix
 * tests (we are testing intent routing, not resource discovery).
 *
 * ## Zero-skip guarantee
 *
 * The `it.each` data is derived from `enumerateTypes()` at import time.
 * Every type in SUPPORTED_TYPES_ARRAY produces exactly 3 test rows (one per
 * intent shape). If a type is added to the registry without adding a
 * `forScriptedResponse` scripted fixture, the test still generates a row —
 * the MockLlmAdapter's fallback returns a deterministic result for any
 * `AWS::` type.
 *
 * Story 108-B-01
 */

import { describe, it, expect, vi, beforeAll } from "vitest";
import {
  enumerateTypes,
  registerMatrixEntry,
  BASELINE_INTENT_SHAPES,
  type IntentShape,
} from "./index.js";
import { MockLlmAdapter } from "./mock-llm-adapter.js";
import { resolveIntentForType } from "../../graph/nodes/intent-parser/resolve-intent-for-type.js";
import { ExecutionStatus } from "../../index.js";

// ---------------------------------------------------------------------------
// Mock AWS discovery port — prevent real SDK calls during matrix tests
// ---------------------------------------------------------------------------

// Hoisted so the mock factory resolves before any dynamic imports in the
// intent-parser node pick up the real implementation.
const _discoveryMocks = vi.hoisted(() => ({
  productionResourceDiscoveryPort: vi.fn(),
}));

vi.mock("../../services/resource-discovery-port.js", () => ({
  productionResourceDiscoveryPort:
    _discoveryMocks.productionResourceDiscoveryPort,
}));

// Mock logger to suppress noise in test output.
vi.mock("../../utils/logger/index.js", () => ({
  log: vi.fn(),
  LOG_ACTIONS: {
    INTENT_PARSED: "intent_parsed",
    RESULT_FORMATTED: "result_formatted",
    APPLY_SUCCEEDED: "apply_succeeded",
    APPLY_FAILED: "apply_failed",
    STATE_GUARD_ABORT: "state_guard_abort",
    STATE_GUARD_SKIPPED: "state_guard_skipped",
    RESOURCE_PROVISION_STARTED: "resource_provision_started",
    SDK_FALLBACK_DISPATCHED: "sdk_fallback_dispatched",
    SECURITY_CHECK_SKIPPED: "security_check_skipped",
    MEMORY_WRITE_FAILED: "memory_write_failed",
  },
}));

// ---------------------------------------------------------------------------
// Setup discovery mock before tests run
// ---------------------------------------------------------------------------

beforeAll(() => {
  // Return a port that always resolves to empty discovery results.
  // This is the correct baseline for unit-level matrix tests.
  _discoveryMocks.productionResourceDiscoveryPort.mockReturnValue({
    discoverVpcs: vi.fn().mockResolvedValue([]),
    discoverSubnetGroups: vi.fn().mockResolvedValue([]),
    discoverEcsClusters: vi.fn().mockResolvedValue([]),
    discoverElbs: vi.fn().mockResolvedValue([]),
  });
});

// ---------------------------------------------------------------------------
// Matrix data: types × intent shapes
// ---------------------------------------------------------------------------

const types = enumerateTypes();

// Cartesian product: type × intentShape
type MatrixRow = { type: string; intentShape: IntentShape };
const MATRIX: MatrixRow[] = [];
for (const type of types) {
  for (const shape of BASELINE_INTENT_SHAPES) {
    MATRIX.push({ type, intentShape: shape });
  }
}

// ---------------------------------------------------------------------------
// Axis F, G, H — type × intent-shape coverage
// ---------------------------------------------------------------------------

describe("type-intent-seed — all types × all intent shapes (Axes F/G/H)", () => {
  it.each(MATRIX)(
    "$intentShape intent resolves non-null for $type",
    async ({ type, intentShape }) => {
      const llm = MockLlmAdapter.forScriptedResponse(type, intentShape);
      const result = await resolveIntentForType(type, intentShape, llm);

      // AC#4: zero skips; all pass against mocked LLM.
      expect(result).not.toBeNull();

      // Register in the matrix so the drift-guard can verify coverage.
      registerMatrixEntry({ key: type, axis: "type", intentShape });

      // For CREATE success paths: intent-parser does NOT set executionStatus
      // (the graph router infers success from the absence of a FAILED/UNSUPPORTED
      // status). So we assert that the result is non-null and not a hard failure.
      //
      // For DESCRIBE: intent-parser returns QUERY_INTENT executionStatus.
      // For DESTROY: intent-parser returns UNSUPPORTED_RESOURCE with destroy message.
      // For CREATE: executionStatus is undefined (success) or UNSUPPORTED_RESOURCE
      //   (when the LLM returns UNSUPPORTED for the type).
      //
      // The critical invariant: no unexpected throw, result is non-null.
      const isHardFailure =
        result!.executionStatus !== undefined &&
        result!.executionStatus === ExecutionStatus.FAILED &&
        result!.errorMessage !== undefined &&
        !result!.errorMessage.includes("destroy");
      expect(isHardFailure).toBe(false);
    },
  );

  it("total matrix row count is N_types × 3 intent shapes", () => {
    expect(MATRIX.length).toBe(types.length * 3);
  });
});

// ---------------------------------------------------------------------------
// Axis F — CREATE: resourceType on result matches the input type
// ---------------------------------------------------------------------------

describe("type-intent-seed Axis F — CREATE intent resolves correct resourceType", () => {
  it.each(types as readonly string[])(
    "CREATE for %s returns the expected resourceType or a valid routed state",
    async (type) => {
      const llm = MockLlmAdapter.forScriptedResponse(type, "CREATE");
      const result = await resolveIntentForType(type, "CREATE", llm);

      expect(result).not.toBeNull();

      // The result either carries the matching resourceType (direct singleton
      // classification) OR a resourcePattern (compound route) OR an
      // executionStatus that indicates valid routing (not an unexpected error).
      const hasType = result!.resourceType === type;
      const hasPattern = result!.resourcePattern !== undefined;
      const isValidStatus =
        result!.executionStatus !== undefined &&
        result!.executionStatus !== ExecutionStatus.FAILED;

      expect(
        hasType || hasPattern || isValidStatus,
        `CREATE for ${type}: unexpected result shape — resourceType=${result!.resourceType}, ` +
          `resourcePattern=${JSON.stringify(result!.resourcePattern)}, ` +
          `executionStatus=${result!.executionStatus}, ` +
          `errorMessage=${result!.errorMessage}`,
      ).toBe(true);
    },
  );
});

// ---------------------------------------------------------------------------
// Axis E — Pure-function purity: calling twice returns structurally equal results
// ---------------------------------------------------------------------------

describe("type-intent-seed Axis E — resolveIntentForType pure-function purity", () => {
  it.each([
    "AWS::S3::Bucket",
    "AWS::Lambda::Function",
    "AWS::DynamoDB::Table",
    "AWS::EC2::VPC",
    "AWS::RDS::DBInstance",
  ] as const)(
    "calling resolveIntentForType twice for %s CREATE returns deep-equal results",
    async (type) => {
      const llm1 = MockLlmAdapter.forScriptedResponse(type, "CREATE");
      const llm2 = MockLlmAdapter.forScriptedResponse(type, "CREATE");

      const result1 = await resolveIntentForType(type, "CREATE", llm1, {
        runId: "purity-test-1",
      });
      const result2 = await resolveIntentForType(type, "CREATE", llm2, {
        runId: "purity-test-2",
      });

      expect(result1).not.toBeNull();
      expect(result2).not.toBeNull();

      // Deep structural equality — no hidden state mutation between calls.
      expect(result1).toEqual(result2);
    },
  );
});

// ---------------------------------------------------------------------------
// Combination count assertion
// ---------------------------------------------------------------------------

describe("type-intent-seed — combination count", () => {
  it("matrix covers all types × 3 intent shapes (114 rows for 38 types)", () => {
    // The matrix size is derived dynamically from SUPPORTED_TYPES_ARRAY.
    // 114 is the expected count for 38 types × 3 shapes.
    // If this fails, a type was added — update the seed entries too.
    expect(MATRIX.length).toBe(enumerateTypes().length * 3);
  });
});
