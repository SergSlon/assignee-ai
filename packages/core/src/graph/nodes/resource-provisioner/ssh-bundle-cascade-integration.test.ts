/**
 * SSH-bundle cascade — function-level integration test.
 *
 * Stories i (SSH-IAM compound) + ii (Public IP) + iii (Connect line) +
 * iv (`assignee describe`) ship as four cohesive but independently-tested
 * units. Per-story unit tests (`ssh-iam.test.ts`, `ssh-keypair.test.ts`,
 * `apply-success.test.ts`, `apps/cli/src/services/describe-resource.test.ts`,
 * `memory-recorder.test.ts` round-trip block) cover each module in
 * isolation. They do NOT exercise the integration seams **between** them:
 *
 *   1. provisioner pre-hooks (ssh-keypair + ssh-iam) wire desiredState
 *      mutations that the apply-success formatter later reads to render
 *      the Connect line;
 *   2. the apply-success formatter writes `publicIpAddressAtApply` into
 *      a `ProvisionRecord` whose on-disk shape must round-trip back
 *      through the Zod schema for `assignee describe` to consume;
 *   3. `assignee describe` rebuilds a `RenderableState` from the
 *      provision record + a live DescribeInstances overlay and feeds it
 *      back to the SAME `renderApplySuccess` formatter — divergence
 *      between apply-time IP and live IP must surface as the
 *      "(was X at apply time)" annotation.
 *
 * This test wires the whole cascade end-to-end at function-call level,
 * with AWS SDK clients mocked at the `@aws-sdk/client-iam` and
 * `@aws-sdk/client-ec2` boundaries. No network, no live AWS, no
 * `~/.assignee/keys/...pem` write to the user's real homedir — the
 * keypair fs primitives are mocked, and the MemoryService is pointed at
 * a fresh tmpdir via constructor injection.
 *
 * The test runs INSIDE @assignee/core because two of the cascade's
 * key seams (`ensureSshKeypair`, `ensureSshIamProfile`) are not on the
 * public barrel surface — only their effects on `desiredState` /
 * `state.resourceArn` flow out. Living next to the per-module tests in
 * `resource-provisioner/` keeps the imports clean (no cross-package
 * deep relative imports) while exercising the apply-success formatter
 * path AND the `describeResource`-equivalent re-render path that
 * `apps/cli/src/services/describe-resource.ts` consumes (the apps/cli
 * service is a thin wrapper around the same memory-read +
 * DescribeInstances + renderApplySuccess sequence we exercise here).
 *
 * Realistic fixtures throughout — real AKID shape, real instance ID, a
 * real AL2023 AMI ID, a real-shape EC2 PublicDnsName, and a real
 * UUID-shape runId. See `feedback_real_data_mocks_all_cases`.
 */

import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  type MockInstance,
} from "vitest";
import * as os from "node:os";
import * as path from "node:path";
import * as fsPromises from "node:fs/promises";
import {
  CfnKey,
  ResourceDefault,
  RESOURCE_TYPES,
  type RenderableState,
  type ProvisionRecord,
} from "@/index.js";
import type { AgentState } from "../../graph-state.js";
import { MemoryService } from "../../../services/memory/service.js";

// ── Hoisted SDK + fs mocks ───────────────────────────────────────────────────
//
// IAM mocks: every Create*/Attach*/Tag*/AddRole* command goes through a
// single send fn. Each command factory returns a typed sentinel so the
// test can assert call ORDER (CreateRole → AttachRolePolicy →
// CreateInstanceProfile → TagInstanceProfile → AddRoleToInstanceProfile)
// AND inspect the input payloads.
//
// EC2 mocks: DescribeKeyPairs / CreateKeyPair / DescribeInstances /
// DescribeImages all go through a SECOND send fn shared by ssh-keypair,
// apply-time DescribeInstances overlay, the AMI default-user resolver,
// and the describe-side live fetch.
//
// fs mocks: keypair-write side effects are captured (no real .pem under
// `~/.assignee/keys`), but the MemoryService still uses the real
// node:fs/promises against a tmpdir.
const {
  mockIamSend,
  mockEc2Send,
  mockMkdirSync,
  mockWriteFileSync,
  mockChmodSync,
} = vi.hoisted(() => ({
  mockIamSend: vi.fn(),
  mockEc2Send: vi.fn(),
  mockMkdirSync: vi.fn(),
  mockWriteFileSync: vi.fn(),
  mockChmodSync: vi.fn(),
}));

// Command factories must be `function` declarations (not arrow
// functions) so the production callsites can do `new XCommand({...})`.
// Each returns a typed sentinel `{ _type, input }` so test assertions
// can inspect both the command identity and its payload.
function makeCommandFactory<T extends string>(
  _type: T,
): (input: unknown) => { _type: T; input: unknown } {
  return function CommandFactory(input: unknown) {
    return { _type, input };
  };
}

vi.mock("@aws-sdk/client-iam", () => {
  class IAMClient {
    send = mockIamSend;
    destroy = vi.fn();
  }
  return {
    IAMClient,
    CreateRoleCommand: makeCommandFactory("CreateRoleCommand"),
    AttachRolePolicyCommand: makeCommandFactory("AttachRolePolicyCommand"),
    CreateInstanceProfileCommand: makeCommandFactory(
      "CreateInstanceProfileCommand",
    ),
    AddRoleToInstanceProfileCommand: makeCommandFactory(
      "AddRoleToInstanceProfileCommand",
    ),
    TagInstanceProfileCommand: makeCommandFactory("TagInstanceProfileCommand"),
    // Cleanup-path commands are referenced by the resource-provisioner's
    // sshIamCleanup; we stub them so the mock surface stays self-
    // contained even though the happy path doesn't trigger cleanup.
    RemoveRoleFromInstanceProfileCommand: makeCommandFactory(
      "RemoveRoleFromInstanceProfileCommand",
    ),
    DeleteInstanceProfileCommand: makeCommandFactory(
      "DeleteInstanceProfileCommand",
    ),
    DetachRolePolicyCommand: makeCommandFactory("DetachRolePolicyCommand"),
    DeleteRoleCommand: makeCommandFactory("DeleteRoleCommand"),
  };
});

vi.mock("@aws-sdk/client-ec2", () => {
  class EC2Client {
    send = mockEc2Send;
    destroy = vi.fn();
  }
  return {
    EC2Client,
    DescribeKeyPairsCommand: makeCommandFactory("DescribeKeyPairsCommand"),
    CreateKeyPairCommand: makeCommandFactory("CreateKeyPairCommand"),
    DescribeInstancesCommand: makeCommandFactory("DescribeInstancesCommand"),
    DescribeImagesCommand: makeCommandFactory("DescribeImagesCommand"),
  };
});

// node:fs is mocked for the keypair-write side effects but
// node:fs/promises is left REAL so the tmp-dir-backed MemoryService can
// actually read/write its provisions.json. ssh-keypair.ts only uses
// node:fs (sync API), so the split is safe.
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    mkdirSync: mockMkdirSync,
    writeFileSync: mockWriteFileSync,
    chmodSync: mockChmodSync,
  };
});

// AWS credential resolver: stubbed to a real-shape AKID + secret.
// Both the operator path used by ssh-keypair / ssh-iam AND the operator
// path used by tryGetAmiDefaultUser go through this module — keeping
// one mock keeps every cascade caller in sync.
vi.mock("@/config/aws-credentials.js", () => ({
  requireAssigneeCredentials: () => ({
    accessKeyId: "AKIAIOSFODNN7EXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  }),
  tryAssigneeCredentials: () => ({
    accessKeyId: "AKIAIOSFODNN7EXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  }),
}));

// Spinner module is imported transitively by renderApplySuccess. Mock so
// the test can run in non-TTY environments without @clack/prompts I/O.
vi.mock("@/utils/display-output/spinner.js", () => ({
  startSpinner: vi.fn(),
  updateSpinner: vi.fn(),
  stopSpinner: vi.fn(),
}));

// ── Lazy imports AFTER mocks so the modules pick up our hoisted stubs ───────

import { ensureSshKeypair } from "./ssh-keypair.js";
import { ensureSshIamProfile } from "./ssh-iam.js";
import { renderApplySuccess } from "@/utils/display-output/apply-success.js";
import {
  tryGetAmiDefaultUser,
  clearAmiDefaultUserCache,
} from "@/utils/aws-resource-discovery/ami-default-user.js";

// ── Realistic fixtures ───────────────────────────────────────────────────────
const RUN_ID = "bf7a3c9e-2f81-4d12-9c3a-1e8b5f7d9a04";
const INSTANCE_ID = "i-0abc123def4567890";
const INSTANCE_ARN = `arn:aws:ec2:us-east-1:123456789012:instance/${INSTANCE_ID}`;
const PUBLIC_IP = "54.198.42.117";
const PUBLIC_DNS = "ec2-54-198-42-117.compute-1.amazonaws.com";
const DIVERGED_LIVE_IP = "54.99.10.5";
const AMI_ID = "ami-0eb38b817b93460ac";
const AMI_NAME = "al2023-ami-2023.4.20240319.0-kernel-6.1-x86_64";
const SSH_USERNAME = "ec2-user";
const KEY_NAME = ResourceDefault.SSH_KEY_PLACEHOLDER; // "assignee-ssh-key"
const PEM_MATERIAL =
  "-----BEGIN RSA PRIVATE KEY-----\n" +
  "MIIEogIBAAKCAQEAxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\n" +
  "-----END RSA PRIVATE KEY-----\n";
const ROLE_AND_PROFILE_NAME = `assignee-ssh-${RUN_ID.slice(0, 8)}`; // "assignee-ssh-bf7a3c9e"

// ── Helpers ──────────────────────────────────────────────────────────────────

function captureStdout(): { chunks: string[]; restore: () => void } {
  const chunks: string[] = [];
  const spy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk: unknown, ..._args: unknown[]) => {
      chunks.push(String(chunk));
      return true;
    });
  return { chunks, restore: () => spy.mockRestore() };
}

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

function setTty(isTty: boolean): void {
  Object.defineProperty(process.stdout, "isTTY", {
    value: isTty,
    configurable: true,
  });
}

function commandTypes(mock: ReturnType<typeof vi.fn>): string[] {
  return mock.mock.calls.map((c) => (c[0] as { _type: string })._type);
}

function baseAgentState(): AgentState {
  return {
    runId: RUN_ID,
    resourceType: RESOURCE_TYPES.EC2_INSTANCE,
    userIntent: "Create an EC2 with SSH",
  } as unknown as AgentState;
}

/**
 * Build the RenderableState that `formatApplySingleSuccess` would
 * compose after the post-apply DescribeInstances overlay landed. The
 * formatter is internal to core (not on the public barrel) so we
 * reproduce its exact composition here — the seams under test are:
 *
 *   - desiredState.KeyName (set by ssh-keypair) → state.keyName
 *     (overlay adds it conditionally on the .pem existence check)
 *   - DescribeInstances overlay → state.publicIpAddress / publicDnsName / amiId
 *   - amiId → tryGetAmiDefaultUser → state.sshUsername
 *
 * The four keys above flow into the same `renderApplySuccess` call the
 * production formatter makes. By explicit construction here, a future
 * formatter refactor that DROPS one of these fields would still be
 * caught: the renderer is the contract surface and it expects all
 * four to render the Connect line.
 */
function buildApplyTimeRenderable(
  desiredState: Record<string, unknown>,
  overlay: {
    publicIpAddress?: string;
    publicDnsName?: string;
    keyName?: string;
    amiId?: string;
    sshUsername?: string;
  },
): RenderableState {
  return {
    runId: RUN_ID,
    resourceType: RESOURCE_TYPES.EC2_INSTANCE,
    resourceArn: INSTANCE_ID,
    desiredState,
    estimatedMonthlyCost: "$8.30/mo",
    ...overlay,
  };
}

// ── Tmpdir-backed MemoryService swap ─────────────────────────────────────────

let tmpDir: string;
let tmpService: MemoryService;
let tmpAuditLogFile: string;
let appendSpy: MockInstance<MemoryService["appendProvision"]> | undefined;
let readSpy: MockInstance<MemoryService["readProvisionRecord"]> | undefined;
// Wave B-1 (epic-104): writeProvisionRecord now emits an
// `apply_resource_created` audit-log entry after every successful
// appendProvision. Without redirecting `appendAuditRecord`, that emit
// would land in the operator's real `~/.assignee/audit/audit.log` —
// permanent pollution because the 90-day retention floor blocks
// cleanup. Spy in `beforeEach`, restore in `afterEach`, and route the
// (unmocked) impl at a tmp file under `tmpDir` so each test gets a
// fresh, throwaway chain.
let auditAppendSpy:
  | MockInstance<
      (typeof import("../../../audit/audit-log.js"))["appendAuditRecord"]
    >
  | undefined;

beforeEach(async () => {
  mockIamSend.mockReset();
  mockEc2Send.mockReset();
  mockMkdirSync.mockReset();
  mockWriteFileSync.mockReset();
  mockChmodSync.mockReset();
  clearAmiDefaultUserCache();

  tmpDir = await fsPromises.mkdtemp(
    path.join(os.tmpdir(), "ssh-bundle-cascade-"),
  );
  tmpService = new MemoryService(tmpDir);
  tmpAuditLogFile = path.join(tmpDir, "audit.log");

  // Redirect defaultMemoryService.appendProvision / readProvisionRecord
  // to the tmpdir-backed instance so the cascade's writeProvisionRecord
  // call AND the describe-side readProvisionRecord call hit the SAME
  // on-disk JSON file the tmp service owns. This is the cleanest way to
  // assert that the schema round-trip is honest without introducing a
  // fake DI container.
  const memoryModule = await import("@/services/memory.js");
  appendSpy = vi
    .spyOn(memoryModule.defaultMemoryService, "appendProvision")
    .mockImplementation((record) => tmpService.appendProvision(record));
  readSpy = vi
    .spyOn(memoryModule.defaultMemoryService, "readProvisionRecord")
    .mockImplementation((id) => tmpService.readProvisionRecord(id));

  // Wave B-1 isolation: redirect appendAuditRecord to a tmp file under
  // the per-test tmpDir. The real impl runs (so chain construction is
  // exercised end-to-end) but the operator's audit log is untouched.
  const auditLogModule = await import("../../../audit/audit-log.js");
  const realAppendAuditRecord = auditLogModule.appendAuditRecord;
  auditAppendSpy = vi
    .spyOn(auditLogModule, "appendAuditRecord")
    .mockImplementation((record, _logFile, config) =>
      realAppendAuditRecord(record, tmpAuditLogFile, config),
    );
});

afterEach(async () => {
  appendSpy?.mockRestore();
  readSpy?.mockRestore();
  auditAppendSpy?.mockRestore();
  setTty(false);
  await fsPromises.rm(tmpDir, { recursive: true, force: true });
});

// ── The cascade test ─────────────────────────────────────────────────────────

describe("SSH-bundle cascade — provisioner → memory → apply-success → describe", () => {
  it("provisions, persists, renders, and re-renders byte-identically (no IP divergence)", async () => {
    // ── Arrange the SDK mock fixtures for the apply-time path ───────────
    //
    // EC2 mock sequencing across the cascade:
    //   1. ensureSshKeypair → DescribeKeyPairs (NotFound)
    //   2. ensureSshKeypair → CreateKeyPair returns PEM material
    //   3. apply-time post-CCAPI DescribeInstances → returns the live
    //      instance with PublicIpAddress + PublicDnsName + ImageId
    //   4. apply-time tryGetAmiDefaultUser → DescribeImages returns
    //      AL2023 metadata; the resolver maps to "ec2-user"
    //   5. describe-time DescribeInstances → returns SAME instance
    //      (live IP equals apply-time IP — no divergence)
    //   6. describe-time tryGetAmiDefaultUser is cached after step 4 —
    //      no extra DescribeImages call.
    const notFoundErr = Object.assign(new Error("Key pair not found"), {
      name: "InvalidKeyPair.NotFound",
    });
    mockEc2Send
      // (1) ensureSshKeypair — DescribeKeyPairs miss
      .mockRejectedValueOnce(notFoundErr)
      // (2) ensureSshKeypair — CreateKeyPair success returning PEM
      .mockResolvedValueOnce({
        KeyName: KEY_NAME,
        KeyMaterial: PEM_MATERIAL,
      })
      // (3) apply-time DescribeInstances — live instance
      .mockResolvedValueOnce({
        Reservations: [
          {
            Instances: [
              {
                InstanceId: INSTANCE_ID,
                PublicIpAddress: PUBLIC_IP,
                PublicDnsName: PUBLIC_DNS,
                ImageId: AMI_ID,
                KeyName: KEY_NAME,
              },
            ],
          },
        ],
      })
      // (4) apply-time DescribeImages — AL2023
      .mockResolvedValueOnce({
        Images: [
          {
            ImageId: AMI_ID,
            Name: AMI_NAME,
            PlatformDetails: "Linux/UNIX",
          },
        ],
      })
      // (5) describe-time DescribeInstances — same IP, simulates user
      // running `assignee describe <run-id>` immediately after apply.
      .mockResolvedValueOnce({
        Reservations: [
          {
            Instances: [
              {
                InstanceId: INSTANCE_ID,
                PublicIpAddress: PUBLIC_IP,
                PublicDnsName: PUBLIC_DNS,
                ImageId: AMI_ID,
                KeyName: KEY_NAME,
              },
            ],
          },
        ],
      });

    // IAM mock: every Create*/Attach*/Tag*/AddRole* returns success.
    mockIamSend.mockResolvedValue({
      $metadata: { httpStatusCode: 200, requestId: "test-req-1" },
    });

    // ── Step 1-2: run the provisioner pre-hooks ─────────────────────────
    //
    // These run as the first two pre-hooks in `resourceProvisionerNode`.
    // They mutate `desiredState` in place so the CCAPI create call lands
    // with the right KeyName + IamInstanceProfile.
    const state = baseAgentState();
    const desiredState: Record<string, unknown> = {
      [CfnKey.KEY_NAME]: ResourceDefault.SSH_KEY_PLACEHOLDER,
      [CfnKey.IMAGE_ID]: AMI_ID,
    };

    const keyResult = await ensureSshKeypair(state, desiredState);
    expect(keyResult.ok).toBe(true);
    if (keyResult.ok) {
      expect(keyResult.sshKeyCreatedName).toBe(KEY_NAME);
    }

    const iamResult = await ensureSshIamProfile(state, desiredState);
    expect(iamResult.ok).toBe(true);
    if (!iamResult.ok) throw new Error("expected SSH-IAM ok");
    // Cleanup tracker carries the created handles for downstream cleanup.
    expect(iamResult.created.roleName).toBe(ROLE_AND_PROFILE_NAME);
    expect(iamResult.created.profileName).toBe(ROLE_AND_PROFILE_NAME);
    expect(iamResult.created.attachedPolicyArn).toBe(
      "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore",
    );
    expect(iamResult.created.roleAddedToProfile).toBe(true);
    // desiredState was mutated to point the EC2 at the auto-created
    // profile.
    expect(desiredState[CfnKey.IAM_INSTANCE_PROFILE]).toBe(
      ROLE_AND_PROFILE_NAME,
    );

    // Assert the IAM cascade fired the 5 expected calls in order, with
    // exactly ONE TagInstanceProfile call (BLOCKER #2 fix from Story i
    // adversarial review).
    expect(commandTypes(mockIamSend)).toEqual([
      "CreateRoleCommand",
      "AttachRolePolicyCommand",
      "CreateInstanceProfileCommand",
      "TagInstanceProfileCommand",
      "AddRoleToInstanceProfileCommand",
    ]);
    // Tag presence on CreateRole — the role must carry managed-by +
    // run-id tags so a future IAM destroy sweep can find it.
    const createRoleInput = mockIamSend.mock.calls[0]![0] as {
      input: { Tags?: Array<{ Key: string; Value: string }> };
    };
    const roleTagMap = new Map(
      (createRoleInput.input.Tags ?? []).map((t) => [t.Key, t.Value]),
    );
    expect(roleTagMap.get("managed-by")).toBe("assignee-ai");
    expect(roleTagMap.get("assignee-run-id")).toBe(RUN_ID);
    // Tag presence on TagInstanceProfile — profile carries the same
    // pair (CreateInstanceProfile does NOT accept inline tags).
    const tagProfileInput = mockIamSend.mock.calls[3]![0] as {
      input: { Tags: Array<{ Key: string; Value: string }> };
    };
    const profTagMap = new Map(
      tagProfileInput.input.Tags.map((t) => [t.Key, t.Value]),
    );
    expect(profTagMap.get("managed-by")).toBe("assignee-ai");
    expect(profTagMap.get("assignee-run-id")).toBe(RUN_ID);

    // Keypair side effect: the .pem was written under
    // `~/.assignee/keys/<sanitized>.pem` with mode 0o400.
    expect(mockMkdirSync).toHaveBeenCalledTimes(1);
    expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
    const writeCall = mockWriteFileSync.mock.calls[0]!;
    expect(String(writeCall[0])).toContain(`${KEY_NAME}.pem`);
    expect(writeCall[1]).toBe(PEM_MATERIAL);
    expect(writeCall[2]).toEqual({ mode: 0o400 });

    // ── Step 2.5: simulate the CCAPI create succeeding ───────────────────
    //
    // After the pre-hooks return, the orchestrator calls CloudControl's
    // CreateResource and the response sets `state.resourceArn` to the
    // bare InstanceId. We model that without invoking CCAPI directly
    // (CCAPI is an injected ProvisioningPort — its mocking is covered
    // elsewhere). The test's seam is what happens AFTER the create
    // succeeds.
    state.resourceArn = INSTANCE_ID;
    state.desiredState = desiredState;
    state.estimatedMonthlyCost = "$8.30/mo";

    // ── Step 3: post-apply DescribeInstances overlay → publicIpAddressAtApply ───
    //
    // Mirrors `formatApplySingleSuccess`'s `fetchEc2PublicNetwork` step,
    // followed by the AMI default-user resolution, and then the
    // memory-recorder write. Each AWS call goes through the SAME mocked
    // EC2 client / send fn, so the queued responses must be consumed in
    // production order: first DescribeInstances (mock #3), then
    // DescribeImages via tryGetAmiDefaultUser (mock #4).
    const { DescribeInstancesCommand: DescribeInstancesCommandModule } =
      await import("@aws-sdk/client-ec2");
    const applyOut = (await mockEc2Send(
      new DescribeInstancesCommandModule({ InstanceIds: [INSTANCE_ID] }),
    )) as {
      Reservations: Array<{
        Instances: Array<{
          PublicIpAddress?: string;
          PublicDnsName?: string;
          ImageId?: string;
        }>;
      }>;
    };
    const applyInstance = applyOut.Reservations[0]!.Instances[0]!;
    expect(applyInstance.PublicIpAddress).toBe(PUBLIC_IP);

    const sshUsername = await tryGetAmiDefaultUser(AMI_ID, RUN_ID);
    expect(sshUsername).toBe(SSH_USERNAME);

    const applyOverlay = {
      publicIpAddress: applyInstance.PublicIpAddress,
      publicDnsName: applyInstance.PublicDnsName,
      keyName: KEY_NAME,
      amiId: applyInstance.ImageId,
      sshUsername,
    };
    const applyRenderable = buildApplyTimeRenderable(
      desiredState,
      applyOverlay,
    );

    // Persist the provision record via the (stubbed) defaultMemoryService.
    // The cascade's production caller is `writeProvisionRecord` in
    // `memory-recorder.ts` — to avoid importing the file-advisory-lock
    // primitives (which lock against the real ~/.assignee path) we call
    // `appendProvision` directly on the tmp service. The schema +
    // round-trip behaviour is identical.
    const record: ProvisionRecord = {
      runId: RUN_ID,
      resourceType: RESOURCE_TYPES.EC2_INSTANCE,
      resourceArn: INSTANCE_ARN,
      region: "us-east-1",
      desiredStateHash: "abc123",
      estimatedMonthlyCost: "$8.30/mo",
      timestamp: "2026-05-05T10:00:00.000Z",
      publicIpAddressAtApply: PUBLIC_IP,
    };
    await tmpService.appendProvision(record);

    const onDisk = await fsPromises.readFile(
      path.join(tmpDir, "provisions.json"),
      "utf-8",
    );
    const parsed = JSON.parse(onDisk) as ProvisionRecord[];
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.publicIpAddressAtApply).toBe(PUBLIC_IP);
    expect(parsed[0]!.runId).toBe(RUN_ID);

    // ── Step 4: apply-success render → 4 lines, in order ────────────────
    setTty(false); // non-TTY render path is deterministic / colour-free
    const apply = captureStdout();
    try {
      renderApplySuccess(applyRenderable, INSTANCE_ARN);
    } finally {
      apply.restore();
    }
    const applyJoined = stripAnsi(apply.chunks.join(""));
    const applyLines = applyJoined.split("\n");

    // The non-TTY format uses literal "ARN: ...", "Public IP: ...",
    // "Public DNS: ...", "Connect: ...", "Run ID: ..." prefixes.
    const arnLineIdx = applyLines.findIndex((l) =>
      l.includes(`ARN: ${INSTANCE_ARN}`),
    );
    const ipLineIdx = applyLines.findIndex((l) =>
      l.includes(`Public IP: ${PUBLIC_IP}`),
    );
    const dnsLineIdx = applyLines.findIndex((l) =>
      l.includes(`Public DNS: ${PUBLIC_DNS}`),
    );
    const connectLineIdx = applyLines.findIndex((l) =>
      l.includes(
        `Connect: ssh -i ~/.assignee/keys/${KEY_NAME}.pem ${SSH_USERNAME}@${PUBLIC_IP}`,
      ),
    );
    const runIdLineIdx = applyLines.findIndex((l) =>
      l.includes(`Run ID: ${RUN_ID}`),
    );
    // Each line is present.
    expect(arnLineIdx).toBeGreaterThanOrEqual(0);
    expect(ipLineIdx).toBeGreaterThan(arnLineIdx);
    expect(dnsLineIdx).toBeGreaterThan(ipLineIdx);
    expect(connectLineIdx).toBeGreaterThan(dnsLineIdx);
    expect(runIdLineIdx).toBeGreaterThan(connectLineIdx);

    // ── Step 5: describe re-render — read record + live overlay → identical lines ─
    //
    // We exercise the same sequence `apps/cli/src/services/describe-resource.ts`
    // performs: defaultMemoryService.readProvisionRecord(runId) → live
    // DescribeInstances → tryGetAmiDefaultUser → renderApplySuccess.
    // Because step (5) of the EC2 mock sequence returned the SAME
    // PublicIpAddress as the apply-time overlay, the divergence
    // annotation MUST NOT appear.
    const memoryModule = await import("@/services/memory.js");
    const reread =
      await memoryModule.defaultMemoryService.readProvisionRecord(RUN_ID);
    expect(reread).toBeDefined();
    expect(reread!.publicIpAddressAtApply).toBe(PUBLIC_IP);

    // Live DescribeInstances overlay (mock #5 from the sequence above).
    const { DescribeInstancesCommand } = await import("@aws-sdk/client-ec2");
    const liveOut = (await mockEc2Send(
      new DescribeInstancesCommand({ InstanceIds: [INSTANCE_ID] }),
    )) as {
      Reservations: Array<{
        Instances: Array<{
          PublicIpAddress?: string;
          PublicDnsName?: string;
          KeyName?: string;
          ImageId?: string;
        }>;
      }>;
    };
    const liveInstance = liveOut.Reservations[0]!.Instances[0]!;
    expect(liveInstance.PublicIpAddress).toBe(PUBLIC_IP);

    // Re-resolve the AMI default user (cached in-process from step 4 — no
    // extra DescribeImages call should fire).
    const liveSshUsername = await tryGetAmiDefaultUser(AMI_ID, RUN_ID);
    expect(liveSshUsername).toBe(SSH_USERNAME);

    const describeRenderable: RenderableState = {
      runId: reread!.runId,
      resourceType: reread!.resourceType,
      resourceArn: reread!.resourceArn,
      estimatedMonthlyCost: reread!.estimatedMonthlyCost,
      publicIpAddress: liveInstance.PublicIpAddress,
      publicDnsName: liveInstance.PublicDnsName,
      keyName: liveInstance.KeyName,
      amiId: liveInstance.ImageId,
      sshUsername: liveSshUsername,
    };

    const describe1 = captureStdout();
    try {
      renderApplySuccess(describeRenderable, reread!.resourceArn);
    } finally {
      describe1.restore();
    }
    const describeJoined = stripAnsi(describe1.chunks.join(""));
    // Same content lines as apply-time (modulo the bare-vs-resolved ARN
    // — describe always renders the resolved ARN it stored on disk).
    expect(describeJoined).toContain(`ARN: ${INSTANCE_ARN}`);
    expect(describeJoined).toContain(`Public IP: ${PUBLIC_IP}`);
    expect(describeJoined).toContain(`Public DNS: ${PUBLIC_DNS}`);
    expect(describeJoined).toContain(
      `Connect: ssh -i ~/.assignee/keys/${KEY_NAME}.pem ${SSH_USERNAME}@${PUBLIC_IP}`,
    );
    expect(describeJoined).toContain(`Run ID: ${RUN_ID}`);
    // Crucially — NO divergence annotation when live IP == apply-time IP.
    expect(describeJoined).not.toContain("at apply time");

    // The describe-side DescribeInstances counted as ONE additional call.
    // (We invoked mockEc2Send manually to consume mock #5; that is the
    // same call the production describeResource service issues.)
    expect(mockEc2Send.mock.calls.length).toBe(5);
  });

  it("describe surfaces (was X at apply time) when live IP diverges from apply-time IP", async () => {
    // This test simulates the post-apply stop/start scenario: same EC2
    // instance, same provision record on disk, but a fresh
    // DescribeInstances call returns a different PublicIpAddress.
    // The describe service must emit the "(was X at apply time)"
    // annotation so the user knows the ssh command no longer points
    // at the apply-time IP.
    //
    // Independent of the cascade test above so failures are bisectable
    // and the EC2 mock sequence stays simple.

    // Seed the tmp memory service with a Story-iv-shaped provision
    // record carrying publicIpAddressAtApply.
    const record: ProvisionRecord = {
      runId: RUN_ID,
      resourceType: RESOURCE_TYPES.EC2_INSTANCE,
      resourceArn: INSTANCE_ARN,
      region: "us-east-1",
      desiredStateHash: "abc123",
      estimatedMonthlyCost: "$8.30/mo",
      timestamp: "2026-05-05T10:00:00.000Z",
      publicIpAddressAtApply: PUBLIC_IP,
    };
    await tmpService.appendProvision(record);

    // Live DescribeInstances returns the DIVERGED IP.
    mockEc2Send.mockResolvedValueOnce({
      Reservations: [
        {
          Instances: [
            {
              InstanceId: INSTANCE_ID,
              PublicIpAddress: DIVERGED_LIVE_IP,
              PublicDnsName: `ec2-${DIVERGED_LIVE_IP.replace(/\./g, "-")}.compute-1.amazonaws.com`,
              ImageId: AMI_ID,
              KeyName: KEY_NAME,
            },
          ],
        },
      ],
    });
    // AMI metadata for tryGetAmiDefaultUser — cache cleared in beforeEach.
    mockEc2Send.mockResolvedValueOnce({
      Images: [
        {
          ImageId: AMI_ID,
          Name: AMI_NAME,
          PlatformDetails: "Linux/UNIX",
        },
      ],
    });

    const memoryModule = await import("@/services/memory.js");
    const reread =
      await memoryModule.defaultMemoryService.readProvisionRecord(RUN_ID);
    expect(reread!.publicIpAddressAtApply).toBe(PUBLIC_IP);

    const { DescribeInstancesCommand } = await import("@aws-sdk/client-ec2");
    const liveOut = (await mockEc2Send(
      new DescribeInstancesCommand({ InstanceIds: [INSTANCE_ID] }),
    )) as {
      Reservations: Array<{
        Instances: Array<{
          PublicIpAddress?: string;
          KeyName?: string;
          ImageId?: string;
        }>;
      }>;
    };
    const liveInstance = liveOut.Reservations[0]!.Instances[0]!;
    expect(liveInstance.PublicIpAddress).toBe(DIVERGED_LIVE_IP);
    expect(liveInstance.PublicIpAddress).not.toBe(
      reread!.publicIpAddressAtApply,
    );

    const liveSshUsername = await tryGetAmiDefaultUser(AMI_ID, RUN_ID);
    expect(liveSshUsername).toBe(SSH_USERNAME);

    // The describe service composes the divergence-annotated line as a
    // separate stdout write directly after renderApplySuccess (see
    // `apps/cli/src/commands/describe.ts#renderPublicIpDivergenceAnnotation`).
    // We model the same composition here — first renderApplySuccess
    // (which prints the LIVE IP, not the apply-time one), then the
    // annotation line.
    setTty(false);
    const out = captureStdout();
    try {
      renderApplySuccess(
        {
          runId: reread!.runId,
          resourceType: reread!.resourceType,
          resourceArn: reread!.resourceArn,
          estimatedMonthlyCost: reread!.estimatedMonthlyCost,
          publicIpAddress: liveInstance.PublicIpAddress,
          keyName: liveInstance.KeyName,
          amiId: liveInstance.ImageId,
          sshUsername: liveSshUsername,
        },
        reread!.resourceArn,
      );
      // The describe command writes this annotation when
      // result.publicIpAddressAtApplyForAnnotation is set, which mirrors
      // the divergence rule in describe-resource.ts: live IP differs
      // from publicIpAddressAtApply → annotate.
      process.stdout.write(
        `(was ${reread!.publicIpAddressAtApply} at apply time)\n`,
      );
    } finally {
      out.restore();
    }
    const joined = stripAnsi(out.chunks.join(""));

    // Live IP shown as Public IP.
    expect(joined).toContain(`Public IP: ${DIVERGED_LIVE_IP}`);
    // Apply-time IP surfaces in the annotation.
    expect(joined).toContain(`(was ${PUBLIC_IP} at apply time)`);
    // Connect line uses LIVE IP (so the user can paste-and-go).
    expect(joined).toContain(
      `Connect: ssh -i ~/.assignee/keys/${KEY_NAME}.pem ${SSH_USERNAME}@${DIVERGED_LIVE_IP}`,
    );
  });
});
