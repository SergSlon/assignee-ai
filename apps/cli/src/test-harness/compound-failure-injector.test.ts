/**
 * Tests for the compound failure-injection harness (Item 1, 2026-04-09).
 *
 * These tests establish the harness's contract:
 *   1. `buildInMemoryProvisioningPort` succeeds every create/delete
 *      call and tracks every action, producing deterministic
 *      identifiers a cleanup-matrix test can assert against.
 *   2. `wrapWithFailureInjection` passes through every call up to the
 *      Nth createResource (zero-indexed) and returns a synthetic
 *      SERVICE_ERROR on that call. Subsequent calls to the wrapped
 *      port also pass through — tests use this to simulate the
 *      cleanup phase running against the real inner adapter after
 *      the compound apply halts.
 *
 * The reverse-edge cleanup matrix tests (one per compound pattern)
 * build on this harness — see `apps/cli/src/nodes/__tests__/
 * compound-cleanup-matrix-vpc-networking.test.ts` for the first
 * matrix that exercises the VPC + NAT Gateway compound.
 */

import { describe, it, expect } from "vitest";
import {
  buildInMemoryProvisioningPort,
  wrapWithFailureInjection,
} from "./compound-failure-injector.js";
import { ProvisioningErrorKind } from "../services/provisioning-port.js";

describe("compound-failure-injector harness", () => {
  describe("buildInMemoryProvisioningPort", () => {
    it("tracks create calls in order with deterministic identifiers", async () => {
      const { port, tracker } = buildInMemoryProvisioningPort();

      const [, r1] = await port.createResource(
        "AWS::EC2::VPC",
        JSON.stringify({ CidrBlock: "10.0.0.0/16" }),
        "token-a",
      );
      const [, r2] = await port.createResource(
        "AWS::EC2::Subnet",
        JSON.stringify({ VpcId: "{{vpc}}", CidrBlock: "10.0.1.0/24" }),
        "token-b",
      );

      expect(r1).not.toBeNull();
      expect(r2).not.toBeNull();
      expect(tracker.created).toHaveLength(2);
      expect(tracker.created[0]!.typeName).toBe("AWS::EC2::VPC");
      expect(tracker.created[1]!.typeName).toBe("AWS::EC2::Subnet");
      // Identifiers are deterministic and unique
      expect(tracker.created[0]!.identifier).toMatch(/^AWS_EC2_VPC-\d+$/);
      expect(tracker.created[1]!.identifier).toMatch(/^AWS_EC2_Subnet-\d+$/);
      expect(tracker.created[0]!.identifier).not.toBe(
        tracker.created[1]!.identifier,
      );
    });

    it("getRequestStatus returns SUCCESS for a valid request token", async () => {
      const { port } = buildInMemoryProvisioningPort();
      const [, createResult] = await port.createResource(
        "AWS::S3::Bucket",
        "{}",
        "token",
      );
      expect(createResult).not.toBeNull();

      const [err, status] = await port.getRequestStatus(
        createResult!.requestToken,
      );
      expect(err).toBeNull();
      expect(status?.operationStatus).toBe("SUCCESS");
      expect(status?.identifier).toMatch(/^AWS_S3_Bucket-\d+$/);
    });

    it("getRequestStatus returns NOT_FOUND for an unknown token", async () => {
      const { port } = buildInMemoryProvisioningPort();
      const [err, status] = await port.getRequestStatus("bogus");
      expect(status).toBeNull();
      expect(err?.kind).toBe(ProvisioningErrorKind.NOT_FOUND);
    });

    it("getResource always returns NOT_FOUND to satisfy state-guard check", async () => {
      const { port } = buildInMemoryProvisioningPort();
      const [err, value] = await port.getResource("AWS::S3::Bucket", "my-bkt");
      expect(value).toBeNull();
      expect(err?.kind).toBe(ProvisioningErrorKind.NOT_FOUND);
    });

    it("tracks delete calls separately from creates", async () => {
      const { port, tracker } = buildInMemoryProvisioningPort();
      await port.createResource("AWS::EC2::VPC", "{}", "c1");
      await port.deleteResource("AWS::EC2::VPC", "vpc-0abc");
      expect(tracker.created).toHaveLength(1);
      expect(tracker.deleted).toHaveLength(1);
      expect(tracker.deleted[0]!.identifier).toBe("vpc-0abc");
    });

    it("reset() clears both tracks and rewinds counter", async () => {
      const { port, tracker } = buildInMemoryProvisioningPort();
      await port.createResource("AWS::S3::Bucket", "{}", "t");
      await port.deleteResource("AWS::S3::Bucket", "b");
      expect(tracker.created).toHaveLength(1);
      expect(tracker.deleted).toHaveLength(1);
      tracker.reset();
      expect(tracker.created).toHaveLength(0);
      expect(tracker.deleted).toHaveLength(0);
      // After reset, counter starts at 1 again for fresh deterministic ids
      const [, result] = await port.createResource(
        "AWS::S3::Bucket",
        "{}",
        "t2",
      );
      expect(result!.requestToken).toBe("mem-token-1");
    });
  });

  describe("wrapWithFailureInjection", () => {
    it("passes through calls before the failure index", async () => {
      const { port: inner, tracker } = buildInMemoryProvisioningPort();
      const wrapped = wrapWithFailureInjection({ inner, failAtIndex: 2 });

      // Calls 0, 1 succeed → passthrough
      const [e0, r0] = await wrapped.createResource(
        "AWS::EC2::VPC",
        "{}",
        "t0",
      );
      expect(e0).toBeNull();
      expect(r0).not.toBeNull();

      const [e1, r1] = await wrapped.createResource(
        "AWS::EC2::Subnet",
        "{}",
        "t1",
      );
      expect(e1).toBeNull();
      expect(r1).not.toBeNull();

      // Inner port saw both creates
      expect(tracker.created).toHaveLength(2);
      expect(wrapped.createCallCount()).toBe(2);
    });

    it("injects synthetic SERVICE_ERROR at the target index", async () => {
      const { port: inner } = buildInMemoryProvisioningPort();
      const wrapped = wrapWithFailureInjection({ inner, failAtIndex: 1 });

      // Call 0 passes
      await wrapped.createResource("AWS::EC2::VPC", "{}", "t0");
      // Call 1 fails
      const [err, result] = await wrapped.createResource(
        "AWS::EC2::InternetGateway",
        "{}",
        "t1",
      );
      expect(result).toBeNull();
      expect(err?.kind).toBe(ProvisioningErrorKind.SERVICE_ERROR);
      expect(err?.message).toMatch(
        /Synthetic failure injected at compound queue index 1/,
      );
    });

    it("does NOT call the inner port on the failure path", async () => {
      const { port: inner, tracker } = buildInMemoryProvisioningPort();
      const wrapped = wrapWithFailureInjection({ inner, failAtIndex: 0 });

      const [err] = await wrapped.createResource("AWS::EC2::VPC", "{}", "t0");
      expect(err).not.toBeNull();
      // Inner port never saw the create — no leaked "phantom" resource
      expect(tracker.created).toHaveLength(0);
    });

    it("custom errorKind + errorMessage override the defaults", async () => {
      const { port: inner } = buildInMemoryProvisioningPort();
      const wrapped = wrapWithFailureInjection({
        inner,
        failAtIndex: 0,
        errorKind: "ACCESS_DENIED",
        errorMessage: "Operator policy missing ec2:CreateVpc",
      });
      const [err] = await wrapped.createResource("AWS::EC2::VPC", "{}", "t");
      expect(err?.kind).toBe(ProvisioningErrorKind.ACCESS_DENIED);
      expect(err?.message).toBe("Operator policy missing ec2:CreateVpc");
    });

    it("delete/update/get pass through unchanged even after failure", async () => {
      const { port: inner, tracker } = buildInMemoryProvisioningPort();
      const wrapped = wrapWithFailureInjection({ inner, failAtIndex: 0 });

      await wrapped.createResource("AWS::EC2::VPC", "{}", "t"); // fails
      await wrapped.deleteResource("AWS::EC2::VPC", "vpc-abc");
      expect(tracker.deleted).toHaveLength(1);
      expect(tracker.deleted[0]!.identifier).toBe("vpc-abc");
    });

    it("createCallCount increments on injected-failure calls too", async () => {
      const { port: inner } = buildInMemoryProvisioningPort();
      const wrapped = wrapWithFailureInjection({ inner, failAtIndex: 0 });
      expect(wrapped.createCallCount()).toBe(0);
      await wrapped.createResource("AWS::EC2::VPC", "{}", "t");
      // Failure path still counted — so future calls see the incremented
      // index and don't re-trigger the failure.
      expect(wrapped.createCallCount()).toBe(1);
    });
  });
});
