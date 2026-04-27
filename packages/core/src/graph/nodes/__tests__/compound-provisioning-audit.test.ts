/**
 * Compound Provisioning Audit — Integration Tests
 *
 * Verifies compound pattern provisioning flows work correctly end-to-end through
 * the key nodes: compound-dispatcher -> plan-generator -> resource-provisioner -> result-formatter.
 *
 * Tests all 8 patterns: serverless-api, three-tier-web, vpc-networking,
 * message-processing, container-service, static-website, efs-with-vpc,
 * scheduled-lambda.
 *
 * @see Story 8.2 — Compound Patterns
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  ExecutionStatus,
  ExecutionMode,
  RESOURCE_TYPES,
  COMPANION_RESOURCE_TYPES,
  defaultPatternRegistry,
  ProvisioningErrorKind,
  type ArchitecturePattern,
  type ProvisioningPort,
} from "@/index.js";
import { compoundDispatcherNode } from "../compound-dispatcher.js";
import { resourceProvisionerNode } from "../resource-provisioner.js";
import type { AgentState } from "../../graph-state.js";

// Suppress logger output
vi.mock("../../../utils/logger/index.js", () => ({
  log: vi.fn(),
  LOG_ACTIONS: {
    RESULT_FORMATTED: "result_formatted",
    APPLY_SUCCEEDED: "apply_succeeded",
    APPLY_FAILED: "apply_failed",
    STATE_GUARD_ABORT: "state_guard_abort",
    STATE_GUARD_SKIPPED: "state_guard_skipped",
    RESOURCE_PROVISION_STARTED: "resource_provision_started",
    SDK_FALLBACK_DISPATCHED: "sdk_fallback_dispatched",
    SECURITY_CHECK_SKIPPED: "security_check_skipped",
    MEMORY_WRITE_FAILED: "memory_write_failed",
  },
}));

// Suppress display output
//
// Story 50-4 Wave 5 Pass H: result-formatter was lifted to @assignee/core;
// it imports display from the core-internal path. Hoisted spies are mocked
// so dynamic imports in tests below resolve to the same spies.
const _displayMocks = vi.hoisted(() => ({
  renderApplySuccess: vi.fn(),
  renderCompoundSuccess: vi.fn(),
  renderCompoundPartialFailure: vi.fn(),
  renderError: vi.fn(),
  renderPlanBox: vi.fn(),
  renderSecurityWarnings: vi.fn(),
  promptFixSelection: vi.fn().mockResolvedValue(null),
}));
vi.mock("../../../utils/display.js", () => _displayMocks);

// Mock memory service (lifted to core in Pass H — hoisted & mocked at the
// core-internal path)
const _memoryMocks = vi.hoisted(() => ({
  defaultMemoryService: {
    appendProvision: vi.fn().mockResolvedValue(undefined),
    appendFailure: vi.fn().mockResolvedValue(undefined),
    upsertPattern: vi.fn().mockResolvedValue(undefined),
    clearFailuresForType: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock("../../../services/memory.js", () => _memoryMocks);

// ── Helpers ───────────────────────────────────────────────────────────────────

function createMockProvisioner(): ProvisioningPort & {
  getResource: ReturnType<typeof vi.fn>;
  createResource: ReturnType<typeof vi.fn>;
  getRequestStatus: ReturnType<typeof vi.fn>;
  deleteResource: ReturnType<typeof vi.fn>;
  updateResource: ReturnType<typeof vi.fn>;
} {
  return {
    getResource: vi.fn(),
    createResource: vi.fn(),
    getRequestStatus: vi.fn(),
    deleteResource: vi.fn(),
    updateResource: vi.fn(),
  };
}

function makeState(overrides: Partial<AgentState> = {}): AgentState {
  return {
    userIntent: "create infrastructure",
    runId: "test-compound-run-001",
    executionMode: ExecutionMode.APPLY,
    resourceType: "",
    executionStatus: ExecutionStatus.PENDING,
    preflightPassed: true,
    preflightErrors: [],
    preflightMode: "local",
    messages: [],
    ...overrides,
  } as AgentState;
}

// ── Real pattern objects from the default registry ───────────────────────────

// 5 patterns are registered in defaultPatternRegistry; vpc-networking is not
// (it's a pattern file without default registration). We retrieve 5 from the
// registry and construct the vpc-networking inline using the same constants.

const serverlessApiPattern = defaultPatternRegistry.get("serverless-api")!;
const threeTierWebPattern = defaultPatternRegistry.get("three-tier-web")!;
const messageProcessingPattern =
  defaultPatternRegistry.get("message-processing")!;
const containerServicePattern =
  defaultPatternRegistry.get("container-service")!;
const staticWebsitePattern = defaultPatternRegistry.get("static-website")!;
const efsWithVpcPattern = defaultPatternRegistry.get("efs-with-vpc")!;
const scheduledLambdaPattern = defaultPatternRegistry.get("scheduled-lambda")!;

/** VPC Networking pattern — 17 resources, constructed inline (not in default registry) */
const vpcNetworkingPattern: ArchitecturePattern = {
  patternId: "vpc-networking",
  displayName: "VPC with Public and Private Subnets",
  keywords: ["vpc with subnets"],
  resourceList: [
    {
      resourceType: RESOURCE_TYPES.EC2_VPC,
      resourceId: "vpc",
      displayName: "VPC",
    },
    {
      resourceType: RESOURCE_TYPES.EC2_SUBNET,
      resourceId: "public-subnet-1",
      displayName: "Public Subnet (AZ-1)",
    },
    {
      resourceType: RESOURCE_TYPES.EC2_SUBNET,
      resourceId: "public-subnet-2",
      displayName: "Public Subnet (AZ-2)",
    },
    {
      resourceType: RESOURCE_TYPES.EC2_SUBNET,
      resourceId: "private-subnet-1",
      displayName: "Private Subnet (AZ-1)",
    },
    {
      resourceType: RESOURCE_TYPES.EC2_SUBNET,
      resourceId: "private-subnet-2",
      displayName: "Private Subnet (AZ-2)",
    },
    {
      resourceType: RESOURCE_TYPES.EC2_INTERNET_GATEWAY,
      resourceId: "igw",
      displayName: "Internet Gateway",
    },
    {
      resourceType: RESOURCE_TYPES.EC2_VPC_GATEWAY_ATTACHMENT,
      resourceId: "igw-attachment",
      displayName: "VPC Gateway Attachment (IGW)",
      provisionable: false,
    },
    {
      resourceType: RESOURCE_TYPES.EC2_ROUTE_TABLE,
      resourceId: "public-route-table",
      displayName: "Public Route Table",
    },
    {
      resourceType: RESOURCE_TYPES.EC2_ROUTE_TABLE,
      resourceId: "private-route-table",
      displayName: "Private Route Table",
    },
    {
      resourceType: RESOURCE_TYPES.EC2_ROUTE,
      resourceId: "public-route",
      displayName: "Public Route (0.0.0.0/0 -> IGW)",
    },
    {
      resourceType: RESOURCE_TYPES.EC2_ROUTE,
      resourceId: "private-route",
      displayName: "Private Route (0.0.0.0/0 -> NAT)",
    },
    {
      resourceType: COMPANION_RESOURCE_TYPES.EC2_EIP,
      resourceId: "nat-eip",
      displayName: "Elastic IP (for NAT Gateway)",
      provisionable: false,
    },
    {
      resourceType: RESOURCE_TYPES.EC2_NAT_GATEWAY,
      resourceId: "nat-gateway",
      displayName: "NAT Gateway",
    },
    {
      resourceType: RESOURCE_TYPES.EC2_SUBNET_ROUTE_TABLE_ASSOCIATION,
      resourceId: "public-subnet-1-rt-assoc",
      displayName: "Public Subnet 1 <-> Public RT",
      provisionable: false,
    },
    {
      resourceType: RESOURCE_TYPES.EC2_SUBNET_ROUTE_TABLE_ASSOCIATION,
      resourceId: "public-subnet-2-rt-assoc",
      displayName: "Public Subnet 2 <-> Public RT",
      provisionable: false,
    },
    {
      resourceType: RESOURCE_TYPES.EC2_SUBNET_ROUTE_TABLE_ASSOCIATION,
      resourceId: "private-subnet-1-rt-assoc",
      displayName: "Private Subnet 1 <-> Private RT",
      provisionable: false,
    },
    {
      resourceType: RESOURCE_TYPES.EC2_SUBNET_ROUTE_TABLE_ASSOCIATION,
      resourceId: "private-subnet-2-rt-assoc",
      displayName: "Private Subnet 2 <-> Private RT",
      provisionable: false,
    },
  ],
  dependencyOrder: [
    ["vpc"],
    [
      "public-subnet-1",
      "public-subnet-2",
      "private-subnet-1",
      "private-subnet-2",
      "igw",
      "nat-eip",
    ],
    ["igw-attachment", "public-route-table", "private-route-table"],
    ["public-route", "nat-gateway"],
    ["private-route"],
    [
      "public-subnet-1-rt-assoc",
      "public-subnet-2-rt-assoc",
      "private-subnet-1-rt-assoc",
      "private-subnet-2-rt-assoc",
    ],
  ],
  defaultOptions: {},
};

// ═══════════════════════════════════════════════════════════════════════════════
// 1. Compound Dispatcher Tests for ALL 7 Patterns
// ═══════════════════════════════════════════════════════════════════════════════

describe("compoundDispatcherNode — all 8 patterns", () => {
  const patternCases: Array<{
    name: string;
    pattern: ArchitecturePattern;
    expectedQueueLength: number;
    expectedFirstResourceType: string;
    expectedFirstResourceId: string;
  }> = [
    {
      name: "serverless-api (8 resources)",
      pattern: serverlessApiPattern,
      expectedQueueLength: 8,
      expectedFirstResourceType: RESOURCE_TYPES.IAM_ROLE,
      expectedFirstResourceId: "iam-execution-role",
    },
    {
      name: "three-tier-web (22 resources: full VPC + ALB + EC2 + RDS)",
      pattern: threeTierWebPattern,
      expectedQueueLength: 22,
      expectedFirstResourceType: RESOURCE_TYPES.EC2_VPC,
      expectedFirstResourceId: "vpc",
    },
    {
      name: "vpc-networking (17 resources)",
      pattern: vpcNetworkingPattern,
      expectedQueueLength: 17,
      expectedFirstResourceType: RESOURCE_TYPES.EC2_VPC,
      expectedFirstResourceId: "vpc",
    },
    {
      name: "message-processing (5 resources)",
      pattern: messageProcessingPattern,
      expectedQueueLength: 5,
      expectedFirstResourceType: RESOURCE_TYPES.SQS_QUEUE,
      expectedFirstResourceId: "dlq",
    },
    {
      name: "container-service (15 resources: public-only VPC + ECS Fargate)",
      pattern: containerServicePattern,
      expectedQueueLength: 15,
      expectedFirstResourceType: RESOURCE_TYPES.EC2_VPC,
      expectedFirstResourceId: "vpc",
    },
    {
      // (f) 2026-04-09 Task 4b: static-website is now a 4-resource
      // fully-CCAPI compound — added AWS::S3::BucketPolicy as the
      // terminal resource that grants CloudFront OAC read access
      // to the bucket (replaces the post-provision SDK
      // PutBucketPolicy call that used to live in cloudfront-setup.ts).
      name: "static-website (4 resources: S3 + OAC + CloudFront + BucketPolicy)",
      pattern: staticWebsitePattern,
      expectedQueueLength: 4,
      expectedFirstResourceType: RESOURCE_TYPES.S3_BUCKET,
      expectedFirstResourceId: "website-bucket",
    },
    {
      name: "efs-with-vpc (10 resources: VPC + subnets + RT + SG + FS + mount targets)",
      pattern: efsWithVpcPattern,
      expectedQueueLength: 10,
      expectedFirstResourceType: RESOURCE_TYPES.EC2_VPC,
      expectedFirstResourceId: "vpc",
    },
    {
      name: "scheduled-lambda (4 resources: IAM role + Lambda + EventBridge rule + display-only permission)",
      pattern: scheduledLambdaPattern,
      expectedQueueLength: 4,
      expectedFirstResourceType: RESOURCE_TYPES.IAM_ROLE,
      expectedFirstResourceId: "iam-execution-role",
    },
  ];

  for (const tc of patternCases) {
    describe(tc.name, () => {
      it("flattens dependencyOrder into resourceQueue with correct length", async () => {
        const state = makeState({ resourcePattern: tc.pattern });
        const result = await compoundDispatcherNode(state);

        expect(result.resourceQueue).toHaveLength(tc.expectedQueueLength);
      });

      it("sets currentResourceIndex to 0", async () => {
        const state = makeState({ resourcePattern: tc.pattern });
        const result = await compoundDispatcherNode(state);

        expect(result.currentResourceIndex).toBe(0);
      });

      it("initializes completedResources as empty array", async () => {
        const state = makeState({ resourcePattern: tc.pattern });
        const result = await compoundDispatcherNode(state);

        expect(result.completedResources).toEqual([]);
      });

      it("sets first resource type correctly", async () => {
        const state = makeState({ resourcePattern: tc.pattern });
        const result = await compoundDispatcherNode(state);

        expect(result.resourceType).toBe(tc.expectedFirstResourceType);
      });

      it("sets first resource ID correctly", async () => {
        const state = makeState({ resourcePattern: tc.pattern });
        const result = await compoundDispatcherNode(state);

        expect(result.resourceQueue?.[0]?.resourceId).toBe(
          tc.expectedFirstResourceId,
        );
      });

      it("clears desiredState", async () => {
        const state = makeState({
          resourcePattern: tc.pattern,
          desiredState: { stale: "value" },
        });
        const result = await compoundDispatcherNode(state);

        expect(result.desiredState).toBeUndefined();
      });

      it("preserves dependency order (groups flattened left-to-right)", async () => {
        const state = makeState({ resourcePattern: tc.pattern });
        const result = await compoundDispatcherNode(state);

        // Verify the queue matches flattening of dependencyOrder
        const expectedFlat = tc.pattern.dependencyOrder.flat();
        const queueIds = result.resourceQueue!.map((r) => r.resourceId);
        expect(queueIds).toEqual(expectedFlat);
      });

      it("all queue entries have valid resourceType strings", async () => {
        const state = makeState({ resourcePattern: tc.pattern });
        const result = await compoundDispatcherNode(state);

        for (const resource of result.resourceQueue!) {
          expect(resource.resourceType).toBeTruthy();
          expect(resource.resourceType).toContain("::");
        }
      });
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. Resource Provisioner Tests for Compound Resources
// ═══════════════════════════════════════════════════════════════════════════════

describe("resourceProvisionerNode — compound context", () => {
  let mockProvisioner: ReturnType<typeof createMockProvisioner>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockProvisioner = createMockProvisioner();
  });

  describe("clientToken uses runId-currentResourceIndex when index > 0", () => {
    it("uses plain runId as clientToken for index 0", async () => {
      mockProvisioner.createResource.mockResolvedValueOnce([
        null,
        { requestToken: "token-idx-0" },
      ]);

      await resourceProvisionerNode(
        makeState({
          resourceType: "AWS::S3::Bucket",
          desiredState: { BucketName: "compound-test-bucket-0" },
          currentResourceIndex: 0,
        }),
        mockProvisioner,
      );

      // H11: index 0 uses runId with a per-attempt random suffix so retries
      // produce different ClientTokens.
      expect(mockProvisioner.createResource).toHaveBeenCalledWith(
        "AWS::S3::Bucket",
        expect.any(String),
        expect.stringMatching(/^test-compound-run-001-[0-9a-f]{12}$/),
      );
    });

    it("appends index to clientToken for index > 0", async () => {
      mockProvisioner.getResource.mockResolvedValueOnce([
        { kind: ProvisioningErrorKind.NOT_FOUND, message: "Not found" },
        null,
      ]);
      mockProvisioner.createResource.mockResolvedValueOnce([
        null,
        { requestToken: "token-idx-2" },
      ]);

      await resourceProvisionerNode(
        makeState({
          resourceType: "AWS::IAM::Role",
          desiredState: {
            RoleName: "compound-role-2",
            AssumeRolePolicyDocument: {
              Version: "2012-10-17",
              Statement: [],
            },
          },
          currentResourceIndex: 2,
        }),
        mockProvisioner,
      );

      // H11: ClientToken = runId-index-<per-attempt random>
      expect(mockProvisioner.createResource).toHaveBeenCalledWith(
        "AWS::IAM::Role",
        expect.any(String),
        expect.stringMatching(/^test-compound-run-001-2-[0-9a-f]{12}$/),
      );
    });

    it("appends correct index for index 5 (large compound like vpc-networking)", async () => {
      mockProvisioner.getResource.mockResolvedValueOnce([
        { kind: ProvisioningErrorKind.NOT_FOUND, message: "Not found" },
        null,
      ]);
      mockProvisioner.createResource.mockResolvedValueOnce([
        null,
        { requestToken: "token-idx-5" },
      ]);

      await resourceProvisionerNode(
        makeState({
          resourceType: "AWS::IAM::Role",
          desiredState: {
            RoleName: "compound-role-5",
            AssumeRolePolicyDocument: {
              Version: "2012-10-17",
              Statement: [],
            },
          },
          currentResourceIndex: 5,
        }),
        mockProvisioner,
      );

      // H11: ClientToken = runId-index-<per-attempt random>
      expect(mockProvisioner.createResource).toHaveBeenCalledWith(
        "AWS::IAM::Role",
        expect.any(String),
        expect.stringMatching(/^test-compound-run-001-5-[0-9a-f]{12}$/),
      );
    });
  });

  describe("tag injection with compound-specific metadata", () => {
    it("injects mandatory tags for each resource in compound flow", async () => {
      mockProvisioner.createResource.mockResolvedValueOnce([
        null,
        { requestToken: "compound-tag-token" },
      ]);

      await resourceProvisionerNode(
        makeState({
          resourceType: "AWS::S3::Bucket",
          desiredState: { BucketName: "compound-tagged-bucket" },
          currentResourceIndex: 1,
        }),
        mockProvisioner,
      );

      const desiredStateJson = mockProvisioner.createResource.mock
        .calls[0]![1] as string;
      const desiredState = JSON.parse(desiredStateJson) as Record<
        string,
        unknown
      >;

      // NFR-14: mandatory traceability tags
      expect(desiredState).toHaveProperty("Tags");
      expect(desiredState["Tags"]).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            Key: "assignee-run-id",
            Value: "test-compound-run-001",
          }),
          expect.objectContaining({
            Key: "managed-by",
            Value: "assignee-ai",
          }),
        ]),
      );
    });
  });

  describe("SDK fallback types in compound context", () => {
    function createMockFallbackDispatcher() {
      return {
        canHandle: vi.fn().mockReturnValue(false),
        isRedirect: vi.fn().mockReturnValue(null),
        subscribe: vi.fn(),
      };
    }

    it("rejects Lambda EventSourceMapping in compound flow as unsupported (A6 — SDK fallback removed)", async () => {
      // A6 (2026-04-08): CCAPI fully supports AWS::Lambda::EventSourceMapping
      // for destroy (see destroy-service.test.ts), but ESM has no plugin /
      // pattern / intent path — it is not in SUPPORTED_TYPES_ARRAY. So any
      // create attempt through the provisioner (including inside a
      // compound) must fail the state guard, not silently fall back to the
      // removed SDK helper.
      const mockFallback = createMockFallbackDispatcher();
      mockFallback.canHandle.mockReturnValue(false);

      const result = await resourceProvisionerNode(
        makeState({
          resourceType: "AWS::Lambda::EventSourceMapping",
          desiredState: {
            EventSourceArn: "arn:aws:sqs:us-east-1:123456789012:compound-queue",
            FunctionName: "compound-function",
          },
          currentResourceIndex: 3,
        }),
        mockProvisioner,
      );

      expect(result.executionStatus).toBe(ExecutionStatus.FAILED);
      expect(result.errorMessage).toMatch(
        /unsupported or missing resourceType/,
      );
      expect(mockFallback.subscribe).not.toHaveBeenCalled();
      expect(mockProvisioner.createResource).not.toHaveBeenCalled();
    });

    it("routes SNS Subscription through CCAPI in compound flow (A10 — promoted to first-class)", async () => {
      // A10 (2026-04-09): AWS::SNS::Subscription was promoted out of
      // CCAPI_FALLBACK_TYPES and now flows through the standard
      // CloudControl CreateResource path — inside compound flows
      // too. The dispatcher.subscribe() branch is retired.
      const mockFallback = createMockFallbackDispatcher();
      mockFallback.canHandle.mockReturnValue(false);
      mockFallback.isRedirect.mockReturnValue(null);

      mockProvisioner.getResource.mockResolvedValueOnce([
        { kind: ProvisioningErrorKind.NOT_FOUND, message: "Not found" },
        null,
      ]);
      mockProvisioner.createResource.mockResolvedValueOnce([
        null,
        { requestToken: "compound-sns-sub-token" },
      ]);

      const result = await resourceProvisionerNode(
        makeState({
          resourceType: "AWS::SNS::Subscription",
          desiredState: {
            TopicArn: "arn:aws:sns:us-east-1:123456789012:compound-topic",
            Protocol: "sqs",
            Endpoint: "arn:aws:sqs:us-east-1:123456789012:compound-queue",
          },
          currentResourceIndex: 4,
        }),
        mockProvisioner,
      );

      expect(result.executionStatus).toBe(ExecutionStatus.IN_PROGRESS);
      expect(result.requestToken).toBe("compound-sns-sub-token");
      expect(mockFallback.subscribe).not.toHaveBeenCalled();
      expect(mockProvisioner.createResource).toHaveBeenCalledWith(
        "AWS::SNS::Subscription",
        expect.stringContaining(
          '"TopicArn":"arn:aws:sns:us-east-1:123456789012:compound-topic"',
        ),
        expect.any(String),
      );
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. Multi-Resource Queue Iteration (result-formatter compound loop)
// ═══════════════════════════════════════════════════════════════════════════════

describe("compound queue iteration (result-formatter loop)", () => {
  let resultFormatterNode: typeof import("../result-formatter.js").resultFormatterNode;

  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = await import("../result-formatter.js");
    resultFormatterNode = mod.resultFormatterNode;
  });

  /** Simple 3-resource pattern for iteration tests */
  const iterPattern: ArchitecturePattern = {
    patternId: "test-iter",
    displayName: "Test Iteration Pattern",
    keywords: ["test"],
    resourceList: [
      {
        resourceId: "role",
        resourceType: "AWS::IAM::Role",
        displayName: "Role",
      },
      {
        resourceId: "lambda",
        resourceType: "AWS::Lambda::Function",
        displayName: "Lambda",
      },
      {
        resourceId: "bucket",
        resourceType: "AWS::S3::Bucket",
        displayName: "Bucket",
      },
    ],
    dependencyOrder: [["role"], ["lambda"], ["bucket"]],
    defaultOptions: {},
  };

  it("advances currentResourceIndex from 0 to 1 after first resource succeeds", async () => {
    const state = makeState({
      executionStatus: ExecutionStatus.SUCCESS,
      resourcePattern: iterPattern,
      resourceQueue: iterPattern.resourceList,
      currentResourceIndex: 0,
      completedResources: [],
      resourceArn: "arn:aws:iam::123:role/test-role",
      resourceType: "AWS::IAM::Role",
    });

    const result = await resultFormatterNode(state);

    expect(result.currentResourceIndex).toBe(1);
    expect(result.resourceType).toBe("AWS::Lambda::Function");
    expect(result.executionStatus).toBe(ExecutionStatus.PENDING);
    expect(result.completedResources).toHaveLength(1);
    expect(result.completedResources?.[0]?.resourceId).toBe("role");
  });

  it("advances currentResourceIndex from 1 to 2 with accumulated completed", async () => {
    const state = makeState({
      executionStatus: ExecutionStatus.SUCCESS,
      resourcePattern: iterPattern,
      resourceQueue: iterPattern.resourceList,
      currentResourceIndex: 1,
      completedResources: [
        {
          resourceId: "role",
          resourceType: "AWS::IAM::Role",
          resourceArn: "arn:aws:iam::123:role/test-role",
          executionStatus: ExecutionStatus.SUCCESS,
        },
      ],
      resourceArn: "arn:aws:lambda:us-east-1:123:function:test-fn",
      resourceType: "AWS::Lambda::Function",
    });

    const result = await resultFormatterNode(state);

    expect(result.currentResourceIndex).toBe(2);
    expect(result.resourceType).toBe("AWS::S3::Bucket");
    expect(result.executionStatus).toBe(ExecutionStatus.PENDING);
    expect(result.completedResources).toHaveLength(2);
    expect(result.completedResources?.[1]?.resourceId).toBe("lambda");
  });

  it("renders compound summary when last resource (index 2) completes", async () => {
    const { renderCompoundSuccess } = await import("@/utils/display.js");
    const state = makeState({
      executionStatus: ExecutionStatus.SUCCESS,
      resourcePattern: iterPattern,
      resourceQueue: iterPattern.resourceList,
      currentResourceIndex: 2, // last resource
      completedResources: [
        {
          resourceId: "role",
          resourceType: "AWS::IAM::Role",
          resourceArn: "arn:aws:iam::123:role/test-role",
          executionStatus: ExecutionStatus.SUCCESS,
        },
        {
          resourceId: "lambda",
          resourceType: "AWS::Lambda::Function",
          resourceArn: "arn:aws:lambda:us-east-1:123:function:test-fn",
          executionStatus: ExecutionStatus.SUCCESS,
        },
      ],
      resourceArn: "arn:aws:s3:::test-bucket",
      resourceType: "AWS::S3::Bucket",
    });

    const result = await resultFormatterNode(state);

    // All 3 completed
    expect(result.completedResources).toHaveLength(3);
    expect(result.completedResources?.[2]?.resourceId).toBe("bucket");
    // No more resources to advance to — should NOT set executionStatus to PENDING
    expect(result.executionStatus).toBeUndefined();
    expect(result.currentResourceIndex).toBeUndefined();
    // Should have rendered compound success. Wave 8/9: a third
    // displayArns parameter is passed (a Record<resourceId, fullArn>)
    // so renderCompoundSuccess can show resolved ARNs while
    // completedResources[].resourceArn keeps the bare CCAPI identifier
    // for downstream compound marker resolution.
    expect(renderCompoundSuccess).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ resourceId: "role" }),
        expect.objectContaining({ resourceId: "lambda" }),
        expect.objectContaining({ resourceId: "bucket" }),
      ]),
      iterPattern,
      expect.any(Object),
    );
  });

  it("completedResources tracking preserves ARNs across iterations", async () => {
    const state = makeState({
      executionStatus: ExecutionStatus.SUCCESS,
      resourcePattern: iterPattern,
      resourceQueue: iterPattern.resourceList,
      currentResourceIndex: 1,
      completedResources: [
        {
          resourceId: "role",
          resourceType: "AWS::IAM::Role",
          resourceArn: "arn:aws:iam::123:role/my-role",
          executionStatus: ExecutionStatus.SUCCESS,
        },
      ],
      resourceArn: "arn:aws:lambda:us-east-1:123:function:my-fn",
      resourceType: "AWS::Lambda::Function",
    });

    const result = await resultFormatterNode(state);

    expect(result.completedResources?.[0]?.resourceArn).toBe(
      "arn:aws:iam::123:role/my-role",
    );
    expect(result.completedResources?.[1]?.resourceArn).toBe(
      "arn:aws:lambda:us-east-1:123:function:my-fn",
    );
  });

  it("resets requestToken, resourceArn, desiredState for next resource", async () => {
    const state = makeState({
      executionStatus: ExecutionStatus.SUCCESS,
      resourcePattern: iterPattern,
      resourceQueue: iterPattern.resourceList,
      currentResourceIndex: 0,
      completedResources: [],
      resourceArn: "arn:aws:iam::123:role/completed",
      requestToken: "old-token",
      desiredState: { RoleName: "old-state" },
      resourceType: "AWS::IAM::Role",
    });

    const result = await resultFormatterNode(state);

    expect(result.requestToken).toBeUndefined();
    expect(result.resourceArn).toBeUndefined();
    expect(result.desiredState).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. Error Handling in Compound Flow
// ═══════════════════════════════════════════════════════════════════════════════

describe("compound flow error handling", () => {
  let resultFormatterNode: typeof import("../result-formatter.js").resultFormatterNode;
  let mockProvisioner: ReturnType<typeof createMockProvisioner>;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockProvisioner = createMockProvisioner();
    const mod = await import("../result-formatter.js");
    resultFormatterNode = mod.resultFormatterNode;
  });

  /** 4-resource pattern to test mid-flow failure */
  const failPattern: ArchitecturePattern = {
    patternId: "test-fail",
    displayName: "Test Failure Pattern",
    keywords: ["test"],
    resourceList: [
      {
        resourceId: "sg",
        resourceType: "AWS::EC2::SecurityGroup",
        displayName: "Security Group",
      },
      {
        resourceId: "role",
        resourceType: "AWS::IAM::Role",
        displayName: "Role",
      },
      {
        resourceId: "lambda",
        resourceType: "AWS::Lambda::Function",
        displayName: "Lambda",
      },
      {
        resourceId: "bucket",
        resourceType: "AWS::S3::Bucket",
        displayName: "Bucket",
      },
    ],
    dependencyOrder: [["sg", "role"], ["lambda"], ["bucket"]],
    defaultOptions: {},
  };

  it("resource provisioner failure at index 2 returns FAILED status", async () => {
    mockProvisioner.getResource.mockResolvedValueOnce([
      { kind: ProvisioningErrorKind.NOT_FOUND, message: "Not found" },
      null,
    ]);
    mockProvisioner.createResource.mockResolvedValueOnce([
      {
        kind: ProvisioningErrorKind.UNKNOWN,
        message: "InternalException: service unavailable",
      },
      null,
    ]);

    const result = await resourceProvisionerNode(
      makeState({
        resourceType: "AWS::Lambda::Function",
        desiredState: {
          FunctionName: "fail-fn",
          Runtime: "nodejs22.x",
          Role: "arn:aws:iam::123:role/exec",
          Code: { ZipFile: "exports.handler = async () => ({});" },
        },
        currentResourceIndex: 2,
        completedResources: [
          {
            resourceId: "sg",
            resourceType: "AWS::EC2::SecurityGroup",
            executionStatus: ExecutionStatus.SUCCESS,
            resourceArn: "sg-abc123",
          },
          {
            resourceId: "role",
            resourceType: "AWS::IAM::Role",
            executionStatus: ExecutionStatus.SUCCESS,
            resourceArn: "arn:aws:iam::123:role/exec",
          },
        ],
      }),
      mockProvisioner,
    );

    expect(result.executionStatus).toBe(ExecutionStatus.FAILED);
    expect(result.errorMessage).toMatch(/CloudControl provisioning failed/);
  });

  it("result-formatter shows cleanup guidance with previously provisioned resources on failure", async () => {
    const { renderCompoundPartialFailure } = await import("@/utils/display.js");

    const state = makeState({
      executionStatus: ExecutionStatus.FAILED,
      errorMessage: "Lambda provisioning failed",
      resourcePattern: failPattern,
      resourceQueue: failPattern.resourceList,
      currentResourceIndex: 2,
      resourceType: "AWS::Lambda::Function",
      completedResources: [
        {
          resourceId: "sg",
          resourceType: "AWS::EC2::SecurityGroup",
          executionStatus: ExecutionStatus.SUCCESS,
          resourceArn: "sg-abc123",
        },
        {
          resourceId: "role",
          resourceType: "AWS::IAM::Role",
          executionStatus: ExecutionStatus.SUCCESS,
          resourceArn: "arn:aws:iam::123:role/exec",
        },
      ],
    });

    await resultFormatterNode(state);

    // Item 1 (2026-04-09): cleanup guidance is now structured input
    // to renderCompoundPartialFailure instead of a single stringified
    // renderError blob. Assert that both completed resources are
    // forwarded and the failed resource is identified.
    expect(renderCompoundPartialFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        completed: expect.arrayContaining([
          expect.objectContaining({
            resourceType: "AWS::EC2::SecurityGroup",
          }),
          expect.objectContaining({ resourceType: "AWS::IAM::Role" }),
        ]),
        failedResource: expect.objectContaining({
          resourceType: expect.stringMatching(/Lambda|Function/),
        }),
      }),
    );
    const call = (renderCompoundPartialFailure as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as {
      completed: Array<{ resourceType: string }>;
      failedResource: { resourceType: string };
    };
    // Verify ORDER (dependency-forward) — toHaveBeenCalledWith above
    // can match the array regardless of order, so a separate ordered
    // assertion guards against regressions that reorder the cleanup
    // list (renderer relies on forward order to do its own reversal).
    expect(call.completed.map((r) => r.resourceType)).toEqual([
      "AWS::EC2::SecurityGroup",
      "AWS::IAM::Role",
    ]);
  });

  it("cleanup guidance lists resources in forward order (renderer reverses for destroy)", async () => {
    const { renderCompoundPartialFailure } = await import("@/utils/display.js");

    const state = makeState({
      executionStatus: ExecutionStatus.FAILED,
      errorMessage: "Bucket provisioning failed",
      resourcePattern: failPattern,
      resourceQueue: failPattern.resourceList,
      currentResourceIndex: 3,
      resourceType: "AWS::S3::Bucket",
      completedResources: [
        {
          resourceId: "sg",
          resourceType: "AWS::EC2::SecurityGroup",
          executionStatus: ExecutionStatus.SUCCESS,
          resourceArn: "sg-abc123",
        },
        {
          resourceId: "role",
          resourceType: "AWS::IAM::Role",
          executionStatus: ExecutionStatus.SUCCESS,
          resourceArn: "arn:aws:iam::123:role/exec",
        },
        {
          resourceId: "lambda",
          resourceType: "AWS::Lambda::Function",
          executionStatus: ExecutionStatus.SUCCESS,
          resourceArn: "arn:aws:lambda:us-east-1:123:function:fn",
        },
      ],
    });

    await resultFormatterNode(state);

    expect(renderCompoundPartialFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        completed: expect.arrayContaining([
          expect.objectContaining({
            resourceType: "AWS::EC2::SecurityGroup",
          }),
          expect.objectContaining({ resourceType: "AWS::IAM::Role" }),
          expect.objectContaining({
            resourceType: "AWS::Lambda::Function",
          }),
        ]),
      }),
    );
    const call = (renderCompoundPartialFailure as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as {
      completed: Array<{ resourceType: string; resourceArn?: string }>;
    };
    // Forward (dependency) order — renderer handles reversal for
    // the destroy output. The reverse-order destroy assertion
    // lives in apps/cli/src/utils/display.test.ts against real
    // captured stderr output.
    expect(call.completed.map((r) => r.resourceType)).toEqual([
      "AWS::EC2::SecurityGroup",
      "AWS::IAM::Role",
      "AWS::Lambda::Function",
    ]);
  });

  it("partial failure with no completed resources shows standard error (no cleanup guidance)", async () => {
    const { renderError } = await import("@/utils/display.js");

    const state = makeState({
      executionStatus: ExecutionStatus.FAILED,
      errorMessage: "First resource failed immediately",
      resourcePattern: failPattern,
      resourceQueue: failPattern.resourceList,
      currentResourceIndex: 0,
      resourceType: "AWS::EC2::SecurityGroup",
      completedResources: [],
    });

    await resultFormatterNode(state);

    // First-arg is the user-visible error message. Assert it does NOT
    // begin with the compound "halted at" prefix because no completed
    // resources exist — this branch must take the standard renderError
    // path, NOT the compound-partial-failure path.
    expect(renderError).toHaveBeenCalledWith(
      expect.not.stringMatching(/halted at/i),
      expect.anything(),
      expect.anything(),
    );
    const errorCall = (renderError as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const errorMessage = errorCall[0] as string;

    // No "halted at" since completedResources is empty
    expect(errorMessage).not.toMatch(/halted at/i);
  });

  it("throttled error mid-compound returns FAILED with throttle message", async () => {
    mockProvisioner.createResource.mockResolvedValueOnce([
      { kind: ProvisioningErrorKind.THROTTLED, message: "Rate exceeded" },
      null,
    ]);

    const result = await resourceProvisionerNode(
      makeState({
        resourceType: "AWS::S3::Bucket",
        desiredState: { BucketName: "throttled-compound-bucket" },
        currentResourceIndex: 3,
      }),
      mockProvisioner,
    );

    expect(result.executionStatus).toBe(ExecutionStatus.FAILED);
    expect(result.errorMessage).toMatch(/throttled/i);
  });

  it("already-exists error mid-compound returns FAILED", async () => {
    mockProvisioner.createResource.mockResolvedValueOnce([
      {
        kind: ProvisioningErrorKind.ALREADY_EXISTS,
        message: "already exists",
      },
      null,
    ]);

    const result = await resourceProvisionerNode(
      makeState({
        resourceType: "AWS::S3::Bucket",
        desiredState: { BucketName: "existing-compound-bucket" },
        currentResourceIndex: 1,
      }),
      mockProvisioner,
    );

    expect(result.executionStatus).toBe(ExecutionStatus.FAILED);
    expect(result.errorMessage).toMatch(
      /already taken globally|already exists/i,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. Full Dispatcher -> Provisioner Integration (serverless-api pattern)
// ═══════════════════════════════════════════════════════════════════════════════

describe("full compound dispatcher -> provisioner integration", () => {
  let mockProvisioner: ReturnType<typeof createMockProvisioner>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockProvisioner = createMockProvisioner();
  });

  it("dispatcher output feeds directly into provisioner for first resource", async () => {
    // Step 1: Run dispatcher with serverless-api pattern
    const dispatchState = makeState({
      resourcePattern: serverlessApiPattern,
    });
    const dispatchResult = await compoundDispatcherNode(dispatchState);

    // Step 2: Verify dispatcher output
    expect(dispatchResult.resourceType).toBe(RESOURCE_TYPES.IAM_ROLE);
    expect(dispatchResult.currentResourceIndex).toBe(0);

    // Step 3: Mock provisioner for IAM Role
    mockProvisioner.getResource.mockResolvedValueOnce([
      { kind: ProvisioningErrorKind.NOT_FOUND, message: "Not found" },
      null,
    ]);
    mockProvisioner.createResource.mockResolvedValueOnce([
      null,
      { requestToken: "iam-role-token-001" },
    ]);

    const provisionState = makeState({
      ...dispatchResult,
      desiredState: {
        RoleName: "serverless-api-role",
        AssumeRolePolicyDocument: {
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Principal: { Service: "lambda.amazonaws.com" },
              Action: "sts:AssumeRole",
            },
          ],
        },
      },
    });

    const provisionResult = await resourceProvisionerNode(
      provisionState,
      mockProvisioner,
    );

    expect(provisionResult.executionStatus).toBe(ExecutionStatus.IN_PROGRESS);
    expect(provisionResult.requestToken).toBe("iam-role-token-001");
    // H11: Index 0 uses runId with a per-attempt random suffix
    expect(mockProvisioner.createResource).toHaveBeenCalledWith(
      "AWS::IAM::Role",
      expect.any(String),
      expect.stringMatching(/^test-compound-run-001-[0-9a-f]{12}$/),
    );
  });

  it("dispatches vpc-networking pattern and first resource is VPC at index 0", async () => {
    const dispatchState = makeState({
      resourcePattern: vpcNetworkingPattern,
    });
    const dispatchResult = await compoundDispatcherNode(dispatchState);

    expect(dispatchResult.resourceQueue).toHaveLength(17);
    expect(dispatchResult.resourceType).toBe(RESOURCE_TYPES.EC2_VPC);
    expect(dispatchResult.currentResourceIndex).toBe(0);

    // Verify VPC pattern has the full dependency chain
    const queueIds = dispatchResult.resourceQueue!.map((r) => r.resourceId);
    expect(queueIds[0]).toBe("vpc");
    // Last group should be associations
    expect(queueIds[queueIds.length - 1]).toBe("private-subnet-2-rt-assoc");
  });

  it("dispatcher includes companion resources (provisionable=false) in queue", async () => {
    const dispatchState = makeState({
      resourcePattern: vpcNetworkingPattern,
    });
    const dispatchResult = await compoundDispatcherNode(dispatchState);

    // VPC pattern has several provisionable=false resources
    const companionResources = dispatchResult.resourceQueue!.filter(
      (r) => r.provisionable === false,
    );

    // igw-attachment, nat-eip, 4x subnet-rt-assoc = 6 companion resources
    expect(companionResources.length).toBe(6);
    expect(companionResources.map((r) => r.resourceId)).toEqual(
      expect.arrayContaining([
        "igw-attachment",
        "nat-eip",
        "public-subnet-1-rt-assoc",
        "public-subnet-2-rt-assoc",
        "private-subnet-1-rt-assoc",
        "private-subnet-2-rt-assoc",
      ]),
    );
  });

  it("serverless-api pattern includes companion resources (provisionable=false) in queue", async () => {
    const dispatchState = makeState({
      resourcePattern: serverlessApiPattern,
    });
    const dispatchResult = await compoundDispatcherNode(dispatchState);

    // Serverless API has 5 provisionable=false resources:
    // http-api, lambda-integration, default-route, default-stage, api-invoke-permission
    const companionResources = dispatchResult.resourceQueue!.filter(
      (r) => r.provisionable === false,
    );

    expect(companionResources.length).toBe(5);
  });
});
