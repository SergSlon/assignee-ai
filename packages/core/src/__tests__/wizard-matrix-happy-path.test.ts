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
import { ExecutionStatus } from "../index.js";
import type { ResourceField } from "../index.js";
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

// AWS resource discovery — return REALISTIC non-empty fixtures so the
// option-elicitor exercises the "pick one of N" branch in
// `resolveDynamicFields` (populated-options path) instead of always hitting
// the empty-array fallback. Shapes mirror the real discovery functions:
//   { value: string, label: string }.
// Story 50-4 Wave 5 Pass H: share aws-resource-discovery spies across
// CLI shim + core path (option-elicitor lifted to core).
// Story 51-it1-B1 (L6-H1): real-data mocks replace the previous `[]`
// placeholders that masked the populated-options branch.
const _discoveryMocks = vi.hoisted(() => ({
  discoverAmis: vi.fn().mockResolvedValue([
    {
      value: "ami-0abcdef1234567890",
      label: "Amazon Linux 2023 (ami-0abcdef1234567890)",
    },
    {
      value: "ami-0123456789abcdef0",
      label: "Ubuntu 22.04 LTS (ami-0123456789abcdef0)",
    },
  ]),
  discoverSubnets: vi.fn().mockResolvedValue([
    {
      value: "subnet-0abc1234def567890",
      label: "public-a (10.0.0.0/24, us-east-1a) — subnet-0abc1234def567890",
    },
    {
      value: "subnet-0def5678abc901234",
      label: "private-a (10.0.1.0/24, us-east-1a) — subnet-0def5678abc901234",
    },
  ]),
  discoverSecurityGroups: vi.fn().mockResolvedValue([
    { value: "", label: "None (use VPC default security group)" },
    {
      value: "sg-0abc1234def567890",
      label: "web-sg (sg-0abc1234def567890)",
    },
  ]),
  discoverKeyPairs: vi.fn().mockResolvedValue([
    { value: "", label: "None (SSM access only)" },
    { value: "my-keypair", label: "my-keypair (rsa)" },
  ]),
  discoverInstanceTypes: vi.fn().mockResolvedValue(null),
  discoverRdsEngineVersions: vi.fn().mockResolvedValue([
    { value: "16.4", label: "PostgreSQL 16.4", recommended: true },
    { value: "15.8", label: "PostgreSQL 15.8" },
  ]),
  discoverRdsInstanceClasses: vi.fn().mockResolvedValue([
    { value: "db.t3.micro", label: "db.t3.micro (2 vCPU, 1 GiB, burstable)" },
    { value: "db.t3.small", label: "db.t3.small (2 vCPU, 2 GiB, burstable)" },
  ]),
  discoverLambdaRuntimes: vi.fn().mockResolvedValue([
    { value: "nodejs20.x", label: "Node.js 20.x" },
    { value: "python3.12", label: "Python 3.12" },
  ]),
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

  // Story 51-it1-B1 (L6-H1): `vi.resetAllMocks()` wipes mock implementations
  // set at hoist time, including the discovery fixtures. Reinstate the
  // realistic non-empty defaults per-test so `resolveDynamicFields` exercises
  // the populated-options branch unless a test explicitly overrides. Tests
  // that need `[]` (empty discovery) must override in-test.
  _discoveryMocks.discoverAmis.mockResolvedValue([
    {
      value: "ami-0abcdef1234567890",
      label: "Amazon Linux 2023 (ami-0abcdef1234567890)",
    },
    {
      value: "ami-0123456789abcdef0",
      label: "Ubuntu 22.04 LTS (ami-0123456789abcdef0)",
    },
  ]);
  _discoveryMocks.discoverSubnets.mockResolvedValue([
    {
      value: "subnet-0abc1234def567890",
      label: "public-a (10.0.0.0/24, us-east-1a) — subnet-0abc1234def567890",
    },
    {
      value: "subnet-0def5678abc901234",
      label: "private-a (10.0.1.0/24, us-east-1a) — subnet-0def5678abc901234",
    },
  ]);
  _discoveryMocks.discoverSecurityGroups.mockResolvedValue([
    { value: "", label: "None (use VPC default security group)" },
    { value: "sg-0abc1234def567890", label: "web-sg (sg-0abc1234def567890)" },
  ]);
  _discoveryMocks.discoverKeyPairs.mockResolvedValue([
    { value: "", label: "None (SSM access only)" },
    { value: "my-keypair", label: "my-keypair (rsa)" },
  ]);
  _discoveryMocks.discoverInstanceTypes.mockResolvedValue(null);
  _discoveryMocks.discoverRdsEngineVersions.mockResolvedValue([
    { value: "16.4", label: "PostgreSQL 16.4", recommended: true },
    { value: "15.8", label: "PostgreSQL 15.8" },
  ]);
  _discoveryMocks.discoverRdsInstanceClasses.mockResolvedValue([
    { value: "db.t3.micro", label: "db.t3.micro (2 vCPU, 1 GiB, burstable)" },
    { value: "db.t3.small", label: "db.t3.small (2 vCPU, 2 GiB, burstable)" },
  ]);
  _discoveryMocks.discoverLambdaRuntimes.mockResolvedValue([
    { value: "nodejs20.x", label: "Node.js 20.x" },
    { value: "python3.12", label: "Python 3.12" },
  ]);
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
        async (options: { field: ResourceField }) => {
          const field = options.field;
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
        async (options: { field: ResourceField }) => {
          const field = options.field;
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

// ── L6-H1: Explicit "pick one of N" branch coverage ────────────────────────
//
// The module-level discovery mocks define realistic return values, but
// `vi.resetAllMocks()` in the shared `beforeEach` wipes those
// implementations so every describe.each row starts from a clean slate.
// That protects per-row mockImplementation from leaking across rows, but it
// also means tests which need a populated discovery must reinstate the
// implementation explicitly inside the test body (as this test does).
// Before Story 51-it1-B1 the populated-options branch at discovery.ts:172
// was never exercised — every wizard-matrix assertion ran through the
// empty-array fallback.
describe("wizard happy-path — L6-H1 populated-discovery branch", () => {
  const DISCOVERED_SUBNETS = [
    {
      value: "subnet-0abc1234def567890",
      label: "public-a (10.0.0.0/24, us-east-1a) — subnet-0abc1234def567890",
    },
    {
      value: "subnet-0def5678abc901234",
      label: "private-a (10.0.1.0/24, us-east-1a) — subnet-0def5678abc901234",
    },
  ];

  it("EC2 instance wizard populates Subnet field with discovered options (pick one of N)", async () => {
    // `discoverSubnets` is mocked with two real subnet IDs at module top.
    // Driving the wizard with an answer that matches the first subnet proves:
    //   1. `resolveDynamicFields` hit the populated-options branch
    //      (field.question.options is set to the discovered list).
    //   2. option-elicitor then prompts with that populated enum, and the
    //      chosen value ends up in elicitedOptions.
    //
    // We target the Subnet (SubnetId) field instead of ImageId because the
    // AMI field has an `initialValue` of `amazon-linux-2023` (an OS name the
    // system resolves downstream), so option-elicitor short-circuits to that
    // initialValue rather than invoking promptWithHelp on a populated enum.
    // SubnetId has no initialValue — its enum is entirely discovery-driven.
    const plugin = ALL_PLUGINS.find(
      (p) => p.resourceType === "AWS::EC2::Instance",
    );
    expect(plugin, "EC2::Instance plugin must be registered").toBeDefined();

    // beforeEach already reinstated the populated discovery defaults; here
    // we just pin the specific fixture used for the end-to-end assertion.
    _discoveryMocks.discoverSubnets.mockResolvedValue(DISCOVERED_SUBNETS);

    const discoveredSubnetValue = DISCOVERED_SUBNETS[0]!.value;
    let subnetFieldSawPopulatedEnum = false;

    vi.mocked(promptWithHelp).mockImplementation(
      async (options: { field: ResourceField }) => {
        const field = options.field;
        // If this is the subnet field, return a discovered value; also assert
        // the field arrived here as an enum with discovered options.
        // Note: after resolveDynamicFields populates options, it clears the
        // `fetcher` marker so the option-elicitor doesn't re-fetch. We match
        // on the field NAME (SubnetId) which is stable across pipeline phases.
        if (field.name === "SubnetId") {
          // Assert the field arrived here carrying the discovered options
          // (populated-branch shape), NOT the string-fallback shape.
          expect(field.question.type).toBe("enum");
          expect(field.question.options).toBeDefined();
          const values = (field.question.options ?? []).map((o) => o.value);
          expect(values).toContain(discoveredSubnetValue);
          subnetFieldSawPopulatedEnum = true;
          return discoveredSubnetValue;
        }
        // Default answer for non-fetcher fields so the wizard completes.
        const q = field.question;
        if (q.initialValue !== undefined && q.initialValue !== "") {
          return q.initialValue;
        }
        if (q.type === "enum" && q.options && q.options.length > 0) {
          return q.options[0]!.value;
        }
        if (q.type === "boolean") return true;
        if (q.type === "multi") return [];
        if (q.type === "categorySelect") {
          const firstCat = q.categories?.[0];
          return firstCat?.options?.[0]?.value ?? "t3.micro";
        }
        return `${field.name.toLowerCase()}-value`;
      },
    );

    // Decline advanced tier to keep the sequence short.
    vi.mocked(clack.confirm).mockResolvedValue(false);

    const result = await optionElicitorNode(makeState("AWS::EC2::Instance"));

    expect(result.elicitedOptions).toBeDefined();
    // The subnet answer must be the discovered value — proves the populated
    // enum's chosen option flowed end-to-end through the elicitor.
    expect(result.elicitedOptions?.["SubnetId"]).toBe(discoveredSubnetValue);
    // Defensive: confirm we actually observed the populated enum (not that
    // the field was short-circuited by some other code path).
    expect(subnetFieldSawPopulatedEnum).toBe(true);
  });
});
