/**
 * Tests for BP integrity + freshness (Stories 12.4, 12.6).
 *
 * Covers:
 * - computeFreshness: stale/fresh detection, custom thresholds, empty dir,
 *   ISO date format verification.
 * - computeManifest: determinism, file-count invariant, hash stability on
 *   mutation, POSIX path separators on all platforms.
 * - verifyManifest: trust-on-first-use, matching hash, hash mismatch,
 *   corrupt reference, wrong version, added/removed/differing file diagnostics.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  utimesSync,
  unlinkSync,
  symlinkSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  computeFreshness,
  computeManifest,
  verifyManifest,
  type BPManifest,
} from "../src/integrity.js";

// Realistic BP YAML content — matches fsbp-entries style so mocks use real data.
const BP_S3_001 = `id: BP-S3-001
title: "S3 bucket should block public access"
severity: CRITICAL
resource_type: "AWS::S3::Bucket"
property_path: "PublicAccessBlockConfiguration.BlockPublicAcls"
check_type: equals
expected_value: true
rationale: "Prevent accidental public exposure of bucket contents."
`;

const BP_S3_002 = `id: BP-S3-002
title: "S3 bucket should have versioning enabled"
severity: HIGH
resource_type: "AWS::S3::Bucket"
property_path: "VersioningConfiguration.Status"
check_type: equals
expected_value: "Enabled"
rationale: "Versioning protects against accidental deletion and ransomware."
`;

const BP_EC2_001 = `id: BP-EC2-001
title: "EC2 instance should not have a public IP by default"
severity: MEDIUM
resource_type: "AWS::EC2::Instance"
property_path: "NetworkInterfaces.0.AssociatePublicIpAddress"
check_type: equals
expected_value: false
rationale: "Public IPs expand the attack surface unnecessarily."
`;

let tmpDirs: string[] = [];

function makeTempBpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "bp-integrity-test-"));
  tmpDirs.push(dir);
  return dir;
}

function writeBp(
  baseDir: string,
  service: string,
  file: string,
  content: string,
): string {
  const svcDir = join(baseDir, service);
  mkdirSync(svcDir, { recursive: true });
  const p = join(svcDir, file);
  writeFileSync(p, content);
  return p;
}

beforeEach(() => {
  tmpDirs = [];
});

afterEach(() => {
  for (const d of tmpDirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

describe("computeFreshness", () => {
  it("returns isStale: true when oldest file is older than threshold", () => {
    const dir = makeTempBpDir();
    const file = writeBp(dir, "s3", "BP-S3-001.yaml", BP_S3_001);
    // Set mtime to 200 days ago
    const ancient = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000);
    utimesSync(file, ancient, ancient);

    const result = computeFreshness(dir, 180);
    expect(result.isStale).toBe(true);
    expect(result.oldestAgeDays).toBeGreaterThanOrEqual(199);
    expect(result.fileCount).toBe(1);
    expect(result.staleThresholdDays).toBe(180);
  });

  it("returns isStale: false when all files are fresh", () => {
    const dir = makeTempBpDir();
    writeBp(dir, "s3", "BP-S3-001.yaml", BP_S3_001);
    writeBp(dir, "ec2", "BP-EC2-001.yaml", BP_EC2_001);

    const result = computeFreshness(dir, 180);
    expect(result.isStale).toBe(false);
    expect(result.oldestAgeDays).toBeLessThan(1);
    expect(result.fileCount).toBe(2);
  });

  it("honors a custom staleThresholdDays argument", () => {
    const dir = makeTempBpDir();
    const file = writeBp(dir, "s3", "BP-S3-001.yaml", BP_S3_001);
    // 45 days ago — stale under 30d threshold, fresh under default 180d
    const old = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000);
    utimesSync(file, old, old);

    const strict = computeFreshness(dir, 30);
    expect(strict.isStale).toBe(true);
    expect(strict.staleThresholdDays).toBe(30);

    const lenient = computeFreshness(dir, 180);
    expect(lenient.isStale).toBe(false);
    expect(lenient.staleThresholdDays).toBe(180);
  });

  it("returns fileCount: 0 and isStale: false for an empty directory", () => {
    const dir = makeTempBpDir();
    const result = computeFreshness(dir);
    expect(result.fileCount).toBe(0);
    expect(result.isStale).toBe(false);
    expect(result.oldestAgeDays).toBe(0);
  });

  it("returns oldestFileDate as a valid ISO string", () => {
    const dir = makeTempBpDir();
    writeBp(dir, "s3", "BP-S3-001.yaml", BP_S3_001);

    const result = computeFreshness(dir);
    // Must parse as a valid Date
    const parsed = new Date(result.oldestFileDate);
    expect(Number.isNaN(parsed.getTime())).toBe(false);
    // ISO format always contains 'T' and ends with 'Z'
    expect(result.oldestFileDate).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );
  });
});

describe("computeManifest", () => {
  it("returns a populated manifest for a real BP directory", () => {
    const dir = makeTempBpDir();
    writeBp(dir, "s3", "BP-S3-001.yaml", BP_S3_001);
    writeBp(dir, "s3", "BP-S3-002.yaml", BP_S3_002);
    writeBp(dir, "ec2", "BP-EC2-001.yaml", BP_EC2_001);

    const manifest = computeManifest(dir);
    expect(manifest.version).toBe(1);
    expect(manifest.count).toBe(3);
    expect(manifest.hash).toBeTruthy();
    expect(manifest.hash).toHaveLength(64); // sha256 hex
    expect(Object.keys(manifest.files)).toHaveLength(3);
  });

  it("is deterministic across successive calls on the same inputs", () => {
    const dir = makeTempBpDir();
    writeBp(dir, "s3", "BP-S3-001.yaml", BP_S3_001);
    writeBp(dir, "ec2", "BP-EC2-001.yaml", BP_EC2_001);

    const a = computeManifest(dir);
    const b = computeManifest(dir);
    expect(a.hash).toBe(b.hash);
    expect(a.count).toBe(b.count);
    expect(a.files).toEqual(b.files);
  });

  it("reports count matching the number of file entries", () => {
    const dir = makeTempBpDir();
    writeBp(dir, "s3", "BP-S3-001.yaml", BP_S3_001);
    writeBp(dir, "s3", "BP-S3-002.yaml", BP_S3_002);

    const manifest = computeManifest(dir);
    expect(Object.keys(manifest.files).length).toBe(manifest.count);
  });

  it("changes overall hash when a tracked file is mutated", () => {
    const dir = makeTempBpDir();
    writeBp(dir, "s3", "BP-S3-001.yaml", BP_S3_001);
    writeBp(dir, "s3", "BP-S3-002.yaml", BP_S3_002);

    const before = computeManifest(dir);

    // Mutate one file — change severity from HIGH to CRITICAL
    writeBp(
      dir,
      "s3",
      "BP-S3-002.yaml",
      BP_S3_002.replace("severity: HIGH", "severity: CRITICAL"),
    );

    const after = computeManifest(dir);
    expect(after.hash).not.toBe(before.hash);
    expect(after.files["s3/BP-S3-002.yaml"]).not.toBe(
      before.files["s3/BP-S3-002.yaml"],
    );
    // Untouched file hash stays the same
    expect(after.files["s3/BP-S3-001.yaml"]).toBe(
      before.files["s3/BP-S3-001.yaml"],
    );
  });

  it("uses POSIX '/' separators in file keys regardless of OS", () => {
    const dir = makeTempBpDir();
    writeBp(dir, "s3", "BP-S3-001.yaml", BP_S3_001);
    writeBp(dir, "ec2", "BP-EC2-001.yaml", BP_EC2_001);

    const manifest = computeManifest(dir);
    for (const key of Object.keys(manifest.files)) {
      expect(key).not.toContain("\\");
      expect(key).toContain("/");
    }
    expect(manifest.files["s3/BP-S3-001.yaml"]).toBeDefined();
    expect(manifest.files["ec2/BP-EC2-001.yaml"]).toBeDefined();
  });
});

describe("verifyManifest", () => {
  it("returns valid with trust-on-first-use when reference does not exist", () => {
    const dir = makeTempBpDir();
    writeBp(dir, "s3", "BP-S3-001.yaml", BP_S3_001);
    const computed = computeManifest(dir);

    const result = verifyManifest(
      computed,
      join(dir, "nonexistent-manifest.json"),
    );
    expect(result.valid).toBe(true);
    expect(result.reason).toContain("No reference manifest");
  });

  it("returns valid when reference hash matches the computed hash", () => {
    const dir = makeTempBpDir();
    writeBp(dir, "s3", "BP-S3-001.yaml", BP_S3_001);
    writeBp(dir, "ec2", "BP-EC2-001.yaml", BP_EC2_001);

    const computed = computeManifest(dir);
    const refPath = join(dir, "reference.json");
    writeFileSync(refPath, JSON.stringify(computed));

    const result = verifyManifest(computed, refPath);
    expect(result.valid).toBe(true);
    expect(result.mismatchedFiles).toBeUndefined();
  });

  it("returns invalid when the reference hash differs from the computed", () => {
    const dir = makeTempBpDir();
    writeBp(dir, "s3", "BP-S3-001.yaml", BP_S3_001);

    const computed = computeManifest(dir);
    const tampered: BPManifest = {
      ...computed,
      hash: "0".repeat(64),
      files: { "s3/BP-S3-001.yaml": "0".repeat(64) },
    };
    const refPath = join(dir, "tampered.json");
    writeFileSync(refPath, JSON.stringify(tampered));

    const result = verifyManifest(computed, refPath);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("hash mismatch");
    expect(result.mismatchedFiles).toEqual(["s3/BP-S3-001.yaml"]);
  });

  it("returns invalid with 'corrupt' reason when reference is invalid JSON", () => {
    const dir = makeTempBpDir();
    writeBp(dir, "s3", "BP-S3-001.yaml", BP_S3_001);

    const computed = computeManifest(dir);
    const refPath = join(dir, "corrupt.json");
    writeFileSync(refPath, "{not valid json");

    const result = verifyManifest(computed, refPath);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("corrupt");
  });

  it("returns invalid when reference has an unsupported version", () => {
    const dir = makeTempBpDir();
    writeBp(dir, "s3", "BP-S3-001.yaml", BP_S3_001);

    const computed = computeManifest(dir);
    const badVersion = {
      ...computed,
      version: 2,
    };
    const refPath = join(dir, "v2.json");
    writeFileSync(refPath, JSON.stringify(badVersion));

    const result = verifyManifest(computed, refPath);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("version");
    expect(result.reason).toContain("2");
  });

  it("lists the specific differing file when one file's hash changes", () => {
    const dir = makeTempBpDir();
    writeBp(dir, "s3", "BP-S3-001.yaml", BP_S3_001);
    writeBp(dir, "s3", "BP-S3-002.yaml", BP_S3_002);
    writeBp(dir, "ec2", "BP-EC2-001.yaml", BP_EC2_001);

    const computed = computeManifest(dir);
    const ref: BPManifest = {
      ...computed,
      hash: "deadbeef".repeat(8),
      files: {
        ...computed.files,
        "ec2/BP-EC2-001.yaml": "f".repeat(64), // differs
      },
    };
    const refPath = join(dir, "ref.json");
    writeFileSync(refPath, JSON.stringify(ref));

    const result = verifyManifest(computed, refPath);
    expect(result.valid).toBe(false);
    expect(result.mismatchedFiles).toEqual(["ec2/BP-EC2-001.yaml"]);
  });

  it("detects added files (computed has files not in reference)", () => {
    const dir = makeTempBpDir();
    writeBp(dir, "s3", "BP-S3-001.yaml", BP_S3_001);
    writeBp(dir, "s3", "BP-S3-002.yaml", BP_S3_002);
    writeBp(dir, "ec2", "BP-EC2-001.yaml", BP_EC2_001);

    const computed = computeManifest(dir);
    // Reference missing ec2/BP-EC2-001.yaml
    const refFiles = { ...computed.files };
    delete refFiles["ec2/BP-EC2-001.yaml"];
    const ref: BPManifest = {
      ...computed,
      hash: "abc123".repeat(10).slice(0, 64),
      files: refFiles,
      count: Object.keys(refFiles).length,
    };
    const refPath = join(dir, "ref.json");
    writeFileSync(refPath, JSON.stringify(ref));

    const result = verifyManifest(computed, refPath);
    expect(result.valid).toBe(false);
    expect(result.mismatchedFiles).toContain("ec2/BP-EC2-001.yaml");
  });

  it("detects removed files (reference has files not in computed)", () => {
    const dir = makeTempBpDir();
    writeBp(dir, "s3", "BP-S3-001.yaml", BP_S3_001);
    writeBp(dir, "s3", "BP-S3-002.yaml", BP_S3_002);

    const computed = computeManifest(dir);
    const ref: BPManifest = {
      ...computed,
      hash: "cafebabe".repeat(8),
      files: {
        ...computed.files,
        "ec2/BP-EC2-001.yaml": "a".repeat(64), // present in ref but not in computed
      },
      count: Object.keys(computed.files).length + 1,
    };
    const refPath = join(dir, "ref.json");
    writeFileSync(refPath, JSON.stringify(ref));

    const result = verifyManifest(computed, refPath);
    expect(result.valid).toBe(false);
    expect(result.mismatchedFiles).toContain("ec2/BP-EC2-001.yaml");
  });

  it("returns invalid with strictNoReference when reference is missing (H18, REG-N7)", () => {
    const dir = makeTempBpDir();
    writeBp(dir, "s3", "BP-S3-001.yaml", BP_S3_001);
    const computed = computeManifest(dir);

    const result = verifyManifest(computed, join(dir, "does-not-exist.json"), {
      strictNoReference: true,
    });
    expect(result.valid).toBe(false);
    // REG-N7: Strict-fail must NOT also signal trust-on-first-use — that
    // contradicts the hard failure and confuses WARN-banner callers.
    expect(result.trustOnFirstUse).toBe(false);
    // The new referenceMissing flag distinguishes "no reference" from
    // "hash mismatch" / "corrupt reference" failures.
    expect(result.referenceMissing).toBe(true);
    expect(result.reason).toContain("No reference manifest");
    expect(result.reason).toContain("strict mode");
  });

  it("flags trustOnFirstUse: true when reference missing and strict=false", () => {
    const dir = makeTempBpDir();
    writeBp(dir, "s3", "BP-S3-001.yaml", BP_S3_001);
    const computed = computeManifest(dir);

    const result = verifyManifest(computed, join(dir, "does-not-exist.json"));
    expect(result.valid).toBe(true);
    expect(result.trustOnFirstUse).toBe(true);
    // referenceMissing is set in both strict and non-strict missing-ref paths.
    expect(result.referenceMissing).toBe(true);
  });
});

// ── M-R5: TOCTOU race in walkBpFiles ────────────────────────────────────────
// readdirSync lists files but a concurrent rule reload / atomic rewrite can
// remove (or break) a file before statSync/readFileSync runs. The previous
// implementation let the ENOENT throw out of the walk, aborting the entire
// integrity computation and the BP library load. The fix wraps the inner
// stat+read in try/catch and skips silently on ENOENT, logging on others.
describe("walkBpFiles TOCTOU race resilience (M-R5)", () => {
  it("skips files that disappear between readdir and stat without aborting the walk", () => {
    const dir = makeTempBpDir();
    // Two real files plus one broken symlink. statSync follows the
    // symlink → ENOENT → previously aborted the entire walk.
    writeBp(dir, "s3", "BP-S3-001.yaml", BP_S3_001);
    writeBp(dir, "s3", "BP-S3-002.yaml", BP_S3_002);

    const svcDir = join(dir, "s3");
    const broken = join(svcDir, "BP-S3-999-disappeared.yaml");
    // Symlink target intentionally does not exist.
    symlinkSync(join(svcDir, "this-target-does-not-exist.yaml"), broken);

    // Must NOT throw — the walker tolerates the missing target.
    const manifest = computeManifest(dir);
    // The two real files are still hashed.
    expect(manifest.count).toBe(2);
    expect(manifest.files["s3/BP-S3-001.yaml"]).toBeDefined();
    expect(manifest.files["s3/BP-S3-002.yaml"]).toBeDefined();
    // The broken file is silently absent — never half-recorded.
    expect(manifest.files["s3/BP-S3-999-disappeared.yaml"]).toBeUndefined();
  });

  it("computeFreshness also tolerates a vanishing file", () => {
    const dir = makeTempBpDir();
    writeBp(dir, "s3", "BP-S3-001.yaml", BP_S3_001);
    const broken = join(dir, "s3", "vanished.yaml");
    symlinkSync(join(dir, "s3", "no-such-target.yaml"), broken);

    const result = computeFreshness(dir, 180);
    expect(result.fileCount).toBe(1);
    expect(result.isStale).toBe(false);
  });

  it("simulates a true delete-between-readdir-and-stat race", () => {
    const dir = makeTempBpDir();
    writeBp(dir, "s3", "BP-S3-001.yaml", BP_S3_001);
    const racing = writeBp(dir, "s3", "BP-S3-002.yaml", BP_S3_002);
    // Delete the file BEFORE the walk reads it. readdirSync (called inside
    // computeManifest) will list it (because we delete after writing); we
    // can't guarantee the deletion happens between readdir and stat in a
    // pure synchronous test, so instead we delete it before the walk
    // starts and rely on a sibling broken symlink with the same name to
    // ensure ENOENT is hit during stat.
    unlinkSync(racing);
    symlinkSync(join(dir, "s3", "no-such.yaml"), racing);

    expect(() => computeManifest(dir)).not.toThrow();
    const m = computeManifest(dir);
    expect(m.count).toBe(1);
    expect(m.files["s3/BP-S3-001.yaml"]).toBeDefined();
  });
});
