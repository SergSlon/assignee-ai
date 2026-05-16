# Variant-matrix harness

> Story 108-B-01 — Wave 0 foundation. All other 108-A and 108-B test stories
> depend on this harness being committed first.

The variant-matrix harness provides machine-enumerable coverage for the
combinatorial axis space: CLI command × resource type × intent shape × compound
pattern × BP rule. It ensures that when a new resource type, pattern, or command
is added to the registry, CI fails until a corresponding test entry is added.

---

## Contents

| File                       | Purpose                                                             |
| -------------------------- | ------------------------------------------------------------------- |
| `index.ts`                 | Registry-driven axis enumeration + in-memory matrix registry        |
| `mock-llm-adapter.ts`      | Shared `MockLlmAdapter` contract with `forScriptedResponse` factory |
| `drift-guard.test.ts`      | Enforces registry parity (fails CI on missing entries)              |
| `type-intent-seed.test.ts` | All N types × {CREATE, DESCRIBE, DESTROY} baseline coverage         |
| `mock-llm-adapter.test.ts` | Unit tests for the MockLlmAdapter contract (Axes C, D)              |
| `README.md`                | This file                                                           |

---

## (a) How to enumerate axes

All enumeration functions live in `index.ts`:

```typescript
import {
  enumerateTypes, // → SUPPORTED_TYPES_ARRAY (38+ types)
  enumeratePatterns, // → defaultPatternRegistry.list() (13+ patterns)
  enumerateBpRules, // → all BP rule IDs from YAML files (185+ rules)
  enumerateCommands, // → CLI_COMMANDS tuple (17 commands)
} from "./__tests__/variant-matrix/index.js";
```

Each function returns the **live** registry value at call time — no static
counts are hardcoded. Adding a new type to `SUPPORTED_TYPES_ARRAY` immediately
changes `enumerateTypes()` output without any manual update to this harness.

---

## (b) How to add a new axis for a new story

### Adding coverage for a new resource type

1. The type is already in `SUPPORTED_TYPES_ARRAY` once the plugin lands.
2. `type-intent-seed.test.ts` uses `it.each(enumerateTypes())` — it auto-
   generates a new row for the new type. No edit needed.
3. `drift-guard.test.ts` will pass automatically because the seed test also
   calls `registerMatrixEntry({key: type, axis: 'type', intentShape})`.

### Adding a new intent shape axis (e.g. UPDATE)

1. Add `UPDATE: 'UPDATE'` to `INTENT_SHAPES` in `index.ts`.
2. Add `'UPDATE'` to `BASELINE_INTENT_SHAPES` if it should be part of
   the default seed.
3. Add a test in `type-intent-seed.test.ts` for the UPDATE shape.
4. Run `pnpm build` to catch TypeScript errors.

### Adding a new compound pattern

1. Register the pattern in `packages/core/src/pattern-templates/index.ts`.
2. `enumeratePatterns()` returns it automatically.
3. Add a `registerMatrixEntry({key: patternId, axis: 'pattern'})` call in
   the relevant pattern test or in `drift-guard.test.ts`'s `seedBaselinePatterns`.
4. If you don't add the entry, `drift-guard.test.ts` "Axis B — pattern coverage"
   test will fail CI.

### Adding a new CLI command

1. Add the command name to the `CLI_COMMANDS` tuple in `index.ts`. This is
   intentionally manual — it's a compile-time signal that a new command was
   added and the matrix needs updating.
2. Add a `registerMatrixEntry({key: commandName, axis: 'command'})` entry in
   `drift-guard.test.ts`'s `seedBaselineCommands`.
3. Run `pnpm build` — the TypeScript tuple ensures the name is valid.

### Adding a full custom axis

1. Create a new enumeration function in `index.ts` (e.g. `enumerateRegions()`).
2. Create a new `*.test.ts` file in this directory for the axis.
3. Register entries via `registerMatrixEntry({key, axis: 'your-axis'})`.
4. Add a drift-guard assertion in `drift-guard.test.ts`.

---

## (c) How the drift-guard threshold works

The drift-guard does NOT use a static numeric threshold. Instead it performs
**key-level coverage checks**:

```
for every key in enumerateTypes():
  expect(coveredKeys.has(key)).toBe(true)
```

This means:

- **Adding a type** → drift-guard fails until a matrix entry is registered.
- **Removing a type** → drift-guard passes (no orphan entry error).
- **The sentinel injection tests** (Axis A, Axis B) simulate the failure by
  augmenting the enumerated list with a fake key and asserting the guard fires.

### Updating after a new type/pattern lands

1. Add a test case (or extend an `it.each`) that registers the entry.
2. Run `pnpm --filter @assignee/core test --max-workers=2` to verify.
3. The drift-guard test will pass once the entry is registered.

---

## Using `resolveIntentForType` in new stories

```typescript
import { MockLlmAdapter } from "../variant-matrix/mock-llm-adapter.js";
import { resolveIntentForType } from "../../graph/nodes/intent-parser/resolve-intent-for-type.js";

// Mock AWS discovery port (always required — prevents real SDK calls):
vi.mock("../../services/resource-discovery-port.js", () => ({
  productionResourceDiscoveryPort: vi.fn().mockReturnValue({
    discoverVpcs: vi.fn().mockResolvedValue([]),
    discoverSubnetGroups: vi.fn().mockResolvedValue([]),
    discoverEcsClusters: vi.fn().mockResolvedValue([]),
    discoverElbs: vi.fn().mockResolvedValue([]),
  }),
}));

// Then in the test:
const llm = MockLlmAdapter.forScriptedResponse("AWS::S3::Bucket", "CREATE");
const result = await resolveIntentForType("AWS::S3::Bucket", "CREATE", llm);
expect(result).not.toBeNull();
expect(result!.resourceType).toBe("AWS::S3::Bucket");
```

---

## Running the harness locally

```bash
# From the repo root — run only the variant-matrix tests with 2 workers max:
pnpm --filter @assignee/core test --reporter=verbose --max-workers=2 \
  --testPathPattern='variant-matrix'

# Full core package tests (coordinator uses this for the serial gate):
pnpm --filter @assignee/core test
```

> **Never** run `pnpm test` / `pnpm -r test:coverage` concurrently with other
> parallel dev-wave workers — each invocation spawns up to 32 vitest workers
> (`feedback_no_parallel_pnpm_test`).
