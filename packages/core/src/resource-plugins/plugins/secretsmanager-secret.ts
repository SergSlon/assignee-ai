import { RESOURCE_TYPES } from "../../config/resource-types.js";
import type { ResourcePlugin } from "../types.js";

/**
 * ResourcePlugin for AWS::SecretsManager::Secret.
 * commonFields: Name (required), Description, GenerateSecretString (boolean),
 * KmsKeyId, Tags.
 * advancedFields: SecretString (showIf GenerateSecretString=false, sensitive),
 * GenerateSecretStringConfig (JSON), ReplicaRegions (multi).
 *
 * Security: SecretString is deliberately gated behind GenerateSecretString=false
 * and marked sensitive — plaintext secrets in wizard/terminal output is a security risk.
 * Prefer GenerateSecretString for auto-generated passwords.
 */
export const secretsManagerSecretPlugin: ResourcePlugin = {
  resourceType: RESOURCE_TYPES.SECRETSMANAGER_SECRET,
  commonFields: [
    {
      name: "Name",
      required: true,
      question: {
        type: "string",
        label: "Secret name",
        placeholder: "my-app/production/db-password",
        hint: "Unique name for this secret. Use path-style names for organization (e.g., app/env/secret). Max 512 characters. Cannot be changed after creation.",
        validate: (value: unknown) => {
          if (!value) return "Secret name is required";
          const s = String(value);
          if (s.length > 512)
            return "Secret name must be 512 characters or fewer";
          if (!/^[a-zA-Z0-9/_+=.@-]+$/.test(s))
            return "Secret name can only contain alphanumeric characters, /, _, +, =, ., @, and -";
          return undefined;
        },
      },
    },
    {
      name: "Description",
      question: {
        type: "string",
        label: "Description",
        placeholder: "Database password for my-app production",
        hint: "Human-readable description of what this secret stores. Max 2048 characters.",
        validate: (value: unknown) => {
          if (!value) return undefined;
          if (String(value).length > 2048)
            return "Description must be 2048 characters or fewer";
          return undefined;
        },
      },
    },
    {
      name: "GenerateSecretString",
      question: {
        type: "boolean",
        label: "Auto-generate a random secret value?",
        initialValue: true,
        hint: "Recommended: generates a cryptographically random password. If disabled, you must supply a plaintext SecretString (less secure — visible in CloudFormation state).",
      },
      toCfn: (answer: unknown) =>
        answer ? { PasswordLength: 32, ExcludePunctuation: false } : undefined,
    },
    {
      name: "KmsKeyId",
      question: {
        type: "string",
        label: "KMS Key ID or ARN",
        placeholder: "arn:aws:kms:... or alias/my-key",
        initialValue: "",
        hint: "ARN or alias of a KMS key for encryption. Default uses the AWS-managed key (aws/secretsmanager). Use a customer-managed key (CMK) for full control over key rotation, auditing, and cross-account access.",
        validate: (value: unknown) => {
          if (!value) return undefined;
          const s = String(value);
          if (
            s === "aws/secretsmanager" ||
            s.startsWith("arn:aws:kms:") ||
            s.startsWith("alias/")
          )
            return undefined;
          return "Must be 'aws/secretsmanager', a KMS key ARN, or a key alias (alias/...)";
        },
      },
    },
    {
      name: "Tags",
      question: {
        type: "string",
        label: "Tags",
        placeholder: "env:production, team:backend",
        hint: "Comma-separated Key:Value pairs for cost tracking and organization.",
      },
      toCfn: (answer: unknown) => {
        if (typeof answer !== "string" || !answer.trim()) return undefined;
        return answer
          .split(",")
          .filter((p) => p.includes(":"))
          .map((pair) => {
            const [Key, ...rest] = pair.trim().split(":");
            return { Key: Key!.trim(), Value: rest.join(":").trim() };
          });
      },
    },
  ],
  advancedFields: [
    {
      name: "SecretString",
      question: {
        type: "string",
        label: "Secret value (plaintext — NOT recommended)",
        placeholder: "my-secret-value",
        hint: "WARNING: This value will be stored in plaintext in the CloudFormation template and state file. Use auto-generate instead unless you must supply a specific value. Never use for production credentials.",
        showIf: { field: "GenerateSecretString", value: false },
        validate: (value: unknown) => {
          if (!value)
            return "Secret value is required when not using auto-generate";
          if (String(value).length > 65536)
            return "Secret value must be 65536 characters or fewer";
          return undefined;
        },
      },
    },
    {
      name: "GenerateSecretStringConfig",
      question: {
        type: "string",
        label: "Password generation config (JSON)",
        placeholder: '{"PasswordLength":32,"ExcludeCharacters":"@/\\\\"}',
        hint: "JSON object to customize generated password: PasswordLength (default 32), ExcludeCharacters, ExcludePunctuation (bool), ExcludeUppercase (bool), ExcludeLowercase (bool), ExcludeNumbers (bool), IncludeSpace (bool), RequireEachIncludedType (bool).",
        showIf: { field: "GenerateSecretString", value: true },
        validate: (value: unknown) => {
          if (!value) return undefined;
          try {
            JSON.parse(String(value));
            return undefined;
          } catch {
            return "Must be valid JSON";
          }
        },
      },
      toCfn: (answer: unknown) => {
        if (!answer) return undefined;
        try {
          return JSON.parse(String(answer));
        } catch {
          return undefined;
        }
      },
    },
    {
      name: "ReplicaRegions",
      question: {
        type: "string",
        label: "Replica regions (comma-separated)",
        placeholder: "us-west-2, eu-west-1",
        hint: "Replicate this secret to other AWS regions for disaster recovery or multi-region applications. Comma-separated region codes.",
      },
      toCfn: (answer: unknown) => {
        if (typeof answer !== "string" || !answer.trim()) return undefined;
        return answer
          .split(",")
          .map((r) => r.trim())
          .filter(Boolean)
          .map((region) => ({ Region: region }));
      },
    },
  ],
  defaults: {
    GenerateSecretString: true,
  },
  configHints: [
    "ALWAYS prefer GenerateSecretString over plaintext SecretString — plaintext values are visible in CloudFormation state and template files.",
    "KMS encryption: 'aws/secretsmanager' uses the AWS-managed key (free). Customer-managed keys (CMK) give full control over rotation, audit, and cross-account access at additional cost (check pricing estimate).",
    "Rotation: automatic rotation requires a separate AWS::SecretsManager::RotationSchedule companion resource — it is NOT configured on the Secret itself. Always set up rotation for production secrets.",
    "SecretString values appear in plaintext in CloudFormation stack events and drift detection output — never store production credentials this way.",
  ],
};
