/**
 * Core type definitions for the ResourcePlugin system.
 * Defines the data model for field elicitation — consumed by the option-elicitor node (Story 7.3).
 *
 * @see project-context.md — Open/Closed Principle section
 */

/** Supported question input types for field elicitation. */
export type QuestionType = "boolean" | "enum" | "string" | "multi";

/**
 * Optional metadata for enriched option display (Story 10.2).
 * Extensible — BP library (Epic 12) will add compliance/security flags later.
 */
export interface OptionMetadata {
  /** Estimated cost hint, e.g. "$0.023/GB-mo" or "~2x cost" */
  costHint?: string;
  /** Suitability hint, e.g. "Best for frequently accessed data" */
  fitHint?: string;
  /** Whether this option is the recommended choice */
  recommended?: boolean;
}

/**
 * Conditional display rule: show this field only when another field equals a specific value.
 * Mirrors JSON Schema if/then pattern.
 */
export interface ShowIfCondition {
  /** Field name in the same plugin's commonFields or advancedFields */
  field: string;
  /** The value the referenced field must equal for this field to be shown */
  value: unknown;
}

/**
 * Configuration for how a CloudFormation property is presented to the user during elicitation.
 */
export interface FieldQuestion {
  type: QuestionType;
  /** Human-readable prompt label */
  label: string;
  /** Placeholder text for string/enum inputs */
  placeholder?: string;
  /** Required for 'enum' and 'multi' types */
  options?: ReadonlyArray<{ value: string; label: string } & OptionMetadata>;
  /** Pre-filled default value shown to user */
  initialValue?: unknown;
  /** Contextual hint displayed before the prompt (e.g., cost/tradeoff note for boolean fields) */
  hint?: string;
  /** Optional inline validation — return error string or undefined */
  validate?: (value: unknown) => string | undefined;
  /** If set, only show this field when the condition is met */
  showIf?: ShowIfCondition;
}

/**
 * Associates a CloudFormation property name with its elicitation question config.
 */
export interface ResourceField {
  /** CloudFormation property name, e.g. "BucketName" */
  name: string;
  question: FieldQuestion;
}

/**
 * Describes how to elicit configuration for a specific CloudFormation resource type.
 * Consumed by the option-elicitor node to determine which questions to ask.
 */
export interface ResourcePlugin {
  /** CloudFormation resource type, e.g. "AWS::S3::Bucket" */
  resourceType: string;
  /**
   * Fields surfaced to all users by default (≤10).
   * Ordered by recommended elicitation sequence.
   */
  commonFields: ResourceField[];
  /**
   * Fields surfaced only when user confirms "Configure advanced options?".
   * Ordered by recommended elicitation sequence.
   */
  advancedFields: ResourceField[];
  /**
   * Default values for fields not explicitly set by user or org policy.
   * Keys are CloudFormation property names (PascalCase).
   */
  defaults: Record<string, unknown>;
  /**
   * Optional prompt hints injected into the plan_generator prompt as resource-specific rules.
   * Each string is a rule that takes precedence over general LLM rules.
   * Example: ["Runtime MUST be one of: nodejs22.x ...", "OMIT Role if user didn't provide ARN"]
   */
  configHints?: string[];
}
