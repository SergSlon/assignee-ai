/**
 * Shared test helpers for destroy-strategy tests.
 *
 * Extracted during Story 49.1 so each test can keep passing a plain
 * `(identifier, region)` pair — we build a `DestroyContext` around it
 * on the fly. Keeps per-test boilerplate small while matching the new
 * shared-core interface.
 */

import type { DestroyContext } from "@assignee/core";

export function makeDestroyContext(
  identifier: string,
  region: string,
  options: {
    arn?: string;
    resourceType?: string;
    warn?: (action: string, extras: Record<string, unknown>) => void;
  } = {},
): DestroyContext {
  const arn = options.arn ?? identifier;
  return {
    resource: {
      arn,
      resourceType: options.resourceType ?? "AWS::Test::Resource",
      identifier,
      region,
    },
    awsConfig: {
      accessKeyId: process.env["ASSIGNEE_OPERATOR_ACCESS_KEY_ID"] ?? "",
      secretAccessKey: process.env["ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY"] ?? "",
      region,
    },
    effectiveRegion: region,
    warn: options.warn ?? (() => {}),
  };
}
