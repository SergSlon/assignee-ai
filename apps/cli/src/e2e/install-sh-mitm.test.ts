/**
 * W7-02: install.sh MITM / tamper fixture
 *
 * Simulates a byte-tampering attack mid-stream against install.sh and asserts
 * that the SHA256 verification step causes the installer to abort rather than
 * install the tampered binary.
 *
 * Gate: RUN_INSTALL_MITM_FIXTURE=1
 * Why gated: the test requires a local copy of install.sh, a real sh interpreter,
 * and writes temp files to the filesystem. It is intentionally excluded from
 * the default `pnpm test` run to avoid side effects on developer machines.
 *
 * To run:
 *   RUN_INSTALL_MITM_FIXTURE=1 pnpm vitest run apps/cli/src/e2e/install-sh-mitm.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync, spawnSync } from "child_process";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from "fs";
import { join, resolve } from "path";
import { tmpdir } from "os";
import { createHash } from "crypto";

const ENABLED = process.env["RUN_INSTALL_MITM_FIXTURE"] === "1";
const REPO_ROOT = resolve(import.meta.dirname, "../../../../..");
const INSTALL_SH = join(REPO_ROOT, "scripts/install.sh");

// Placeholder version that matches the manifest placeholder
const TEST_VERSION = "v0.0.0-mitm-test";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function sha256(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function createFakeTarball(content: string): Buffer {
  // Create a minimal tar.gz containing a fake "assignee" binary
  // We use a base64-encoded minimal tar.gz for portability
  // (avoids spawning tar in the test setup)
  const fakeContent = Buffer.from(content, "utf8");
  return fakeContent; // tests use file SHA, not actual tar extraction
}

/**
 * Creates a local HTTP server stub that serves a tampered tarball.
 * Returns the tampered content and its real SHA256.
 */
function buildMitmScenario(
  dir: string,
  legitContent: string,
): {
  legitSha: string;
  tamperedContent: string;
  tamperedSha: string;
  manifestPath: string;
} {
  const legitSha = sha256(legitContent);

  // Tampered content differs by one byte
  const tamperedContent = legitContent.slice(0, -5) + "XHACK";
  const tamperedSha = sha256(tamperedContent);

  // Write a manifest that knows the legit SHA (not the tampered one)
  const manifest = {
    version: TEST_VERSION,
    generated: new Date().toISOString(),
    minimum_version: "0.0.1",
    entries: [
      {
        filename: `assignee-${TEST_VERSION}-linux-x64.tar.gz`,
        sha256: legitSha,
        version: TEST_VERSION,
      },
      {
        filename: `assignee-${TEST_VERSION}-darwin-arm64.tar.gz`,
        sha256: legitSha,
        version: TEST_VERSION,
      },
      {
        filename: `assignee-${TEST_VERSION}-darwin-x64.tar.gz`,
        sha256: legitSha,
        version: TEST_VERSION,
      },
    ],
  };

  const manifestPath = join(dir, "release-manifest.signed.json");
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  return { legitSha, tamperedContent, tamperedSha, manifestPath };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(!ENABLED)("install.sh — MITM / tamper detection", () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "assignee-mitm-test-"));
  });

  afterAll(() => {
    execSync(`rm -rf "${tmpDir}"`);
  });

  it("SHA256 mismatch causes install.sh to abort with non-zero exit", () => {
    const { tamperedContent, manifestPath } = buildMitmScenario(
      tmpDir,
      "legitimate tarball content",
    );

    // Write the tampered file where install.sh would expect it
    const tarballDir = join(tmpDir, "download");
    mkdirSync(tarballDir, { recursive: true });
    const tarballPath = join(
      tarballDir,
      `assignee-${TEST_VERSION}-linux-x64.tar.gz`,
    );
    writeFileSync(tarballPath, tamperedContent);

    // Patch install.sh to:
    // 1. Use our local manifest (instead of fetching from GitHub)
    // 2. Use the pre-downloaded tarball (instead of fetching from release)
    // 3. Use our test version
    //
    // We do this by injecting shell overrides via env vars and a wrapper script
    const wrapperScript = join(tmpDir, "install-test-wrapper.sh");
    const installSh = readFileSync(INSTALL_SH, "utf8");

    // Create a patched version of install.sh for testing
    // Replace the manifest fetch and tarball download with local file paths
    const patchedInstallSh = installSh
      .replace(/MANIFEST_URL=.*$/m, `MANIFEST_URL="file://${manifestPath}"`)
      .replace(
        // Override the curl download to copy the tampered file instead
        /info "Downloading \${URL}\.\.\."\s*\ncurl -sSL -o "\${TMPDIR}\/\${TARBALL}" "\$URL"/,
        `info "Using test tarball (MITM simulation)..."
  cp "${tarballPath}" "\${TMPDIR}/\${TARBALL}"`,
      )
      // Force test version so we don't hit GitHub API
      .replace(
        /VERSION="\${ASSIGNEE_VERSION:-}"\s*\n\s*if \[ -z "\$VERSION" \]; then/,
        `VERSION="${TEST_VERSION}"
  if [ -z "" ]; then`,
      );

    writeFileSync(wrapperScript, patchedInstallSh);
    execSync(`chmod +x "${wrapperScript}"`);

    const result = spawnSync("sh", [wrapperScript], {
      env: {
        ...process.env,
        ASSIGNEE_VERSION: TEST_VERSION,
        ASSIGNEE_INSTALL_DIR: join(tmpDir, "bin"),
        HOME: tmpDir,
      },
      timeout: 30000,
    });

    const stdout = result.stdout?.toString() ?? "";
    const stderr = result.stderr?.toString() ?? "";
    const output = stdout + stderr;

    // The installer must exit non-zero when SHA256 mismatches
    expect(result.status).not.toBe(0);

    // The error message must mention SHA256 mismatch
    expect(output).toMatch(/SHA256 mismatch/i);

    // The installer must NOT have installed the binary
    const binPath = join(tmpDir, "bin", "assignee");
    try {
      execSync(`test ! -f "${binPath}"`);
    } catch {
      throw new Error(
        `install.sh installed the tampered binary despite SHA256 mismatch! Path: ${binPath}`,
      );
    }
  });

  it("SHA256 match allows install.sh to proceed past the verification step", () => {
    const legitContent = "legitimate tarball content v2";
    const { legitSha, manifestPath } = buildMitmScenario(tmpDir, legitContent);

    // Write the LEGIT file (not tampered)
    const tarballDir = join(tmpDir, "download2");
    mkdirSync(tarballDir, { recursive: true });
    const tarballPath = join(
      tarballDir,
      `assignee-${TEST_VERSION}-linux-x64.tar.gz`,
    );
    writeFileSync(tarballPath, legitContent);

    const installSh = readFileSync(INSTALL_SH, "utf8");

    // Patch manifest URL and download step; also patch verify_install to skip
    // the actual binary invocation (the "tarball" is just a text file in this test)
    const patchedInstallSh = installSh
      .replace(/MANIFEST_URL=.*$/m, `MANIFEST_URL="file://${manifestPath}"`)
      .replace(
        /info "Downloading \${URL}\.\.\."\s*\ncurl -sSL -o "\${TMPDIR}\/\${TARBALL}" "\$URL"/,
        `info "Using legit test tarball..."
  cp "${tarballPath}" "\${TMPDIR}/\${TARBALL}"`,
      )
      .replace(
        /VERSION="\${ASSIGNEE_VERSION:-}"\s*\n\s*if \[ -z "\$VERSION" \]; then/,
        `VERSION="${TEST_VERSION}"
  if [ -z "" ]; then`,
      )
      // Skip verify_install (the fake tarball has no actual binary)
      .replace(/verify_install$/m, "# verify_install skipped in test mode");

    const wrapperScript2 = join(tmpDir, "install-test-legit-wrapper.sh");
    writeFileSync(wrapperScript2, patchedInstallSh);
    execSync(`chmod +x "${wrapperScript2}"`);

    const result = spawnSync("sh", [wrapperScript2], {
      env: {
        ...process.env,
        ASSIGNEE_VERSION: TEST_VERSION,
        ASSIGNEE_INSTALL_DIR: join(tmpDir, "bin2"),
        HOME: tmpDir,
      },
      timeout: 30000,
    });

    const stdout = result.stdout?.toString() ?? "";
    const stderr = result.stderr?.toString() ?? "";
    const output = stdout + stderr;

    // With a matching SHA256, the script should pass the verification step
    // (it may fail later trying to extract or run the fake tarball, but
    // it must not fail on SHA256 mismatch)
    expect(output).toMatch(/SHA256 verified/i);
    expect(output).not.toMatch(/SHA256 mismatch/i);
  });

  it("version not in allowlist causes install.sh to abort when ASSIGNEE_DOWNGRADE_ACK is unset", () => {
    const { manifestPath } = buildMitmScenario(tmpDir, "tarball content");

    const installSh = readFileSync(INSTALL_SH, "utf8");
    const UNKNOWN_VERSION = "v9.9.9-unknown";

    const patchedInstallSh = installSh
      .replace(/MANIFEST_URL=.*$/m, `MANIFEST_URL="file://${manifestPath}"`)
      .replace(
        /VERSION="\${ASSIGNEE_VERSION:-}"\s*\n\s*if \[ -z "\$VERSION" \]; then/,
        `VERSION="${UNKNOWN_VERSION}"
  if [ -z "" ]; then`,
      );

    const wrapperScript3 = join(tmpDir, "install-test-unknown-version.sh");
    writeFileSync(wrapperScript3, patchedInstallSh);
    execSync(`chmod +x "${wrapperScript3}"`);

    const result = spawnSync("sh", [wrapperScript3], {
      env: {
        ...process.env,
        ASSIGNEE_VERSION: UNKNOWN_VERSION,
        ASSIGNEE_INSTALL_DIR: join(tmpDir, "bin3"),
        HOME: tmpDir,
        // Deliberately NOT setting ASSIGNEE_DOWNGRADE_ACK
      },
      timeout: 30000,
    });

    const stdout = result.stdout?.toString() ?? "";
    const stderr = result.stderr?.toString() ?? "";
    const output = stdout + stderr;

    // Must abort with non-zero exit
    expect(result.status).not.toBe(0);

    // Must mention the allowlist rejection
    expect(output).toMatch(/not in the release allowlist/i);
  });

  it("ASSIGNEE_DOWNGRADE_ACK=1 bypasses the allowlist check with a warning", () => {
    const { manifestPath } = buildMitmScenario(tmpDir, "tarball content");

    const installSh = readFileSync(INSTALL_SH, "utf8");
    const UNKNOWN_VERSION = "v9.9.9-unknown";

    const patchedInstallSh = installSh
      .replace(/MANIFEST_URL=.*$/m, `MANIFEST_URL="file://${manifestPath}"`)
      .replace(
        /VERSION="\${ASSIGNEE_VERSION:-}"\s*\n\s*if \[ -z "\$VERSION" \]; then/,
        `VERSION="${UNKNOWN_VERSION}"
  if [ -z "" ]; then`,
      )
      // Skip download + verify_install so the test completes
      .replace(
        /download_and_install$/m,
        "# download_and_install skipped in test mode",
      )
      .replace(/verify_install$/m, "# verify_install skipped in test mode");

    const wrapperScript4 = join(tmpDir, "install-test-downgrade-ack.sh");
    writeFileSync(wrapperScript4, patchedInstallSh);
    execSync(`chmod +x "${wrapperScript4}"`);

    const result = spawnSync("sh", [wrapperScript4], {
      env: {
        ...process.env,
        ASSIGNEE_VERSION: UNKNOWN_VERSION,
        ASSIGNEE_INSTALL_DIR: join(tmpDir, "bin4"),
        ASSIGNEE_DOWNGRADE_ACK: "1",
        HOME: tmpDir,
      },
      timeout: 30000,
    });

    const stdout = result.stdout?.toString() ?? "";
    const stderr = result.stderr?.toString() ?? "";
    const output = stdout + stderr;

    // Must NOT abort due to the allowlist (DOWNGRADE_ACK bypasses it)
    expect(output).not.toMatch(/not in the release allowlist/i);

    // Must emit a warning about bypassing the allowlist
    expect(output).toMatch(/ASSIGNEE_DOWNGRADE_ACK/i);
  });
});
