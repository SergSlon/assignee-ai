import { describe, it, expect } from "vitest";

// A10 (2026-04-09): after SNS Subscription promotion the dispatcher
// no longer instantiates any AWS SDK client — it is pure in-memory
// classification logic. The @aws-sdk/client-sns mocks that earlier
// versions of this file set up are no longer needed.
//
// The only things worth testing here are:
//   - canHandle() / canDelete() return false for every known type
//     (CCAPI_SDK_ROUTABLE_TYPES is empty after A10)
//   - isRedirect() returns the right friendly message for the two
//     remaining redirect-only types
//     (AWS::Lambda::Permission, AWS::ElastiCache::ReplicationGroup)
//   - isRedirect() returns null for supported CCAPI types and for
//     types that were redirect-routed pre-A10 (SNS Subscription)

import { SDKFallbackDispatcher } from "../sdk-fallback-dispatcher.js";

describe("SDKFallbackDispatcher (A10 — redirect-only)", () => {
  const dispatcher = new SDKFallbackDispatcher();

  describe("canHandle", () => {
    it("returns false for every type (CCAPI_SDK_ROUTABLE_TYPES is empty after A10)", () => {
      // A10: SNS Subscription was the last SDK-routable type. After
      // promoting it to first-class, there are zero remaining SDK
      // write paths in this codebase. The canHandle() hook survives
      // as an always-false extension point.
      expect(dispatcher.canHandle("AWS::SNS::Subscription")).toBe(false);
      expect(dispatcher.canHandle("AWS::Lambda::EventSourceMapping")).toBe(
        false,
      );
      expect(dispatcher.canHandle("AWS::SNS::Topic")).toBe(false);
      expect(dispatcher.canHandle("AWS::S3::Bucket")).toBe(false);
      expect(dispatcher.canHandle("AWS::Lambda::Permission")).toBe(false);
      expect(dispatcher.canHandle("AWS::ElastiCache::ReplicationGroup")).toBe(
        false,
      );
    });
  });

  describe("canDelete", () => {
    it("mirrors canHandle — always false after A10", () => {
      expect(dispatcher.canDelete("AWS::SNS::Subscription")).toBe(false);
      expect(dispatcher.canDelete("AWS::S3::Bucket")).toBe(false);
      expect(dispatcher.canDelete("AWS::Lambda::Permission")).toBe(false);
    });
  });

  describe("isRedirect", () => {
    it("returns redirect info for AWS::Lambda::Permission", () => {
      const result = dispatcher.isRedirect("AWS::Lambda::Permission");
      expect(result).not.toBeNull();
      expect(result!.redirect).toBe(true);
      expect(result!.message).toBe(
        "AWS::Lambda::Permission is not supported by CCAPI. Use AWS::Lambda::PermissionPolicy instead.",
      );
    });

    it("returns redirect info for AWS::ElastiCache::ReplicationGroup", () => {
      const result = dispatcher.isRedirect(
        "AWS::ElastiCache::ReplicationGroup",
      );
      expect(result).not.toBeNull();
      expect(result!.redirect).toBe(true);
      expect(result!.message).toBe(
        "ElastiCache ReplicationGroup is not supported. Use AWS::ElastiCache::ServerlessCache for Redis/Memcached.",
      );
    });

    it("returns null for AWS::SNS::Subscription after A10 promotion", () => {
      // Pre-A10 this type was a redirect candidate routed through the
      // SDK dispatcher. After A10 it has a real plugin + full CCAPI
      // support and isRedirect() must NOT short-circuit it or the
      // resource-provisioner node will never reach the CloudControl
      // CreateResource call.
      expect(dispatcher.isRedirect("AWS::SNS::Subscription")).toBeNull();
    });

    it("returns null for AWS::Lambda::EventSourceMapping (A6 promotion)", () => {
      expect(
        dispatcher.isRedirect("AWS::Lambda::EventSourceMapping"),
      ).toBeNull();
    });

    it("returns null for standard CCAPI types", () => {
      expect(dispatcher.isRedirect("AWS::S3::Bucket")).toBeNull();
      expect(dispatcher.isRedirect("AWS::EC2::Instance")).toBeNull();
      expect(dispatcher.isRedirect("AWS::Lambda::Function")).toBeNull();
      expect(dispatcher.isRedirect("AWS::IAM::Role")).toBeNull();
    });

    it("returns null for unknown resource types", () => {
      expect(dispatcher.isRedirect("AWS::Nonexistent::Type")).toBeNull();
      expect(dispatcher.isRedirect("")).toBeNull();
    });
  });

  describe("construction", () => {
    it("does not require credentials (pure in-memory classifier)", () => {
      // Pre-A10 the constructor instantiated an SNSClient from AWS
      // credentials and threw ConfigurationError if they were
      // missing. After A10 the dispatcher is pure logic — constructors
      // must succeed unconditionally so no-credential flows (doctor,
      // intent-parser, plan preview) don't blow up.
      expect(() => new SDKFallbackDispatcher()).not.toThrow();
    });
  });
});
