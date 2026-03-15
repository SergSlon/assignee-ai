import { describe, it, expect, vi, beforeEach } from "vitest";
import { ExecutionStatus } from "@assignee/core";
import { resourceProvisionerNode } from "./resource-provisioner.js";
import type { StructuredTool } from "@langchain/core/tools";

// ── Real MCP response shapes captured from ccapi-mcp-server v1+ ──────────────
//
// ccapi-mcp-server returns plain JSON strings (no { type:"text", text } wrapper),
// unlike aws-iac-mcp-server and aws-pricing-mcp-server which use the wrapper.

/** get_aws_account_info response — account metadata + opaque credentials token */
const REAL_ACCOUNT_INFO_RESPONSE = JSON.stringify({
  account_id: "112233445566",
  region: "us-east-1",
  credentials_token:
    "eyJhY2NvdW50X2lkIjoiMDU0MTI1MDE4NDc2IiwicmVnaW9uIjoidXMtZWFzdC0xIn0=",
});

/** generate_infrastructure_code response — CDK/CFN code + opaque code token */
const REAL_GENERATE_CODE_RESPONSE = JSON.stringify({
  generated_code_token:
    "eyJyZXNvdXJjZV90eXBlIjoiQVdTOjpTMzo6QnVja2V0IiwicHJvcGVydGllcyI6eyJCdWNrZXROYW1lIjoicG9jLXNtb2tlLXRlc3QifX0=",
  resource_type: "AWS::S3::Bucket",
  code_summary:
    "Creates an S3 bucket named poc-smoke-test with mandatory tags.",
});

/** explain response — human-readable explanation + opaque explained token */
const REAL_EXPLAIN_RESPONSE = JSON.stringify({
  explained_token:
    "eyJvcGVyYXRpb24iOiJjcmVhdGUiLCJyZXNvdXJjZV90eXBlIjoiQVdTOjpTMzo6QnVja2V0In0=",
  operation: "create",
  explanation:
    "This operation will create a new S3 bucket named poc-smoke-test in us-east-1.",
});

/** run_checkov response — security scan results + opaque scan token */
const REAL_CHECKOV_RESPONSE = JSON.stringify({
  security_scan_token: "eyJwYXNzZWQiOnRydWUsImZpbmRpbmdzIjpbXX0=",
  passed: true,
  findings: [],
  summary: "0 failed, 12 passed",
});

/** create_resource response — async operation started, poll via request_token */
const REAL_CREATE_RESOURCE_RESPONSE = JSON.stringify({
  request_token: "0ff011d6-654f-4110-8a37-9754bd6aad59",
  status: "IN_PROGRESS",
  is_complete: false,
  resource_type: "AWS::S3::Bucket",
  operation: "CREATE",
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeState(overrides: Record<string, unknown> = {}) {
  return {
    userIntent: "Create an S3 bucket named poc-smoke-test",
    runId: "run-prov-test-001",
    executionStatus: ExecutionStatus.PENDING,
    executionMode: "apply",
    resourceType: "AWS::S3::Bucket",
    resourceSchema: undefined,
    desiredState: { BucketName: "poc-smoke-test" },
    estimatedMonthlyCost: "$0.0230/GB-month",
    requestToken: undefined,
    resourceArn: undefined,
    errorMessage: undefined,
    startedAt: undefined,
    messages: [],
    preflightPassed: true,
    preflightErrors: [],
    preflightMode: "local",
    ...overrides,
  } as unknown as Parameters<typeof resourceProvisionerNode>[0];
}

function makeTool(name: string, response: unknown): StructuredTool {
  return {
    name,
    invoke: vi.fn().mockResolvedValue(response),
  } as unknown as StructuredTool;
}

/** Full happy-path tool set — all 5 required CCAPI tools */
function makeAllTools(overrides: Partial<Record<string, unknown>> = {}) {
  return [
    makeTool(
      "get_aws_account_info",
      overrides["get_aws_account_info"] ?? REAL_ACCOUNT_INFO_RESPONSE,
    ),
    makeTool(
      "generate_infrastructure_code",
      overrides["generate_infrastructure_code"] ?? REAL_GENERATE_CODE_RESPONSE,
    ),
    makeTool("explain", overrides["explain"] ?? REAL_EXPLAIN_RESPONSE),
    makeTool("run_checkov", overrides["run_checkov"] ?? REAL_CHECKOV_RESPONSE),
    makeTool(
      "create_resource",
      overrides["create_resource"] ?? REAL_CREATE_RESOURCE_RESPONSE,
    ),
  ];
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("resourceProvisionerNode", () => {
  describe("pre-flight guards", () => {
    it("returns empty when executionStatus is CANCELLED", async () => {
      const result = await resourceProvisionerNode(
        makeState({ executionStatus: ExecutionStatus.CANCELLED }),
        makeAllTools(),
      );
      expect(result).toEqual({});
    });

    it("fails when desiredState is missing", async () => {
      const result = await resourceProvisionerNode(
        makeState({ desiredState: undefined }),
        makeAllTools(),
      );
      expect(result.executionStatus).toBe(ExecutionStatus.FAILED);
      expect(result.errorMessage).toMatch(/desiredState is missing/);
    });

    it("fails when a required CCAPI tool is missing", async () => {
      // Drop 'run_checkov' from the tool list
      const tools = makeAllTools().filter((t) => t.name !== "run_checkov");
      const result = await resourceProvisionerNode(makeState(), tools);
      expect(result.executionStatus).toBe(ExecutionStatus.FAILED);
      expect(result.errorMessage).toMatch(/missing tool 'run_checkov'/);
    });

    it("fails when ALL tools are absent", async () => {
      const result = await resourceProvisionerNode(makeState(), []);
      expect(result.executionStatus).toBe(ExecutionStatus.FAILED);
      expect(result.errorMessage).toMatch(/ccapi-mcp-server not available/);
    });
  });

  describe("state guard (FR-15 Read-Before-Write)", () => {
    it("aborts with Stale Plan error when get_resource succeeds (resource exists)", async () => {
      // Real get_resource response when the S3 bucket already exists
      const getResourceTool = makeTool(
        "get_resource",
        JSON.stringify({
          resource_type: "AWS::S3::Bucket",
          identifier: "poc-smoke-test",
          properties: {
            BucketName: "poc-smoke-test",
            Arn: "arn:aws:s3:::poc-smoke-test",
          },
        }),
      );
      const tools = [...makeAllTools(), getResourceTool];

      const result = await resourceProvisionerNode(makeState(), tools);

      expect(result.executionStatus).toBe(ExecutionStatus.FAILED);
      expect(result.errorMessage).toMatch(/Stale Plan/);
      expect(result.errorMessage).toMatch(/poc-smoke-test/);
      // Provisioning tools must NOT have been called
      const createTool = tools.find((t) => t.name === "create_resource")!;
      expect(
        createTool.invoke as ReturnType<typeof vi.fn>,
      ).not.toHaveBeenCalled();
    });

    it("proceeds when get_resource throws (resource not found — safe to create)", async () => {
      // Real error thrown by ccapi-mcp-server when resource does not exist
      const getResourceTool = {
        name: "get_resource",
        invoke: vi
          .fn()
          .mockRejectedValue(
            new Error(
              "Resource not found: AWS::S3::Bucket/poc-smoke-test (HandlerErrorCode: NotFound)",
            ),
          ),
      } as unknown as StructuredTool;
      const tools = [...makeAllTools(), getResourceTool];

      const result = await resourceProvisionerNode(makeState(), tools);

      expect(result.executionStatus).toBe(ExecutionStatus.IN_PROGRESS);
      expect(result.requestToken).toBe("0ff011d6-654f-4110-8a37-9754bd6aad59");
    });

    it("skips state guard when get_resource tool is not provided", async () => {
      // No get_resource in tool list — guard is silently bypassed
      const result = await resourceProvisionerNode(makeState(), makeAllTools());

      expect(result.executionStatus).toBe(ExecutionStatus.IN_PROGRESS);
    });

    it("skips state guard when identifier cannot be derived (no BucketName)", async () => {
      const getResourceTool = makeTool("get_resource", "{}");
      const tools = [...makeAllTools(), getResourceTool];

      // desiredState has no BucketName — getPrimaryIdentifier returns undefined
      const result = await resourceProvisionerNode(
        makeState({ desiredState: { Tags: [] } }),
        tools,
      );

      expect(
        getResourceTool.invoke as ReturnType<typeof vi.fn>,
      ).not.toHaveBeenCalled();
      expect(result.executionStatus).toBe(ExecutionStatus.IN_PROGRESS);
    });
  });

  describe("happy path — full 4-step CCAPI workflow", () => {
    it("calls all 5 tools in order and returns IN_PROGRESS with requestToken", async () => {
      const tools = makeAllTools();
      const result = await resourceProvisionerNode(makeState(), tools);

      expect(result.executionStatus).toBe(ExecutionStatus.IN_PROGRESS);
      expect(result.requestToken).toBe("0ff011d6-654f-4110-8a37-9754bd6aad59");
      expect(result.startedAt).toBeDefined();

      const [accountTool, codeTool, explainTool, checkovTool, createTool] =
        tools as [
          StructuredTool,
          StructuredTool,
          StructuredTool,
          StructuredTool,
          StructuredTool,
        ];

      // Step 1: get_aws_account_info — no input required
      expect(accountTool.invoke).toHaveBeenCalledWith({});

      // Step 2: generate_infrastructure_code — receives credentials_token from step 1
      expect(codeTool.invoke).toHaveBeenCalledWith(
        expect.objectContaining({
          resource_type: "AWS::S3::Bucket",
          credentials_token:
            "eyJhY2NvdW50X2lkIjoiMDU0MTI1MDE4NDc2IiwicmVnaW9uIjoidXMtZWFzdC0xIn0=",
        }),
      );

      // Step 3: explain — receives generated_code_token from step 2
      expect(explainTool.invoke).toHaveBeenCalledWith(
        expect.objectContaining({
          generated_code_token:
            "eyJyZXNvdXJjZV90eXBlIjoiQVdTOjpTMzo6QnVja2V0IiwicHJvcGVydGllcyI6eyJCdWNrZXROYW1lIjoicG9jLXNtb2tlLXRlc3QifX0=",
          operation: "create",
        }),
      );

      // Step 4: run_checkov — receives explained_token from step 3
      expect(checkovTool.invoke).toHaveBeenCalledWith(
        expect.objectContaining({
          explained_token:
            "eyJvcGVyYXRpb24iOiJjcmVhdGUiLCJyZXNvdXJjZV90eXBlIjoiQVdTOjpTMzo6QnVja2V0In0=",
        }),
      );

      // Step 5: create_resource — receives all 3 tokens
      expect(createTool.invoke).toHaveBeenCalledWith(
        expect.objectContaining({
          resource_type: "AWS::S3::Bucket",
          credentials_token:
            "eyJhY2NvdW50X2lkIjoiMDU0MTI1MDE4NDc2IiwicmVnaW9uIjoidXMtZWFzdC0xIn0=",
          explained_token:
            "eyJvcGVyYXRpb24iOiJjcmVhdGUiLCJyZXNvdXJjZV90eXBlIjoiQVdTOjpTMzo6QnVja2V0In0=",
          security_scan_token: "eyJwYXNzZWQiOnRydWUsImZpbmRpbmdzIjpbXX0=",
        }),
      );
    });

    it("injects mandatory tags into generate_infrastructure_code properties", async () => {
      const tools = makeAllTools();
      await resourceProvisionerNode(makeState(), tools);

      const codeTool = tools.find(
        (t) => t.name === "generate_infrastructure_code",
      )!;
      const callArgs = (
        (codeTool.invoke as ReturnType<typeof vi.fn>).mock.calls[0] as [
          Record<string, unknown>,
        ]
      )[0];
      const properties = callArgs["properties"] as Record<string, unknown>;

      // NFR-14: mandatory traceability tags must be injected
      expect(properties).toHaveProperty("Tags");
      expect(properties["Tags"]).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            Key: "assignee-run-id",
            Value: "run-prov-test-001",
          }),
          expect.objectContaining({ Key: "managed-by", Value: "assignee-ai" }),
        ]),
      );
    });

    it("works for AWS::SSM::Parameter with Name as identifier", async () => {
      const createResponse = JSON.stringify({
        request_token: "ssm-req-token-abc",
        status: "IN_PROGRESS",
        is_complete: false,
      });
      const tools = makeAllTools({ create_resource: createResponse });

      const result = await resourceProvisionerNode(
        makeState({
          resourceType: "AWS::SSM::Parameter",
          desiredState: {
            Name: "/app/config/env",
            Value: "production",
            Type: "String",
          },
        }),
        tools,
      );

      expect(result.executionStatus).toBe(ExecutionStatus.IN_PROGRESS);
      expect(result.requestToken).toBe("ssm-req-token-abc");
    });

    it("works for AWS::IAM::Role with RoleName as identifier", async () => {
      const createResponse = JSON.stringify({
        request_token: "iam-req-token-xyz",
        status: "IN_PROGRESS",
        is_complete: false,
      });
      const tools = makeAllTools({ create_resource: createResponse });

      const result = await resourceProvisionerNode(
        makeState({
          resourceType: "AWS::IAM::Role",
          desiredState: {
            RoleName: "poc-lambda-role",
            AssumeRolePolicyDocument: { Version: "2012-10-17", Statement: [] },
          },
        }),
        tools,
      );

      expect(result.executionStatus).toBe(ExecutionStatus.IN_PROGRESS);
      expect(result.requestToken).toBe("iam-req-token-xyz");
    });
  });

  describe("error handling — each step can fail independently", () => {
    it("fails when get_aws_account_info throws (bad credentials)", async () => {
      // Real error from ccapi-mcp-server when AWS credentials are invalid
      const tools = makeAllTools();
      const accountTool = tools.find((t) => t.name === "get_aws_account_info")!;
      (accountTool as unknown as { invoke: ReturnType<typeof vi.fn> }).invoke =
        vi
          .fn()
          .mockRejectedValue(
            new Error(
              "Unable to locate credentials. You can configure credentials by running 'aws configure'.",
            ),
          );

      const result = await resourceProvisionerNode(makeState(), tools);
      expect(result.executionStatus).toBe(ExecutionStatus.FAILED);
      expect(result.errorMessage).toMatch(/Resource creation failed/);
      expect(result.errorMessage).toMatch(/Unable to locate credentials/);
    });

    it("fails when generate_infrastructure_code throws", async () => {
      const tools = makeAllTools();
      const codeTool = tools.find(
        (t) => t.name === "generate_infrastructure_code",
      )!;
      (codeTool as unknown as { invoke: ReturnType<typeof vi.fn> }).invoke = vi
        .fn()
        .mockRejectedValue(
          new Error(
            "Invalid resource type: AWS::S3::Bucket is not supported in this region",
          ),
        );

      const result = await resourceProvisionerNode(makeState(), tools);
      expect(result.executionStatus).toBe(ExecutionStatus.FAILED);
      expect(result.errorMessage).toMatch(/Resource creation failed/);
    });

    it("fails when run_checkov returns invalid JSON", async () => {
      const tools = makeAllTools({ run_checkov: "not-valid-json{{" });

      const result = await resourceProvisionerNode(makeState(), tools);
      expect(result.executionStatus).toBe(ExecutionStatus.FAILED);
      expect(result.errorMessage).toMatch(/Resource creation failed/);
    });

    it("fails when create_resource throws (e.g. BucketAlreadyExists race condition)", async () => {
      // Real error from CCAPI when S3 bucket name is already taken
      const tools = makeAllTools();
      const createTool = tools.find((t) => t.name === "create_resource")!;
      (createTool as unknown as { invoke: ReturnType<typeof vi.fn> }).invoke =
        vi
          .fn()
          .mockRejectedValue(
            new Error(
              'Resource handler returned message: "BucketAlreadyOwnedByYou" (HandlerErrorCode: AlreadyExists)',
            ),
          );

      const result = await resourceProvisionerNode(makeState(), tools);
      expect(result.executionStatus).toBe(ExecutionStatus.FAILED);
      expect(result.errorMessage).toMatch(/BucketAlreadyOwnedByYou/);
    });
  });
});
