import { CfnKey } from "@/config/cfn-keys.js";
import type { ResourcePlugin } from "../../types.js";

/** Database credential + initial-DB fields (name, username, password). */
export const credentialFields: ResourcePlugin["commonFields"] = [
  {
    name: CfnKey.DB_NAME,
    question: {
      type: "string",
      label: "Initial database name",
      placeholder: "myapp",
      hint: "Name of the initial database created on launch. If omitted, no database is created and you must create one manually after provisioning. Use lowercase letters and underscores.",
      validate: (value: unknown) => {
        if (!value) return undefined;
        const s = String(value);
        if (s.length < 1 || s.length > 64)
          return "Database name must be between 1 and 64 characters";
        if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(s))
          return "Database name must start with a letter and contain only letters, numbers, and underscores";
        return undefined;
      },
    },
  },
  {
    name: CfnKey.MASTER_USERNAME,
    required: true,
    question: {
      type: "string",
      label: "Master username",
      placeholder: "appuser",
      initialValue: "appuser",
      hint: "Admin username for the database. Avoid 'admin' or 'root' in production for security. Must start with a letter. Cannot be changed after creation.",
      validate: (value: unknown) => {
        if (typeof value !== "string" || value.length === 0)
          return "Master username is required";
        if (value.length > 41)
          return "Master username must be at most 41 characters";
        if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(value))
          return "Must start with a letter and contain only letters, numbers, and underscores";
        return undefined;
      },
    },
  },
  {
    name: CfnKey.MASTER_USER_PASSWORD,
    // W1-01 (Epic 100): credential field — strip from elicited-options at
    // every persistence boundary via stripSensitiveFromElicited().
    sensitive: true,
    question: {
      type: "string",
      label: "Master password",
      placeholder: "Auto-generated if blank",
      hint: 'Set a strong password (min 8 chars, uppercase + lowercase + numbers). Leave blank to auto-generate a secure password stored in AWS Secrets Manager. Avoid /, @, " and spaces.',
      validate: (value: unknown) => {
        if (!value) return undefined;
        const s = String(value);
        if (s.length < 8) return "Password must be at least 8 characters";
        if (s.length > 128) return "Password must be 128 characters or less";
        if (/[/@" ]/.test(s))
          return 'Password must not contain /, @, " (double quote), or spaces';
        return undefined;
      },
    },
  },
];
