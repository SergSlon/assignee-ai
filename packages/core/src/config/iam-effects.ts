/**
 * IAM policy effect constants.
 * Single source of truth — every `Effect:` in IAM policy documents must reference these constants.
 */

export const IamEffect = {
  ALLOW: "Allow",
  DENY: "Deny",
} as const;

export type IamEffectType = (typeof IamEffect)[keyof typeof IamEffect];
