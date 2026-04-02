/**
 * Core type definitions for the ResourcePlugin system.
 * Defines the data model for field elicitation — consumed by the option-elicitor node (Story 7.3).
 *
 * @see project-context.md — Open/Closed Principle section
 */

/** Context passed to fetcher functions — contains previously answered wizard field values. */
export type FetcherContext = Record<string, unknown>;

/** Supported question input types for field elicitation. */
export type QuestionType =
  | "boolean"
  | "enum"
  | "string"
  | "multi"
  | "categorySelect";

/** Named constants for question types to eliminate magic strings. */
export const QuestionTypeName = {
  BOOLEAN: "boolean" as const,
  ENUM: "enum" as const,
  STRING: "string" as const,
  MULTI: "multi" as const,
  CATEGORY_SELECT: "categorySelect" as const,
};

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
  /** Whether this option is deprecated / past EOL */
  deprecated?: boolean;
}

/**
 * Conditional display rule: show this field only when another field equals a specific value.
 * Mirrors JSON Schema if/then pattern.
 */
export interface ShowIfCondition {
  /** Field name in the same plugin's commonFields or advancedFields */
  field: string;
  /** The value the referenced field must equal for this field to be shown (exact match). */
  value?: unknown;
  /**
   * Regex pattern tested against the string value of the referenced field.
   * When set, `value` is ignored — the field is shown if the pattern matches.
   * Example: "^t[34]" matches burstable instance types t3.* and t4g.*.
   */
  pattern?: string;
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
  /** Optional inline validation — return error string or undefined. Second arg is current answers for cross-field validation. */
  validate?: (
    value: unknown,
    answers?: Record<string, unknown>,
  ) => string | undefined;
  /** If set, only show this field when the condition is met */
  showIf?: ShowIfCondition;
  /** Optional identifier for runtime option discovery (e.g., "discover-amis"). When set, the option-elicitor fetches options dynamically before prompting. */
  fetcher?: string;
  /**
   * Category groupings for `categorySelect` type. Each category groups related
   * options with a label, description, and list of options belonging to it.
   * @see Story 18.12
   */
  categories?: ReadonlyArray<{
    key: string;
    label: string;
    description: string;
    options: ReadonlyArray<{ value: string; label: string } & OptionMetadata>;
  }>;
}

/**
 * Associates a CloudFormation property name with its elicitation question config.
 */
export interface ResourceField {
  /** CloudFormation property name, e.g. "BucketName" */
  name: string;
  question: FieldQuestion;
  /**
   * Whether this field is required for resource creation.
   * When --no-wizard is set, required fields without initialValue or plugin defaults
   * cause a MissingRequiredFieldsError. Defaults to false.
   */
  required?: boolean;
  /**
   * Transforms the user's answer into the correct CloudFormation property value.
   * If absent, the raw answer is used as-is (suitable for string/number fields).
   * Return undefined to omit the field from desiredState (e.g., user answered "no").
   */
  toCfn?: (answer: unknown) => unknown;
}

/**
 * Structured CloudFormation resource output produced by toCfn() or companionResources().
 */
export interface CfnOutput {
  /** Logical ID for the CloudFormation resource, e.g. "NatGateway" */
  logicalId: string;
  /** CloudFormation resource type, e.g. RESOURCE_TYPES.EC2_NAT_GATEWAY */
  type: string;
  /** CloudFormation resource properties */
  properties: Record<string, unknown>;
}

/**
 * Describes how to elicit configuration for a specific CloudFormation resource type.
 * Consumed by the option-elicitor node to determine which questions to ask.
 */
export interface ResourcePlugin {
  /** CloudFormation resource type, e.g. RESOURCE_TYPES.S3_BUCKET */
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
  /**
   * Optional method to transform desiredState into one or more CfnOutput resources.
   * Used by plugins that need to produce multiple CloudFormation resources (e.g., NatGateway + EIP).
   */
  toCfn?: (desiredState: Record<string, unknown>) => CfnOutput[];
  /**
   * Optional method to generate companion resources for this plugin (e.g., auto-provisioned LogGroups).
   * @see Story 25.6 — LogGroup co-provisioning
   */
  companionResources?: (desiredState: Record<string, unknown>) => CfnOutput[];
}
