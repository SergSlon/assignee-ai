/**
 * ProvisioningPort — abstracts CloudControl SDK operations behind a clean interface.
 * Nodes depend on this port; the CloudControlAdapter implements it.
 * This satisfies DIP: nodes no longer import @aws-sdk/client-cloudcontrol.
 */

/** Provisioning error categories for discriminated error handling. */
export const ProvisioningErrorKind = {
  NOT_FOUND: "NOT_FOUND",
  ALREADY_EXISTS: "ALREADY_EXISTS",
  THROTTLED: "THROTTLED",
  SERVICE_ERROR: "SERVICE_ERROR",
  UNKNOWN: "UNKNOWN",
} as const;

export type ProvisioningErrorKindType =
  (typeof ProvisioningErrorKind)[keyof typeof ProvisioningErrorKind];

export interface ProvisioningPortError {
  kind: ProvisioningErrorKindType;
  message: string;
}

export interface CreateResourceResult {
  requestToken: string;
}

export interface GetRequestStatusResult {
  operationStatus: string | undefined;
  identifier: string | undefined;
  statusMessage: string | undefined;
}

export interface ProvisioningPort {
  /** Check if a resource exists. Returns the error kind on failure. */
  getResource(
    typeName: string,
    identifier: string,
  ): Promise<[ProvisioningPortError, null] | [null, unknown]>;

  /** Create a resource. Returns a request token on success. */
  createResource(
    typeName: string,
    desiredState: string,
    clientToken: string,
  ): Promise<[ProvisioningPortError, null] | [null, CreateResourceResult]>;

  /** Poll async operation status. */
  getRequestStatus(
    requestToken: string,
  ): Promise<[ProvisioningPortError, null] | [null, GetRequestStatusResult]>;
}
