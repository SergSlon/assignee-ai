import { IamPolicy, AwsServicePrincipal } from "@/config/aws-arns.js";
import { IamEffect } from "@/config/iam-effects.js";

/**
 * Wave 19 Bug #2: recognize a real AssumeRolePolicyDocument emitted by the
 * LLM plan_generator, so we can pass it through unchanged instead of trying
 * to look it up as if it were a 3-enum wizard key. The LLM may emit the
 * policy as either:
 *
 *   1. A parsed JSON OBJECT — `{ Version: "2012-10-17", Statement: [...] }`
 *      (rare; happens when the upstream pipeline already parsed it)
 *   2. A JSON STRING — `'{"Version":"2012-10-17","Statement":[...]}'`
 *      (common; matches what we observed in the 2026-04-08 live smoke logs)
 *
 * Both forms must be accepted. The CFN AssumeRolePolicyDocument property
 * itself is a JSON-typed structure, so handing CCAPI either an object or a
 * pre-stringified JSON works the same way at the CloudFormation level.
 *
 * Returns the parsed/passed-through policy object on success, or null when
 * the input is not a recognizable policy shape (callers fall back to enum
 * lookup).
 */
export function tryParseTrustPolicyDocument(value: unknown): object | null {
  // Object shape — pass through unchanged
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const doc = value as { Statement?: unknown };
    if (Array.isArray(doc.Statement) && doc.Statement.length > 0) {
      return value;
    }
    return null;
  }
  // String shape — try parsing as JSON. The leading `{` check is a cheap
  // pre-filter so we don't run JSON.parse on enum keys like "ec2" / "lambda".
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed.startsWith("{")) return null;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        !Array.isArray(parsed)
      ) {
        const doc = parsed as { Statement?: unknown };
        if (Array.isArray(doc.Statement) && doc.Statement.length > 0) {
          return parsed;
        }
      }
    } catch {
      // Not valid JSON — fall through to enum lookup
    }
  }
  return null;
}

/** Common trust policies for AWS service principals. */
export const TRUST_POLICIES: Record<string, object> = {
  ec2: {
    Version: IamPolicy.VERSION,
    Statement: [
      {
        Effect: IamEffect.ALLOW,
        Principal: { Service: AwsServicePrincipal.EC2 },
        Action: IamPolicy.ACTION_ASSUME_ROLE,
      },
    ],
  },
  lambda: {
    Version: IamPolicy.VERSION,
    Statement: [
      {
        Effect: IamEffect.ALLOW,
        Principal: { Service: AwsServicePrincipal.LAMBDA },
        Action: IamPolicy.ACTION_ASSUME_ROLE,
      },
    ],
  },
  ecs: {
    Version: IamPolicy.VERSION,
    Statement: [
      {
        Effect: IamEffect.ALLOW,
        Principal: { Service: AwsServicePrincipal.ECS_TASKS },
        Action: IamPolicy.ACTION_ASSUME_ROLE,
      },
    ],
  },
};

/**
 * toCfn transformer for the AssumeRolePolicyDocument field — handles the
 * wizard enum path as well as LLM-provided object / JSON-string paths.
 */
export function assumeRolePolicyToCfn(answer: unknown): unknown {
  const llmPolicy = tryParseTrustPolicyDocument(answer);
  if (llmPolicy !== null) {
    return llmPolicy;
  }
  const key = String(answer);
  const policy = TRUST_POLICIES[key];
  if (!policy) {
    process.stderr.write(
      `Warning: Unknown trust policy "${key}". AssumeRolePolicyDocument omitted.\n`,
    );
    return undefined;
  }
  return policy;
}
