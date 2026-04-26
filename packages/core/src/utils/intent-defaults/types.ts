/**
 * Intent-defaults types. Shared by all rule modules and the resolver.
 */

/** A single field default override derived from intent analysis. */
export interface IntentDefaultOverride {
  /** CloudFormation property name, e.g. "InstanceType" */
  fieldName: string;
  /** Default value to inject */
  value: unknown;
  /** Explanation shown as clack hint, e.g. "Selected for web serving — burstable with 2 GiB RAM" */
  reason: string;
  /**
   * Tells the categorySelect renderer which category to pre-select,
   * skipping the category step. E.g., "burstable", "compute", "memory".
   * @see Story 18.12
   */
  categoryHint?: string;
  /**
   * When true, the wizard MUST skip this field without prompting the user.
   * The value will be pre-injected into elicitedOptions so the provisioner
   * receives it at apply time (e.g. SSH_KEY_PLACEHOLDER triggers auto-create).
   * The user can still override via `--set fieldName=value`.
   * @see EC2 SSH bundle — KeyName auto-create
   */
  autoProvision?: boolean;
}

/** Rule definition for keyword-to-override mapping. Exported for matrix tests. */
export interface IntentRule {
  resourceType: string;
  keywords: string[];
  overrides: IntentDefaultOverride[];
}
