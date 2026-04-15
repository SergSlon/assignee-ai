/**
 * JSON Patch (RFC 6902) construction for `assignee reconcile`.
 * Wave-6d F4: split out of reconcile.ts (SRP).
 */
import {
  ChangeType,
  CloudFormationSchemaService,
  adaptDescribeTypeToMcpFormat,
  type DriftedField,
} from "@assignee/core";

/**
 * Fetch the createOnlyProperties for a CloudFormation resource type.
 * Returns an array of JSON pointer paths (e.g. ["/properties/FunctionName"]).
 */
export async function fetchCreateOnlyProperties(
  resourceType: string,
): Promise<string[]> {
  try {
    const service = new CloudFormationSchemaService();
    const rawSchema = await service.getSchema(resourceType);
    const adapted = adaptDescribeTypeToMcpFormat(
      rawSchema as Record<string, unknown>,
    );
    return Array.isArray(adapted.createOnlyProperties)
      ? adapted.createOnlyProperties
      : [];
  } catch {
    return [];
  }
}

/**
 * RFC 6901 escape rules for a JSON Pointer reference token: `~` must be
 * encoded as `~0` and `/` as `~1`. The order matters — `~` must be encoded
 * BEFORE `/` so the resulting `~1` is not double-escaped to `~01`.
 */
export function escapeJsonPointerSegment(segment: string): string {
  return segment.replaceAll("~", "~0").replaceAll("/", "~1");
}

/**
 * Normalise a drifted-field path to the JSON-pointer format used by
 * CloudFormation's createOnlyProperties (e.g. "/properties/FunctionName").
 *
 * Property names containing `/` or `~` (rare but legal in CloudFormation
 * resource schemas) are escaped per RFC 6901.
 */
export function fieldPathToJsonPointer(fieldPath: string): string {
  // Split into segments on `.` (object navigation) and `[index]` (array
  // navigation), escape each segment per RFC 6901, then re-join.
  const normalized = fieldPath.replace(/\[(\d+)\]/g, ".$1");
  const segments = normalized.split(".").filter((s) => s.length > 0);
  const escaped = segments.map(escapeJsonPointerSegment);
  return "/" + escaped.join("/");
}

export function fieldPathToSchemaPointer(fieldPath: string): string {
  return "/properties" + fieldPathToJsonPointer(fieldPath);
}

/**
 * Build a JSON Patch (RFC 6902) from drifted fields to restore desired
 * state. If createOnlyProperties are provided, create-only fields are
 * excluded from the patch and surfaced separately for warning output.
 */
export function buildPatchDocument(
  driftedFields: DriftedField[],
  createOnlyProperties: string[] = [],
): { ops: object[]; skippedCreateOnly: DriftedField[] } {
  const ops: object[] = [];
  const skippedCreateOnly: DriftedField[] = [];

  for (const field of driftedFields) {
    const jsonPath = fieldPathToJsonPointer(field.path);

    const schemaPointer = fieldPathToSchemaPointer(field.path);
    if (createOnlyProperties.includes(schemaPointer)) {
      skippedCreateOnly.push(field);
      continue;
    }

    switch (field.changeType) {
      case ChangeType.MODIFIED:
        ops.push({ op: "replace", path: jsonPath, value: field.desiredValue });
        break;
      case ChangeType.REMOVED:
        // Field was removed externally — add it back with desired value
        ops.push({ op: "add", path: jsonPath, value: field.desiredValue });
        break;
      case ChangeType.ADDED_EXTERNALLY:
        // Field was added externally — remove it to restore desired state
        ops.push({ op: "remove", path: jsonPath });
        break;
    }
  }

  return { ops, skippedCreateOnly };
}
