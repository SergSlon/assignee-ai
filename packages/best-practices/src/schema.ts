import { z } from "zod";
import {
  BP_SEVERITY,
  BP_CATEGORY,
  BP_CHECK_TYPE,
  BP_FIX_TYPE,
  FixType,
  FixAction,
  POLICY_ANTIPATTERN_NAMES,
} from "./types.js";
import { parseNestedArrayPredicate } from "./evaluate/predicates/nested-array-predicate.js";

const triggerSchema = z
  .object({
    resourceType: z.string().optional(),
    fieldCondition: z.string().optional(),
    patternId: z.string().optional(),
    intentKeywords: z.array(z.string()).optional(),
    always: z.boolean().optional(),
    excludePatterns: z.array(z.string()).optional(),
  })
  .strict();

export const bestPracticeSchema = z
  .object({
    id: z
      .string()
      .regex(
        /^BP-[A-Z0-9]+-\d{3}$/,
        "BP ID must match format BP-{SERVICE}-{NNN}",
      ),
    title: z.string().min(1),
    severity: z.enum(BP_SEVERITY),
    resource_type: z.string().min(1),
    property_path: z.string().min(1),
    check_type: z.enum(BP_CHECK_TYPE),
    expected_value: z.unknown(),
    source: z.string().min(1),
    source_id: z.string().optional(),
    description: z.string().optional(),
    remediation: z.string().optional(),
    category: z.enum(BP_CATEGORY),
    version: z.string().optional(),
    lastVerified: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    triggers: z.array(triggerSchema).optional(),
    autoFixable: z.boolean().optional(),
    desiredStatePatch: z.record(z.unknown()).optional(),
    blocking: z.boolean().optional().default(false),
    condition: z.record(z.unknown()).optional(),
    fix_hint: z.string().max(80).optional(),
    consequence: z.string().max(200).optional(),
    skip_when_advisory: z.array(z.string()).optional(),
    fixType: z.enum(BP_FIX_TYPE).optional(),
    interactiveOptions: z
      .array(
        z.object({
          label: z.string(),
          action: z.enum([
            FixAction.PROMPT_VALUE,
            FixAction.SET_VALUE,
            FixAction.REMOVE_PROPERTY,
            FixAction.SKIP,
          ]),
          targetField: z.string().optional(),
          targetValue: z.unknown().optional(),
        }),
      )
      .optional(),
  })
  .strict()
  .refine(
    (bp) => {
      if (bp.fixType === FixType.AUTO) {
        return bp.autoFixable === true && bp.desiredStatePatch != null;
      }
      return true;
    },
    {
      message:
        "fixType 'auto' requires autoFixable=true and a desiredStatePatch",
    },
  )
  .refine(
    (bp) => {
      if (bp.fixType === FixType.INTERACTIVE) {
        return (
          bp.interactiveOptions != null && bp.interactiveOptions.length > 0
        );
      }
      return true;
    },
    { message: "fixType 'interactive' requires non-empty interactiveOptions" },
  )
  .superRefine((bp, ctx) => {
    // M-γ-08: validate expected_value grammar for policy_antipattern
    if (bp.check_type === "policy_antipattern") {
      if (typeof bp.expected_value !== "string") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["expected_value"],
          message: `policy_antipattern expected_value must be a string; got ${typeof bp.expected_value}`,
        });
        return;
      }
      if (
        !(POLICY_ANTIPATTERN_NAMES as readonly string[]).includes(
          bp.expected_value,
        )
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["expected_value"],
          message: `Unknown policy_antipattern name "${bp.expected_value}". Known values: ${POLICY_ANTIPATTERN_NAMES.join(", ")}`,
        });
      }
    }

    // M-γ-08: validate expected_value grammar for nested_array_predicate
    if (bp.check_type === "nested_array_predicate") {
      if (typeof bp.expected_value !== "string") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["expected_value"],
          message: `nested_array_predicate expected_value must be a string; got ${typeof bp.expected_value}`,
        });
        return;
      }
      const parsed = parseNestedArrayPredicate(bp.expected_value);
      if (parsed === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["expected_value"],
          message: `nested_array_predicate expected_value does not match required grammar: '<innerArray>[?(@.<prop>=~/<regex>/<flags>)] does not exist'. Got: "${bp.expected_value}"`,
        });
      }
    }

    // M-γ-08: validate condition shape — must have field (string) and value (string | number | boolean)
    if (bp.condition !== undefined && bp.condition !== null) {
      const cond = bp.condition as Record<string, unknown>;
      if (typeof cond["field"] !== "string") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["condition", "field"],
          message: `condition.field must be a string`,
        });
      }
      const valueType = typeof cond["value"];
      if (
        valueType !== "string" &&
        valueType !== "number" &&
        valueType !== "boolean"
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["condition", "value"],
          message: `condition.value must be a string, number, or boolean; got ${valueType}`,
        });
      }
    }
  });
