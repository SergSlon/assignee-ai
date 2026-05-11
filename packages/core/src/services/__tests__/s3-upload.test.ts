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
    return { _type: "PutObjectCommand", ...(input as object) };
  }
  function PutBucketPolicyCommand(input: unknown) {
    return { _type: "PutBucketPolicyCommand", ...(input as object) };
  }
  function ListObjectsV2Command(input: unknown) {
    return { _type: "ListObjectsV2Command", ...(input as object) };
  }
  function DeleteObjectsCommand(input: unknown) {
    return { _type: "DeleteObjectsCommand", ...(input as object) };
  }
  return {
    S3Client: vi.fn(),
    PutObjectCommand,
    PutBucketPolicyCommand,
    ListObjectsV2Command,
    DeleteObjectsCommand,
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

// ─────────────────────────────────────────────────────────────────────────────
// `assignee update` follow-on: MIME-type expansion (video / audio / markdown)
// ─────────────────────────────────────────────────────────────────────────────
describe("getMimeType — assignee-update MIME expansion", () => {
  // Pure data table. Drives both the unit assertion and (indirectly via
  // import in `uploadStaticSite`) the ContentType S3 will store.
  const TABLE: ReadonlyArray<[string, string]> = [
    ["clip.mp4", "video/mp4"],
    ["clip.webm", "video/webm"],
    ["clip.mov", "video/quicktime"],
    ["clip.m4v", "video/x-m4v"],
    ["song.mp3", "audio/mpeg"],
    ["sample.wav", "audio/wav"],
    ["loop.ogg", "audio/ogg"],
    ["README.md", "text/markdown"],
    // Case-insensitive resolution (existing behaviour, regression guard).
    ["TRAILER.MP4", "video/mp4"],
    ["song.MP3", "audio/mpeg"],
  ];
  for (const [name, expected] of TABLE) {
    it(`maps ${name} → ${expected}`, () => {
      expect(getMimeType(name)).toBe(expected);
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// `assignee update` follow-on: deleteOrphans sweep
// ─────────────────────────────────────────────────────────────────────────────
describe("uploadStaticSite — deleteOrphans", () => {
  let tmpDir: string;
  let mockSend: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "s3-upload-deleteorphans-"));
    const { S3Client } = await import("@aws-sdk/client-s3");
    mockSend = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Partial mock of S3Client; only `send` is exercised
    vi.mocked(S3Client).mockImplementation(() => ({ send: mockSend }) as any);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /**
   * Helper: drive `mockSend` through the PUT/LIST/DELETE call sequence.
   *
   * - PutObjectCommand calls (N of them, one per local file) → resolve {}
   * - ListObjectsV2Command → resolve { Contents: [...], IsTruncated: false }
   * - DeleteObjectsCommand → resolve { Errors: [] } (Quiet=true)
   */
  function wireUploadThenListAndDelete(
    localFileCount: number,
    remoteKeys: readonly string[],
  ): void {
    for (let i = 0; i < localFileCount; i++) {
      mockSend.mockResolvedValueOnce({
        ETag: '"d41d8cd98f00b204e9800998ecf8427e"',
        $metadata: { httpStatusCode: 200, requestId: `req-put-${i}` },
      });
    }
    mockSend.mockResolvedValueOnce({
      Contents: remoteKeys.map((Key) => ({ Key, Size: 100 })),
      IsTruncated: false,
      $metadata: { httpStatusCode: 200, requestId: "req-list-1" },
    });
    mockSend.mockResolvedValueOnce({
      Errors: [],
      Deleted: remoteKeys.map((Key) => ({ Key })),
      $metadata: { httpStatusCode: 200, requestId: "req-delete-1" },
    });
  }

  it("returns deleted: 0 when no deleteOrphans option is passed (default OFF)", async () => {
    writeFileSync(join(tmpDir, "index.html"), "<h1>hi</h1>");
    mockSend.mockResolvedValueOnce({
      ETag: '"d41d8cd98f00b204e9800998ecf8427e"',
      $metadata: { httpStatusCode: 200, requestId: "req-put-default" },
    });

    const result = await uploadStaticSite("my-bucket", tmpDir);

    expect(result.uploaded).toBe(1);
    expect(result.deleted).toBe(0);
    // ONLY the PUT happened — no LIST, no DELETE.
    expect(mockSend).toHaveBeenCalledTimes(1);
    const cmd = mockSend.mock.calls[0]![0];
    expect(cmd._type).toBe("PutObjectCommand");
  });

  it("deletes remote objects with no local counterpart", async () => {
    writeFileSync(join(tmpDir, "index.html"), "<h1>new</h1>");
    writeFileSync(join(tmpDir, "style.css"), "body {}");

    // Remote has TWO extra orphans: old/legacy.html and removed.js.
    wireUploadThenListAndDelete(2, [
      "index.html", // present locally → preserved
      "style.css", // present locally → preserved
      "old/legacy.html", // orphan → delete
      "removed.js", // orphan → delete
    ]);

    const result = await uploadStaticSite("my-bucket", tmpDir, {
      deleteOrphans: true,
    });

    expect(result.uploaded).toBe(2);
    expect(result.deleted).toBe(2);
    expect(result.failed).toBe(0);

    // Last call was a DeleteObjectsCommand carrying the exact orphan set.
    type DelCmd = {
      _type: string;
      Bucket: string;
      Delete: { Objects: Array<{ Key: string }>; Quiet: boolean };
    };
    const delCmd = mockSend.mock.calls.at(-1)![0] as DelCmd;
    expect(delCmd._type).toBe("DeleteObjectsCommand");
    expect(delCmd.Bucket).toBe("my-bucket");
    expect(delCmd.Delete.Quiet).toBe(true);
    const deletedKeys = delCmd.Delete.Objects.map((o) => o.Key).sort();
    expect(deletedKeys).toEqual(["old/legacy.html", "removed.js"].sort());
  });

  it("returns deleted: 0 when there are no orphans (clean bucket)", async () => {
    writeFileSync(join(tmpDir, "index.html"), "<h1>hi</h1>");
    // Remote contains EXACTLY the local set — no orphans.
    mockSend.mockResolvedValueOnce({
      $metadata: { httpStatusCode: 200, requestId: "req-put" },
    });
    mockSend.mockResolvedValueOnce({
      Contents: [{ Key: "index.html", Size: 100 }],
      IsTruncated: false,
      $metadata: { httpStatusCode: 200, requestId: "req-list" },
    });

    const result = await uploadStaticSite("my-bucket", tmpDir, {
      deleteOrphans: true,
    });

    expect(result.uploaded).toBe(1);
    expect(result.deleted).toBe(0);
    // PUT + LIST, but NO DELETE call (empty orphan batch is skipped).
    expect(mockSend).toHaveBeenCalledTimes(2);
    const last = mockSend.mock.calls.at(-1)![0];
    expect(last._type).toBe("ListObjectsV2Command");
  });

  it("paginates ListObjectsV2 via NextContinuationToken", async () => {
    writeFileSync(join(tmpDir, "index.html"), "<h1>hi</h1>");
    mockSend.mockResolvedValueOnce({
      $metadata: { httpStatusCode: 200, requestId: "req-put" },
    });
    // Page 1 — truncated, with continuation token.
    mockSend.mockResolvedValueOnce({
      Contents: [{ Key: "page1-orphan.txt" }],
      IsTruncated: true,
      NextContinuationToken: "page2-token",
      $metadata: { httpStatusCode: 200, requestId: "req-list-1" },
    });
    // Page 2 — final.
    mockSend.mockResolvedValueOnce({
      Contents: [{ Key: "page2-orphan.txt" }, { Key: "index.html" }],
      IsTruncated: false,
      $metadata: { httpStatusCode: 200, requestId: "req-list-2" },
    });
    // Delete batch.
    mockSend.mockResolvedValueOnce({
      Errors: [],
      Deleted: [{ Key: "page1-orphan.txt" }, { Key: "page2-orphan.txt" }],
      $metadata: { httpStatusCode: 200, requestId: "req-delete" },
    });

    const result = await uploadStaticSite("my-bucket", tmpDir, {
      deleteOrphans: true,
    });

    expect(result.deleted).toBe(2);
    // Second LIST call MUST carry the continuation token from page 1.
    const listCalls = mockSend.mock.calls
      .map((c) => c[0])
      .filter((c) => c._type === "ListObjectsV2Command");
    expect(listCalls).toHaveLength(2);
    expect(listCalls[1].ContinuationToken).toBe("page2-token");
  });

  it("counts S3 DeleteObjects per-key errors as failures, not deletes", async () => {
    writeFileSync(join(tmpDir, "index.html"), "<h1>hi</h1>");
    mockSend.mockResolvedValueOnce({
      $metadata: { httpStatusCode: 200, requestId: "req-put" },
    });
    mockSend.mockResolvedValueOnce({
      Contents: [
        { Key: "orphan-1" },
        { Key: "orphan-2" },
        { Key: "index.html" },
      ],
      IsTruncated: false,
      $metadata: { httpStatusCode: 200, requestId: "req-list" },
    });
    mockSend.mockResolvedValueOnce({
      Errors: [
        { Key: "orphan-2", Code: "AccessDenied", Message: "policy denies" },
      ],
      Deleted: [{ Key: "orphan-1" }],
      $metadata: { httpStatusCode: 200, requestId: "req-delete" },
    });

    const result = await uploadStaticSite("my-bucket", tmpDir, {
      deleteOrphans: true,
    });

    // 2 orphans, 1 succeeded, 1 reported as error.
    expect(result.deleted).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.file).toBe("orphan-2");
    expect(result.errors[0]!.error).toMatch(/policy denies/);
  });

  // T3-2: localKeys is snapshotted at upload-start, not recomputed at
  // orphan-sweep time. If a local file is removed mid-flight (between
  // collectFiles and the orphan sweep), the corresponding remote object
  // must NOT be treated as an orphan.
  it("T3-2: local file deleted mid-flight does NOT cause the remote object to be treated as an orphan", async () => {
    // Two local files: index.html and ephemeral.css.
    writeFileSync(join(tmpDir, "index.html"), "<h1>hi</h1>");
    writeFileSync(join(tmpDir, "ephemeral.css"), "body {}");

    // Simulate the race: uploadStaticSite starts, both files are
    // collected by collectFiles. During the upload of ephemeral.css,
    // the OS removes it (upload fails for that file). The remote bucket
    // already contains a prior-run version of ephemeral.css. If localKeys
    // were recomputed AFTER the upload loop, ephemeral.css would be absent
    // (collectFiles re-runs and misses it) and the orphan sweep would
    // delete the still-valid remote object. With T3-2's start-snapshot,
    // ephemeral.css is in localKeys from the initial scan and is not
    // treated as an orphan.
    //
    // Test implementation: wire the second PUT (ephemeral.css) to fail —
    // simulating the upload failure due to the file being removed mid-flight.
    // The remote bucket is wired to contain BOTH index.html and ephemeral.css
    // (prior-run version). The orphan sweep must NOT include ephemeral.css
    // in the DeleteObjectsCommand.
    mockSend
      .mockResolvedValueOnce({
        // PUT index.html succeeds
        ETag: '"a3cca2b2aa1e3b5b3b5aa5b5aa5aa5aa"',
        $metadata: { httpStatusCode: 200, requestId: "req-put-1" },
      })
      .mockRejectedValueOnce(new Error("NoSuchKey: ephemeral.css disappeared"))
      // LIST returns both objects (prior-run ephemeral.css still in bucket)
      .mockResolvedValueOnce({
        Contents: [
          { Key: "index.html", Size: 100 },
          { Key: "ephemeral.css", Size: 200 }, // prior-run version, valid!
          { Key: "old-orphan.txt", Size: 50 }, // genuine orphan
        ],
        IsTruncated: false,
        $metadata: { httpStatusCode: 200, requestId: "req-list" },
      })
      // DELETE — only old-orphan.txt
      .mockResolvedValueOnce({
        Errors: [],
        Deleted: [{ Key: "old-orphan.txt" }],
        $metadata: { httpStatusCode: 200, requestId: "req-delete" },
      });

    const result = await uploadStaticSite("my-bucket", tmpDir, {
      deleteOrphans: true,
    });

    expect(result.uploaded).toBe(1); // index.html only
    expect(result.failed).toBe(1); // ephemeral.css
    // Only the genuine orphan (old-orphan.txt) was deleted — NOT ephemeral.css.
    expect(result.deleted).toBe(1);

    // Confirm the DeleteObjectsCommand carried only old-orphan.txt.
    type DelCmd = {
      _type: string;
      Delete: { Objects: Array<{ Key: string }> };
    };
    const deleteCalls = mockSend.mock.calls
      .map((c) => c[0] as DelCmd)
      .filter((c) => c._type === "DeleteObjectsCommand");
    expect(deleteCalls).toHaveLength(1);
    const deletedKeys = deleteCalls[0]!.Delete.Objects.map((o) => o.Key);
    expect(deletedKeys).toEqual(["old-orphan.txt"]);
    // ephemeral.css must NOT appear in the delete set.
    expect(deletedKeys).not.toContain("ephemeral.css");
  });
});
