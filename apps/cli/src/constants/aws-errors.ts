/**
 * Named constants for AWS SDK error names used in error classification.
 * Eliminates repeated magic strings across CLI error handling code.
 */
export const AwsErrorName = {
  THROTTLING: "ThrottlingException",
  TOO_MANY_REQUESTS: "TooManyRequestsException",
  ACCESS_DENIED: "AccessDeniedException",
  ACCESS_DENIED_SHORT: "AccessDenied",
  RESOURCE_NOT_FOUND: "ResourceNotFoundException",
  NOT_FOUND: "NotFoundException",
  ENTITY_ALREADY_EXISTS: "EntityAlreadyExistsException",
  NO_SUCH_ENTITY: "NoSuchEntityException",
  RESOURCE_CONFLICT: "ResourceConflictException",
  INVALID_PARAMETER: "InvalidParameterValueException",
  SERVICE_EXCEPTION: "ServiceException",
  RESOURCE_ALREADY_EXISTS: "ResourceAlreadyExistsException",
} as const;
