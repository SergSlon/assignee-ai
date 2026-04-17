/**
 * Wizard Interaction Matrix — Happy-Path Coverage.
 *
 * One test per registered resource plugin (minus generic): drives the
 * option-elicitor through commonFields + advancedFields with realistic default
 * answers and asserts the resulting `elicitedOptions` contains every answered
 * value. Also verifies that the "Configure advanced?" confirm prompt appears
 * iff the plugin defines at least one advanced field.
 *
 * @see _bmad-output/implementation-artifacts/wizard-interaction-matrix.md — AC #8
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ExecutionStatus } from "@assignee/core";
import type { ResourceField } from "@assignee/core";
import {
  ALL_PLUGINS,
  PLUGINS_WITH_ADVANCED,
  generateAnswerSequence,
} from "./fixtures/wizard-matrix-plugins.js";

// ── Mocks ───────────────────────────────────────────────────────────────────
// Mock @clack/prompts so renderAdvancedConfirm + any stray prompt calls are
// intercepted. The bulk of the wizard (promptWithHelp) is stubbed separately
// below so every field prompt resolves to a sequenced answer.
vi.mock("@clack/prompts", () => ({
  confirm: vi.fn(),
  select: vi.fn(),
  text: vi.fn(),
  multiselect: vi.fn(),
  autocomplete: vi.fn(),
  autocompleteMultiselect: vi.fn(),
  isCancel: vi.fn(() => false),
  spinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn() })),
  log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
  note: vi.fn(),
  cancel: vi.fn(),
}));

// Avoid file-system reads for BPs — BP-hint accuracy is tested separately.
vi.mock("@assignee/best-practices", () => ({
  loadBestPractices: () => [],
}));

// Config loaders all return undefined (no user/project/org config).
vi.mock("../config/user-config-loader.js", () => ({
  loadUserConfig: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../config/project-config-loader.js", () => ({
  loadProjectConfig: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../config/org-policy-cache.js", () => ({
  readAuthToken: vi.fn().mockResolvedValue(undefined),
  fetchOrgPolicy: vi.fn().mockResolvedValue(undefined),
}));

// AWS resource discovery — all fetchers return empty so fields fall back to
// their static defaults / string-entry paths without hitting AWS.
// Story 50-4 Wave 5 Pass H: share aws-resource-discovery spies across
// CLI shim + core path (option-elicitor lifted to core).
const _discoveryMocks = vi.hoisted(() => ({
  discoverAmis: vi.fn().mockResolvedValue([]),
  discoverSubnets: vi.fn().mockResolvedValue([]),
  discoverSecurityGroups: vi.fn().mockResolvedValue([]),
  discoverKeyPairs: vi.fn().mockResolvedValue([]),
  discoverInstanceTypes: vi.fn().mockResolvedValue(null),
  discoverRdsEngineVersions: vi.fn().mockResolvedValue([]),
  discoverRdsInstanceClasses: vi.fn().mockResolvedValue([]),
  discoverLambdaRuntimes: vi.fn().mockResolvedValue([]),
  resolveAmiFromOsName: vi.fn().mockResolvedValue(null),
  clearDiscoveryCache: vi.fn(),
  DiscoveryCacheKey: {
    AMIS: "discover-amis",
    SUBNETS: "discover-subnets",
    KEY_PAIRS: "discover-key-pairs",
    SECURITY_GROUPS: "discover-security-groups",
    RDS_ENGINE_VERSIONS: "discover-rds-engine-versions",
    RDS_INSTANCE_CLASSES: "discover-rds-instance-classes",
    LAMBDA_RUNTIMES: "discover-lambda-runtimes",
  },
}));
vi.mock("../utils/aws-resource-discovery/index.js", () => _discoveryMocks);

// Stub promptWithHelp while keeping every other wizard-helpers export real.
// This is the crux of the matrix tests: we drive the option-elicitor's main
// field-prompt loop via a controlled sequence instead of wiring up every
// @clack primitive for 134 tests.
// Story 50-4 Wave 5 Pass H: share spy across CLI shim + core path.
const _promptWithHelpSpy = vi.hoisted(() => vi.fn());
vi.mock("../utils/wizard-helpers.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../utils/wizard-helpers.js")>();
  return { ...actual, promptWithHelp: _promptWithHelpSpy };
});

const { optionElicitorNode } =
  await import("../graph/nodes/option-elicitor.js");
const { promptWithHelp } = await import("../utils/wizard-helpers.js");
const clack = await import("@clack/prompts");

function setTTY(value: boolean) {
  Object.defineProperty(process.stdin, "isTTY", { value, configurable: true });
  Object.defineProperty(process.stdout, "isTTY", { value, configurable: true });
}

function makeState(resourceType: string) {
  return {
    executionStatus: ExecutionStatus.PENDING,
    resourceType,
    elicitedOptions: undefined,
    userIntent: "",
    runId: "wizard-matrix-test",
  } as unknown as Parameters<typeof optionElicitorNode>[0];
}

beforeEach(() => {
  // resetAllMocks (not clearAllMocks) so mockImplementation set in one
  // describe.each row does not bleed into the next. clearAllMocks only
  // resets call history.
  vi.resetAllMocks();
  setTTY(true);
});

afterEach(() => {
  Object.defineProperty(process.stdin, "isTTY", {
    value: undefined,
    configurable: true,
  });
  Object.defineProperty(process.stdout, "isTTY", {
    value: undefined,
    configurable: true,
  });
});

describe.each(ALL_PLUGINS.map((p) => [p.resourceType, p] as const))(
  "wizard happy-path — %s",
  (_resourceType, plugin) => {
    it("prompts every visible field in expected order and lands all answers in elicitedOptions", async () => {
      const { sequence, answerMap } = generateAnswerSequence(plugin, {
        includeAdvanced: true,
      });
      const expectedNames = sequence.map((s) => s.field.name);

      // Drive promptWithHelp by *field name* (not positional index) so a bug
      // that reorders fields, skips one, or prompts a phantom one is caught
      // immediately. The lookup map is built from the fixture's expected
      // sequence, which mirrors option-elicitor's loop.
      const expectedByName = new Map(
        sequence.map((s) => [s.field.name, s.value]),
      );
      const calledNames: string[] = [];
      vi.mocked(promptWithHelp).mockImplementation(
        async (field: ResourceField) => {
          calledNames.push(field.name);
          if (!expectedByName.has(field.name)) {
            throw new Error(
              `${plugin.resourceType}: option-elicitor prompted unexpected field ${field.name}`,
            );
          }
          return expectedByName.get(field.name);
        },
      );

      // User opts IN to advanced tier if the plugin has any advanced fields.
      vi.mocked(clack.confirm).mockResolvedValue(
        plugin.advancedFields.length > 0,
      );

      const result = await optionElicitorNode(makeState(plugin.resourceType));

      expect(result.elicitedOptions).toBeDefined();

      // (1) Prompt order matches the fixture's expected sequence exactly.
      expect(calledNames, `${plugin.resourceType} prompt order drift`).toEqual(
        expectedNames,
      );

      // (2) Every answered field lands in elicitedOptions with the same
      //     value. option-elicitor drops undefined and "" answers — we mirror
      //     that filter here so we only assert on values that should survive.
      const expectedKeys: string[] = [];
      for (const [name, val] of Object.entries(answerMap)) {
        if (val === undefined || val === "") continue;
        expect(
          result.elicitedOptions?.[name],
          `${plugin.resourceType} field ${name}`,
        ).toEqual(val);
        expectedKeys.push(name);
      }

      // (3) No phantom keys: elicitedOptions must not contain anything we
      //     did not feed it (modulo intent-injected booleans, which the
      //     option-elicitor pre-seeds and we tolerate).
      const elicitedKeys = Object.keys(result.elicitedOptions ?? {});
      const phantomKeys = elicitedKeys.filter((k) => !expectedKeys.includes(k));
      expect(
        phantomKeys,
        `${plugin.resourceType} unexpected keys in elicitedOptions: ${phantomKeys.join(", ")}`,
      ).toEqual([]);
    });

    it("omits advanced tier when user declines the confirm prompt", async () => {
      const { sequence: commonSeq } = generateAnswerSequence(plugin, {
        includeAdvanced: false,
      });
      const expectedCommonNames = commonSeq.map((s) => s.field.name);
      const expectedByName = new Map(
        commonSeq.map((s) => [s.field.name, s.value]),
      );
      const calledNames: string[] = [];

      vi.mocked(promptWithHelp).mockImplementation(
        async (field: ResourceField) => {
          calledNames.push(field.name);
          if (!expectedByName.has(field.name)) {
            throw new Error(
              `${plugin.resourceType}: option-elicitor prompted advanced field ${field.name} despite user declining`,
            );
          }
          return expectedByName.get(field.name);
        },
      );
      vi.mocked(clack.confirm).mockResolvedValue(false);

      await optionElicitorNode(makeState(plugin.resourceType));

      if (plugin.advancedFields.length > 0) {
        // "Configure advanced?" must have been asked.
        expect(vi.mocked(clack.confirm)).toHaveBeenCalledWith(
          expect.objectContaining({
            message: expect.stringContaining("advanced"),
          }),
        );
      } else {
        // No advanced fields → confirm prompt must not be used.
        expect(vi.mocked(clack.confirm)).not.toHaveBeenCalled();
      }

      // Only common fields should have been prompted, in declared order.
      expect(calledNames).toEqual(expectedCommonNames);
    });
  },
);

describe("wizard happy-path — coverage invariants", () => {
  it("advanced-confirm prompt is exercised by at least one plugin", () => {
    // Guardrail: if someone removes every advancedFields array from every
    // plugin, the matrix would silently lose the confirm-prompt branch.
    expect(PLUGINS_WITH_ADVANCED.length).toBeGreaterThan(0);
  });

  it("ALL_PLUGINS covers every 23-resource-type row in the story matrix", () => {
    // This guards against accidental removal from the fixture list.
    expect(ALL_PLUGINS.length).toBeGreaterThanOrEqual(23);
  });
});
