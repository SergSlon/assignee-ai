/**
 * User-facing strings, messages, boxen styling. Domain sub-module of
 * the former `config/constants.ts` coupling hub (Story 49.5).
 */

/** User-facing cancellation messages. */
export const UserMessage = {
  INIT_CANCELLED: "Initialization cancelled.",
  WIZARD_CANCELLED: "Wizard cancelled.",
  CANCELLED: "Cancelled.",
  BULK_DESTROY_CANCELLED: "Bulk destroy cancelled.",
  DESTROY_CANCELLED: "Destroy cancelled.",
  SETUP_CANCELLED: "Setup cancelled.",
  RESOURCE_CLEANUP_CANCELLED: "Resource cleanup cancelled.",
} as const;

export const BoxenAlign = {
  CENTER: "center" as const,
  LEFT: "left" as const,
} as const;

export const BoxenBorderColor = {
  CYAN: "cyan" as const,
} as const;

/** Error prefix used when plan generation fails. */
export const PLAN_GENERATION_FAILED = "Plan generation failed" as const;

/** Example S3 intent used in help text and error messages. */
export const EXAMPLE_S3_INTENT = "Create an S3 bucket named my-bucket" as const;
