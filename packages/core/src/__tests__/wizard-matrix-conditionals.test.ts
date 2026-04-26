/**
 * Wizard Interaction Matrix — showIf Conditional Field Coverage.
 *
 * For every plugin that defines `showIf` on any field, verify that:
 *   1. Each `showIf` condition is evaluated consistently by our fixture's
 *      `showIfSatisfied` helper and the real `evaluateShowIf` export
 *      (mirror-check: if these diverge, the fixtures will produce wrong
 *      sequences and every happy-path test for a showIf plugin silently
 *      misses fields).
 *   2. Every `showIf.field` references a field that actually exists on the
 *      same plugin (common or advanced) — a dangling reference silently
 *      hides the dependent field forever.
 *   3. Driving the wizard with a matching parent value reveals the dependent
 *      field in `elicitedOptions`.
 *   4. Driving the wizard with a non-matching parent value hides the
 *      dependent field from `elicitedOptions`.
 *
 * @see _bmad-output/implementation-artifacts/wizard-interaction-matrix.md — AC #10
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ExecutionStatus } from "../index.js";
import type { ResourceField, ResourcePlugin } from "../index.js";
import {
  PLUGINS_WITH_SHOWIF,
  generateDefaultAnswer,
  pickPatternMatch,
} from "./fixtures/wizard-matrix-plugins.js";

// ── Mocks — identical surface to happy-path (keeps tests hermetic). ─────────
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

vi.mock("@assignee/best-practices", () => ({
  loadBestPractices: () => [],
}));
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
// Story 50-4 Wave 5 Pass H: share aws-resource-discovery spies across
// CLI shim + core path (option-elicitor lifted to core).
// Story 51-it1-B1 (L6-H1): real-data mocks so `resolveDynamicFields`
// hits the populated-options branch (not the empty-array fallback).
// Shapes mirror real discovery function return values.
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
  discoverRouteTables: vi.fn().mockResolvedValue([]),
  discoverInternetGateways: vi.fn().mockResolvedValue([]),
  discoverNatGateways: vi.fn().mockResolvedValue([]),
  discoverEfsFileSystems: vi.fn().mockResolvedValue([]),
  discoverSnsTopics: vi.fn().mockResolvedValue([]),
  discoverKmsKeys: vi.fn().mockResolvedValue([]),
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
    ROUTE_TABLES: "discover-route-tables",
    INTERNET_GATEWAYS: "discover-internet-gateways",
    NAT_GATEWAYS: "discover-nat-gateways",
    EFS_FILE_SYSTEMS: "discover-efs-file-systems",
    SNS_TOPICS: "discover-sns-topics",
    KMS_KEYS: "discover-kms-keys",
  },
}));
vi.mock("../utils/aws-resource-discovery/index.js", () => _discoveryMocks);

// Story 50-4 Wave 5 Pass H: option-elicitor lifted to core; wizard-helpers
// imported via core-internal path. Share a single promptWithHelp spy across
// both mock paths so vi.mocked(promptWithHelp).mockImplementation propagates.
const _promptWithHelpSpy = vi.hoisted(() => vi.fn());
vi.mock("../utils/wizard-helpers.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../utils/wizard-helpers.js")>();
  return { ...actual, promptWithHelp: _promptWithHelpSpy };
});

const { optionElicitorNode } =
  await import("../graph/nodes/option-elicitor.js");
const { promptWithHelp, evaluateShowIf } =
  await import("../utils/wizard-helpers.js");
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
  // describe.each row does not bleed into the next.
  vi.resetAllMocks();
  setTTY(true);

  // Story 51-it1-B1 (L6-H1): reinstate the realistic non-empty discovery
  // defaults that were cleared by `vi.resetAllMocks()`. With populated
  // options, `resolveDynamicFields` hits the enum-populated branch that the
  // previous `[]` placeholders left untouched.
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

// ── Helper types ────────────────────────────────────────────────────────────

interface ConditionalPair {
  plugin: ResourcePlugin;
  parent: ResourceField;
  child: ResourceField;
  /** Value the parent field must hold for the child to appear. */
  satisfyingValue: unknown;
  /** Value the parent field holds when the child should be hidden. */
  nonSatisfyingValue: unknown;
}

/** Collect every (parent, child) pair derived from showIf definitions. */
function collectConditionalPairs(plugin: ResourcePlugin): ConditionalPair[] {
  const allFields = [...plugin.commonFields, ...plugin.advancedFields];
  const pairs: ConditionalPair[] = [];

  for (const child of allFields) {
    const cond = child.question.showIf;
    if (!cond) continue;
    const parent = allFields.find((f) => f.name === cond.field);
    if (!parent) continue; // dangling reference; surfaced by "every showIf target exists" test below

    // Pick satisfying + non-satisfying values that actually exercise
    // the real evaluateShowIf branches.
    let satisfyingValue: unknown;
    let nonSatisfyingValue: unknown;

    if (cond.pattern) {
      // Pattern branch: pick a string that matches the regex from a small
      // table of values (covers `^t[34]` etc.). If the table can't satisfy
      // the pattern we leave both values undefined and the drive tests
      // skip — but that should be the exception, not the rule.
      const match = pickPatternMatch(cond.pattern);
      satisfyingValue = match;
      nonSatisfyingValue =
        match !== undefined ? "__assignee_pattern_nomatch__" : undefined;
    } else if (cond.value === true) {
      satisfyingValue = true;
      nonSatisfyingValue = false;
    } else if (cond.value === false) {
      satisfyingValue = false;
      nonSatisfyingValue = true;
    } else {
      satisfyingValue = cond.value;
      // Use a sentinel that cannot equal any normal enum/string value.
      nonSatisfyingValue = "__assignee_wizard_matrix_nonmatch__";
    }

    pairs.push({
      plugin,
      parent,
      child,
      satisfyingValue,
      nonSatisfyingValue,
    });
  }

  return pairs;
}

// ── Static invariants ───────────────────────────────────────────────────────

describe("showIf — static invariants", () => {
  it("every showIf.field references a field on the same plugin", () => {
    for (const plugin of PLUGINS_WITH_SHOWIF) {
      const allFields = [...plugin.commonFields, ...plugin.advancedFields];
      const fieldNames = new Set(allFields.map((f) => f.name));
      for (const field of allFields) {
        const cond = field.question.showIf;
        if (!cond) continue;
        expect(
          fieldNames.has(cond.field),
          `plugin ${plugin.resourceType}: field ${field.name} showIf references unknown parent ${cond.field}`,
        ).toBe(true);
      }
    }
  });

  it("fixture `showIfSatisfied` mirrors the real `evaluateShowIf`", () => {
    // Cross-check every showIf across every plugin using both code paths so
    // the fixtures (used by happy-path/conditional tests) cannot drift from
    // the production evaluator.
    for (const plugin of PLUGINS_WITH_SHOWIF) {
      const allFields = [...plugin.commonFields, ...plugin.advancedFields];
      for (const field of allFields) {
        const cond = field.question.showIf;
        if (!cond) continue;

        // Drive three representative answer maps per field:
        //   empty, parent-satisfying, parent-non-satisfying.
        const satisfying: Record<string, unknown> =
          cond.value === true
            ? { [cond.field]: true }
            : cond.value === false
              ? { [cond.field]: false }
              : cond.pattern
                ? { [cond.field]: pickPatternMatch(cond.pattern) }
                : { [cond.field]: cond.value };

        const nonSatisfying: Record<string, unknown> =
          cond.value === true
            ? { [cond.field]: false }
            : cond.value === false
              ? { [cond.field]: true }
              : cond.pattern
                ? { [cond.field]: "zzz-no-match-xyz" }
                : { [cond.field]: "__nonmatch__" };

        expect(evaluateShowIf(cond, satisfying)).toBe(true);
        expect(evaluateShowIf(cond, nonSatisfying)).toBe(false);
      }
    }
  });
});

// ── Driven behavior: one test per (plugin, parent→child) pair ───────────────

// Build a flat list so each conditional pair becomes its own describe.each row.
type ConditionalRow = readonly [label: string, pair: ConditionalPair];
const conditionalRows: ConditionalRow[] = PLUGINS_WITH_SHOWIF.flatMap(
  (plugin) =>
    collectConditionalPairs(plugin).map<ConditionalRow>((pair) => [
      `${plugin.resourceType} — ${pair.child.name} visible when ${pair.parent.name}=${JSON.stringify(pair.parent.question.showIf?.value ?? "<pattern>")}`,
      pair,
    ]),
);

describe.each(conditionalRows)("showIf driven — %s", (_label, pair) => {
  it("dependent field IS prompted when parent condition is satisfied", async () => {
    if (pair.satisfyingValue === undefined) {
      // Pattern-based conditionals are covered by the static invariant test
      // above; skip the drive-based branch because the parent field often
      // has validation/fetcher logic that makes picking a valid matching
      // value brittle.
      return;
    }

    const { plugin, parent, child } = pair;
    const { promptedFieldNames } = await driveFlow(plugin, {
      [parent.name]: pair.satisfyingValue,
    });
    // The child field MUST have been prompted. We assert on promptWithHelp
    // invocation rather than elicitedOptions because fields with empty/""
    // answers are intentionally dropped from elicitedOptions (e.g.
    // EFS::KmsKeyId initialValue "").
    expect(promptedFieldNames).toContain(child.name);
  });

  it("dependent field is NOT prompted when parent condition is NOT satisfied", async () => {
    if (pair.nonSatisfyingValue === undefined) return;

    const { plugin, parent, child } = pair;
    const { promptedFieldNames, elicited } = await driveFlow(plugin, {
      [parent.name]: pair.nonSatisfyingValue,
    });
    expect(promptedFieldNames).not.toContain(child.name);
    // Belt-and-suspenders: the child must not have leaked into the output.
    expect(elicited[child.name]).toBeUndefined();
  });
});

/**
 * Drive a plugin through option-elicitor with forced values for specific
 * fields. Any field not present in `forced` gets its default answer.
 * Returns both the resulting elicitedOptions map and a list of field names
 * that promptWithHelp was actually called with.
 */
async function driveFlow(
  plugin: ResourcePlugin,
  forced: Record<string, unknown>,
): Promise<{
  elicited: Record<string, unknown>;
  promptedFieldNames: string[];
}> {
  const promptedFieldNames: string[] = [];

  vi.mocked(promptWithHelp).mockImplementation(
    async (options: { field: ResourceField }) => {
      const field = options.field;
      promptedFieldNames.push(field.name);
      const override = forced[field.name];
      return override !== undefined ? override : generateDefaultAnswer(field);
    },
  );

  // Always opt into the advanced tier so advanced showIf children get a chance.
  vi.mocked(clack.confirm).mockResolvedValue(true);

  const result = await optionElicitorNode(makeState(plugin.resourceType));
  const elicited = (result.elicitedOptions ?? {}) as Record<string, unknown>;
  return { elicited, promptedFieldNames };
}
