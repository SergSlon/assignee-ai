/**
 * CloudControlAdapter — implements ProvisioningPort using AWS CloudControl SDK.
 * Translates SDK-specific exceptions into ProvisioningPortError results.
 *
 * Lifted from apps/cli/src/services/cloudcontrol-adapter.ts in Story 50-4
 * Wave 5.1 so the in-core graph can construct it without reaching back
 * into the CLI app. The CLI's old path becomes a thin re-export shim.
 */

import {
  type CloudControlClient,
  CreateResourceCommand,
  DeleteResourceCommand,
  GetResourceCommand,
  GetResourceRequestStatusCommand,
  UpdateResourceCommand,
  ResourceNotFoundException,
  AlreadyExistsException,
  ThrottlingException,
  GeneralServiceException,
} from "@aws-sdk/client-cloudcontrol";
import {
  ProvisioningErrorKind,
  type ProvisioningPort,
  type ProvisioningPortError,
  type CreateResourceResult,
  type DeleteResourceResult,
  type UpdateResourceResult,
  type GetRequestStatusResult,
} from "../ports/provisioning-port.js";
import { AwsErrorName } from "../constants/aws-error-names.js";
import { redactSensitive } from "../utils/redact.js";

function classifyError(err: unknown): ProvisioningPortError {
  if (err instanceof ResourceNotFoundException) {
    return {
      kind: ProvisioningErrorKind.NOT_FOUND,
      message: redactSensitive(err.message),
    };
  }
  if (err instanceof AlreadyExistsException) {
    return {
      kind: ProvisioningErrorKind.ALREADY_EXISTS,
      message: redactSensitive(err.message),
    };
  }
  if (err instanceof ThrottlingException) {
    return {
      kind: ProvisioningErrorKind.THROTTLED,
      message: redactSensitive(err.message),
    };
  }
  if (err instanceof GeneralServiceException) {
    // S3 "bucket name is not available" comes as GeneralServiceException
    // but is semantically an ALREADY_EXISTS error (globally unique names).
    if (err.message.includes("bucket name is not available")) {
      return {
        kind: ProvisioningErrorKind.ALREADY_EXISTS,
        message: redactSensitive(err.message),
      };
    }
    return {
      kind: ProvisioningErrorKind.SERVICE_ERROR,
      message: redactSensitive(err.message),
    };
  }
  // AccessDeniedException is not exported as a class by the CloudControl SDK;
  // detect it via the error name property.
  if (
    err instanceof Error &&
    (err.name === AwsErrorName.ACCESS_DENIED ||
      err.name === AwsErrorName.ACCESS_DENIED_SHORT)
  ) {
    return {
      kind: ProvisioningErrorKind.ACCESS_DENIED,
      message: redactSensitive(err.message),
    };
  }
  const rawMessage = err instanceof Error ? err.message : String(err);
  return {
    kind: ProvisioningErrorKind.UNKNOWN,
    message: redactSensitive(rawMessage),
  };
}

export class CloudControlAdapter implements ProvisioningPort {
  constructor(private readonly client: CloudControlClient) {}

  async getResource(
    typeName: string,
    identifier: string,
  ): Promise<[ProvisioningPortError, null] | [null, unknown]> {
    try {
      const result = await this.client.send(
        new GetResourceCommand({ TypeName: typeName, Identifier: identifier }),
      );
      return [null, result];
    } catch (err) {
      return [classifyError(err), null];
    }
  }

  async createResource(
    typeName: string,
    desiredState: string,
    clientToken: string,
  ): Promise<[ProvisioningPortError, null] | [null, CreateResourceResult]> {
    try {
      const result = await this.client.send(
        new CreateResourceCommand({
          TypeName: typeName,
          DesiredState: desiredState,
          ClientToken: clientToken,
        }),
      );
      const requestToken = result.ProgressEvent?.RequestToken;
      if (!requestToken) {
        return [
          {
            kind: ProvisioningErrorKind.UNKNOWN,
            message: "CreateResource returned no RequestToken",
          },
          null,
        ];
      }
      return [null, { requestToken }];
    } catch (err) {
      return [classifyError(err), null];
    }
  }

  async deleteResource(
    typeName: string,
    identifier: string,
  ): Promise<[ProvisioningPortError, null] | [null, DeleteResourceResult]> {
    try {
      const result = await this.client.send(
        new DeleteResourceCommand({
          TypeName: typeName,
          Identifier: identifier,
        }),
      );
      const requestToken = result.ProgressEvent?.RequestToken;
      if (!requestToken) {
        return [
          {
            kind: ProvisioningErrorKind.UNKNOWN,
            message: "DeleteResource returned no RequestToken",
          },
          null,
        ];
      }
      return [null, { requestToken }];
    } catch (err) {
      return [classifyError(err), null];
    }
  }

  async updateResource(
    typeName: string,
    identifier: string,
    patchDocument: string,
  ): Promise<[ProvisioningPortError, null] | [null, UpdateResourceResult]> {
    try {
      const result = await this.client.send(
        new UpdateResourceCommand({
          TypeName: typeName,
          Identifier: identifier,
          PatchDocument: patchDocument,
        }),
      );
      const requestToken = result.ProgressEvent?.RequestToken;
      if (!requestToken) {
        return [
          {
            kind: ProvisioningErrorKind.UNKNOWN,
            message: "UpdateResource returned no RequestToken",
          },
          null,
        ];
      }
      return [null, { requestToken }];
    } catch (err) {
      const classified = classifyError(err);
      if (classified.kind === ProvisioningErrorKind.ACCESS_DENIED) {
        classified.message =
          "Reconcile requires OPERATOR-level AWS credentials with write access to CloudControl. " +
          classified.message;
      }
      return [classified, null];
    }
  }

  async getRequestStatus(
    requestToken: string,
  ): Promise<[ProvisioningPortError, null] | [null, GetRequestStatusResult]> {
    if (!requestToken || requestToken.trim() === "") {
      return [
        {
          kind: ProvisioningErrorKind.UNKNOWN,
          message: "getRequestStatus called with empty requestToken",
        },
        null,
      ];
    }
    try {
      const result = await this.client.send(
        new GetResourceRequestStatusCommand({ RequestToken: requestToken }),
      );
      const event = result.ProgressEvent;
      return [
        null,
        {
          operationStatus: event?.OperationStatus,
          identifier: event?.Identifier,
          statusMessage: event?.StatusMessage,
          errorCode: event?.ErrorCode,
          resourceModel: event?.ResourceModel,
        },
      ];
    } catch (err) {
      return [classifyError(err), null];
    }
  }
}
