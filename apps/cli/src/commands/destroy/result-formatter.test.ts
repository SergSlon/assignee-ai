/**
 * Tests for the destroy command's result-formatter helpers.
 *
 * Epic 92 Wave 1 (e92.1.b): introduced `renderDestroyScheduled` to stop
 * lying to users about KMS keys (PendingDeletion, not destroyed — D-21)
 * and Secrets (scheduled-for-deletion, not destroyed — D-25). This
 * file pins the output phrasing so a future "Resource destroyed."
 * regression on those types can't silently land.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Neutralize chalk so the assertions check plain text — we're testing
// the SHAPE of the emitted line, not ANSI coloring. Identity-stub keeps
// tty + non-tty branches functionally equivalent for assertions.
vi.mock("chalk", () => {
  const identity = (s: string) => s;
  return { default: { green: identity, red: identity, yellow: identity } };
});

// boxen is used by renderDestroyBox — stub to return the content
// unmodified so we can assert on the body text.
vi.mock("boxen", () => ({
  default: (content: string) => content,
}));

import {
  renderDestroyBox,
  renderDestroySuccess,
  renderDestroyScheduled,
} from "./result-formatter.js";

const origStdoutIsTTY = process.stdout.isTTY;
const origStdoutWrite = process.stdout.write.bind(process.stdout);

let stdoutOutput: string;

beforeEach(() => {
  stdoutOutput = "";
  process.stdout.write = vi.fn((chunk: string | Uint8Array) => {
    stdoutOutput += String(chunk);
    return true;
  }) as typeof process.stdout.write;
});

afterEach(() => {
  process.stdout.write = origStdoutWrite;
  Object.defineProperty(process.stdout, "isTTY", {
    value: origStdoutIsTTY,
    writable: true,
    configurable: true,
  });
});

describe("renderDestroyBox", () => {
  it("renders every required field in the destroy confirmation box", () => {
    // Non-TTY branch — plain-text fallback so assertions can match
    // without coping with boxen / chalk framing.
    Object.defineProperty(process.stdout, "isTTY", {
      value: false,
      writable: true,
      configurable: true,
    });

    renderDestroyBox({
      resourceType: "AWS::KMS::Key",
      arn: "arn:aws:kms:us-east-1:210987654321:key/ba48550a-3f14-446e-8f0c-1473f345c62d",
      region: "us-east-1",
      identifier: "ba48550a-3f14-446e-8f0c-1473f345c62d",
      estimatedMonthlyCost: "$1.00/mo",
    });

    expect(stdoutOutput).toContain("=== Destroy Resource ===");
    expect(stdoutOutput).toContain("Resource Type:   AWS::KMS::Key");
    expect(stdoutOutput).toContain(
      "ARN:             arn:aws:kms:us-east-1:210987654321:key/ba48550a-3f14-446e-8f0c-1473f345c62d",
    );
    // KMS::Key is region-scoped — the resolved region must survive.
    expect(stdoutOutput).toContain("Region:          us-east-1");
    expect(stdoutOutput).toContain(
      "Identifier:      ba48550a-3f14-446e-8f0c-1473f345c62d",
    );
    expect(stdoutOutput).toContain("Estimated Cost:  $1.00/mo");
  });

  // Epic 92 u.e (D-16): IAM and CloudFront resources live in the
  // global control plane. Previously the destroy box showed the
  // resolved API region (e.g. `us-east-1`) which contradicted the
  // `list` output (`global`). Both surfaces must agree.
  it("D-16: IAM Role shows Region: global (not the credential's resolved region)", () => {
    Object.defineProperty(process.stdout, "isTTY", {
      value: false,
      writable: true,
      configurable: true,
    });

    renderDestroyBox({
      resourceType: "AWS::IAM::Role",
      arn: "arn:aws:iam::210987654321:role/assignee-operator",
      region: "us-east-1",
      identifier: "assignee-operator",
      estimatedMonthlyCost: "Free",
    });

    expect(stdoutOutput).toContain("Resource Type:   AWS::IAM::Role");
    expect(stdoutOutput).toContain("Region:          global");
    // Must NOT show the resolved AWS region for a global resource.
    expect(stdoutOutput).not.toContain("Region:          us-east-1");
  });

  it("D-16: IAM User also renders as global", () => {
    Object.defineProperty(process.stdout, "isTTY", {
      value: false,
      writable: true,
      configurable: true,
    });

    renderDestroyBox({
      resourceType: "AWS::IAM::User",
      arn: "arn:aws:iam::210987654321:user/operator",
      region: "eu-west-1",
      identifier: "operator",
      estimatedMonthlyCost: "Free",
    });

    expect(stdoutOutput).toContain("Region:          global");
  });

  it("D-16: CloudFront Distribution renders as global", () => {
    Object.defineProperty(process.stdout, "isTTY", {
      value: false,
      writable: true,
      configurable: true,
    });

    renderDestroyBox({
      resourceType: "AWS::CloudFront::Distribution",
      arn: "arn:aws:cloudfront::210987654321:distribution/E1234567890ABC",
      region: "us-east-1",
      identifier: "E1234567890ABC",
      estimatedMonthlyCost: "$0.85/mo",
    });

    expect(stdoutOutput).toContain("Region:          global");
  });

  // Regression guard: S3::Bucket is NOT global (buckets live in a
  // single region). If we accidentally add S3 to the global list, the
  // user would see the wrong region label on every bucket destroy.
  it("D-16 anti-regression: S3::Bucket stays region-scoped (not global)", () => {
    Object.defineProperty(process.stdout, "isTTY", {
      value: false,
      writable: true,
      configurable: true,
    });

    renderDestroyBox({
      resourceType: "AWS::S3::Bucket",
      arn: "arn:aws:s3:::demo-bucket-210987654321",
      region: "us-west-2",
      identifier: "demo-bucket-210987654321",
      estimatedMonthlyCost: "$0.023/mo",
    });

    expect(stdoutOutput).toContain("Region:          us-west-2");
    expect(stdoutOutput).not.toContain("Region:          global");
  });
});

describe("renderDestroySuccess", () => {
  // Regression guard: non-scheduled types (S3, Lambda, SG, etc.) MUST
  // keep using "Resource destroyed." phrasing. Epic 92 only changed
  // the KMS / Secrets paths; every other destroy must be unaffected.
  it('keeps the "Resource destroyed." line unchanged (invariant)', () => {
    Object.defineProperty(process.stdout, "isTTY", {
      value: true,
      writable: true,
      configurable: true,
    });

    renderDestroySuccess("$5.00/mo");

    expect(stdoutOutput).toBe(
      "Resource destroyed. Estimated savings: $5.00/mo\n",
    );
  });

  it("renders in non-TTY mode without ANSI wrapping", () => {
    Object.defineProperty(process.stdout, "isTTY", {
      value: false,
      writable: true,
      configurable: true,
    });

    renderDestroySuccess("$0.00/mo");

    expect(stdoutOutput).toBe(
      "Resource destroyed. Estimated savings: $0.00/mo\n",
    );
  });
});

describe("renderDestroyScheduled (Epic 92 D-21, D-25)", () => {
  it('emits "Scheduled for deletion on <YYYY-MM-DD>" in TTY mode', () => {
    Object.defineProperty(process.stdout, "isTTY", {
      value: true,
      writable: true,
      configurable: true,
    });

    // Use a known UTC date so the assertion is deterministic.
    // 2026-04-27T12:34:56Z → "2026-04-27" after UTC date-slice.
    const scheduledAt = new Date("2026-04-27T12:34:56Z");
    renderDestroyScheduled(scheduledAt, "$1.00/mo");

    expect(stdoutOutput).toBe(
      "Scheduled for deletion on 2026-04-27. Estimated savings after deletion: $1.00/mo\n",
    );
  });

  it('does NOT emit the "Resource destroyed." string (D-21 anti-regression)', () => {
    Object.defineProperty(process.stdout, "isTTY", {
      value: false,
      writable: true,
      configurable: true,
    });

    renderDestroyScheduled(new Date("2026-05-04T00:00:00Z"), "$0.40/mo");

    // The whole point of D-21/D-25: never claim "Resource destroyed."
    // for a resource that is merely PendingDeletion.
    expect(stdoutOutput).not.toContain("Resource destroyed");
    expect(stdoutOutput).toContain("Scheduled for deletion on 2026-05-04");
    expect(stdoutOutput).toContain("$0.40/mo");
  });

  it("handles free-tier / no-cost secrets with a plain cost label", () => {
    Object.defineProperty(process.stdout, "isTTY", {
      value: false,
      writable: true,
      configurable: true,
    });

    // Real-world shape: getCostSavingsEstimate returns "(cost data unavailable)"
    // when the billing MCP cannot find a matching line item. The
    // scheduled-deletion line must still format correctly.
    renderDestroyScheduled(
      new Date("2026-04-30T00:00:00Z"),
      "(cost data unavailable)",
    );

    expect(stdoutOutput).toBe(
      "Scheduled for deletion on 2026-04-30. Estimated savings after deletion: (cost data unavailable)\n",
    );
  });

  it("date portion is UTC-date-only regardless of local timezone offset", () => {
    // `toISOString()` is always UTC, so two dates that fall on different
    // local days but the same UTC day must both render to the same string.
    Object.defineProperty(process.stdout, "isTTY", {
      value: false,
      writable: true,
      configurable: true,
    });

    const scheduledEarly = new Date("2026-06-15T00:00:01Z");
    renderDestroyScheduled(scheduledEarly, "$2.50/mo");
    expect(stdoutOutput).toContain("Scheduled for deletion on 2026-06-15");
    stdoutOutput = "";

    const scheduledLate = new Date("2026-06-15T23:59:59Z");
    renderDestroyScheduled(scheduledLate, "$2.50/mo");
    expect(stdoutOutput).toContain("Scheduled for deletion on 2026-06-15");
  });
});
