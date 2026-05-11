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
 * @see Story e92.1.a — CCAPI-shape hardening (DDB, ECS, CloudFront rules)
 */

import { CfnKey } from "../config/cfn-keys/keys.js";
import { CloudFormationKey } from "../constants/cfn-keys.js";
import { RESOURCE_TYPES } from "../config/resource-types.js";

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
 * 4. (When `resourceType` is supplied) applies resource-aware CCAPI-shape rules
 *    that a JSON schema alone cannot express — e.g., dropping
 *    `ProvisionedThroughput` when DDB `BillingMode=PAY_PER_REQUEST`.
 *
 * @param desiredState - The LLM-generated desiredState object
 * @param schema - The CloudFormation resource schema (with `properties` key)
 * @param resourceType - Optional CFN resource type (e.g. `AWS::DynamoDB::Table`)
 *                      enabling resource-specific post-processing rules
 * @returns Sanitized result with stripped/coerced audit trail
 */
export function sanitizeDesiredState(
  desiredState: Record<string, unknown>,
  schema: Record<string, unknown> | undefined,
  resourceType?: string,
): SanitizeResult {
  const strippedKeys: string[] = [];
  const coercedKeys: SanitizeResult["coercedKeys"] = [];

  let working: Record<string, unknown> = desiredState;

  // Resource-specific CCAPI-shape rules FIRST — they normalise shapes
  // (e.g. ECS ClusterSettings key-as-name → {Name,Value}) that the
  // downstream schema sanitize would otherwise strip as "extraneous".
  if (resourceType) {
    working = applyResourceRules(
      working,
      resourceType,
      strippedKeys,
      coercedKeys,
    );
  }

  if (schema) {
    const schemaProperties =
      (schema[CfnKey.CFN_PROPERTIES] as
        | Record<string, SchemaProperty>
        | undefined) ??
      (schema[CloudFormationKey.PROPERTIES] as
        | Record<string, SchemaProperty>
        | undefined) ??
      {};

    if (Object.keys(schemaProperties).length > 0) {
      working = sanitizeObject(
        working,
        schemaProperties,
        "",
        strippedKeys,
        coercedKeys,
      );
    }
  }

  return { sanitized: working, strippedKeys, coercedKeys };
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

// ──────────────────────────────────────────────────────────────
// Resource-specific CCAPI-shape rules (e92.1.a)
// ──────────────────────────────────────────────────────────────

function applyResourceRules(
  obj: Record<string, unknown>,
  resourceType: string,
  strippedKeys: string[],
  coercedKeys: SanitizeResult["coercedKeys"],
): Record<string, unknown> {
  switch (resourceType) {
    case RESOURCE_TYPES.DYNAMODB_TABLE:
      return applyDynamoDbRules(obj, strippedKeys);
    case RESOURCE_TYPES.ECS_CLUSTER:
      return applyEcsClusterRules(obj, coercedKeys);
    case RESOURCE_TYPES.CLOUDFRONT_DISTRIBUTION:
      return applyCloudFrontRules(obj, strippedKeys, coercedKeys);
    default:
      return obj;
  }
}

/**
 * DynamoDB CCAPI-shape rules (A-01, A-09, A-16):
 *   1. When BillingMode=PAY_PER_REQUEST, ProvisionedThroughput must not be
 *      present — CCAPI rejects the pair. Strip it.
 *   2. AttributeDefinitions must cover every KeySchema.AttributeName
 *      (incl. GlobalSecondaryIndexes / LocalSecondaryIndexes). When
 *      KeySchema names an attribute that the LLM omitted from
 *      AttributeDefinitions, synthesise a definition (default type=S).
 */
function applyDynamoDbRules(
  obj: Record<string, unknown>,
  strippedKeys: string[],
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...obj };

  // Rule 1: PAY_PER_REQUEST drops ProvisionedThroughput.
  const billingMode = result["BillingMode"];
  if (
    typeof billingMode === "string" &&
    billingMode === "PAY_PER_REQUEST" &&
    "ProvisionedThroughput" in result
  ) {
    delete result["ProvisionedThroughput"];
    strippedKeys.push("ProvisionedThroughput");
  }

  // Rule 2: AttributeDefinitions ↔ KeySchema parity.
  const referencedAttrs = collectKeySchemaAttrs(result);
  if (referencedAttrs.size > 0) {
    const existing = Array.isArray(result["AttributeDefinitions"])
      ? [...(result["AttributeDefinitions"] as Array<Record<string, unknown>>)]
      : [];
    const existingNames = new Set(
      existing
        .map((d) =>
          d && typeof d === "object" && typeof d["AttributeName"] === "string"
            ? (d["AttributeName"] as string)
            : undefined,
        )
        .filter((n): n is string => typeof n === "string"),
    );
    let mutated = false;
    for (const { name, type } of referencedAttrs.values()) {
      if (!existingNames.has(name)) {
        existing.push({ AttributeName: name, AttributeType: type });
        existingNames.add(name);
        mutated = true;
      }
    }
    if (mutated || !("AttributeDefinitions" in result)) {
      result["AttributeDefinitions"] = existing;
    }
  }

  // Rule 3: Strip AttributeDefinitions entries not referenced by any
  // KeySchema (table, GSI, or LSI). CCAPI rejects entries for attributes
  // that are not key attrs — e.g. TTL target attributes.
  // Only runs when KeySchema is present and non-empty so we don't
  // aggressively strip valid state when KeySchema is missing.
  const keySchemaAttrs = collectKeySchemaAttrs(result);
  if (
    keySchemaAttrs.size > 0 &&
    Array.isArray(result["AttributeDefinitions"])
  ) {
    const attrDefs = result["AttributeDefinitions"] as Array<
      Record<string, unknown>
    >;
    const retained: Array<Record<string, unknown>> = [];
    for (const def of attrDefs) {
      const attrName =
        def &&
        typeof def === "object" &&
        typeof def["AttributeName"] === "string"
          ? (def["AttributeName"] as string)
          : undefined;
      if (attrName === undefined || keySchemaAttrs.has(attrName)) {
        retained.push(def);
      } else {
        strippedKeys.push(`AttributeDefinitions[${attrName}]`);
      }
    }
    if (retained.length !== attrDefs.length) {
      result["AttributeDefinitions"] = retained;
    }
  }

  return result;
}

/**
 * Walks KeySchema / GSI / LSI and returns the set of attribute names the
 * caller must have in AttributeDefinitions. Returns a Map keyed by name so
 * duplicates (same name across GSIs) collapse.
 */
function collectKeySchemaAttrs(
  obj: Record<string, unknown>,
): Map<string, { name: string; type: string }> {
  const out = new Map<string, { name: string; type: string }>();

  const walk = (schema: unknown): void => {
    if (!Array.isArray(schema)) return;
    for (const entry of schema) {
      if (
        entry &&
        typeof entry === "object" &&
        typeof (entry as Record<string, unknown>)["AttributeName"] === "string"
      ) {
        const name = (entry as Record<string, unknown>)[
          "AttributeName"
        ] as string;
        if (!out.has(name)) {
          out.set(name, { name, type: "S" });
        }
      }
    }
  };

  walk(obj["KeySchema"]);

  const gsi = obj["GlobalSecondaryIndexes"];
  if (Array.isArray(gsi)) {
    for (const idx of gsi) {
      if (idx && typeof idx === "object") {
        walk((idx as Record<string, unknown>)["KeySchema"]);
      }
    }
  }
  const lsi = obj["LocalSecondaryIndexes"];
  if (Array.isArray(lsi)) {
    for (const idx of lsi) {
      if (idx && typeof idx === "object") {
        walk((idx as Record<string, unknown>)["KeySchema"]);
      }
    }
  }

  // If the LLM already gave us AttributeDefinitions, trust its AttributeType
  // for names it declared (so an `N` sort key isn't downgraded to `S`).
  const defs = obj["AttributeDefinitions"];
  if (Array.isArray(defs)) {
    for (const d of defs) {
      if (d && typeof d === "object") {
        const name = (d as Record<string, unknown>)["AttributeName"];
        const type = (d as Record<string, unknown>)["AttributeType"];
        if (
          typeof name === "string" &&
          typeof type === "string" &&
          out.has(name)
        ) {
          out.set(name, { name, type });
        }
      }
    }
  }

  return out;
}

/**
 * ECS Cluster CCAPI-shape rules (C-03):
 *   ClusterSettings items can arrive from the LLM as
 *   `[{containerInsights:"enabled"}]` (key-as-name form); CCAPI requires
 *   `[{Name:"containerInsights", Value:"enabled"}]`. Coerce.
 */
function applyEcsClusterRules(
  obj: Record<string, unknown>,
  coercedKeys: SanitizeResult["coercedKeys"],
): Record<string, unknown> {
  const settings = obj["ClusterSettings"];
  if (!Array.isArray(settings)) return obj;

  let mutated = false;
  const coerced = settings.map((entry, idx) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return entry;
    }
    const rec = entry as Record<string, unknown>;
    // Already in {Name,Value} shape — passthrough.
    if (typeof rec["Name"] === "string" && "Value" in rec) {
      return rec;
    }
    // Key-as-name form: {containerInsights:"enabled"} → {Name,Value}.
    const keys = Object.keys(rec);
    if (keys.length === 1) {
      const key = keys[0]!;
      const value = rec[key];
      mutated = true;
      coercedKeys.push({
        path: `ClusterSettings[${idx}]`,
        from: "key-as-name",
        to: "{Name,Value}",
      });
      return {
        Name: key,
        Value: typeof value === "string" ? value : String(value),
      };
    }
    return rec;
  });

  if (!mutated) return obj;
  return { ...obj, ClusterSettings: coerced };
}

/**
 * CloudFront Distribution CCAPI-shape rules (C-04, C-15):
 *   1. Each Origin requires exactly ONE of S3OriginConfig / CustomOriginConfig.
 *      - If DomainName looks like an S3 bucket endpoint AND both configs
 *        are present → keep S3OriginConfig, drop CustomOriginConfig.
 *      - Otherwise (non-S3 origin) → keep CustomOriginConfig, drop
 *        S3OriginConfig.
 *      - `OriginAccessIdentity:""` is an LLM placeholder — strip the empty
 *        string so CCAPI sees an absent field rather than a rejected empty.
 *   2. Origins / CacheBehaviors / CustomErrorResponses must be wrapped in
 *      `{Items,Quantity}`. LLMs sometimes emit bare arrays; canonicalise.
 */
function applyCloudFrontRules(
  obj: Record<string, unknown>,
  strippedKeys: string[],
  coercedKeys: SanitizeResult["coercedKeys"],
): Record<string, unknown> {
  const config = obj["DistributionConfig"];
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return obj;
  }
  const cfg = { ...(config as Record<string, unknown>) };

  // Canonicalise the three list fields first so subsequent Origin rules
  // operate on the {Items,Quantity} shape uniformly.
  for (const field of ["Origins", "CacheBehaviors", "CustomErrorResponses"]) {
    const raw = cfg[field];
    if (Array.isArray(raw)) {
      cfg[field] = { Items: raw, Quantity: raw.length };
      coercedKeys.push({
        path: `DistributionConfig.${field}`,
        from: "array",
        to: "{Items,Quantity}",
      });
    } else if (
      raw &&
      typeof raw === "object" &&
      Array.isArray((raw as Record<string, unknown>)["Items"])
    ) {
      // Ensure Quantity matches Items.length even if the LLM set Quantity=1
      // for a two-item Items list.
      const items = (raw as Record<string, unknown>)["Items"] as unknown[];
      const rawQty = (raw as Record<string, unknown>)["Quantity"];
      if (rawQty !== items.length) {
        cfg[field] = {
          ...(raw as Record<string, unknown>),
          Quantity: items.length,
        };
        coercedKeys.push({
          path: `DistributionConfig.${field}.Quantity`,
          from: "mismatched",
          to: "Items.length",
        });
      }
    }
  }

  // Origin-config disambiguation + OAI-empty strip.
  const originsHolder = cfg["Origins"] as Record<string, unknown> | undefined;
  if (
    originsHolder &&
    typeof originsHolder === "object" &&
    Array.isArray(originsHolder["Items"])
  ) {
    const items = originsHolder["Items"] as Array<Record<string, unknown>>;
    const fixed = items.map((origin, idx) => {
      if (!origin || typeof origin !== "object") return origin;
      const out = { ...origin };
      const domain =
        typeof out["DomainName"] === "string"
          ? (out["DomainName"] as string)
          : "";
      const looksLikeS3 = /\.s3(?:[.-][a-z0-9-]+)?\.amazonaws\.com$/.test(
        domain,
      );

      const hasS3 = "S3OriginConfig" in out;
      const hasCustom = "CustomOriginConfig" in out;

      // Strip empty-string OriginAccessIdentity (LLM placeholder).
      if (hasS3) {
        const s3 = out["S3OriginConfig"] as Record<string, unknown> | undefined;
        if (s3 && typeof s3 === "object" && s3["OriginAccessIdentity"] === "") {
          const cleaned = { ...s3 };
          delete cleaned["OriginAccessIdentity"];
          out["S3OriginConfig"] = cleaned;
          strippedKeys.push(
            `DistributionConfig.Origins.Items[${idx}].S3OriginConfig.OriginAccessIdentity`,
          );
        }
      }

      if (hasS3 && hasCustom) {
        if (looksLikeS3) {
          delete out["CustomOriginConfig"];
          strippedKeys.push(
            `DistributionConfig.Origins.Items[${idx}].CustomOriginConfig`,
          );
        } else {
          delete out["S3OriginConfig"];
          strippedKeys.push(
            `DistributionConfig.Origins.Items[${idx}].S3OriginConfig`,
          );
        }
      } else if (!hasS3 && !hasCustom) {
        // Neither config — default to CustomOriginConfig for non-S3 domains;
        // S3 domains fall through untouched (user may want OAC-only setups).
        if (!looksLikeS3 && domain) {
          out["CustomOriginConfig"] = {
            HTTPPort: 80,
            HTTPSPort: 443,
            OriginProtocolPolicy: "https-only",
          };
          coercedKeys.push({
            path: `DistributionConfig.Origins.Items[${idx}].CustomOriginConfig`,
            from: "absent",
            to: "default",
          });
        }
      }

      return out;
    });

    cfg["Origins"] = { ...originsHolder, Items: fixed };
  }

  return { ...obj, DistributionConfig: cfg };
}
