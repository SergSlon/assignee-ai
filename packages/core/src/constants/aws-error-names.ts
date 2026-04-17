/**
 * Named constants for AWS SDK error names used in error classification.
 * Eliminates repeated magic strings across CLI/MCP error handling code.
 *
 * Lifted from `apps/cli/src/constants/aws-errors.ts` in Story 50-4 Wave 5.1
 * so it can be imported by the in-core CloudControlAdapter without a
 * cross-app reach. The CLI `constants/aws-errors.ts` file becomes a thin
 * re-export of this canonical list.
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
  VALIDATION_EXCEPTION: "ValidationException",
  BUCKET_ALREADY_EXISTS: "BucketAlreadyExists",
  BUCKET_ALREADY_OWNED: "BucketAlreadyOwnedByYou",
  BUCKET_NAME_NOT_AVAILABLE: "BucketNameNotAvailable",
  INVALID_PARAMETER_VALUE: "InvalidParameterValue",
  RATE_EXCEEDED: "Rate exceeded",
  NETWORKING_ERROR: "NetworkingError",
  SCHEMA_FETCH_ERROR: "SchemaFetchError",
  THROTTLING_SHORT: "Throttling",
  TOO_MANY_REQUESTS_SHORT: "TooManyRequests",
} as const;
