/**
 * Reverse mapping from human-friendly names → CfnKey values.
 * Supports case-insensitive lookup + common aliases (e.g., "size" → "InstanceType").
 * Used by --set to accept human-readable field names.
 */
import { CfnKey } from "@assignee/core";
import { FRIENDLY_NAMES } from "./friendly-names.js";

const REVERSE_FRIENDLY: Map<string, string> = new Map();
for (const [cfnKey, friendlyName] of Object.entries(FRIENDLY_NAMES)) {
  REVERSE_FRIENDLY.set(friendlyName.toLowerCase(), cfnKey);
}
// Common aliases
REVERSE_FRIENDLY.set("size", CfnKey.INSTANCE_TYPE);
REVERSE_FRIENDLY.set("type", CfnKey.INSTANCE_TYPE);
REVERSE_FRIENDLY.set("ami", CfnKey.IMAGE_ID);
REVERSE_FRIENDLY.set("key", CfnKey.KEY_NAME);
REVERSE_FRIENDLY.set("subnet", CfnKey.SUBNET_ID);
REVERSE_FRIENDLY.set("memory", CfnKey.MEMORY_SIZE);
REVERSE_FRIENDLY.set("runtime", CfnKey.RUNTIME);
REVERSE_FRIENDLY.set("engine", CfnKey.ENGINE);
REVERSE_FRIENDLY.set("storage", CfnKey.ALLOCATED_STORAGE);
REVERSE_FRIENDLY.set("name", CfnKey.BUCKET_NAME);
REVERSE_FRIENDLY.set("retention", CfnKey.RETENTION_IN_DAYS);
REVERSE_FRIENDLY.set("port", CfnKey.FROM_PORT);
REVERSE_FRIENDLY.set("protocol", CfnKey.PROTOCOL_TYPE);
REVERSE_FRIENDLY.set("region", CfnKey.AVAILABILITY_ZONE);

/**
 * Resolves a --set key to a CfnKey. Accepts:
 * 1. Exact CfnKey (e.g., "InstanceType") — returned as-is
 * 2. Human-friendly name (e.g., "Instance Type") — resolved via FRIENDLY_NAMES
 * 3. Common alias (e.g., "size") — resolved via aliases
 */
export function resolveSetKey(key: string): string {
  if (/^[A-Z]/.test(key)) return key;
  return REVERSE_FRIENDLY.get(key.toLowerCase()) ?? key;
}
