import { describe, it, expect, vi, beforeEach } from "vitest";
import { ProvisioningErrorKind } from "../provisioning-port.js";

// ── Mock AWS SDK clients ────────────────────────────────────────────────────

const mockLambdaSend = vi.fn();
vi.mock("@aws-sdk/client-lambda", () => ({
  LambdaClient: vi.fn().mockImplementation(() => ({ send: mockLambdaSend })),
  CreateEventSourceMappingCommand: vi.fn().mockImplementation((input) => input),
}));

const mockSnsSend = vi.fn();
vi.mock("@aws-sdk/client-sns", () => ({
  SNSClient: vi.fn().mockImplementation(() => ({ send: mockSnsSend })),
  SubscribeCommand: vi.fn().mockImplementation((input) => input),
}));

// Import AFTER mocks are set up
import { SDKFallbackDispatcher } from "../sdk-fallback-dispatcher.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

const TEST_CONFIG = {
  accessKeyId: "AKIATEST",
  secretAccessKey: "test-secret",
  region: "us-east-1",
};

let dispatcher: SDKFallbackDispatcher;

beforeEach(() => {
  vi.clearAllMocks();
  dispatcher = new SDKFallbackDispatcher(TEST_CONFIG);
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("SDKFallbackDispatcher", () => {
  describe("canHandle", () => {
    it("returns true for AWS::Lambda::EventSourceMapping", () => {
      expect(dispatcher.canHandle("AWS::Lambda::EventSourceMapping")).toBe(
        true,
      );
    });

    it("returns true for AWS::SNS::Subscription", () => {
      expect(dispatcher.canHandle("AWS::SNS::Subscription")).toBe(true);
    });

    it("returns false for AWS::S3::Bucket (standard CCAPI type)", () => {
      expect(dispatcher.canHandle("AWS::S3::Bucket")).toBe(false);
    });

    it("returns false for AWS::Lambda::Permission (redirect type, not SDK-routable)", () => {
      expect(dispatcher.canHandle("AWS::Lambda::Permission")).toBe(false);
    });

    it("returns false for AWS::ElastiCache::ReplicationGroup (redirect type, not SDK-routable)", () => {
      expect(dispatcher.canHandle("AWS::ElastiCache::ReplicationGroup")).toBe(
        false,
      );
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

    it("returns null for SDK-routable types", () => {
      expect(
        dispatcher.isRedirect("AWS::Lambda::EventSourceMapping"),
      ).toBeNull();
    });

    it("returns null for standard CCAPI types", () => {
      expect(dispatcher.isRedirect("AWS::S3::Bucket")).toBeNull();
    });
  });

  describe("createEventSourceMapping", () => {
    it("returns UUID identifier on success", async () => {
      const testUuid = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
      mockLambdaSend.mockResolvedValueOnce({ UUID: testUuid });

      const [err, result] = await dispatcher.createEventSourceMapping({
        EventSourceArn: "arn:aws:sqs:us-east-1:123456789012:my-queue",
        FunctionName: "my-function",
        BatchSize: 5,
      });

      expect(err).toBeNull();
      expect(result).not.toBeNull();
      expect(result!.identifier).toBe(testUuid);
    });

    it("returns error when SDK returns no UUID", async () => {
      mockLambdaSend.mockResolvedValueOnce({});

      const [err, result] = await dispatcher.createEventSourceMapping({
        EventSourceArn: "arn:aws:sqs:us-east-1:123456789012:my-queue",
        FunctionName: "my-function",
      });

      expect(err).not.toBeNull();
      expect(err!.kind).toBe(ProvisioningErrorKind.UNKNOWN);
      expect(err!.message).toMatch(/no UUID/);
      expect(result).toBeNull();
    });

    it("returns typed error on SDK failure", async () => {
      const sdkError = new Error("Function not found");
      sdkError.name = "ResourceNotFoundException";
      mockLambdaSend.mockRejectedValueOnce(sdkError);

      const [err, result] = await dispatcher.createEventSourceMapping({
        EventSourceArn: "arn:aws:sqs:us-east-1:123456789012:my-queue",
        FunctionName: "nonexistent-function",
      });

      expect(err).not.toBeNull();
      expect(err!.kind).toBe(ProvisioningErrorKind.NOT_FOUND);
      expect(err!.message).toMatch(/Function not found/);
      expect(result).toBeNull();
    });

    it("maps ResourceConflictException to ALREADY_EXISTS", async () => {
      const sdkError = new Error("Mapping already exists");
      sdkError.name = "ResourceConflictException";
      mockLambdaSend.mockRejectedValueOnce(sdkError);

      const [err, result] = await dispatcher.createEventSourceMapping({
        EventSourceArn: "arn:aws:sqs:us-east-1:123456789012:my-queue",
        FunctionName: "my-function",
      });

      expect(err).not.toBeNull();
      expect(err!.kind).toBe(ProvisioningErrorKind.ALREADY_EXISTS);
      expect(result).toBeNull();
    });

    it("maps TooManyRequestsException to THROTTLED", async () => {
      const sdkError = new Error("Rate exceeded");
      sdkError.name = "TooManyRequestsException";
      mockLambdaSend.mockRejectedValueOnce(sdkError);

      const [err, result] = await dispatcher.createEventSourceMapping({
        EventSourceArn: "arn:aws:sqs:us-east-1:123456789012:my-queue",
        FunctionName: "my-function",
      });

      expect(err).not.toBeNull();
      expect(err!.kind).toBe(ProvisioningErrorKind.THROTTLED);
      expect(result).toBeNull();
    });

    it("uses default BatchSize of 10 when not specified", async () => {
      mockLambdaSend.mockResolvedValueOnce({
        UUID: "default-batch-uuid",
      });

      await dispatcher.createEventSourceMapping({
        EventSourceArn: "arn:aws:sqs:us-east-1:123456789012:my-queue",
        FunctionName: "my-function",
      });

      // The CreateEventSourceMappingCommand mock captures the input
      const { CreateEventSourceMappingCommand } =
        await import("@aws-sdk/client-lambda");
      expect(CreateEventSourceMappingCommand).toHaveBeenCalledWith(
        expect.objectContaining({ BatchSize: 10 }),
      );
    });
  });

  describe("subscribe", () => {
    it("returns subscription ARN on success", async () => {
      const testArn = "arn:aws:sns:us-east-1:123456789012:my-topic:a1b2c3d4";
      mockSnsSend.mockResolvedValueOnce({
        SubscriptionArn: testArn,
      });

      const [err, result] = await dispatcher.subscribe({
        TopicArn: "arn:aws:sns:us-east-1:123456789012:my-topic",
        Protocol: "sqs",
        Endpoint: "arn:aws:sqs:us-east-1:123456789012:my-queue",
      });

      expect(err).toBeNull();
      expect(result).not.toBeNull();
      expect(result!.identifier).toBe(testArn);
    });

    it("returns error when SDK returns no SubscriptionArn", async () => {
      mockSnsSend.mockResolvedValueOnce({});

      const [err, result] = await dispatcher.subscribe({
        TopicArn: "arn:aws:sns:us-east-1:123456789012:my-topic",
        Protocol: "sqs",
        Endpoint: "arn:aws:sqs:us-east-1:123456789012:my-queue",
      });

      expect(err).not.toBeNull();
      expect(err!.kind).toBe(ProvisioningErrorKind.UNKNOWN);
      expect(err!.message).toMatch(/no SubscriptionArn/);
      expect(result).toBeNull();
    });

    it("returns typed error on SDK failure", async () => {
      const sdkError = new Error("Topic not found");
      sdkError.name = "NotFoundException";
      mockSnsSend.mockRejectedValueOnce(sdkError);

      const [err, result] = await dispatcher.subscribe({
        TopicArn: "arn:aws:sns:us-east-1:123456789012:nonexistent",
        Protocol: "sqs",
        Endpoint: "arn:aws:sqs:us-east-1:123456789012:my-queue",
      });

      expect(err).not.toBeNull();
      expect(err!.kind).toBe(ProvisioningErrorKind.NOT_FOUND);
      expect(err!.message).toMatch(/Topic not found/);
      expect(result).toBeNull();
    });

    it("maps ThrottlingException to THROTTLED", async () => {
      const sdkError = new Error("Rate exceeded");
      sdkError.name = "ThrottlingException";
      mockSnsSend.mockRejectedValueOnce(sdkError);

      const [err, result] = await dispatcher.subscribe({
        TopicArn: "arn:aws:sns:us-east-1:123456789012:my-topic",
        Protocol: "sqs",
        Endpoint: "arn:aws:sqs:us-east-1:123456789012:my-queue",
      });

      expect(err).not.toBeNull();
      expect(err!.kind).toBe(ProvisioningErrorKind.THROTTLED);
      expect(result).toBeNull();
    });

    it("passes ReturnSubscriptionArn: true", async () => {
      mockSnsSend.mockResolvedValueOnce({
        SubscriptionArn: "arn:aws:sns:us-east-1:123456789012:my-topic:sub-id",
      });

      await dispatcher.subscribe({
        TopicArn: "arn:aws:sns:us-east-1:123456789012:my-topic",
        Protocol: "lambda",
        Endpoint: "arn:aws:lambda:us-east-1:123456789012:function:my-fn",
      });

      const { SubscribeCommand } = await import("@aws-sdk/client-sns");
      expect(SubscribeCommand).toHaveBeenCalledWith(
        expect.objectContaining({ ReturnSubscriptionArn: true }),
      );
    });
  });
});
