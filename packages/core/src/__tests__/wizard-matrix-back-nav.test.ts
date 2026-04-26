/**
 * Wizard Interaction Matrix — Back Navigation Consistency.
 *
 * Verifies that the user-visible "← Back" affordance is consistent across
 * every field type the wizard supports — closing the gap that motivated
 * `wizard-back-navigation-ux` (the real EC2+SSH session that got stuck in
 * a 2-step loop on 2026-04-10).
 *
 * Specifically:
 *
 *   1. **Visible Back option in every field type when showBack=true.** For
 *      `boolean`, `enum`, `string`, `multi`, and `categorySelect`, the prompt
 *      built by `renderOptionPrompt` must include the `BACK_SENTINEL` as a
 *      selectable option.
 *
 *   2. **No Back option when showBack=false** (which option-elicitor passes
 *      for the very first visible field). Specifically: text fields skip the
 *      action menu, boolean uses confirm not select, etc.
 *
 *   3. **Selecting Back returns BACK_SENTINEL.** The dispatcher must
 *      propagate the sentinel back to the option-elicitor for every field
 *      type so the loop can pop history.
 *
 * @see _bmad-output/implementation-artifacts/wizard-interaction-matrix.md — AC #1-4
 * @see _bmad-output/implementation-artifacts/wizard-back-navigation-ux.md
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  ExecutionStatus,
  RESOURCE_TYPES,
  defaultPluginRegistry,
} from "../index.js";
import type { ResourceField, ResolvedFieldConfig } from "../index.js";
import { FieldPolicy, FieldSource } from "../constants/field-policy.js";

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

// Additional mocks needed for the option-elicitor integration test at the
// bottom of this file. They're harmless for the renderOptionPrompt-only
// tests above because vitest hoists vi.mock calls regardless of position.
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

// Partial mock so we can stub promptWithHelp for the integration test.
const _promptWithHelpSpy = vi.hoisted(() => vi.fn());
vi.mock("../utils/wizard-helpers.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../utils/wizard-helpers.js")>();
  return { ...actual, promptWithHelp: _promptWithHelpSpy };
});

const { renderOptionPrompt, BACK_SENTINEL, ENTER_VALUE_SENTINEL } =
  await import("../utils/display-prompts.js");
const clack = await import("@clack/prompts");
const { optionElicitorNode } =
  await import("../graph/nodes/option-elicitor.js");
const { promptWithHelp } = await import("../utils/wizard-helpers.js");

function setTTY(value: boolean) {
  Object.defineProperty(process.stdin, "isTTY", { value, configurable: true });
  Object.defineProperty(process.stdout, "isTTY", { value, configurable: true });
}

function makeResolved(value?: unknown): ResolvedFieldConfig {
  return {
    policy: FieldPolicy.ASK_IF_NOT_SET,
    value,
    source: FieldSource.PLUGIN_DEFAULT,
  };
}

beforeEach(() => {
  // resetAllMocks (not clearAllMocks) so mockImplementation set in one
  // test does not bleed into the next.
  vi.resetAllMocks();
  setTTY(true);
});

afterEach(() => {
  Object.defineProperty(process.stdin, "isTTY", {
    value: undefined,
    configurable: true,
  });
});

// ── Per-field-type fixtures ─────────────────────────────────────────────────

const booleanField: ResourceField = {
  name: "Encrypted",
  question: {
    type: "boolean",
    label: "Enable encryption?",
    initialValue: true,
  },
};

const enumField: ResourceField = {
  name: "Engine",
  question: {
    type: "enum",
    label: "Engine",
    options: [
      { value: "postgres", label: "PostgreSQL" },
      { value: "mysql", label: "MySQL" },
    ],
  },
};

const stringField: ResourceField = {
  name: "Name",
  question: { type: "string", label: "Resource name", placeholder: "my-thing" },
};

const multiField: ResourceField = {
  name: "Tags",
  question: {
    type: "multi",
    label: "Tags",
    options: [
      { value: "env:prod", label: "env:prod" },
      { value: "env:dev", label: "env:dev" },
    ],
  },
};

const categorySelectField: ResourceField = {
  name: "InstanceType",
  question: {
    type: "categorySelect",
    label: "Instance type",
    categories: [
      {
        key: "burstable",
        label: "Burstable — t3 family",
        description: "Cost-efficient general purpose",
        options: [
          { value: "t3.micro", label: "t3.micro" },
          { value: "t3.small", label: "t3.small" },
        ],
      },
    ],
  },
};

// ── Visible Back option (showBack=true) ─────────────────────────────────────

describe("renderOptionPrompt — visible Back option (showBack=true)", () => {
  it("boolean: select call includes BACK_SENTINEL among options", async () => {
    vi.mocked(clack.select).mockResolvedValueOnce("true");
    await renderOptionPrompt(booleanField, makeResolved(true), true);

    const call = vi.mocked(clack.select).mock.calls[0]?.[0] as
      | { options: Array<{ value: string }> }
      | undefined;
    expect(call).toBeDefined();
    expect(call?.options.some((o) => o.value === BACK_SENTINEL)).toBe(true);
  });

  it("enum: select call includes BACK_SENTINEL among options", async () => {
    vi.mocked(clack.select).mockResolvedValueOnce("postgres");
    await renderOptionPrompt(enumField, makeResolved("postgres"), true);

    const call = vi.mocked(clack.select).mock.calls[0]?.[0] as
      | { options: Array<{ value: string }> }
      | undefined;
    expect(call?.options.some((o) => o.value === BACK_SENTINEL)).toBe(true);
  });

  it("string: action menu pre-step includes BACK_SENTINEL and ENTER_VALUE_SENTINEL", async () => {
    // First call (action menu) returns ENTER_VALUE so we then drop into clack.text.
    vi.mocked(clack.select).mockResolvedValueOnce(ENTER_VALUE_SENTINEL);
    vi.mocked(clack.text).mockResolvedValueOnce("my-thing");

    await renderOptionPrompt(stringField, makeResolved(""), true);

    const actionCall = vi.mocked(clack.select).mock.calls[0]?.[0] as
      | { options: Array<{ value: string }> }
      | undefined;
    expect(actionCall).toBeDefined();
    expect(actionCall?.options.some((o) => o.value === BACK_SENTINEL)).toBe(
      true,
    );
    expect(
      actionCall?.options.some((o) => o.value === ENTER_VALUE_SENTINEL),
    ).toBe(true);
  });

  it("multi: multiselect call includes BACK_SENTINEL among options", async () => {
    vi.mocked(clack.multiselect).mockResolvedValueOnce(["env:prod"]);
    await renderOptionPrompt(multiField, makeResolved([]), true);

    const call = vi.mocked(clack.multiselect).mock.calls[0]?.[0] as
      | { options: Array<{ value: string }> }
      | undefined;
    expect(call?.options.some((o) => o.value === BACK_SENTINEL)).toBe(true);
  });

  it("categorySelect: category step includes BACK_SENTINEL among options", async () => {
    // Category step → return BACK_SENTINEL so we don't fall into the size step.
    vi.mocked(clack.select).mockResolvedValueOnce(BACK_SENTINEL);

    const result = await renderOptionPrompt(
      categorySelectField,
      makeResolved("t3.micro"),
      true,
    );
    expect(result).toBe(BACK_SENTINEL);

    const call = vi.mocked(clack.select).mock.calls[0]?.[0] as
      | { options: Array<{ value: string }> }
      | undefined;
    expect(call?.options.some((o) => o.value === BACK_SENTINEL)).toBe(true);
  });
});

// ── Back is hidden when showBack=false (first field) ─────────────────────────

describe("renderOptionPrompt — Back hidden when showBack=false", () => {
  it("boolean (showBack=false): uses clack.confirm, no select with Back", async () => {
    vi.mocked(clack.confirm).mockResolvedValueOnce(true);
    await renderOptionPrompt(booleanField, makeResolved(true), false);

    expect(vi.mocked(clack.confirm)).toHaveBeenCalledOnce();
    // select should not have been called at all.
    expect(vi.mocked(clack.select)).not.toHaveBeenCalled();
  });

  it("enum (showBack=false): select is called but options exclude BACK_SENTINEL", async () => {
    vi.mocked(clack.select).mockResolvedValueOnce("postgres");
    await renderOptionPrompt(enumField, makeResolved("postgres"), false);

    const call = vi.mocked(clack.select).mock.calls[0]?.[0] as
      | { options: Array<{ value: string }> }
      | undefined;
    expect(call?.options.some((o) => o.value === BACK_SENTINEL)).toBe(false);
  });

  it("string (showBack=false): no action menu, goes straight to clack.text", async () => {
    vi.mocked(clack.text).mockResolvedValueOnce("my-thing");
    await renderOptionPrompt(stringField, makeResolved(""), false);

    expect(vi.mocked(clack.text)).toHaveBeenCalledOnce();
    expect(vi.mocked(clack.select)).not.toHaveBeenCalled();
  });

  it("multi (showBack=false): multiselect options exclude BACK_SENTINEL", async () => {
    vi.mocked(clack.multiselect).mockResolvedValueOnce([]);
    await renderOptionPrompt(multiField, makeResolved([]), false);

    const call = vi.mocked(clack.multiselect).mock.calls[0]?.[0] as
      | { options: Array<{ value: string }> }
      | undefined;
    expect(call?.options.some((o) => o.value === BACK_SENTINEL)).toBe(false);
  });
});

// ── Selecting Back returns BACK_SENTINEL ─────────────────────────────────────

describe("renderOptionPrompt — selecting Back returns BACK_SENTINEL", () => {
  it("boolean (showBack=true): select returning BACK_SENTINEL propagates", async () => {
    vi.mocked(clack.select).mockResolvedValueOnce(BACK_SENTINEL);
    const result = await renderOptionPrompt(
      booleanField,
      makeResolved(true),
      true,
    );
    expect(result).toBe(BACK_SENTINEL);
  });

  it("enum: select returning BACK_SENTINEL propagates", async () => {
    vi.mocked(clack.select).mockResolvedValueOnce(BACK_SENTINEL);
    const result = await renderOptionPrompt(
      enumField,
      makeResolved("postgres"),
      true,
    );
    expect(result).toBe(BACK_SENTINEL);
  });

  it("string: action menu returning BACK_SENTINEL skips text() and propagates", async () => {
    vi.mocked(clack.select).mockResolvedValueOnce(BACK_SENTINEL);
    const result = await renderOptionPrompt(
      stringField,
      makeResolved(""),
      true,
    );
    expect(result).toBe(BACK_SENTINEL);
    // Crucially, clack.text should NOT have been called when user picks Back.
    expect(vi.mocked(clack.text)).not.toHaveBeenCalled();
  });

  it("string: typing 'back' inside the text input still propagates BACK_SENTINEL (backcompat)", async () => {
    // Action menu picks Enter value, then user types "back" inside the text input.
    vi.mocked(clack.select).mockResolvedValueOnce(ENTER_VALUE_SENTINEL);
    vi.mocked(clack.text).mockResolvedValueOnce("back");

    const result = await renderOptionPrompt(
      stringField,
      makeResolved(""),
      true,
    );
    expect(result).toBe(BACK_SENTINEL);
  });

  it("string: empty text input is treated as undefined (skip), NOT as Back", async () => {
    // Edge case found by Edge Case Hunter: pressing enter on an optional
    // text field should produce undefined (skip), not BACK_SENTINEL — we
    // never want a "type nothing → go back" surprise.
    vi.mocked(clack.select).mockResolvedValueOnce(ENTER_VALUE_SENTINEL);
    vi.mocked(clack.text).mockResolvedValueOnce("");

    const result = await renderOptionPrompt(
      stringField,
      makeResolved(""),
      true,
    );
    expect(result).toBeUndefined();
    expect(result).not.toBe(BACK_SENTINEL);
  });

  it("multi: multiselect returning [BACK_SENTINEL] propagates", async () => {
    // Multi returns the array as-is when no OTHER_SENTINEL; option-elicitor
    // checks the result for BACK_SENTINEL membership upstream.
    vi.mocked(clack.multiselect).mockResolvedValueOnce([BACK_SENTINEL]);
    const result = await renderOptionPrompt(multiField, makeResolved([]), true);
    // The renderer returns the array; the option-elicitor's promptWithHelp
    // wrapper is responsible for unwrapping it. We assert the renderer
    // surfaces the sentinel as part of its output.
    expect(Array.isArray(result)).toBe(true);
    expect((result as unknown[]).includes(BACK_SENTINEL)).toBe(true);
  });

  it("categorySelect: category step returning BACK_SENTINEL propagates immediately", async () => {
    vi.mocked(clack.select).mockResolvedValueOnce(BACK_SENTINEL);
    const result = await renderOptionPrompt(
      categorySelectField,
      makeResolved("t3.micro"),
      true,
    );
    expect(result).toBe(BACK_SENTINEL);
  });
});

// ── Real wizard integration: forward → back → forward through option-elicitor ─

describe("AC #3 — back navigation consistency through a real plugin", () => {
  it("S3 bucket: forward to field 3 → Back twice → forward again to completion", async () => {
    // Drive the option-elicitor's commonFields loop using the *real*
    // S3::Bucket plugin from the registry. Sequence:
    //   step 1: BucketName        → "first-bucket-name"
    //   step 2: BucketEncryption  → true
    //   step 3: PublicAccessBlock → BACK         (return to step 2)
    //   step 4: BucketEncryption  → BACK         (return to step 1)
    //   step 5: BucketName        → "second-bucket-name"
    //   step 6: BucketEncryption  → true
    //   step 7: PublicAccessBlock → true
    //   ... (continue with default answers for any remaining commonFields)
    //   advanced confirm → no
    // This exercises both the commonHistory.pop() path and the showIf
    // cleanup path that the wizard-back-navigation-ux story added.

    const plugin = defaultPluginRegistry.get(RESOURCE_TYPES.S3_BUCKET);
    expect(plugin).toBeDefined();
    if (!plugin) return;

    const callLog: Array<{ name: string; value: unknown }> = [];
    let stepCount = 0;
    vi.mocked(promptWithHelp).mockImplementation(
      async (options: { field: ResourceField }) => {
        const field = options.field;
        stepCount++;
        // Step 3: user picks Back from the third field.
        if (stepCount === 3) {
          callLog.push({ name: field.name, value: BACK_SENTINEL });
          return BACK_SENTINEL;
        }
        // Step 4: option-elicitor re-prompts the prior field, user picks
        // Back again to go further back.
        if (stepCount === 4) {
          callLog.push({ name: field.name, value: BACK_SENTINEL });
          return BACK_SENTINEL;
        }
        // Step 5: re-prompt the very first field. We give it a different
        // value so the test can verify the corrected name was preserved
        // across the back-and-forward dance.
        if (stepCount === 5 && field.name === plugin.commonFields[0]!.name) {
          callLog.push({ name: field.name, value: "second-bucket-name" });
          return "second-bucket-name";
        }
        // Steps 1, 2, 5, 6, 7+: provide a sensible default per field type.
        let value: unknown;
        switch (field.question.type) {
          case "boolean":
            value = true;
            break;
          case "string":
            value = `${field.name.toLowerCase()}-value`;
            break;
          case "enum":
            value = field.question.options?.[0]?.value ?? "default";
            break;
          case "multi": {
            const opt = field.question.options?.[0]?.value;
            value = opt ? [opt] : [];
            break;
          }
          default:
            value = field.question.initialValue ?? "default";
        }
        callLog.push({ name: field.name, value });
        return value;
      },
    );

    // Decline the advanced tier so the test stays focused on commonFields.
    vi.mocked(clack.confirm).mockResolvedValue(false);

    const result = await optionElicitorNode({
      executionStatus: ExecutionStatus.PENDING,
      resourceType: RESOURCE_TYPES.S3_BUCKET,
      elicitedOptions: undefined,
      userIntent: "",
      runId: "back-nav-integration",
    } as unknown as Parameters<typeof optionElicitorNode>[0]);

    expect(result.elicitedOptions).toBeDefined();

    // After two backs the user must have been re-prompted for the FIRST
    // common field, and the corrected value must be the one that landed
    // in elicitedOptions (not the first attempt).
    const firstFieldName = plugin.commonFields[0]!.name;
    expect(result.elicitedOptions?.[firstFieldName]).toBe("second-bucket-name");

    // Sanity: prompt log shows the back/forward dance — at least 2
    // BACK_SENTINEL invocations followed by re-prompts of earlier fields.
    const backCount = callLog.filter((c) => c.value === BACK_SENTINEL).length;
    expect(backCount).toBe(2);

    // The first field must have been prompted at least twice (once
    // initially, once after the two backs).
    const firstFieldPrompts = callLog.filter((c) => c.name === firstFieldName);
    expect(firstFieldPrompts.length).toBeGreaterThanOrEqual(2);

    // AC #4: option-elicitor MUST pass showBack=false on the very first
    // visible field (so renderOptionPrompt doesn't render the Back option
    // when there's no history to pop). The options object's showBack property.
    const firstCall = vi.mocked(promptWithHelp).mock.calls[0];
    expect(firstCall).toBeDefined();
    expect(firstCall![0].showBack).toBeFalsy();
  });
});
