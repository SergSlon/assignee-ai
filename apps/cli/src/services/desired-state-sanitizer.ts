/**
 * Post-LLM desiredState sanitizer — strips extraneous CloudFormation properties
 * and coerces mistyped values before sending to the CloudControl API.
 *
 * The plan-generator LLM sometimes outputs properties not in the schema
 * (e.g., PointInTimeRecoveryEnabled, ContainerInsights, DeletionProtection)
 * or uses string values where integers are required (e.g., "256" for MaximumMessageSize).
 *
 * This sanitizer runs AFTER the LLM generates desiredState and BEFORE it is returned.
 *
 * @see Story E2E.1 — MCP Pipeline Production Code Fixes
 */

import { CfnKey } from "@assignee/core";
import { CloudFormationKey } from "../constants/cfn-keys.js";

export interface SanitizeResult {
  /** Sanitized desiredState with extraneous keys removed and types coerced. */
  sanitized: Record<string, unknown>;
  /** Keys that were stripped (with dot-path for nested). */
  strippedKeys: string[];
  /** Keys whose values were type-coerced (with dot-path and from→to type). */
  coercedKeys: Array<{ path: string; from: string; to: string }>;
}

/**
 * Schema property shape from CloudFormation Registry.
 * Minimal interface for what we need — the real schema has more fields.
 */
interface SchemaProperty {
  type?: string;
  properties?: Record<string, SchemaProperty>;
  items?: SchemaProperty;
}

/**
 * Sanitizes a desiredState object against its CloudFormation schema.
 *
 * 1. Recursively strips keys not present in `schema.properties`
 * 2. Coerces string values to integers/numbers when schema expects integer/number
 * 3. Coerces string "true"/"false" to booleans when schema expects boolean
 *
 * @param desiredState - The LLM-generated desiredState object
 * @param schema - The CloudFormation resource schema (with `properties` key)
 * @returns Sanitized result with stripped/coerced audit trail
 */
export function sanitizeDesiredState(
  desiredState: Record<string, unknown>,
  schema: Record<string, unknown> | undefined,
): SanitizeResult {
  const strippedKeys: string[] = [];
  const coercedKeys: SanitizeResult["coercedKeys"] = [];

  if (!schema) {
    return { sanitized: desiredState, strippedKeys, coercedKeys };
  }

  const schemaProperties =
    (schema[CfnKey.CFN_PROPERTIES] as
      | Record<string, SchemaProperty>
      | undefined) ??
    (schema[CloudFormationKey.PROPERTIES] as
      | Record<string, SchemaProperty>
      | undefined) ??
    {};

  if (Object.keys(schemaProperties).length === 0) {
    return { sanitized: desiredState, strippedKeys, coercedKeys };
  }

  const sanitized = sanitizeObject(
    desiredState,
    schemaProperties,
    "",
    strippedKeys,
    coercedKeys,
  );

  return { sanitized, strippedKeys, coercedKeys };
}

function sanitizeObject(
  obj: Record<string, unknown>,
  schemaProps: Record<string, SchemaProperty>,
  prefix: string,
  strippedKeys: string[],
  coercedKeys: SanitizeResult["coercedKeys"],
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const validKeys = new Set(Object.keys(schemaProps));

  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;

    if (!validKeys.has(key)) {
      strippedKeys.push(path);
      continue;
    }

    const propSchema = schemaProps[key];
    if (!propSchema) {
      result[key] = value;
      continue;
    }

    result[key] = sanitizeValue(
      value,
      propSchema,
      path,
      strippedKeys,
      coercedKeys,
    );
  }

  return result;
}

function sanitizeValue(
  value: unknown,
  propSchema: SchemaProperty,
  path: string,
  strippedKeys: string[],
  coercedKeys: SanitizeResult["coercedKeys"],
): unknown {
  const schemaType = propSchema.type;

  // Recursively sanitize nested objects
  if (
    schemaType === "object" &&
    propSchema.properties &&
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  ) {
    return sanitizeObject(
      value as Record<string, unknown>,
      propSchema.properties,
      path,
      strippedKeys,
      coercedKeys,
    );
  }

  // Recursively sanitize array items
  if (schemaType === "array" && propSchema.items && Array.isArray(value)) {
    return value.map((item, idx) =>
      sanitizeValue(
        item,
        propSchema.items!,
        `${path}[${idx}]`,
        strippedKeys,
        coercedKeys,
      ),
    );
  }

  // Type coercion: string → integer (strict — entire string must be numeric)
  if (schemaType === "integer" && typeof value === "string") {
    const trimmed = value.trim();
    if (/^-?\d+$/.test(trimmed)) {
      const parsed = parseInt(trimmed, 10);
      coercedKeys.push({ path, from: "string", to: "integer" });
      return parsed;
    }
  }

  // Type coercion: string → number (strict — entire string must be numeric)
  if (schemaType === "number" && typeof value === "string") {
    const trimmed = value.trim();
    if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
      const parsed = parseFloat(trimmed);
      coercedKeys.push({ path, from: "string", to: "number" });
      return parsed;
    }
  }

  // Type coercion: string → boolean
  if (schemaType === "boolean" && typeof value === "string") {
    const lower = value.toLowerCase();
    if (lower === "true" || lower === "false") {
      coercedKeys.push({ path, from: "string", to: "boolean" });
      return lower === "true";
    }
  }

  // Type coercion: integer/number → string (e.g., RDS AllocatedStorage: schema expects "20" not 20)
  if (schemaType === "string" && typeof value === "number") {
    coercedKeys.push({ path, from: "number", to: "string" });
    return String(value);
  }

  // Type coercion: boolean → string
  if (schemaType === "string" && typeof value === "boolean") {
    coercedKeys.push({ path, from: "boolean", to: "string" });
    return String(value);
  }

  return value;
}
