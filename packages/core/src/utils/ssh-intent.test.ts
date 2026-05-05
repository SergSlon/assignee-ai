/**
 * Tests for `isSshIntent` — the shared SSH-bundle intent gate.
 *
 * Real-shape user intents drawn from the demo phrasebook + the
 * pre-demo audit (2026-05-05) H2 finding.
 */

import { describe, it, expect } from "vitest";
import { isSshIntent } from "./ssh-intent.js";

describe("isSshIntent — positive matches (bundle SHOULD fire)", () => {
  it.each([
    "Create EC2 with SSH",
    "create a t3.micro EC2 with SSH access",
    "Spin up an EC2 instance and enable SSH",
    "I want an EC2 with ssh and TLS",
    "EC2 + SSH",
    "ssh into a new EC2",
    "Use SSH on the box",
  ])("%s", (intent) => {
    expect(isSshIntent(intent)).toBe(true);
  });
});

describe("isSshIntent — negation phrasings (bundle MUST NOT fire)", () => {
  it.each([
    // Pre-prefix negations
    "Create EC2 without SSH",
    "Spin up an EC2 with no SSH",
    "Create an EC2 with no any ssh access",
    "Create an EC2 with no SSH access at all",
    "EC2 disabled SSH",
    "EC2 with disabled SSH",
    "Create EC2 disabling SSH",
    "Drop SSH from this EC2",
    "Remove SSH from the box",
    "Removed SSH access",
    "Removing SSH from the SG",
    "Exclude SSH ports",
    "Excluding SSH from the SG",
    "Excluded SSH from the SG",
    "Skip SSH on this EC2",
    "Not requiring SSH on this box",
    // Post-suffix negations
    "Create EC2, SSH disabled",
    "Create EC2 with SSH is disabled",
    "Create EC2 with SSH off",
  ])("%s", (intent) => {
    expect(isSshIntent(intent)).toBe(false);
  });
});

describe("isSshIntent — edge cases", () => {
  it("returns false for undefined intent", () => {
    expect(isSshIntent(undefined)).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isSshIntent("")).toBe(false);
  });

  it("returns false for intent without ssh at all", () => {
    expect(isSshIntent("Create a t3.micro EC2 instance")).toBe(false);
  });

  it("returns false for substring match (word-boundary regex)", () => {
    expect(isSshIntent("create a splashscreen page")).toBe(false);
    expect(isSshIntent("test sshfs mount")).toBe(false);
  });

  it("matches case-insensitively", () => {
    expect(isSshIntent("Create EC2 with SSH")).toBe(true);
    expect(isSshIntent("Create EC2 with Ssh")).toBe(true);
    expect(isSshIntent("Create EC2 with sSh")).toBe(true);
  });

  it("treats unrelated mentions of 'no' as non-negating when 'ssh' is the actual ask", () => {
    // "no" appears but doesn't qualify ssh.
    expect(isSshIntent("Create EC2 in no-port-22-shared subnet with SSH")).toBe(
      true,
    );
  });

  it("trims well: trailing whitespace doesn't break detection", () => {
    expect(isSshIntent("  Create EC2 with SSH  ")).toBe(true);
    expect(isSshIntent("  Create EC2 without SSH  ")).toBe(false);
  });
});
