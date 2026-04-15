/**
 * Unit tests for aws-errors classifiers.
 *
 * Each classifier is exercised against ten+ realistic error shapes:
 *  - SDK v3 structured errors (`err.name` + `$metadata.httpStatusCode`)
 *  - SDK v2 legacy shape (`err.Code`)
 *  - Wrapped `$response.body` forms (legacy XML-parsed body)
 *  - Lowercase `code` field (middleware objects)
 *  - HTTP-status-only detection (403 / 401 / 429)
 *  - Edge inputs: undefined, null, string, plain Error, empty object
 *
 * Critically, classifiers MUST NOT match on message substrings — resource
 * names like "user-not-authorized-policy" would false-positive.
 */

import { describe, it, expect } from "vitest";
import {
  isAccessDeniedError,
  isAuthFailureError,
  isThrottlingError,
} from "./aws-errors.js";

describe("isAccessDeniedError", () => {
  it("matches SDK v3 AccessDeniedException via err.name", () => {
    const err = Object.assign(new Error("denied"), {
      name: "AccessDeniedException",
      $metadata: { httpStatusCode: 403 },
    });
    expect(isAccessDeniedError(err)).toBe(true);
  });

  it("matches SDK v3 AccessDenied via err.name", () => {
    const err = Object.assign(new Error("x"), { name: "AccessDenied" });
    expect(isAccessDeniedError(err)).toBe(true);
  });

  it("matches EC2 UnauthorizedOperation via err.name", () => {
    const err = Object.assign(new Error("x"), {
      name: "UnauthorizedOperation",
    });
    expect(isAccessDeniedError(err)).toBe(true);
  });

  it("matches EC2 AuthFailure via err.name", () => {
    const err = Object.assign(new Error("x"), { name: "AuthFailure" });
    expect(isAccessDeniedError(err)).toBe(true);
  });

  it("matches Forbidden", () => {
    const err = Object.assign(new Error("x"), { name: "Forbidden" });
    expect(isAccessDeniedError(err)).toBe(true);
  });

  it("matches OperationNotPermitted", () => {
    const err = Object.assign(new Error("x"), {
      name: "OperationNotPermitted",
    });
    expect(isAccessDeniedError(err)).toBe(true);
  });

  it("matches SDK v2 legacy err.Code field", () => {
    expect(isAccessDeniedError({ Code: "AccessDenied" })).toBe(true);
    expect(isAccessDeniedError({ Code: "UnauthorizedOperation" })).toBe(true);
  });

  it("matches wrapped $response.body.Code form", () => {
    const err = {
      name: "UnknownServiceError",
      $response: { body: { Code: "AccessDeniedException" } },
    };
    expect(isAccessDeniedError(err)).toBe(true);
  });

  it("matches lowercase err.code middleware shape", () => {
    expect(isAccessDeniedError({ code: "AccessDenied" })).toBe(true);
  });

  it("matches HTTP 403 even when name is generic", () => {
    const err = Object.assign(new Error("x"), {
      name: "ServiceException",
      $metadata: { httpStatusCode: 403 },
    });
    expect(isAccessDeniedError(err)).toBe(true);
  });

  it("matches HTTP 403 on statusCode field", () => {
    expect(isAccessDeniedError({ statusCode: 403 })).toBe(true);
  });

  it("does NOT match plain Error with message-only signal", () => {
    // This is the exact false-positive the classifier was built to prevent.
    expect(
      isAccessDeniedError(new Error("bucket user-not-authorized-policy")),
    ).toBe(false);
    expect(isAccessDeniedError(new Error("AccessDenied"))).toBe(false);
  });

  it("does NOT match throttling / auth errors", () => {
    expect(isAccessDeniedError({ name: "ThrottlingException" })).toBe(false);
    expect(isAccessDeniedError({ name: "ExpiredToken" })).toBe(false);
  });

  it("returns false for null / undefined / strings / empty", () => {
    expect(isAccessDeniedError(null)).toBe(false);
    expect(isAccessDeniedError(undefined)).toBe(false);
    expect(isAccessDeniedError("AccessDenied")).toBe(false);
    expect(isAccessDeniedError({})).toBe(false);
  });
});

describe("isAuthFailureError", () => {
  it("matches STS ExpiredToken", () => {
    expect(isAuthFailureError({ name: "ExpiredToken" })).toBe(true);
  });

  it("matches STS ExpiredTokenException", () => {
    expect(isAuthFailureError({ name: "ExpiredTokenException" })).toBe(true);
  });

  it("matches InvalidClientTokenId", () => {
    expect(isAuthFailureError({ name: "InvalidClientTokenId" })).toBe(true);
  });

  it("matches SignatureDoesNotMatch", () => {
    expect(isAuthFailureError({ name: "SignatureDoesNotMatch" })).toBe(true);
  });

  it("matches TokenRefreshRequired", () => {
    expect(isAuthFailureError({ name: "TokenRefreshRequired" })).toBe(true);
  });

  it("matches via legacy err.Code", () => {
    expect(isAuthFailureError({ Code: "ExpiredToken" })).toBe(true);
  });

  it("matches HTTP 401", () => {
    expect(isAuthFailureError({ $metadata: { httpStatusCode: 401 } })).toBe(
      true,
    );
  });

  it("matches wrapped $response.body.Code form", () => {
    expect(
      isAuthFailureError({
        $response: { body: { Code: "InvalidClientTokenId" } },
      }),
    ).toBe(true);
  });

  it("does NOT match AccessDenied (that is per-resource, not session)", () => {
    expect(isAuthFailureError({ name: "AccessDenied" })).toBe(false);
    expect(isAuthFailureError({ name: "UnauthorizedOperation" })).toBe(false);
  });

  it("does NOT match 403 (which is AccessDenied, not session auth)", () => {
    expect(isAuthFailureError({ $metadata: { httpStatusCode: 403 } })).toBe(
      false,
    );
  });

  it("returns false for null / undefined / empty", () => {
    expect(isAuthFailureError(null)).toBe(false);
    expect(isAuthFailureError(undefined)).toBe(false);
    expect(isAuthFailureError({})).toBe(false);
    expect(isAuthFailureError("ExpiredToken")).toBe(false);
  });
});

describe("isThrottlingError", () => {
  it("matches ThrottlingException", () => {
    expect(isThrottlingError({ name: "ThrottlingException" })).toBe(true);
  });

  it("matches short-form Throttling", () => {
    expect(isThrottlingError({ name: "Throttling" })).toBe(true);
  });

  it("matches TooManyRequestsException", () => {
    expect(isThrottlingError({ name: "TooManyRequestsException" })).toBe(true);
  });

  it("matches EC2 RequestLimitExceeded", () => {
    expect(isThrottlingError({ name: "RequestLimitExceeded" })).toBe(true);
  });

  it("matches SQS RequestThrottled variants", () => {
    expect(isThrottlingError({ name: "RequestThrottled" })).toBe(true);
    expect(isThrottlingError({ name: "RequestThrottledException" })).toBe(true);
  });

  it("matches S3 SlowDown", () => {
    expect(isThrottlingError({ name: "SlowDown" })).toBe(true);
  });

  it("matches via legacy err.Code", () => {
    expect(isThrottlingError({ Code: "ThrottlingException" })).toBe(true);
  });

  it("matches HTTP 429", () => {
    expect(isThrottlingError({ $metadata: { httpStatusCode: 429 } })).toBe(
      true,
    );
  });

  it("matches wrapped $response.body.Code form", () => {
    expect(
      isThrottlingError({
        $response: { body: { Code: "ThrottlingException" } },
      }),
    ).toBe(true);
  });

  it("does NOT match AccessDenied / auth failures", () => {
    expect(isThrottlingError({ name: "AccessDenied" })).toBe(false);
    expect(isThrottlingError({ name: "ExpiredToken" })).toBe(false);
  });

  it("returns false for null / undefined / empty", () => {
    expect(isThrottlingError(null)).toBe(false);
    expect(isThrottlingError(undefined)).toBe(false);
    expect(isThrottlingError({})).toBe(false);
  });
});
