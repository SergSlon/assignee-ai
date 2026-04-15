/**
 * Static x86 → Graviton (ARM) equivalence maps for the cost-optimizer.
 *
 * EC2 mappings live in the shared advice/constants.ts `ARM_EQUIVALENTS`
 * table. RDS mappings are local to the optimizer because A7 is the
 * first consumer of an RDS-specific Graviton mapping.
 */
import { ARM_EQUIVALENTS } from "../constants.js";

/**
 * Derive the ARM-equivalent instance type for a given EC2 instance
 * type. Returns `null` when the input type is not in the ARM
 * equivalence map (e.g. already ARM, or a family without a Graviton
 * counterpart).
 */
export function armEquivalentEc2(instanceType: string): string | null {
  for (const [x86Prefix, armPrefix] of Object.entries(ARM_EQUIVALENTS)) {
    if (instanceType.startsWith(x86Prefix)) {
      return instanceType.replace(x86Prefix, armPrefix);
    }
  }
  return null;
}

/**
 * Derive the Graviton-equivalent RDS instance class (e.g.
 * `db.r5.large` → `db.r6g.large`). Returns `null` when no known
 * mapping applies.
 */
export function gravitonEquivalentRds(instanceClass: string): string | null {
  // Static mapping — matches the existing RDS_LARGE_CLASS_PREFIXES
  // in advice/constants.ts. Kept inline here because A7 is the
  // first consumer of an RDS-specific Graviton mapping.
  const rdsArmEquivalents: Record<string, string> = {
    "db.t3.": "db.t4g.",
    "db.m5.": "db.m6g.",
    "db.m6i.": "db.m6g.",
    "db.r5.": "db.r6g.",
    "db.r6i.": "db.r6g.",
    "db.c5.": "db.c6g.",
  };
  for (const [x86Prefix, armPrefix] of Object.entries(rdsArmEquivalents)) {
    if (instanceClass.startsWith(x86Prefix)) {
      return instanceClass.replace(x86Prefix, armPrefix);
    }
  }
  return null;
}
