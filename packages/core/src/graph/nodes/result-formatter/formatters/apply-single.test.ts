/**
 * Tests for `formatApplySingleSuccess` — single-resource apply success
 * formatter. SSH-bundle Story ii created this file to pin the
 * post-apply DescribeInstances wiring that surfaces a freshly-launched
 * EC2 instance's PublicIpAddress / PublicDnsName on the success line.
 *
 * Coverage:
 *   - EC2 happy path: DescribeInstances called once with the bare
 *     InstanceId from `state.resourceArn`; result spread onto the
 *     RenderableState passed to renderApplySuccess.
 *   - EC2 with no public IP: DescribeInstances called, returns
 *     instance with no PublicIpAddress; renderApplySuccess receives
 *     state without network fields.
 *   - DescribeInstances throws (throttle / AccessDenied): rendering
 *     proceeds with ARN-only state (no apply failure).
 *   - Non-EC2 resource: DescribeInstances NOT called (S3, IAM, RDS).
 *
 * All AWS-shape values are real (real-shape InstanceId, real
 * PublicDnsName template) per `feedback_real_data_mocks_all_cases`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ExecutionMode, ExecutionStatus } from "@/index.js";
import type { AgentState } from "@/graph/graph-state.js";
import type { RenderableState } from "@/utils/display-helpers/renderable-state.js";
import { ProcessEnvConfigAdapter } from "@/config/config-port.js";

// ── Hoisted mocks ────────────────────────────────────────────────────────────

const {
  mockEc2Send,
  mockEc2Destroy,
  mockExistsSync,
  mockAttachCompensatingBucketPolicy,
  mockGetOperatorCallerArn,
} = vi.hoisted(() => ({
  mockEc2Send: vi.fn(),
  mockEc2Destroy: vi.fn(),
  // Story iii reviewer fix HIGH #2: apply-single now stat-checks the
  // keypair .pem file before surfacing keyName on the renderable state.
  // Default behaviour: pretend the .pem exists (every existing test
  // flow assumed it did pre-fix). Per-test overrides use
  // mockExistsSync.mockReturnValueOnce(false) for the missing-file case.
  mockExistsSync: vi.fn().mockReturnValue(true),
  // Bug S3-001 Part 2: compensating bucket policy attachment.
  // Default: succeeds. Per-test overrides for failure/skip cases.
  mockAttachCompensatingBucketPolicy: vi
    .fn()
    .mockResolvedValue({ attached: true }),
  // Default: returns a realistic operator ARN.
  mockGetOperatorCallerArn: vi
    .fn()
    .mockResolvedValue("arn:aws:iam::112233445566:user/assignee-operator"),
}));

vi.mock("@aws-sdk/client-ec2", () => {
  class EC2Client {
    send = mockEc2Send;
    destroy = mockEc2Destroy;
  }
  function DescribeInstancesCommand(input: unknown) {
    return { _type: "DescribeInstancesCommand", input };
  }
  return { EC2Client, DescribeInstancesCommand };
});

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return { ...actual, existsSync: mockExistsSync };
});

vi.mock("@/utils/display.js", () => ({
  renderApplySuccess: vi.fn(),
}));

vi.mock("@/utils/logger/index.js", () => ({
  log: vi.fn(),
  LOG_ACTIONS: {
    APPLY_SUCCEEDED: "apply_succeeded",
  },
}));

vi.mock("@/utils/security-posture.js", () => ({
  checkSecurityPosture: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/utils/memory-recorder.js", () => ({
  writeProvisionRecord: vi.fn().mockResolvedValue(undefined),
  clearFailureHistory: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../arn-display.js", () => ({
  resolveDisplayArn: vi.fn(),
}));

vi.mock("./static-site-upload.js", () => ({
  runStaticSiteUploadFor: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/utils/aws-resource-discovery/ami-default-user.js", () => ({
  tryGetAmiDefaultUser: vi.fn(),
}));

vi.mock("@/services/s3-compensating-bucket-policy.js", () => ({
  attachCompensatingBucketPolicy: mockAttachCompensatingBucketPolicy,
}));

vi.mock("@/utils/resolve-arn.js", () => ({
  getOperatorCallerArn: mockGetOperatorCallerArn,
}));

import { formatApplySingleSuccess } from "./apply-single.js";
import { renderApplySuccess } from "@/utils/display.js";
import { resolveDisplayArn } from "../arn-display.js";
import { tryGetAmiDefaultUser } from "@/utils/aws-resource-discovery/ami-default-user.js";

// ── Realistic fixtures ───────────────────────────────────────────────────────

const EC2_INSTANCE_ID = "i-0abc123def4567890";
const EC2_DISPLAY_ARN = `arn:aws:ec2:us-east-1:123456789012:instance/${EC2_INSTANCE_ID}`;
const EC2_PUBLIC_IP = "54.198.42.117";
const EC2_PUBLIC_DNS = "ec2-54-198-42-117.compute-1.amazonaws.com";
const EC2_PRIVATE_IP = "10.0.1.42";

// Snapshot env so per-test credential mutations don't leak.
const ORIGINAL_ENV = { ...process.env };

function makeState(overrides: Partial<AgentState> = {}): AgentState {
  return {
    userIntent: "create an EC2 instance",
    runId: "run-2026-05-05-ec2-test",
    executionMode: ExecutionMode.APPLY,
    resourceType: "AWS::EC2::Instance",
    resourceArn: EC2_INSTANCE_ID,
    executionStatus: ExecutionStatus.SUCCESS,
    preflightPassed: true,
    preflightErrors: [],
    preflightMode: "local",
    messages: [],
    config: new ProcessEnvConfigAdapter(),
    ...overrides,
  } as AgentState;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockEc2Send.mockReset();
  mockEc2Destroy.mockReset();
  // Default: pretend the .pem keypair file exists so the existing
  // Story iii tests that pre-date the file-existence guard continue
  // to surface keyName on the renderable state. Per-test overrides
  // (`mockExistsSync.mockReturnValueOnce(false)`) cover the missing-
  // file suppression path.
  mockExistsSync.mockReset();
  mockExistsSync.mockReturnValue(true);
  // Operator credentials needed by requireAssigneeCredentials("operator").
  process.env["ASSIGNEE_OPERATOR_ACCESS_KEY_ID"] = "AKIAIOSFODNN7EXAMPLE";
  process.env["ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY"] =
    "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
  // Default: resolveDisplayArn returns the synthesized full ARN. Tests
  // that need the bare-identifier fall-through override per-case.
  vi.mocked(resolveDisplayArn).mockResolvedValue(EC2_DISPLAY_ARN);
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("formatApplySingleSuccess — EC2 DescribeInstances wiring", () => {
  it("calls DescribeInstances for EC2::Instance and plumbs PublicIpAddress + PublicDnsName into the RenderableState", async () => {
    mockEc2Send.mockResolvedValueOnce({
      Reservations: [
        {
          Instances: [
            {
              InstanceId: EC2_INSTANCE_ID,
              PublicIpAddress: EC2_PUBLIC_IP,
              PublicDnsName: EC2_PUBLIC_DNS,
              PrivateIpAddress: EC2_PRIVATE_IP,
              State: { Name: "running", Code: 16 },
            },
          ],
        },
      ],
    });

    const state = makeState();
    await formatApplySingleSuccess(state);

    // DescribeInstances issued once, with the bare InstanceId.
    expect(mockEc2Send).toHaveBeenCalledTimes(1);
    expect(mockEc2Send).toHaveBeenCalledWith(
      expect.objectContaining({
        _type: "DescribeInstancesCommand",
        input: { InstanceIds: [EC2_INSTANCE_ID] },
      }),
    );

    // renderApplySuccess receives state with the network fields applied.
    expect(renderApplySuccess).toHaveBeenCalledTimes(1);
    const [renderedState, displayArn] = vi.mocked(renderApplySuccess).mock
      .calls[0] as [RenderableState, string];
    expect(displayArn).toBe(EC2_DISPLAY_ARN);
    expect(renderedState.publicIpAddress).toBe(EC2_PUBLIC_IP);
    expect(renderedState.publicDnsName).toBe(EC2_PUBLIC_DNS);
    // Original state must NOT be mutated — overlay applied via spread only.
    // Cast to RenderableState for the probe access; the SSH-bundle overlay
    // fields live on RenderableState, not on AgentState — the assertion
    // here verifies the source AgentState was not back-filled with them.
    const stateProbe = state as unknown as RenderableState;
    expect(stateProbe.publicIpAddress).toBeUndefined();
    expect(stateProbe.publicDnsName).toBeUndefined();

    // EC2 client cleaned up.
    expect(mockEc2Destroy).toHaveBeenCalledTimes(1);
  });

  it("private-subnet EC2: DescribeInstances returns no PublicIpAddress → state has no network fields", async () => {
    mockEc2Send.mockResolvedValueOnce({
      Reservations: [
        {
          Instances: [
            {
              InstanceId: EC2_INSTANCE_ID,
              // No PublicIpAddress / PublicDnsName at all.
              PrivateIpAddress: EC2_PRIVATE_IP,
              State: { Name: "running", Code: 16 },
            },
          ],
        },
      ],
    });

    await formatApplySingleSuccess(makeState());

    expect(mockEc2Send).toHaveBeenCalledTimes(1);
    const [renderedState] = vi.mocked(renderApplySuccess).mock.calls[0] as [
      RenderableState,
      string,
    ];
    expect(renderedState.publicIpAddress).toBeUndefined();
    expect(renderedState.publicDnsName).toBeUndefined();
  });

  it("DescribeInstances throws → apply succeeds, renderApplySuccess called without network fields", async () => {
    mockEc2Send.mockRejectedValueOnce(
      Object.assign(new Error("Rate exceeded"), {
        name: "ThrottlingException",
      }),
    );

    await formatApplySingleSuccess(makeState());

    // Rendering still happened — describe failure cannot fail the apply.
    expect(renderApplySuccess).toHaveBeenCalledTimes(1);
    const [renderedState] = vi.mocked(renderApplySuccess).mock.calls[0] as [
      RenderableState,
      string,
    ];
    expect(renderedState.publicIpAddress).toBeUndefined();
    expect(renderedState.publicDnsName).toBeUndefined();
    // Client still destroyed in the finally block.
    expect(mockEc2Destroy).toHaveBeenCalledTimes(1);
  });

  it("DescribeInstances returns empty Reservations → state has no network fields", async () => {
    mockEc2Send.mockResolvedValueOnce({ Reservations: [] });

    await formatApplySingleSuccess(makeState());

    const [renderedState] = vi.mocked(renderApplySuccess).mock.calls[0] as [
      RenderableState,
      string,
    ];
    expect(renderedState.publicIpAddress).toBeUndefined();
    expect(renderedState.publicDnsName).toBeUndefined();
  });

  it("non-EC2 resource (S3): DescribeInstances NOT called", async () => {
    vi.mocked(resolveDisplayArn).mockResolvedValueOnce(
      "arn:aws:s3:::my-bucket-1714867200",
    );

    const state = makeState({
      resourceType: "AWS::S3::Bucket",
      resourceArn: "my-bucket-1714867200",
    });
    await formatApplySingleSuccess(state);

    expect(mockEc2Send).not.toHaveBeenCalled();
    expect(mockEc2Destroy).not.toHaveBeenCalled();
    expect(renderApplySuccess).toHaveBeenCalledTimes(1);
  });

  it("non-EC2 resource (IAM Role): DescribeInstances NOT called", async () => {
    vi.mocked(resolveDisplayArn).mockResolvedValueOnce(
      "arn:aws:iam::123456789012:role/my-role",
    );

    const state = makeState({
      resourceType: "AWS::IAM::Role",
      resourceArn: "my-role",
    });
    await formatApplySingleSuccess(state);

    expect(mockEc2Send).not.toHaveBeenCalled();
  });

  it("EC2 with no resourceArn (degenerate): DescribeInstances NOT called", async () => {
    vi.mocked(resolveDisplayArn).mockResolvedValueOnce(undefined);

    const state = makeState({
      resourceType: "AWS::EC2::Instance",
      resourceArn: undefined,
    });
    await formatApplySingleSuccess(state);

    expect(mockEc2Send).not.toHaveBeenCalled();
    expect(renderApplySuccess).toHaveBeenCalledTimes(1);
  });

  it("returns {} when displayArn equals state.resourceArn (no propagation)", async () => {
    // Mock describe to return nothing of interest.
    mockEc2Send.mockResolvedValueOnce({ Reservations: [] });
    // resolveDisplayArn returns the bare InstanceId (matches state.resourceArn).
    vi.mocked(resolveDisplayArn).mockResolvedValueOnce(EC2_INSTANCE_ID);

    const result = await formatApplySingleSuccess(makeState());

    expect(result).toEqual({});
  });

  it("returns {resourceArn: displayArn} when resolver transforms the identifier", async () => {
    mockEc2Send.mockResolvedValueOnce({ Reservations: [] });
    vi.mocked(resolveDisplayArn).mockResolvedValueOnce(EC2_DISPLAY_ARN);

    const result = await formatApplySingleSuccess(makeState());

    expect(result).toEqual({ resourceArn: EC2_DISPLAY_ARN });
  });
});

// ── Story iii — SSH-bundle wiring (KeyName → AMI lookup → sshUsername) ──
describe("formatApplySingleSuccess — Story iii SSH-bundle AMI lookup wiring", () => {
  const SSH_KEY_NAME = "assignee-ssh-key";
  const AMI_AL2023 = "ami-0abcdef1234567890";

  it("EC2 with KeyName + Public IP: looks up AMI default user and plumbs keyName/sshUsername/amiId into the RenderableState", async () => {
    mockEc2Send.mockResolvedValueOnce({
      Reservations: [
        {
          Instances: [
            {
              InstanceId: EC2_INSTANCE_ID,
              ImageId: AMI_AL2023,
              PublicIpAddress: EC2_PUBLIC_IP,
              PublicDnsName: EC2_PUBLIC_DNS,
              State: { Name: "running", Code: 16 },
            },
          ],
        },
      ],
    });
    vi.mocked(tryGetAmiDefaultUser).mockResolvedValueOnce("ec2-user");

    const state = makeState({
      desiredState: {
        ImageId: AMI_AL2023,
        KeyName: SSH_KEY_NAME,
      },
    });
    await formatApplySingleSuccess(state);

    // tryGetAmiDefaultUser must be called with the AMI from the
    // describe response and the run id.
    expect(tryGetAmiDefaultUser).toHaveBeenCalledTimes(1);
    expect(tryGetAmiDefaultUser).toHaveBeenCalledWith(
      AMI_AL2023,
      "run-2026-05-05-ec2-test",
    );

    // Renderer receives the SSH-bundle overlay fields.
    const [renderedState] = vi.mocked(renderApplySuccess).mock.calls[0] as [
      RenderableState,
      string,
    ];
    expect(renderedState.publicIpAddress).toBe(EC2_PUBLIC_IP);
    expect(renderedState.keyName).toBe(SSH_KEY_NAME);
    expect(renderedState.sshUsername).toBe("ec2-user");
    expect(renderedState.amiId).toBe(AMI_AL2023);

    // Original state must NOT be mutated.
    const stateProbe = state as unknown as RenderableState;
    expect(stateProbe.keyName).toBeUndefined();
    expect(stateProbe.sshUsername).toBeUndefined();
    expect(stateProbe.amiId).toBeUndefined();
  });

  it("EC2 without KeyName: AMI lookup is NOT called and no SSH fields are set", async () => {
    mockEc2Send.mockResolvedValueOnce({
      Reservations: [
        {
          Instances: [
            {
              InstanceId: EC2_INSTANCE_ID,
              ImageId: AMI_AL2023,
              PublicIpAddress: EC2_PUBLIC_IP,
              State: { Name: "running", Code: 16 },
            },
          ],
        },
      ],
    });

    const state = makeState({
      desiredState: {
        ImageId: AMI_AL2023,
        // No KeyName.
      },
    });
    await formatApplySingleSuccess(state);

    expect(tryGetAmiDefaultUser).not.toHaveBeenCalled();
    const [renderedState] = vi.mocked(renderApplySuccess).mock.calls[0] as [
      RenderableState,
      string,
    ];
    expect(renderedState.keyName).toBeUndefined();
    expect(renderedState.sshUsername).toBeUndefined();
  });

  it("EC2 with KeyName but DescribeImages throttle (tryGetAmiDefaultUser returns undefined): keyName surfaced, sshUsername absent — Connect line will suppress at renderer", async () => {
    mockEc2Send.mockResolvedValueOnce({
      Reservations: [
        {
          Instances: [
            {
              InstanceId: EC2_INSTANCE_ID,
              ImageId: AMI_AL2023,
              PublicIpAddress: EC2_PUBLIC_IP,
              State: { Name: "running", Code: 16 },
            },
          ],
        },
      ],
    });
    // tryGetAmiDefaultUser already swallows errors and returns undefined.
    vi.mocked(tryGetAmiDefaultUser).mockResolvedValueOnce(undefined);

    const state = makeState({
      desiredState: {
        ImageId: AMI_AL2023,
        KeyName: SSH_KEY_NAME,
      },
    });
    await formatApplySingleSuccess(state);

    expect(tryGetAmiDefaultUser).toHaveBeenCalledTimes(1);
    const [renderedState] = vi.mocked(renderApplySuccess).mock.calls[0] as [
      RenderableState,
      string,
    ];
    expect(renderedState.keyName).toBe(SSH_KEY_NAME);
    expect(renderedState.sshUsername).toBeUndefined();
    expect(renderedState.amiId).toBe(AMI_AL2023);
    // Apply still succeeded.
    expect(renderApplySuccess).toHaveBeenCalledTimes(1);
  });

  it("DescribeInstances response missing ImageId: falls back to desiredState.ImageId for the AMI lookup", async () => {
    mockEc2Send.mockResolvedValueOnce({
      Reservations: [
        {
          Instances: [
            {
              InstanceId: EC2_INSTANCE_ID,
              // No ImageId in describe response (degenerate).
              PublicIpAddress: EC2_PUBLIC_IP,
              State: { Name: "running", Code: 16 },
            },
          ],
        },
      ],
    });
    vi.mocked(tryGetAmiDefaultUser).mockResolvedValueOnce("ubuntu");

    const state = makeState({
      desiredState: {
        ImageId: AMI_AL2023,
        KeyName: SSH_KEY_NAME,
      },
    });
    await formatApplySingleSuccess(state);

    expect(tryGetAmiDefaultUser).toHaveBeenCalledWith(
      AMI_AL2023,
      "run-2026-05-05-ec2-test",
    );
    const [renderedState] = vi.mocked(renderApplySuccess).mock.calls[0] as [
      RenderableState,
      string,
    ];
    expect(renderedState.amiId).toBe(AMI_AL2023);
    expect(renderedState.sshUsername).toBe("ubuntu");
  });

  it("desiredState.ImageId still unresolved (OS-name placeholder, NOT 'ami-…'): no fallback AMI used, no AMI lookup, no sshUsername", async () => {
    // Defense-in-depth: if some upstream path failed to resolve the OS
    // name to an ami-* id (compound-plan or LLM-plan), apply-single.ts
    // must NOT pass the placeholder string to getAmiDefaultUser — the
    // describe call already returned no ImageId, and we have no
    // resolved AMI to query.
    mockEc2Send.mockResolvedValueOnce({
      Reservations: [
        {
          Instances: [
            {
              InstanceId: EC2_INSTANCE_ID,
              PublicIpAddress: EC2_PUBLIC_IP,
              State: { Name: "running", Code: 16 },
            },
          ],
        },
      ],
    });

    const state = makeState({
      desiredState: {
        ImageId: "amazon-linux-2023", // unresolved OS name
        KeyName: SSH_KEY_NAME,
      },
    });
    await formatApplySingleSuccess(state);

    expect(tryGetAmiDefaultUser).not.toHaveBeenCalled();
    const [renderedState] = vi.mocked(renderApplySuccess).mock.calls[0] as [
      RenderableState,
      string,
    ];
    expect(renderedState.keyName).toBe(SSH_KEY_NAME);
    expect(renderedState.sshUsername).toBeUndefined();
    expect(renderedState.amiId).toBeUndefined();
  });

  it("non-EC2 with KeyName-shaped desiredState: AMI lookup NOT called (apply-single still gates on EC2 type)", async () => {
    vi.mocked(resolveDisplayArn).mockResolvedValueOnce(
      "arn:aws:s3:::weird-bucket",
    );
    const state = makeState({
      resourceType: "AWS::S3::Bucket",
      resourceArn: "weird-bucket",
      desiredState: {
        BucketName: "weird-bucket",
        // Hypothetical/wrong: KeyName on a bucket. Apply-single must
        // ignore SSH-bundle wiring for non-EC2 resource types.
        KeyName: SSH_KEY_NAME,
      },
    });
    await formatApplySingleSuccess(state);

    expect(mockEc2Send).not.toHaveBeenCalled();
    expect(tryGetAmiDefaultUser).not.toHaveBeenCalled();
  });
});

// ── Story iii reviewer fixes — file-existence guard + sanitizeKeyName ──────
//
// HIGH #2: spec invariant 113-114 — Connect line is suppressed silently
// if the keypair file does NOT exist on disk. apply-single is responsible
// for that I/O check (renderer is type-agnostic / no-I/O). When the .pem
// is missing, networkOverlay.keyName must NOT be set so the renderer's
// existing `if (!state.keyName) return;` gate suppresses the Connect line.
//
// MED #4: sanitizeKeyName the raw KeyName value before assignment so the
// printed Connect command's filename matches the on-disk filename written
// by ssh-keypair.ts (which sanitises before writing). Without this, an
// LLM- or user-seeded `KeyName: "my key;rm -rf"` would (a) print a path
// that does not exist and (b) be shell-injectable when copy-pasted.
describe("formatApplySingleSuccess — Story iii reviewer fixes (file-existence + sanitizeKeyName)", () => {
  const AMI_AL2023 = "ami-0abcdef1234567890";

  it("HIGH #2: KeyName set but .pem file missing on disk → keyName SUPPRESSED on renderable state (Connect line hidden)", async () => {
    mockEc2Send.mockResolvedValueOnce({
      Reservations: [
        {
          Instances: [
            {
              InstanceId: EC2_INSTANCE_ID,
              ImageId: AMI_AL2023,
              PublicIpAddress: EC2_PUBLIC_IP,
              State: { Name: "running", Code: 16 },
            },
          ],
        },
      ],
    });
    // Override the global stub for THIS test only — pretend the .pem
    // does not exist on disk.
    mockExistsSync.mockReturnValueOnce(false);

    const state = makeState({
      desiredState: {
        ImageId: AMI_AL2023,
        KeyName: "assignee-ssh-key",
      },
    });
    await formatApplySingleSuccess(state);

    // existsSync was consulted with the resolved keypair path.
    expect(mockExistsSync).toHaveBeenCalledTimes(1);
    const [statedPath] = mockExistsSync.mock.calls[0] as [string];
    expect(statedPath).toMatch(
      /\.assignee[/\\]keys[/\\]assignee-ssh-key\.pem$/,
    );

    // Renderer must NOT receive a keyName — so the Connect line is
    // suppressed by the renderer's existing three-field gate.
    const [renderedState] = vi.mocked(renderApplySuccess).mock.calls[0] as [
      RenderableState,
      string,
    ];
    expect(renderedState.keyName).toBeUndefined();
    // The AMI-lookup short-circuit happens because there is no keyName
    // — saves a wasted DescribeImages call when the line will be
    // suppressed downstream anyway.
    expect(tryGetAmiDefaultUser).not.toHaveBeenCalled();
    expect(renderedState.sshUsername).toBeUndefined();
  });

  it("HIGH #2: KeyName set + .pem present on disk → keyName SURFACED, AMI lookup runs, full Connect line wired", async () => {
    mockEc2Send.mockResolvedValueOnce({
      Reservations: [
        {
          Instances: [
            {
              InstanceId: EC2_INSTANCE_ID,
              ImageId: AMI_AL2023,
              PublicIpAddress: EC2_PUBLIC_IP,
              State: { Name: "running", Code: 16 },
            },
          ],
        },
      ],
    });
    // Default beforeEach behaviour — existsSync returns true.
    vi.mocked(tryGetAmiDefaultUser).mockResolvedValueOnce("ec2-user");

    const state = makeState({
      desiredState: {
        ImageId: AMI_AL2023,
        KeyName: "assignee-ssh-key",
      },
    });
    await formatApplySingleSuccess(state);

    expect(mockExistsSync).toHaveBeenCalledTimes(1);
    const [renderedState] = vi.mocked(renderApplySuccess).mock.calls[0] as [
      RenderableState,
      string,
    ];
    expect(renderedState.keyName).toBe("assignee-ssh-key");
    expect(renderedState.sshUsername).toBe("ec2-user");
  });

  it("MED #4: dirty KeyName like 'my key;test' → renderable keyName matches sanitised form (no shell metacharacters in the printed path)", async () => {
    mockEc2Send.mockResolvedValueOnce({
      Reservations: [
        {
          Instances: [
            {
              InstanceId: EC2_INSTANCE_ID,
              ImageId: AMI_AL2023,
              PublicIpAddress: EC2_PUBLIC_IP,
              State: { Name: "running", Code: 16 },
            },
          ],
        },
      ],
    });
    vi.mocked(tryGetAmiDefaultUser).mockResolvedValueOnce("ec2-user");

    const state = makeState({
      desiredState: {
        ImageId: AMI_AL2023,
        // Shell-injectable raw KeyName as it could land from an LLM
        // hallucination or user typo. ssh-keypair.ts on the apply path
        // already sanitises before writing the .pem; apply-single MUST
        // mirror that so the Connect line points at the real file.
        KeyName: "my key;test",
      },
    });
    await formatApplySingleSuccess(state);

    const [renderedState] = vi.mocked(renderApplySuccess).mock.calls[0] as [
      RenderableState,
      string,
    ];
    // sanitizeKeyName replaces space + ';' with '_'. The result must
    // be the on-disk filename (whitelist `[A-Za-z0-9._-]`).
    expect(renderedState.keyName).toBe("my_key_test");
    // No shell metacharacters survive into the printed command.
    expect(renderedState.keyName).not.toMatch(/[ ;&|`$<>]/);
    // existsSync was consulted with the SANITISED filename (matches
    // what ssh-keypair.ts writes), not the raw value.
    const [statedPath] = mockExistsSync.mock.calls[0] as [string];
    expect(statedPath).toMatch(/\.assignee[/\\]keys[/\\]my_key_test\.pem$/);
    expect(statedPath).not.toContain(";");
  });
});

// ── Bug S3-001 Part 2 — compensating bucket policy wiring ────────────────────
//
// apply-single.ts should call attachCompensatingBucketPolicy for S3 buckets
// immediately after the bucket creation succeeds. Failure is non-blocking:
// the apply result is still a success, but a warning is printed to stderr and
// logged.
describe("formatApplySingleSuccess — S3 compensating bucket policy", () => {
  const S3_BUCKET_NAME = "assignee-assets-bucket-2026";
  const S3_DISPLAY_ARN = `arn:aws:s3:::${S3_BUCKET_NAME}`;
  const OPERATOR_ARN = "arn:aws:iam::112233445566:user/assignee-operator";

  beforeEach(() => {
    vi.mocked(resolveDisplayArn).mockResolvedValue(S3_DISPLAY_ARN);
    mockGetOperatorCallerArn.mockResolvedValue(OPERATOR_ARN);
    mockAttachCompensatingBucketPolicy.mockResolvedValue({ attached: true });
  });

  it("calls attachCompensatingBucketPolicy with the bucket name and operator ARN for S3 buckets", async () => {
    const state = makeState({
      resourceType: "AWS::S3::Bucket",
      resourceArn: S3_BUCKET_NAME,
    });
    await formatApplySingleSuccess(state);

    expect(mockAttachCompensatingBucketPolicy).toHaveBeenCalledTimes(1);
    expect(mockAttachCompensatingBucketPolicy).toHaveBeenCalledWith(
      expect.objectContaining({
        bucketName: S3_BUCKET_NAME,
        operatorArn: OPERATOR_ARN,
      }),
    );
    // Apply still succeeds.
    expect(renderApplySuccess).toHaveBeenCalledTimes(1);
  });

  it("does NOT call attachCompensatingBucketPolicy for non-S3 resources (EC2)", async () => {
    mockEc2Send.mockResolvedValueOnce({ Reservations: [] });
    vi.mocked(resolveDisplayArn).mockResolvedValueOnce(
      `arn:aws:ec2:us-east-1:112233445566:instance/${EC2_INSTANCE_ID}`,
    );

    const state = makeState({
      resourceType: "AWS::EC2::Instance",
      resourceArn: EC2_INSTANCE_ID,
    });
    await formatApplySingleSuccess(state);

    expect(mockAttachCompensatingBucketPolicy).not.toHaveBeenCalled();
  });

  it("warns to stderr + logs when attachCompensatingBucketPolicy fails — does NOT fail the apply", async () => {
    mockAttachCompensatingBucketPolicy.mockResolvedValueOnce({
      attached: false,
      reason: "Access Denied",
    });
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    const state = makeState({
      resourceType: "AWS::S3::Bucket",
      resourceArn: S3_BUCKET_NAME,
    });
    const result = await formatApplySingleSuccess(state);

    // Apply still succeeds (non-blocking failure).
    expect(renderApplySuccess).toHaveBeenCalledTimes(1);
    // Warning written to stderr.
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        "Compensating bucket policy could not be attached",
      ),
    );
    // No exception propagated.
    expect(result).toBeDefined();

    stderrSpy.mockRestore();
  });

  it("skips the policy attachment (logs warn) when operator ARN is unavailable", async () => {
    mockGetOperatorCallerArn.mockResolvedValueOnce(undefined);
    const { log } = await import("@/utils/logger/index.js");

    const state = makeState({
      resourceType: "AWS::S3::Bucket",
      resourceArn: S3_BUCKET_NAME,
    });
    await formatApplySingleSuccess(state);

    expect(mockAttachCompensatingBucketPolicy).not.toHaveBeenCalled();
    // A structured log entry with the skip reason should be emitted.
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        extras: expect.objectContaining({
          compensatingBucketPolicySkipped: true,
        }),
      }),
    );
    // Apply still succeeds.
    expect(renderApplySuccess).toHaveBeenCalledTimes(1);
  });

  it("does NOT call attachCompensatingBucketPolicy when S3 bucket has no resourceArn (degenerate)", async () => {
    vi.mocked(resolveDisplayArn).mockResolvedValueOnce(undefined);

    const state = makeState({
      resourceType: "AWS::S3::Bucket",
      resourceArn: undefined,
    });
    await formatApplySingleSuccess(state);

    expect(mockAttachCompensatingBucketPolicy).not.toHaveBeenCalled();
    expect(renderApplySuccess).toHaveBeenCalledTimes(1);
  });

  // bug-s3-bucket-policy-attach-failure-observability — propagation
  // path: when the SDK call returns `attached: false`, the provision
  // record must capture compensatingPolicyAttached + compensatingPolicyError
  // so `assignee list` can flag the bucket.
  it("threads compensatingPolicyAttached=false + reason onto the provision record on attach failure", async () => {
    const { writeProvisionRecord } = await import("@/utils/memory-recorder.js");
    mockAttachCompensatingBucketPolicy.mockResolvedValueOnce({
      attached: false,
      reason: "AccessDenied: PutBucketPolicy not allowed",
    });
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    const state = makeState({
      resourceType: "AWS::S3::Bucket",
      resourceArn: S3_BUCKET_NAME,
    });
    await formatApplySingleSuccess(state);

    // writeProvisionRecord called with extras carrying the failure info.
    const writeCalls = (
      writeProvisionRecord as unknown as { mock: { calls: unknown[][] } }
    ).mock.calls;
    expect(writeCalls.length).toBeGreaterThan(0);
    // Find the call for the S3 bucket — extras is the 7th positional arg.
    const lastCall = writeCalls[writeCalls.length - 1]!;
    const extras = lastCall[6] as
      | {
          compensatingPolicyAttached?: boolean;
          compensatingPolicyError?: string;
        }
      | undefined;
    expect(extras).toBeDefined();
    expect(extras!.compensatingPolicyAttached).toBe(false);
    expect(extras!.compensatingPolicyError).toBe(
      "AccessDenied: PutBucketPolicy not allowed",
    );

    stderrSpy.mockRestore();
  });

  it("threads compensatingPolicyAttached=true onto the provision record on attach success", async () => {
    const { writeProvisionRecord } = await import("@/utils/memory-recorder.js");
    // Default mock from beforeEach already returns { attached: true }.

    const state = makeState({
      resourceType: "AWS::S3::Bucket",
      resourceArn: S3_BUCKET_NAME,
    });
    await formatApplySingleSuccess(state);

    const writeCalls = (
      writeProvisionRecord as unknown as { mock: { calls: unknown[][] } }
    ).mock.calls;
    const lastCall = writeCalls[writeCalls.length - 1]!;
    const extras = lastCall[6] as
      | {
          compensatingPolicyAttached?: boolean;
          compensatingPolicyError?: string;
        }
      | undefined;
    expect(extras).toBeDefined();
    expect(extras!.compensatingPolicyAttached).toBe(true);
    // No error field on the happy path.
    expect(extras!.compensatingPolicyError).toBeUndefined();
  });
});
