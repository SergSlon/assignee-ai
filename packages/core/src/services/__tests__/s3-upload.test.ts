import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ── Mock AWS SDK ────────────────────────────────────────────────────────────
// NOTE: S3Client kept as vi.fn so the per-suite beforeEach below can re-install
// its implementation; the command constructors are plain functions because
// they have no call assertions.
vi.mock("@aws-sdk/client-s3", () => {
  function PutObjectCommand(input: unknown) {
    return input;
  }
  function PutBucketPolicyCommand(input: unknown) {
    return input;
  }
  return {
    S3Client: vi.fn(),
    PutObjectCommand,
    PutBucketPolicyCommand,
  };
});

// Snapshot env so per-suite credential mutations don't leak between tests
const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  // s3-upload now uses requireAssigneeCredentials("operator") from
  // @assignee/core. Tests must set the operator env vars or expect a
  // MissingAssigneeCredentialsError. Use realistic-shaped IAM-like values.
  process.env["ASSIGNEE_OPERATOR_ACCESS_KEY_ID"] = "AKIAIOSFODNN7EXAMPLE";
  process.env["ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY"] =
    "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
  // L-A10: createS3Client now requires an explicit region (no us-east-1
  // silent fallback). Default tests run in us-east-1 unless overridden.
  process.env["AWS_REGION"] = "us-east-1";
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

import {
  getMimeType,
  collectFiles,
  uploadStaticSite,
  configureBucketPolicy,
} from "../s3-upload.js";
import type { UploadProgress } from "../s3-upload.js";
import { MissingAssigneeCredentialsError } from "../../config/aws-credentials.js";

// ── collectFiles ────────────────────────────────────────────────────────────
describe("collectFiles", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "s3-upload-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("collects files from a flat directory", () => {
    writeFileSync(join(tmpDir, "index.html"), "<h1>hello</h1>");
    writeFileSync(join(tmpDir, "style.css"), "body {}");

    const files = collectFiles(tmpDir);
    expect(files).toHaveLength(2);
    expect(files.sort()).toEqual(
      [join(tmpDir, "index.html"), join(tmpDir, "style.css")].sort(),
    );
  });

  it("collects files from nested directories", () => {
    mkdirSync(join(tmpDir, "css"));
    mkdirSync(join(tmpDir, "js"));
    mkdirSync(join(tmpDir, "img", "icons"), { recursive: true });

    writeFileSync(join(tmpDir, "index.html"), "<h1>hello</h1>");
    writeFileSync(join(tmpDir, "css", "app.css"), "body {}");
    writeFileSync(join(tmpDir, "js", "app.js"), "console.log('hi')");
    writeFileSync(join(tmpDir, "img", "logo.png"), "fake-png");
    writeFileSync(join(tmpDir, "img", "icons", "favicon.ico"), "fake-ico");

    const files = collectFiles(tmpDir);
    expect(files).toHaveLength(5);
    expect(files).toContain(join(tmpDir, "index.html"));
    expect(files).toContain(join(tmpDir, "css", "app.css"));
    expect(files).toContain(join(tmpDir, "js", "app.js"));
    expect(files).toContain(join(tmpDir, "img", "logo.png"));
    expect(files).toContain(join(tmpDir, "img", "icons", "favicon.ico"));
  });

  it("returns empty array for empty directory", () => {
    expect(collectFiles(tmpDir)).toEqual([]);
  });
});

// ── getMimeType ─────────────────────────────────────────────────────────────
describe("getMimeType", () => {
  it("returns text/html for .html", () => {
    expect(getMimeType("index.html")).toBe("text/html");
  });

  it("returns text/css for .css", () => {
    expect(getMimeType("css/styles.css")).toBe("text/css");
  });

  it("returns application/javascript for .js", () => {
    expect(getMimeType("bundle.js")).toBe("application/javascript");
  });

  it("returns application/javascript for .mjs", () => {
    expect(getMimeType("module.mjs")).toBe("application/javascript");
  });

  it("returns image/png for .png", () => {
    expect(getMimeType("logo.png")).toBe("image/png");
  });

  it("returns image/jpeg for .jpg and .jpeg", () => {
    expect(getMimeType("photo.jpg")).toBe("image/jpeg");
    expect(getMimeType("photo.jpeg")).toBe("image/jpeg");
  });

  it("returns image/svg+xml for .svg", () => {
    expect(getMimeType("icon.svg")).toBe("image/svg+xml");
  });

  it("returns font/woff2 for .woff2", () => {
    expect(getMimeType("font.woff2")).toBe("font/woff2");
  });

  it("returns application/manifest+json for .webmanifest", () => {
    expect(getMimeType("site.webmanifest")).toBe("application/manifest+json");
  });

  it("returns application/octet-stream for unknown extensions", () => {
    expect(getMimeType("file.xyz")).toBe("application/octet-stream");
  });

  it("handles uppercase extensions via lowercase normalization", () => {
    expect(getMimeType("file.HTML")).toBe("text/html");
    expect(getMimeType("image.PNG")).toBe("image/png");
  });
});

// ── uploadStaticSite ────────────────────────────────────────────────────────
describe("uploadStaticSite", () => {
  let tmpDir: string;
  let mockSend: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "s3-upload-test-"));

    // Reset mock to get a fresh send function. Real PutObjectCommand
    // response shape: { ETag, VersionId, ServerSideEncryption, $metadata }.
    // Tests don't read any of these off the result, but a realistic shape
    // keeps the mock honest against the production SDK contract.
    const { S3Client } = await import("@aws-sdk/client-s3");
    mockSend = vi.fn().mockResolvedValue({
      ETag: '"d41d8cd98f00b204e9800998ecf8427e"',
      VersionId: "null",
      ServerSideEncryption: "AES256",
      $metadata: {
        httpStatusCode: 200,
        requestId: "test-req-s3-put-upload",
        attempts: 1,
        totalRetryDelay: 0,
      },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Partial mock of S3Client for test isolation (only `send` is exercised; full client shape has dozens of internal fields irrelevant to the unit under test)
    vi.mocked(S3Client).mockImplementation(() => ({ send: mockSend }) as any);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("uploads all files with correct keys and content types", async () => {
    mkdirSync(join(tmpDir, "css"));
    writeFileSync(join(tmpDir, "index.html"), "<h1>hello</h1>");
    writeFileSync(join(tmpDir, "css", "styles.css"), "body {}");

    const result = await uploadStaticSite("my-bucket", tmpDir);

    expect(result.uploaded).toBe(2);
    expect(result.failed).toBe(0);
    expect(result.totalBytes).toBeGreaterThan(0);
    expect(result.errors).toEqual([]);
    expect(mockSend).toHaveBeenCalledTimes(2);

    // Verify PutObjectCommand inputs
    type PutObjectInput = {
      Bucket?: string;
      Key?: string;
      ContentType?: string;
    };
    const calls = mockSend.mock.calls.map(
      (c: unknown[]) => c[0] as PutObjectInput,
    );
    const keys = calls.map((c) => c.Key).sort();
    expect(keys).toEqual(["css/styles.css", "index.html"]);

    const htmlCall = calls.find((c) => c.Key === "index.html")!;
    expect(htmlCall.Bucket).toBe("my-bucket");
    expect(htmlCall.ContentType).toBe("text/html");

    const cssCall = calls.find((c) => c.Key === "css/styles.css")!;
    expect(cssCall.ContentType).toBe("text/css");
  });

  it("continues uploading when one file fails", async () => {
    writeFileSync(join(tmpDir, "good.html"), "<h1>ok</h1>");
    writeFileSync(join(tmpDir, "bad.js"), "fail");
    writeFileSync(join(tmpDir, "also-good.css"), "body {}");

    // Fail only the second call
    mockSend
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error("Access Denied"))
      .mockResolvedValueOnce({});

    const result = await uploadStaticSite("my-bucket", tmpDir);

    expect(result.uploaded).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.error).toBe("Access Denied");
    // All three files were attempted
    expect(mockSend).toHaveBeenCalledTimes(3);
  });

  it("invokes progress callback for each file", async () => {
    writeFileSync(join(tmpDir, "a.html"), "a");
    writeFileSync(join(tmpDir, "b.css"), "b");

    const progressCalls: UploadProgress[] = [];
    await uploadStaticSite("my-bucket", tmpDir, {
      onProgress: (p) => progressCalls.push({ ...p }),
    });

    expect(progressCalls).toHaveLength(2);
    expect(progressCalls[0]!.current).toBe(1);
    expect(progressCalls[0]!.total).toBe(2);
    expect(progressCalls[1]!.current).toBe(2);
    expect(progressCalls[1]!.total).toBe(2);
  });

  it("returns zero counts for empty directory", async () => {
    const result = await uploadStaticSite("my-bucket", tmpDir);

    expect(result.uploaded).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.totalBytes).toBe(0);
    expect(result.errors).toEqual([]);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("passes region override to S3Client", async () => {
    writeFileSync(join(tmpDir, "index.html"), "hi");

    const { S3Client } = await import("@aws-sdk/client-s3");

    await uploadStaticSite("my-bucket", tmpDir, { region: "eu-west-1" });

    expect(S3Client).toHaveBeenCalledWith(
      expect.objectContaining({ region: "eu-west-1" }),
    );
  });

  // L-A10 regression: a previous refactor removed the AWS_REGION validation,
  // so when neither an override nor process.env.AWS_REGION was set the SDK
  // silently defaulted to us-east-1. createS3Client now throws
  // ConfigurationError so misconfiguration fails fast.
  it("throws ConfigurationError when AWS_REGION is missing and no override given", async () => {
    delete process.env["AWS_REGION"];
    writeFileSync(join(tmpDir, "index.html"), "hi");

    const { ConfigurationError } = await import("../../errors.js");
    await expect(uploadStaticSite("my-bucket", tmpDir)).rejects.toThrow(
      ConfigurationError,
    );
    await expect(uploadStaticSite("my-bucket", tmpDir)).rejects.toThrow(
      /AWS_REGION is missing or empty/,
    );
  });

  it("throws ConfigurationError when AWS_REGION is empty string and no override given", async () => {
    process.env["AWS_REGION"] = "";
    writeFileSync(join(tmpDir, "index.html"), "hi");

    const { ConfigurationError } = await import("../../errors.js");
    await expect(uploadStaticSite("my-bucket", tmpDir)).rejects.toThrow(
      ConfigurationError,
    );
  });

  it("uses process.env.AWS_REGION when no override is given", async () => {
    process.env["AWS_REGION"] = "ap-southeast-2";
    writeFileSync(join(tmpDir, "index.html"), "hi");
    const { S3Client } = await import("@aws-sdk/client-s3");

    await uploadStaticSite("my-bucket", tmpDir);

    expect(S3Client).toHaveBeenCalledWith(
      expect.objectContaining({ region: "ap-southeast-2" }),
    );
  });
});

// ── configureBucketPolicy ──────────────────────────────────────────────────
describe("configureBucketPolicy", () => {
  let mockSend: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    // PutBucketPolicyCommand is an empty-success command — the real SDK
    // response carries only $metadata. Use the realistic shape.
    const { S3Client } = await import("@aws-sdk/client-s3");
    mockSend = vi.fn().mockResolvedValue({
      $metadata: {
        httpStatusCode: 200,
        requestId: "test-req-s3-put-bucket-policy",
        attempts: 1,
        totalRetryDelay: 0,
      },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Partial mock of S3Client for test isolation (only `send` is exercised; full client shape has dozens of internal fields irrelevant to the unit under test)
    vi.mocked(S3Client).mockImplementation(() => ({ send: mockSend }) as any);
  });

  it("calls PutBucketPolicyCommand with correct bucket name", async () => {
    await configureBucketPolicy("my-website-bucket");

    expect(mockSend).toHaveBeenCalledTimes(1);
    const cmd = mockSend.mock.calls[0]![0];
    expect(cmd.Bucket).toBe("my-website-bucket");
  });

  it("policy JSON has correct Statement structure", async () => {
    await configureBucketPolicy("test-static-site");

    const cmd = mockSend.mock.calls[0]![0];
    const policy = JSON.parse(cmd.Policy);

    expect(policy.Version).toBe("2012-10-17");
    expect(policy.Statement).toHaveLength(1);

    const stmt = policy.Statement[0];
    expect(stmt.Principal).toBe("*");
    expect(stmt.Action).toBe("s3:GetObject");
    expect(stmt.Resource).toBe("arn:aws:s3:::test-static-site/*");
    expect(stmt.Effect).toBe("Allow");
  });
});

// ── Fail-closed credential enforcement ─────────────────────────────────────
// Both s3-upload entrypoints must throw MissingAssigneeCredentialsError when
// the operator env vars are unset, and must NEVER fall through to
// ~/.aws/credentials, SSO sessions, or instance metadata even if shell
// AWS_* vars are populated.
describe("s3-upload fail-closed credential enforcement", () => {
  let mockSend: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    delete process.env["ASSIGNEE_OPERATOR_ACCESS_KEY_ID"];
    delete process.env["ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY"];
    // Belt-and-suspenders: shell AWS_* must NOT be honored
    process.env["AWS_ACCESS_KEY_ID"] = "shell-leak-key";
    process.env["AWS_SECRET_ACCESS_KEY"] = "shell-leak-secret";

    // These tests all assert mockSend was NEVER called (fail-closed before
    // any SDK roundtrip), so the resolved value is belt-and-suspenders. A
    // realistic PutObjectCommand shape (the most-likely command to leak)
    // makes the mock honest if the guard ever regresses.
    const { S3Client } = await import("@aws-sdk/client-s3");
    mockSend = vi.fn().mockResolvedValue({
      ETag: '"d41d8cd98f00b204e9800998ecf8427e"',
      VersionId: "null",
      ServerSideEncryption: "AES256",
      $metadata: {
        httpStatusCode: 200,
        requestId: "test-req-s3-failclosed-should-not-run",
        attempts: 1,
        totalRetryDelay: 0,
      },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Partial mock of S3Client for test isolation (only `send` is exercised; full client shape has dozens of internal fields irrelevant to the unit under test)
    vi.mocked(S3Client).mockImplementation(() => ({ send: mockSend }) as any);
  });

  it("configureBucketPolicy throws MissingAssigneeCredentialsError", async () => {
    await expect(
      configureBucketPolicy("my-website-bucket"),
    ).rejects.toBeInstanceOf(MissingAssigneeCredentialsError);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("uploadStaticSite throws MissingAssigneeCredentialsError before any upload", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "s3-upload-failclosed-"));
    try {
      writeFileSync(join(tmpDir, "index.html"), "<h1>hi</h1>");
      await expect(
        uploadStaticSite("my-bucket", tmpDir),
      ).rejects.toBeInstanceOf(MissingAssigneeCredentialsError);
      expect(mockSend).not.toHaveBeenCalled();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("error message names the exact missing env vars", async () => {
    try {
      await configureBucketPolicy("any-bucket");
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(MissingAssigneeCredentialsError);
      const msg = (err as Error).message;
      expect(msg).toContain("ASSIGNEE_OPERATOR_ACCESS_KEY_ID");
      expect(msg).toContain("ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY");
    }
  });
});
