/**
 * Tests for `renderApplySuccess` — single-resource apply completion line.
 *
 * SSH-bundle Story ii created this file. The original 42-LOC renderer
 * had only transitive coverage via `display-plan-box.test.ts`; this
 * file pins both the legacy ARN-only baseline AND the new public-IP /
 * public-DNS branches added in Story ii.
 *
 * All fixtures use real AWS-shape values (real-shape ARNs, real
 * `i-…` instance IDs, real EC2 PublicDnsName format) per
 * `feedback_real_data_mocks_all_cases`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Stop the spinner module from doing real I/O — it imports @clack/prompts
// which throws at import time when stdin is not a TTY in some test
// environments. Mocking the singleton-getter is sufficient because the
// renderer only calls stopSpinner() at entry.
vi.mock("./spinner.js", () => ({
  startSpinner: vi.fn(),
  updateSpinner: vi.fn(),
  stopSpinner: vi.fn(),
}));

import { renderApplySuccess } from "./apply-success.js";
import type { RenderableState } from "../display-helpers/renderable-state.js";

// ── Test utilities ───────────────────────────────────────────────────────────

function captureStdout() {
  const chunks: string[] = [];
  const spy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk: unknown, ..._args: unknown[]) => {
      chunks.push(String(chunk));
      return true;
    });
  return { chunks, restore: () => spy.mockRestore() };
}

function setTty(isTty: boolean) {
  Object.defineProperty(process.stdout, "isTTY", {
    value: isTty,
    configurable: true,
  });
}

// ── Realistic fixtures ───────────────────────────────────────────────────────

// Real-shape S3 ARN (synthesized account = doc-example placeholder).
const S3_DISPLAY_ARN = "arn:aws:s3:::my-static-site-1714867200";

// Real-shape EC2 instance: 17-char hex InstanceId; AWS-shape PublicDnsName
// (us-east-1 default DNS template); private IP NOT rendered, only public.
const EC2_INSTANCE_ID = "i-0abc123def4567890";
const EC2_DISPLAY_ARN = `arn:aws:ec2:us-east-1:123456789012:instance/${EC2_INSTANCE_ID}`;
const EC2_PUBLIC_IP = "54.198.42.117";
const EC2_PUBLIC_DNS = "ec2-54-198-42-117.compute-1.amazonaws.com";

// Story iii fixtures — SSH-bundle keypair name + AMI default user pair.
// `assignee-ssh-key` is the production SSH_KEY_PLACEHOLDER constant
// (see `config/cfn-keys/defaults.ts`); `ec2-user` is the canonical AL2023
// default user resolved by `getAmiDefaultUser`.
const SSH_KEY_NAME = "assignee-ssh-key";
const SSH_USERNAME_AL2023 = "ec2-user";
const SSH_USERNAME_UBUNTU = "ubuntu";
const EXPECTED_CONNECT_CMD = `ssh -i ~/.assignee/keys/${SSH_KEY_NAME}.pem ${SSH_USERNAME_AL2023}@${EC2_PUBLIC_IP}`;

// RDS — has no PublicIpAddress concept; renderer must not print
// network lines even if the RenderableState fields are accidentally
// set (defence-in-depth — apply-single.ts already gates on resource
// type but the renderer should not crash if both somehow appear).
const RDS_DISPLAY_ARN = "arn:aws:rds:us-east-1:123456789012:db:prod-db-1";

function baseState(overrides: Partial<RenderableState> = {}): RenderableState {
  return {
    resourceType: "AWS::S3::Bucket",
    runId: "run-2026-05-05-abc123",
    resourceArn: "my-static-site-1714867200",
    ...overrides,
  };
}

// Strip ANSI colour codes (chalk wraps every TTY write); makes line-by-line
// assertions comparable across TTY / non-TTY.
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("renderApplySuccess — TTY mode", () => {
  beforeEach(() => setTty(true));
  afterEach(() => {
    vi.restoreAllMocks();
    setTty(false);
  });

  it("baseline: ARN-only output for non-EC2 resources renders unchanged (S3)", () => {
    const { chunks, restore } = captureStdout();
    renderApplySuccess(baseState(), S3_DISPLAY_ARN);
    restore();

    const out = stripAnsi(chunks.join(""));
    expect(out).toContain("✅ Resource created successfully!");
    expect(out).toContain(`   ARN: ${S3_DISPLAY_ARN}`);
    expect(out).toContain("   Run ID: run-2026-05-05-abc123");
    // No network lines for S3.
    expect(out).not.toContain("Public IP");
    expect(out).not.toContain("Public DNS");
  });

  it("EC2 with publicIpAddress renders the Public IP line between ARN and Run ID", () => {
    const { chunks, restore } = captureStdout();
    renderApplySuccess(
      baseState({
        resourceType: "AWS::EC2::Instance",
        resourceArn: EC2_INSTANCE_ID,
        publicIpAddress: EC2_PUBLIC_IP,
      }),
      EC2_DISPLAY_ARN,
    );
    restore();

    const out = stripAnsi(chunks.join(""));
    expect(out).toContain(`   ARN: ${EC2_DISPLAY_ARN}`);
    expect(out).toContain(`   Public IP:  ${EC2_PUBLIC_IP}`);
    expect(out).toContain("   Run ID: run-2026-05-05-abc123");
    // Order check: ARN → Public IP → Run ID.
    const arnIdx = out.indexOf("ARN:");
    const ipIdx = out.indexOf("Public IP:");
    const runIdx = out.indexOf("Run ID:");
    expect(arnIdx).toBeLessThan(ipIdx);
    expect(ipIdx).toBeLessThan(runIdx);
  });

  it("EC2 with both publicIpAddress and publicDnsName renders both lines", () => {
    const { chunks, restore } = captureStdout();
    renderApplySuccess(
      baseState({
        resourceType: "AWS::EC2::Instance",
        resourceArn: EC2_INSTANCE_ID,
        publicIpAddress: EC2_PUBLIC_IP,
        publicDnsName: EC2_PUBLIC_DNS,
      }),
      EC2_DISPLAY_ARN,
    );
    restore();

    const out = stripAnsi(chunks.join(""));
    expect(out).toContain(`   Public IP:  ${EC2_PUBLIC_IP}`);
    expect(out).toContain(`   Public DNS: ${EC2_PUBLIC_DNS}`);
    // Order check: IP printed before DNS.
    const ipIdx = out.indexOf("Public IP:");
    const dnsIdx = out.indexOf("Public DNS:");
    expect(ipIdx).toBeLessThan(dnsIdx);
  });

  it("EC2 without public IP renders ARN only — no network lines", () => {
    // Private-subnet EC2: no PublicIpAddress, no PublicDnsName.
    const { chunks, restore } = captureStdout();
    renderApplySuccess(
      baseState({
        resourceType: "AWS::EC2::Instance",
        resourceArn: EC2_INSTANCE_ID,
      }),
      EC2_DISPLAY_ARN,
    );
    restore();

    const out = stripAnsi(chunks.join(""));
    expect(out).toContain(`   ARN: ${EC2_DISPLAY_ARN}`);
    expect(out).not.toContain("Public IP");
    expect(out).not.toContain("Public DNS");
    expect(out).toContain("   Run ID: run-2026-05-05-abc123");
  });

  it("DNS suppressed when DNS string equals IP string (no duplicate line)", () => {
    const { chunks, restore } = captureStdout();
    renderApplySuccess(
      baseState({
        resourceType: "AWS::EC2::Instance",
        resourceArn: EC2_INSTANCE_ID,
        publicIpAddress: EC2_PUBLIC_IP,
        publicDnsName: EC2_PUBLIC_IP, // pathological case — AWS sometimes
        // returns the IP as the "DNS" when no public DNS configured.
      }),
      EC2_DISPLAY_ARN,
    );
    restore();

    const out = stripAnsi(chunks.join(""));
    expect(out).toContain(`   Public IP:  ${EC2_PUBLIC_IP}`);
    // Public DNS line should NOT appear because dns === ip.
    expect(out).not.toContain("Public DNS");
  });

  it("DNS-only branch: prints DNS even when IP is absent", () => {
    const { chunks, restore } = captureStdout();
    renderApplySuccess(
      baseState({
        resourceType: "AWS::EC2::Instance",
        resourceArn: EC2_INSTANCE_ID,
        publicDnsName: EC2_PUBLIC_DNS,
      }),
      EC2_DISPLAY_ARN,
    );
    restore();

    const out = stripAnsi(chunks.join(""));
    expect(out).toContain(`   Public DNS: ${EC2_PUBLIC_DNS}`);
    expect(out).not.toContain("Public IP:");
  });

  it("RDS with stray network fields renders nothing extra (defence-in-depth)", () => {
    // The apply-single.ts caller gates on EC2 only — but if a future
    // caller were to pass network fields for an RDS resource, the
    // renderer must still print them faithfully (no type-specific
    // suppression in the renderer). This test pins that contract: the
    // renderer is type-agnostic, suppression is the caller's job.
    const { chunks, restore } = captureStdout();
    renderApplySuccess(
      baseState({
        resourceType: "AWS::RDS::DBInstance",
        resourceArn: "prod-db-1",
      }),
      RDS_DISPLAY_ARN,
    );
    restore();

    const out = stripAnsi(chunks.join(""));
    expect(out).toContain(`   ARN: ${RDS_DISPLAY_ARN}`);
    expect(out).not.toContain("Public IP");
    expect(out).not.toContain("Public DNS");
  });

  // ── Story iii — SSH connect line ────────────────────────────────────────

  it("EC2 with SSH bundle (publicIp + keyName + sshUsername) renders the Connect line BETWEEN Public IP and Run ID", () => {
    const { chunks, restore } = captureStdout();
    renderApplySuccess(
      baseState({
        resourceType: "AWS::EC2::Instance",
        resourceArn: EC2_INSTANCE_ID,
        publicIpAddress: EC2_PUBLIC_IP,
        keyName: SSH_KEY_NAME,
        sshUsername: SSH_USERNAME_AL2023,
      }),
      EC2_DISPLAY_ARN,
    );
    restore();

    const out = stripAnsi(chunks.join(""));
    expect(out).toContain(`   Connect:    ${EXPECTED_CONNECT_CMD}`);
    // Order: ARN → Public IP → Connect → Run ID.
    const arnIdx = out.indexOf("ARN:");
    const ipIdx = out.indexOf("Public IP:");
    const connectIdx = out.indexOf("Connect:");
    const runIdx = out.indexOf("Run ID:");
    expect(arnIdx).toBeLessThan(ipIdx);
    expect(ipIdx).toBeLessThan(connectIdx);
    expect(connectIdx).toBeLessThan(runIdx);
  });

  it("Connect line uses the resolved AMI user (ubuntu) when sshUsername reflects an Ubuntu AMI", () => {
    const { chunks, restore } = captureStdout();
    renderApplySuccess(
      baseState({
        resourceType: "AWS::EC2::Instance",
        resourceArn: EC2_INSTANCE_ID,
        publicIpAddress: EC2_PUBLIC_IP,
        keyName: SSH_KEY_NAME,
        sshUsername: SSH_USERNAME_UBUNTU,
      }),
      EC2_DISPLAY_ARN,
    );
    restore();

    const out = stripAnsi(chunks.join(""));
    expect(out).toContain(
      `   Connect:    ssh -i ~/.assignee/keys/${SSH_KEY_NAME}.pem ${SSH_USERNAME_UBUNTU}@${EC2_PUBLIC_IP}`,
    );
  });

  it("EC2 with SSH bundle but missing publicIp suppresses the Connect line", () => {
    // Private-subnet EC2 with the SSH bundle: keypair is created but no
    // public IP, so there's no point printing a connect command that
    // can't reach the box.
    const { chunks, restore } = captureStdout();
    renderApplySuccess(
      baseState({
        resourceType: "AWS::EC2::Instance",
        resourceArn: EC2_INSTANCE_ID,
        keyName: SSH_KEY_NAME,
        sshUsername: SSH_USERNAME_AL2023,
        // publicIpAddress is intentionally absent.
      }),
      EC2_DISPLAY_ARN,
    );
    restore();

    const out = stripAnsi(chunks.join(""));
    expect(out).not.toContain("Connect:");
  });

  it("EC2 without keyName (no SSH bundle) suppresses the Connect line even when publicIp + sshUsername are set", () => {
    // BYO-keypair EC2 with the user-provided KeyName but the SSH bundle
    // is NOT in play — apply-single.ts only populates state.keyName when
    // it knows the key is under ~/.assignee/keys/. If a future change
    // populates sshUsername without keyName (degenerate), the renderer
    // still suppresses.
    const { chunks, restore } = captureStdout();
    renderApplySuccess(
      baseState({
        resourceType: "AWS::EC2::Instance",
        resourceArn: EC2_INSTANCE_ID,
        publicIpAddress: EC2_PUBLIC_IP,
        sshUsername: SSH_USERNAME_AL2023,
        // keyName intentionally absent.
      }),
      EC2_DISPLAY_ARN,
    );
    restore();

    const out = stripAnsi(chunks.join(""));
    expect(out).not.toContain("Connect:");
  });

  it("EC2 with keyName + publicIp but no sshUsername (DescribeImages failed) suppresses Connect", () => {
    const { chunks, restore } = captureStdout();
    renderApplySuccess(
      baseState({
        resourceType: "AWS::EC2::Instance",
        resourceArn: EC2_INSTANCE_ID,
        publicIpAddress: EC2_PUBLIC_IP,
        keyName: SSH_KEY_NAME,
        // sshUsername absent — DescribeImages was throttled or AccessDenied.
      }),
      EC2_DISPLAY_ARN,
    );
    restore();

    const out = stripAnsi(chunks.join(""));
    expect(out).not.toContain("Connect:");
  });

  it("renderer is type-agnostic: synthetic non-EC2 resource with SSH-shaped fields still renders Connect (caller suppression contract)", () => {
    // Mirrors the Story ii contract that suppression is the caller's
    // job, not the renderer's. A future caller could conceivably use
    // these fields for a Lightsail / EC2 fleet member type; the
    // renderer must not pre-judge.
    const { chunks, restore } = captureStdout();
    renderApplySuccess(
      baseState({
        resourceType: "AWS::Lightsail::Instance",
        resourceArn: "my-lightsail",
        publicIpAddress: EC2_PUBLIC_IP,
        keyName: SSH_KEY_NAME,
        sshUsername: SSH_USERNAME_AL2023,
      }),
      "arn:aws:lightsail:us-east-1:123456789012:Instance/my-lightsail",
    );
    restore();

    const out = stripAnsi(chunks.join(""));
    expect(out).toContain(`   Connect:    ${EXPECTED_CONNECT_CMD}`);
  });

  it("treats empty-string keyName / sshUsername as absent", () => {
    const { chunks, restore } = captureStdout();
    renderApplySuccess(
      baseState({
        resourceType: "AWS::EC2::Instance",
        resourceArn: EC2_INSTANCE_ID,
        publicIpAddress: EC2_PUBLIC_IP,
        keyName: "",
        sshUsername: "",
      }),
      EC2_DISPLAY_ARN,
    );
    restore();

    const out = stripAnsi(chunks.join(""));
    expect(out).not.toContain("Connect:");
  });
});

describe("renderApplySuccess — non-TTY (CI / pipe) mode", () => {
  beforeEach(() => setTty(false));
  afterEach(() => vi.restoreAllMocks());

  it("baseline: SUCCESS / ARN / Run ID without any ANSI codes (S3)", () => {
    const { chunks, restore } = captureStdout();
    renderApplySuccess(baseState(), S3_DISPLAY_ARN);
    restore();

    const out = chunks.join("");
    expect(out).toContain("SUCCESS");
    expect(out).toContain(`ARN: ${S3_DISPLAY_ARN}`);
    expect(out).toContain("Run ID: run-2026-05-05-abc123");
    expect(out).not.toMatch(/\x1b\[[0-9;]*m/);
    expect(out).not.toContain("Public IP");
  });

  it("EC2 with both fields prints Public IP and Public DNS in pipe mode (no ANSI)", () => {
    const { chunks, restore } = captureStdout();
    renderApplySuccess(
      baseState({
        resourceType: "AWS::EC2::Instance",
        resourceArn: EC2_INSTANCE_ID,
        publicIpAddress: EC2_PUBLIC_IP,
        publicDnsName: EC2_PUBLIC_DNS,
      }),
      EC2_DISPLAY_ARN,
    );
    restore();

    const out = chunks.join("");
    expect(out).toContain(`Public IP: ${EC2_PUBLIC_IP}`);
    expect(out).toContain(`Public DNS: ${EC2_PUBLIC_DNS}`);
    expect(out).not.toMatch(/\x1b\[[0-9;]*m/);
    // Order: ARN → Public IP → Public DNS → Run ID.
    expect(out.indexOf("ARN:")).toBeLessThan(out.indexOf("Public IP:"));
    expect(out.indexOf("Public IP:")).toBeLessThan(out.indexOf("Public DNS:"));
    expect(out.indexOf("Public DNS:")).toBeLessThan(out.indexOf("Run ID:"));
  });

  it("falls back to N/A when neither displayArn nor state.resourceArn is set", () => {
    const { chunks, restore } = captureStdout();
    renderApplySuccess(
      { resourceType: "AWS::S3::Bucket", runId: "run-x" },
      undefined,
    );
    restore();

    const out = chunks.join("");
    expect(out).toContain("ARN: N/A");
    expect(out).toContain("Run ID: run-x");
  });

  it("empty-string publicIpAddress / publicDnsName are treated as absent", () => {
    const { chunks, restore } = captureStdout();
    renderApplySuccess(
      baseState({
        resourceType: "AWS::EC2::Instance",
        resourceArn: EC2_INSTANCE_ID,
        publicIpAddress: "",
        publicDnsName: "",
      }),
      EC2_DISPLAY_ARN,
    );
    restore();

    const out = chunks.join("");
    expect(out).not.toContain("Public IP");
    expect(out).not.toContain("Public DNS");
  });

  it("EC2 SSH bundle: prints the Connect line with no ANSI codes in pipe mode", () => {
    const { chunks, restore } = captureStdout();
    renderApplySuccess(
      baseState({
        resourceType: "AWS::EC2::Instance",
        resourceArn: EC2_INSTANCE_ID,
        publicIpAddress: EC2_PUBLIC_IP,
        keyName: SSH_KEY_NAME,
        sshUsername: SSH_USERNAME_AL2023,
      }),
      EC2_DISPLAY_ARN,
    );
    restore();

    const out = chunks.join("");
    expect(out).toContain(`Connect: ${EXPECTED_CONNECT_CMD}`);
    expect(out).not.toMatch(/\x1b\[[0-9;]*m/);
    // Order: ARN → Public IP → Connect → Run ID.
    expect(out.indexOf("ARN:")).toBeLessThan(out.indexOf("Public IP:"));
    expect(out.indexOf("Public IP:")).toBeLessThan(out.indexOf("Connect:"));
    expect(out.indexOf("Connect:")).toBeLessThan(out.indexOf("Run ID:"));
  });

  it("missing SSH-bundle markers in pipe mode → no Connect line", () => {
    const { chunks, restore } = captureStdout();
    renderApplySuccess(
      baseState({
        resourceType: "AWS::EC2::Instance",
        resourceArn: EC2_INSTANCE_ID,
        publicIpAddress: EC2_PUBLIC_IP,
        // No keyName / sshUsername.
      }),
      EC2_DISPLAY_ARN,
    );
    restore();

    const out = chunks.join("");
    expect(out).not.toContain("Connect:");
  });
});
