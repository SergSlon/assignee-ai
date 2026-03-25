# Story E2E.3: Generic Required-Field Repairer for Plan Generator

Status: done

## Story

As a developer using assignee.ai MCP server,
I want missing required CloudFormation fields to be automatically filled from plugin defaults after LLM generation,
so that plans never fail at preflight for fields that have known safe defaults.

## Acceptance Criteria (BDD)

### AC1: Generic repair for all 23 resource types

```gherkin
Given the plan-generator LLM produces a desiredState with missing required fields
When the repairer runs after the sanitizer
Then missing required fields are filled from plugin defaults (initialValue → plugin.defaults fallback)
And toCfn transforms are applied to repaired values
And injected fields are logged with their source
And the desiredState passes preflight-guard validation
```

### AC2: Lambda Code special case removed

```gherkin
Given the Lambda plugin
When Code is a required schema field and the LLM doesn't generate it
Then the repairer injects it from the Lambda plugin's defaults (ZipFile placeholder)
And the one-off Lambda Code if-block in plan-generator is removed
```

### AC3: No false repairs

```gherkin
Given a field is required but has no plugin default and no initialValue
Then the repairer does NOT inject a placeholder
And preflight-guard reports the missing field as before
```

### AC4: elicitedOptions take precedence

```gherkin
Given elicitedOptions already contain a required field value
When the repairer runs
Then it does NOT override the elicitedOptions value
```

## Tasks / Subtasks

- [ ] Task 1: Create required-field-repairer.ts (AC: #1, #3, #4)
  - [ ] 1.1 Create `apps/cli/src/services/required-field-repairer.ts`
  - [ ] 1.2 Function `repairRequiredFields(desiredState, resourceType, schemaRequired)` that:
    - Gets plugin from `defaultPluginRegistry.get(resourceType)`
    - For each schema-required field missing from desiredState:
      - Checks `field.question.initialValue` (user-visible default)
      - Falls back to `plugin.defaults[fieldName]`
      - Applies `field.toCfn()` if transform exists
      - Skips if no default available (let preflight catch it)
    - Returns `{ repaired, injectedFields: string[] }`
  - [ ] 1.3 Skip fields already present in desiredState (AC #4)

- [ ] Task 2: Add Lambda Code to plugin defaults (AC: #2)
  - [ ] 2.1 In `packages/core/src/resource-plugins/plugins/lambda-function.ts`, add `Code` to plugin defaults:
    ```
    Code: { ZipFile: "exports.handler = async (event) => ({ statusCode: 200, body: 'placeholder' });" }
    ```
  - [ ] 2.2 Add `Code` as a field with `required: true` if not already present (or handle via schema required list)

- [ ] Task 3: Integrate repairer into plan-generator (AC: #1)
  - [ ] 3.1 In `plan-generator.ts`, call `repairRequiredFields()` after sanitizer, before return
  - [ ] 3.2 Remove the Lambda Code special-case if-block (lines ~578-591)
  - [ ] 3.3 Log injected fields via existing logger

- [ ] Task 4: Write comprehensive tests (AC: #1, #2, #3)
  - [ ] 4.1 Create `apps/cli/src/services/required-field-repairer.test.ts`
  - [ ] 4.2 Test: SSM Parameter — fills Name, Value, Type from initialValues
  - [ ] 4.3 Test: Lambda — fills Code from plugin defaults
  - [ ] 4.4 Test: CloudWatch Alarm — fills ComparisonOperator, Statistic, Period from initialValues
  - [ ] 4.5 Test: ECR Repository — fills RepositoryName (but only if available)
  - [ ] 4.6 Test: No-op when all required fields present
  - [ ] 4.7 Test: No-op when plugin not found (generic/unknown type)
  - [ ] 4.8 Test: Does NOT override existing desiredState values
  - [ ] 4.9 Test: toCfn transforms applied to repaired values
  - [ ] 4.10 Update integration test for Lambda placeholder (now via repairer, not special case)

## Dev Notes

### Critical Files

| File                                                            | Change                                               |
| --------------------------------------------------------------- | ---------------------------------------------------- |
| `apps/cli/src/services/required-field-repairer.ts`              | **NEW** — generic repair function                    |
| `apps/cli/src/nodes/plan-generator.ts`                          | Integrate repairer, remove Lambda special case       |
| `packages/core/src/resource-plugins/plugins/lambda-function.ts` | Add Code to defaults                                 |
| `apps/cli/src/services/required-field-repairer.test.ts`         | **NEW** — tests                                      |
| `apps/cli/src/services/graph-state.ts`                          | Remove `placeholderCodeInjected` if no longer needed |

### Plugin Data Flow

```
LLM output → sanitizer(strip+coerce) → repairer(fill required) → return desiredState
                                              ↑
                                    plugin.defaults + field.initialValue + field.toCfn
```

### Key Constraint

The repairer fills from PLUGIN data only — never guesses, never uses LLM. If no plugin default exists for a required field, it stays missing and preflight reports it. This is safe because plugin authors explicitly define what defaults are reasonable.

### References

- [Source: packages/core/src/resource-plugins/types.ts] — ResourcePlugin, ResourceField interfaces
- [Source: packages/core/src/resource-plugins/index.ts] — defaultPluginRegistry
- [Source: apps/cli/src/services/desired-state-sanitizer.ts] — sanitizer pattern to follow
- [Source: apps/cli/src/nodes/plan-generator.ts#578-591] — Lambda special case to remove

## Dev Agent Record

### Agent Model Used

Claude Opus 4.6
