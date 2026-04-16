/**
 * Shared mock fixture for destroy-service-*.test.ts suites.
 *
 * Prior to this extraction, 4 destroy-service test files each contained the
 * SAME verbatim ~210-LOC block of `vi.hoisted` mocks, `vi.mock()` calls for
 * operator credentials / resolve-arn / CloudControlAdapter / AWS SDK
 * clients, and the shared `beforeEach`/`afterEach`/`afterAll` harness.
 * The mock-setup hash (awk from `vi.hoisted` to first `describe`) was
 * identical across all 4 files, verified by Wave-3 R2-B. Zero-drift
 * today, but invisible drift tomorrow if one file edits and the others
 * forget.
 *
 * `setupDestroyServiceMocks()` installs ALL mocks and wires the
 * beforeEach/afterEach/afterAll hooks, returning the shared hoisted mock
 * functions so individual tests can drive them.
 *
 * CRITICAL: This file MUST be imported at the top of each test file
 * (before the `import { destroySingleResource } from ...` line). The
 * `vi.mock()` calls inside are hoisted by Vitest to run before ANY
 * other module evaluation, so the "order of imports" concern is moot —
 * what matters is that a single import of this file reaches `vi.mock`
 * before destroy-service.js is evaluated.
 *
 * Each test file calls `setupDestroyServiceMocks()` inside its own
 * top-level scope to install the beforeEach/afterEach/afterAll hooks
 * and receive the shared mock handles.
 *
 * @see Wave-4 F5 P2-R2-16 — shared mock-fixture extraction
 */
import { vi, beforeEach, afterEach, afterAll } from "vitest";

// ── Hoisted mocks ─────────────────────────────────────────────────────────────
// A6  (2026-04-08): mockDeleteEventSourceMapping and mockDeleteTopic were
//                   removed after Lambda ESM and SNS Topic delete were
//                   migrated from SDK fallback to CCAPI. Both types now go
//                   through mockDeleteResource.
// A10 (2026-04-09): mockUnsubscribe was removed after SNS::Subscription was
//                   promoted to first-class; destroy now routes through
//                   mockDeleteResource too.
// Vitest disallows `export const { ... } = vi.hoisted(...)` because the
// hoisted binding cannot be re-exported (vi.hoisted lifts the expression
// above imports). Assign to a non-exported const first, then re-export
// each handle. Each re-export reads the already-hoisted function so
// consumers still see the same vi.fn() identity as the vi.mock() factories.
const hoistedMocks = vi.hoisted(() => ({
  mockDeleteResource: vi.fn(),
  mockGetRequestStatus: vi.fn(),
  mockCfSend: vi.fn(),
  mockDdbSend: vi.fn(),
  mockS3Send: vi.fn(),
  mockEc2Send: vi.fn(),
}));
const {
  mockDeleteResource,
  mockGetRequestStatus,
  mockCfSend,
  mockDdbSend,
  mockS3Send,
  mockEc2Send,
} = hoistedMocks;
export {
  mockDeleteResource,
  mockGetRequestStatus,
  mockCfSend,
  mockDdbSend,
  mockS3Send,
  mockEc2Send,
};

// ── Mock operator credentials ─────────────────────────────────────────────────
vi.mock("../../config/operator-credentials.js", () => ({
  operatorCredentials: () => ({
    accessKeyId: "AKIAIOSFODNN7EXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    region: "us-east-1",
  }),
}));

// ── Mock resolve-arn (Wave 11 P2-2 cross-account guard) ─────────────────
// classifyNotFoundShortCircuit dynamic-imports getOperatorAccountId from
// resolve-arn.js when a CCAPI NotFound fires. The default mock returns
// undefined so existing tests get the legacy behavior (NotFound treated
// as success regardless of cross-account threat). Cross-account tests
// override this via mockGetOperatorAccountId.mockResolvedValueOnce.
const hoistedResolveArn = vi.hoisted(() => ({
  mockGetOperatorAccountId: vi.fn<() => Promise<string | undefined>>(),
}));
const { mockGetOperatorAccountId } = hoistedResolveArn;
export { mockGetOperatorAccountId };
vi.mock("../../utils/resolve-arn.js", () => ({
  getOperatorAccountId: mockGetOperatorAccountId,
  resolveResourceArn: vi.fn(),
  resetAccountIdCache: vi.fn(),
}));

// ── Mock CloudControlAdapter ──────────────────────────────────────────────────
vi.mock("../cloudcontrol-adapter.js", () => {
  class CloudControlAdapter {
    deleteResource = mockDeleteResource;
    getRequestStatus = mockGetRequestStatus;
  }
  return { CloudControlAdapter };
});

// ── Mock createCloudControlClient ─────────────────────────────────────────────
vi.mock("../cloudcontrol-client.js", () => ({
  createCloudControlClient: () => ({}),
}));

// ── Mock SDKFallbackDispatcher ────────────────────────────────────────────────
// A10 (2026-04-09): after SNS Subscription promotion the dispatcher is a
// redirect-only classifier with no SDK write paths. destroy-service no
// longer constructs the dispatcher at all, but keeping a trivial mock
// here guarantees any future regression that re-introduces a dispatcher
// import surfaces immediately.
vi.mock("../sdk-fallback-dispatcher.js", () => {
  class SDKFallbackDispatcher {
    canHandle = () => false;
    canDelete = () => false;
    isRedirect = () => null;
  }
  return { SDKFallbackDispatcher };
});

// ── Mock @aws-sdk/client-cloudfront ───────────────────────────────────────────
vi.mock("@aws-sdk/client-cloudfront", () => {
  class MockCloudFrontClient {
    send = mockCfSend;
    destroy = vi.fn();
  }
  function GetDistributionCommand(input: Record<string, unknown>) {
    return { _type: "GetDistribution", ...input };
  }
  function UpdateDistributionCommand(input: Record<string, unknown>) {
    return { _type: "UpdateDistribution", ...input };
  }
  function DeleteDistributionCommand(input: Record<string, unknown>) {
    return { _type: "DeleteDistribution", ...input };
  }
  return {
    CloudFrontClient: MockCloudFrontClient,
    GetDistributionCommand,
    UpdateDistributionCommand,
    DeleteDistributionCommand,
  };
});

// ── Mock @aws-sdk/client-dynamodb ─────────────────────────────────────────────
vi.mock("@aws-sdk/client-dynamodb", () => {
  class MockDynamoDBClient {
    send = mockDdbSend;
    destroy = vi.fn();
  }
  function UpdateTableCommand(input: Record<string, unknown>) {
    return { _type: "UpdateTable", ...input };
  }
  function DescribeTableCommand(input: Record<string, unknown>) {
    return { _type: "DescribeTable", ...input };
  }
  return {
    DynamoDBClient: MockDynamoDBClient,
    UpdateTableCommand,
    DescribeTableCommand,
  };
});

// ── Mock @aws-sdk/client-s3 ───────────────────────────────────────────────────
vi.mock("@aws-sdk/client-s3", () => {
  class MockS3Client {
    send = mockS3Send;
    destroy = vi.fn();
  }
  function ListObjectVersionsCommand(input: Record<string, unknown>) {
    return { _type: "ListObjectVersions", ...input };
  }
  function DeleteObjectsCommand(input: Record<string, unknown>) {
    return { _type: "DeleteObjects", ...input };
  }
  return {
    S3Client: MockS3Client,
    ListObjectVersionsCommand,
    DeleteObjectsCommand,
  };
});

// ── Mock @aws-sdk/client-ec2 ──────────────────────────────────────────────────
vi.mock("@aws-sdk/client-ec2", () => {
  class MockEC2Client {
    send = mockEc2Send;
    destroy = vi.fn();
  }
  function DescribeInternetGatewaysCommand(input: Record<string, unknown>) {
    return { _type: "DescribeInternetGateways", ...input };
  }
  function DetachInternetGatewayCommand(input: Record<string, unknown>) {
    return { _type: "DetachInternetGateway", ...input };
  }
  function DescribeRouteTablesCommand(input: Record<string, unknown>) {
    return { _type: "DescribeRouteTables", ...input };
  }
  function DisassociateRouteTableCommand(input: Record<string, unknown>) {
    return { _type: "DisassociateRouteTable", ...input };
  }
  function DescribeNetworkInterfacesCommand(input: Record<string, unknown>) {
    return { _type: "DescribeNetworkInterfaces", ...input };
  }
  return {
    EC2Client: MockEC2Client,
    DescribeInternetGatewaysCommand,
    DetachInternetGatewayCommand,
    DescribeRouteTablesCommand,
    DisassociateRouteTableCommand,
    DescribeNetworkInterfacesCommand,
  };
});

/**
 * Install the shared beforeEach/afterEach/afterAll hooks for a destroy-service
 * test suite. Call this once at the top level of a `describe` block or the
 * module body. It stubs `globalThis.setTimeout` to resolve immediately (so the
 * polling loops inside destroy-service don't wait on real timers), restores
 * process.env between tests, and primes the operator-account-id mock to the
 * legacy "undefined → shortcircuit" default.
 */
export function setupDestroyServiceMocks(): void {
  // Stub global setTimeout to resolve immediately — avoids real timer waits in
  // pollDeleteStatus and the CloudFront disable-then-delete polling loop.
  const originalSetTimeout = globalThis.setTimeout;
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    // Default: operator account is undefined → classifyNotFoundShortCircuit
    // returns "safe-shortcircuit" → NotFound treated as success (the legacy
    // Wave 5 behavior). Specific cross-account tests override this via
    // mockGetOperatorAccountId.mockResolvedValueOnce. Must be set AFTER
    // clearAllMocks or the default would be wiped.
    mockGetOperatorAccountId.mockResolvedValue(undefined);
    // @ts-expect-error — simplified stub for test purposes
    globalThis.setTimeout = (fn: () => void) => originalSetTimeout(fn, 0);
    // destroy-service now uses requireAssigneeCredentials("operator") for the
    // DynamoDB and S3 pre-delete hooks. Provide realistic-shaped credentials
    // so the hooks construct their SDK clients and exercise the mocked send().
    process.env["ASSIGNEE_OPERATOR_ACCESS_KEY_ID"] = "AKIAIOSFODNN7EXAMPLE";
    process.env["ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY"] =
      "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
  });
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });
  afterAll(() => {
    globalThis.setTimeout = originalSetTimeout;
  });
}
