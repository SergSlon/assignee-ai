/**
 * Unit tests for waitForCredentialPropagation.
 *
 * Uses vi.useFakeTimers() to avoid real 30s+ waits.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — must be hoisted above the SUT import.
// ---------------------------------------------------------------------------

// Capture spinner messages so tests can assert on them.
const spinnerStartMsgs: string[] = [];
const spinnerMessageMsgs: string[] = [];
const spinnerStopMsgs: string[] = [];

vi.mock("@clack/prompts", () => ({
  spinner: () => ({
    start: (msg?: string) => {
      spinnerStartMsgs.push(msg ?? "");
    },
    message: (msg?: string) => {
      spinnerMessageMsgs.push(msg ?? "");
    },
    stop: (msg?: string) => {
      spinnerStopMsgs.push(msg ?? "");
    },
  }),
}));

// Capture which STSClient instances were created and mock their send().
const mockStsSend = vi.fn();
vi.mock("@aws-sdk/client-sts", () => {
  class STSClient {
    _opts: unknown;
    constructor(opts: unknown) {
      this._opts = opts;
    }
    send = mockStsSend;
  }
  class GetCallerIdentityCommand {
    _type = "GetCallerIdentity";
    constructor() {}
  }
  return { STSClient, GetCallerIdentityCommand };
});

// ---------------------------------------------------------------------------
// SUT import (after mocks are registered)
// ---------------------------------------------------------------------------

import { waitForCredentialPropagation } from "./credentials-propagation.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE_OPTS = {
  accessKeyId: "AKIAIOSFODNN7EXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  region: "us-east-1",
  userLabel: "assignee-operator",
};

function makeInvalidTokenError(): Error {
  return Object.assign(
    new Error("The security token included in the request is invalid."),
    {
      name: "InvalidClientTokenId",
    },
  );
}

function makeAccessDeniedError(): Error {
  return Object.assign(
    new Error(
      "User: arn:aws:iam::123456789012:user/foo is not authorized to assume role",
    ),
    { name: "AccessDenied" },
  );
}

function makeNetworkError(): Error {
  return Object.assign(new Error("connect ETIMEDOUT 169.254.169.254:80"), {
    name: "NetworkingError",
    code: "ETIMEDOUT",
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("waitForCredentialPropagation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    spinnerStartMsgs.length = 0;
    spinnerMessageMsgs.length = 0;
    spinnerStopMsgs.length = 0;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("succeeds after 2 eventual-consistency failures then a success (attemptsUsed = 3)", async () => {
    // Attempt 1: InvalidClientTokenId
    // Attempt 2: InvalidClientTokenId
    // Attempt 3: success
    mockStsSend
      .mockRejectedValueOnce(makeInvalidTokenError())
      .mockRejectedValueOnce(makeInvalidTokenError())
      .mockResolvedValueOnce({ Account: "123456789012" });

    const promise = waitForCredentialPropagation({ ...BASE_OPTS });

    // Advance timers: attempt 1 sleep = 2000ms
    await vi.advanceTimersByTimeAsync(2000);
    // Advance timers: attempt 2 sleep = 3000ms
    await vi.advanceTimersByTimeAsync(3000);
    // Advance timers: attempt 3 sleep = 5000ms
    await vi.advanceTimersByTimeAsync(5000);

    const result = await promise;

    expect(result.succeeded).toBe(true);
    expect(result.attemptsUsed).toBe(3);
    // 2000 + 3000 + 5000 = 10000ms
    expect(result.totalWaitMs).toBe(10000);
    expect(result.lastError).toBeUndefined();

    // STS was called 3 times
    expect(mockStsSend).toHaveBeenCalledTimes(3);
  });

  it("times out (succeeded: false) after 6 attempts of InvalidClientTokenId", async () => {
    mockStsSend.mockRejectedValue(makeInvalidTokenError());

    const promise = waitForCredentialPropagation({ ...BASE_OPTS });

    // Fibonacci delays: 2s, 3s, 5s, 8s, 13s, 13s = 44s total
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(3000);
    await vi.advanceTimersByTimeAsync(5000);
    await vi.advanceTimersByTimeAsync(8000);
    await vi.advanceTimersByTimeAsync(13000);
    await vi.advanceTimersByTimeAsync(13000);

    const result = await promise;

    expect(result.succeeded).toBe(false);
    expect(result.attemptsUsed).toBe(6);
    expect(result.totalWaitMs).toBe(44000);
    expect(result.lastError).toBeDefined();
    expect(result.lastError).toContain("security token");

    expect(mockStsSend).toHaveBeenCalledTimes(6);
  });

  it("fails fast on AccessDenied (non-eventual-consistency) after 1 attempt", async () => {
    mockStsSend.mockRejectedValue(makeAccessDeniedError());

    const promise = waitForCredentialPropagation({ ...BASE_OPTS });

    // Only 1 sleep = 2000ms
    await vi.advanceTimersByTimeAsync(2000);

    const result = await promise;

    expect(result.succeeded).toBe(false);
    expect(result.attemptsUsed).toBe(1);
    expect(result.lastError).toContain("not authorized to assume role");

    // Only 1 STS call — fail-fast on non-transient error
    expect(mockStsSend).toHaveBeenCalledTimes(1);
  });

  it("fails fast on NetworkingError (ETIMEDOUT) after 1 attempt", async () => {
    mockStsSend.mockRejectedValue(makeNetworkError());

    const promise = waitForCredentialPropagation({ ...BASE_OPTS });

    await vi.advanceTimersByTimeAsync(2000);

    const result = await promise;

    expect(result.succeeded).toBe(false);
    expect(result.attemptsUsed).toBe(1);
    expect(result.lastError).toContain("ETIMEDOUT");

    expect(mockStsSend).toHaveBeenCalledTimes(1);
  });

  it("updates spinner message on each retry attempt", async () => {
    // 2 failures then success
    mockStsSend
      .mockRejectedValueOnce(makeInvalidTokenError())
      .mockRejectedValueOnce(makeInvalidTokenError())
      .mockResolvedValueOnce({ Account: "123456789012" });

    const promise = waitForCredentialPropagation({
      ...BASE_OPTS,
      userLabel: "assignee-operator",
    });

    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(3000);
    await vi.advanceTimersByTimeAsync(5000);
    await promise;

    // spinner.start() was called with attempt 1 text
    expect(spinnerStartMsgs[0]).toContain("attempt 1/6");
    expect(spinnerStartMsgs[0]).toContain("assignee-operator");

    // spinner.message() was called for attempt 2 (after first failure)
    const allMessages = spinnerMessageMsgs.join("\n");
    expect(allMessages).toContain("attempt 2/6");
    // attempt 3 message (after second failure)
    expect(allMessages).toContain("attempt 3/6");

    // spinner.stop() was called with success text
    const stopText = spinnerStopMsgs.join("\n");
    expect(stopText).toContain("assignee-operator");
    expect(stopText).toContain("verified");
  });

  it("respects custom maxAttempts option", async () => {
    mockStsSend.mockRejectedValue(makeInvalidTokenError());

    const promise = waitForCredentialPropagation({
      ...BASE_OPTS,
      maxAttempts: 3,
    });

    // Only 3 attempts: 2s + 3s + 5s = 10s
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(3000);
    await vi.advanceTimersByTimeAsync(5000);

    const result = await promise;

    expect(result.succeeded).toBe(false);
    expect(result.attemptsUsed).toBe(3);
    expect(result.totalWaitMs).toBe(10000);
    expect(mockStsSend).toHaveBeenCalledTimes(3);
  });

  it("constructs STSClient with the explicit credentials (not provider chain)", async () => {
    mockStsSend.mockResolvedValueOnce({ Account: "123456789012" });

    const { STSClient } = await import("@aws-sdk/client-sts");
    const constructorSpy = vi.spyOn(
      STSClient.prototype,
      "constructor" as never,
    );

    const promise = waitForCredentialPropagation({
      accessKeyId: "AKIA_SPECIFIC_KEY",
      secretAccessKey: "specific_secret",
      region: "eu-west-1",
      userLabel: "assignee-reader",
    });

    await vi.advanceTimersByTimeAsync(2000);
    const result = await promise;

    // The call succeeded (mock resolved)
    expect(result.succeeded).toBe(true);
    // STSClient.send was called with GetCallerIdentityCommand
    expect(mockStsSend).toHaveBeenCalledTimes(1);

    constructorSpy.mockRestore();
  });

  it("emits timeout stop message after exhausting retries", async () => {
    mockStsSend.mockRejectedValue(makeInvalidTokenError());

    const promise = waitForCredentialPropagation({
      ...BASE_OPTS,
      maxAttempts: 2,
    });

    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(3000);

    await promise;

    const stopText = spinnerStopMsgs.join("\n");
    expect(stopText).toContain("timed out");
    expect(stopText).toContain("assignee-operator");
  });
});
