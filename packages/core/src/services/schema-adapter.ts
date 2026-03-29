/**
 * Schema Adapter Layer — converts DescribeType API output to the format
 * that schema-fetcher.ts and downstream nodes (plan-generator, preflight-guard)
 * expect.
 *
 * ## Background
 *
 * The raw AWS DescribeType API returns the
 * CloudFormation Resource Provider Schema mostly as-is.  The new
 * `CloudFormationSchemaService.getSchema()` (Story 31.1) fetches the same
 * schema via the DescribeType API.  Both sources return objects conforming to
 * the Resource Provider Schema spec:
 *
 *   https://docs.aws.amazon.com/cloudformation-cli/latest/userguide/resource-type-schema.html
 *
 * ## Field mapping
 *
 * | DescribeType field          | MCP tool output field       | Mapping  |
 * |-----------------------------|-----------------------------|----------|
 * | typeName                    | typeName                    | 1:1      |
 * | description                 | description                 | 1:1      |
 * | properties                  | properties                  | 1:1      |
 * | required                    | required                    | 1:1 — defaults to [] if absent |
 * | readOnlyProperties          | readOnlyProperties          | 1:1 — JSONPointer paths       |
 * | primaryIdentifier           | primaryIdentifier           | 1:1 — JSONPointer paths       |
 * | additionalProperties        | additionalProperties        | 1:1 — defaults to false       |
 * | definitions                 | definitions                 | 1:1 — nested $ref types       |
 * | createOnlyProperties        | (not used downstream)       | Passed through if present     |
 * | writeOnlyProperties         | (not used downstream)       | Passed through if present     |
 * | handlers                    | (not used downstream)       | Stripped — not needed          |
 * | tagging                     | (not used downstream)       | Stripped — not needed          |
 * | sourceUrl                   | (not used downstream)       | Stripped — not needed          |
 * | documentationUrl            | (not used downstream)       | Stripped — not needed          |
 *
 * ## Downstream consumers
 *
 * - `plan-generator.ts` reads: `properties`, `required`, entire schema as excerpt
 * - `preflight-guard.ts` reads: `required`
 * - `schema-fetcher.ts` sets: `state.resourceSchema` (the whole object)
 *
 * @see Story 31.2
 */

/**
 * Fields that downstream pipeline nodes actually read from the schema.
 * Any field NOT in this list is either passed through for completeness
 * or intentionally stripped.
 */
const PIPELINE_CONSUMED_FIELDS = [
  "typeName",
  "description",
  "properties",
  "required",
  "readOnlyProperties",
  "primaryIdentifier",
  "additionalProperties",
  "definitions",
  "createOnlyProperties",
  "writeOnlyProperties",
] as const;

/**
 * Fields present in the full DescribeType schema that are not needed by
 * the pipeline and are stripped to reduce payload size.
 */
const STRIPPED_FIELDS = [
  "handlers",
  "tagging",
  "taggable",
  "sourceUrl",
  "documentationUrl",
  "replacementStrategy",
  "resourceLink",
  "propertyTransform",
  "typeConfiguration",
] as const;

/** The shape returned by the adapter — matches what schema-fetcher.ts historically set on state.resourceSchema */
export interface AdaptedSchema {
  typeName: string;
  description: string;
  properties: Record<string, unknown>;
  required: string[];
  readOnlyProperties: string[];
  primaryIdentifier: string[];
  additionalProperties: boolean;
  definitions?: Record<string, unknown>;
  createOnlyProperties?: string[];
  writeOnlyProperties?: string[];
  /** Allow assignment to Record<string, unknown> (used by graph state). */
  [key: string]: unknown;
}

/**
 * Adapt a raw DescribeType schema to the format expected by schema-fetcher.ts
 * and downstream pipeline nodes.
 *
 * The DescribeType API returns the full CloudFormation Resource Provider Schema.
 * The raw DescribeType output contains essentially the
 * same structure. This adapter normalises edge cases and strips non-essential
 * fields to produce format parity with the old MCP output.
 *
 * @param rawSchema - The parsed JSON schema object from DescribeType (already
 *   JSON.parsed by CloudFormationSchemaService.getSchema())
 * @returns An object matching the shape that plan-generator and other nodes expect
 */
export function adaptDescribeTypeToMcpFormat(
  rawSchema: Record<string, unknown>,
): AdaptedSchema {
  const raw = rawSchema as Record<string, unknown>;

  // --- Core fields (1:1 mapping with safe defaults) ---

  const typeName = typeof raw["typeName"] === "string" ? raw["typeName"] : "";

  const description =
    typeof raw["description"] === "string" ? raw["description"] : "";

  // `properties` — the heart of the schema; defaults to empty object
  const properties =
    raw["properties"] != null &&
    typeof raw["properties"] === "object" &&
    !Array.isArray(raw["properties"])
      ? (raw["properties"] as Record<string, unknown>)
      : {};

  // `required` — array of required property names; absent in many resource types
  const required = Array.isArray(raw["required"])
    ? (raw["required"] as string[])
    : [];

  // `readOnlyProperties` — JSONPointer paths (e.g. "/properties/Arn")
  // Both DescribeType and MCP use the same JSONPointer format; no conversion needed.
  const readOnlyProperties = Array.isArray(raw["readOnlyProperties"])
    ? (raw["readOnlyProperties"] as string[])
    : [];

  // `primaryIdentifier` — JSONPointer paths (e.g. "/properties/BucketName")
  const primaryIdentifier = Array.isArray(raw["primaryIdentifier"])
    ? (raw["primaryIdentifier"] as string[])
    : [];

  // `additionalProperties` — boolean, defaults to false (matches MCP behaviour)
  const additionalProperties =
    typeof raw["additionalProperties"] === "boolean"
      ? raw["additionalProperties"]
      : false;

  // `definitions` — nested type definitions referenced via $ref
  const definitions =
    raw["definitions"] != null &&
    typeof raw["definitions"] === "object" &&
    !Array.isArray(raw["definitions"])
      ? (raw["definitions"] as Record<string, unknown>)
      : undefined;

  // --- Optional fields passed through for completeness ---

  const createOnlyProperties = Array.isArray(raw["createOnlyProperties"])
    ? (raw["createOnlyProperties"] as string[])
    : undefined;

  const writeOnlyProperties = Array.isArray(raw["writeOnlyProperties"])
    ? (raw["writeOnlyProperties"] as string[])
    : undefined;

  // Build the adapted schema, omitting undefined optional fields
  const adapted: AdaptedSchema = {
    typeName,
    description,
    properties,
    required,
    readOnlyProperties,
    primaryIdentifier,
    additionalProperties,
  };

  if (definitions !== undefined) {
    adapted.definitions = definitions;
  }

  if (createOnlyProperties !== undefined) {
    adapted.createOnlyProperties = createOnlyProperties;
  }

  if (writeOnlyProperties !== undefined) {
    adapted.writeOnlyProperties = writeOnlyProperties;
  }

  return adapted;
}

// Re-export for convenient access
export { PIPELINE_CONSUMED_FIELDS, STRIPPED_FIELDS };
