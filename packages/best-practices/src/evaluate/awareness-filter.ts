/**
 * Awareness check types — they unconditionally "fail" so that the
 * corresponding best-practice fires an informational finding. Kept in a
 * dedicated module (SRP) so adding new awareness-family types does not
 * disturb the rule-runner switch.
 */

export type AwarenessCheckType =
  | "awareness"
  | "cross_resource_count"
  | "cross_resource_reference";

const AWARENESS_TYPES: ReadonlySet<string> = new Set<AwarenessCheckType>([
  "awareness",
  "cross_resource_count",
  "cross_resource_reference",
]);

/** True when the given check type is an awareness-family informational check. */
export function isAwarenessCheck(checkType: string): boolean {
  return AWARENESS_TYPES.has(checkType);
}
