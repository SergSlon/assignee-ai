/**
 * ProvisioningPort — thin re-export shim.
 *
 * The interface and error kinds live in `@assignee/core` (lifted in
 * Story 50-4 Wave 5.1 alongside the CloudControlAdapter implementation).
 * Keeping this module file as a re-export means existing CLI imports of
 * "../services/provisioning-port.js" keep working without touching every
 * callsite.
 */
export {
  ProvisioningErrorKind,
  type ProvisioningErrorKindType,
  type ProvisioningPort,
  type ProvisioningPortError,
  type CreateResourceResult,
  type DeleteResourceResult,
  type UpdateResourceResult,
  type GetRequestStatusResult,
} from "@assignee/core";
