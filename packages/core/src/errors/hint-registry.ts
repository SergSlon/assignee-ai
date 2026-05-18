/**
 * ErrorHintRegistry — maps typed ProvisioningErrorCode discriminants to actionable hint strings.
 * Replaces the ERROR_HINTS string-substring matching approach in result-formatter.
 *
 * @see Story 9.6 — M5: Typed error codes instead of substring matching
 */

import {
  AssigneeError,
  ProvisioningError,
  PROVISIONING_ERROR_CODES,
  type ProvisioningErrorCode,
} from "../errors.js";

export class ErrorHintRegistry {
  private readonly hints = new Map<ProvisioningErrorCode, string>();

  register(code: ProvisioningErrorCode, hint: string): void {
    this.hints.set(code, hint);
  }

  getHint(error: AssigneeError | undefined): string | undefined {
    if (!error) return undefined;
    if (error instanceof ProvisioningError) {
      return this.hints.get(error.provisioningCode);
    }
    return undefined;
  }
}

export const defaultErrorHintRegistry = new ErrorHintRegistry();

defaultErrorHintRegistry.register(
  PROVISIONING_ERROR_CODES.ALREADY_EXISTS,
  "A resource with this name already exists. Try a different name.",
);
defaultErrorHintRegistry.register(
  PROVISIONING_ERROR_CODES.NOT_FOUND,
  "Resource was removed during provisioning. Re-run `assignee infra plan` to get a fresh plan.",
);
defaultErrorHintRegistry.register(
  PROVISIONING_ERROR_CODES.THROTTLED,
  "AWS is throttling requests. Wait 30 seconds and retry.",
);
defaultErrorHintRegistry.register(
  PROVISIONING_ERROR_CODES.STATE_MISMATCH,
  "Resource already exists. Choose a different name and re-run 'assignee infra plan'.",
);
