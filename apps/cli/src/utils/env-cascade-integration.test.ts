/**
 * End-to-end cascade test for the `assignee setup → loadEnvFile →
 * requireAssigneeCredentials → SDK client` flow.
 *
 * Existing `env-writer.test.ts` covers `mergeEnvFile` in isolation.
 * That coverage is necessary but not sufficient — the user-visible bug
 * (Bedrock receiving a stale `ASSIGNEE_OPERATOR_SESSION_TOKEN` paired
 * with a fresh AKIA AKID) crossed FOUR boundaries:
 *
 *   1. setup writes the new AKID+SECRET via mergeEnvFile (.env)
 *   2. CLI bootstrap loads the .env via process.loadEnvFile() (process.env)
 *   3. requireAssigneeCredentials reads process.env (creds object)
 *   4. SDK client passes creds to AWS (signed request)
 *
 * Unit tests stop after step 1. This test exercises 1→3 against the
 * user's actual fixture shape — three role rotations with paired stale
 * tokens — to lock in that the eviction survives the parse/load round
 * trip, and that the resulting credential object has NO sessionToken
 * (so the SDK client cannot accidentally re-introduce the stale token).
 *
 * Step 4 is not exercisable without live AWS — but if step 3 returns
 * `{ accessKeyId, secretAccessKey, sessionToken: undefined }` the SDK
 * has no way to reach AWS with a stale token. That property is the
 * load-bearing assertion of this test.
 *
 * Why a child Node process for step 2: process.loadEnvFile(path) only
 * SETS keys it sees, it does not DELETE keys not present in the file.
 * If the parent test process happens to have a stale
 * ASSIGNEE_OPERATOR_SESSION_TOKEN in its own process.env (e.g. from
 * shell exports during a real `assignee setup` rerun) loadEnvFile
 * leaves it. The user's actual flow runs the CLI fresh — to mirror
 * that, we spawn a clean child Node and assert against ITS process.env.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawnSync } from "node:child_process";
import { mergeEnvFile } from "./env-writer.js";

// Realistic AWS-shape fixtures matching what `assignee setup` actually
// emits. Mirror the conventions in env-writer.test.ts so a regex /
// parser regression surfaces against true STS shapes (= padding, +/=/
// Base64 alphabet) instead of synthetic placeholders.
const OPERATOR_AKID_NEW = "AKIAIOSFODNN7EXAMPLE";
const OPERATOR_SECRET_NEW = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
const OPERATOR_AKID_OLD = "ASIAIOSFODNN7EXAMPLE";
const OPERATOR_SECRET_OLD = "oldOperatorSecret/AbCdEfGhIjKlMnOpQrStUvWx";
const READER_AKID_NEW = "AKIAJBCDEFGHIJKLMNOP";
const READER_SECRET_NEW = "QrStUvWxYz0123456789/AbCdEfGhIjKlMnOpQrSt";
const READER_AKID_OLD = "ASIAJBCDEFGHIJKLMNOP";
const READER_SECRET_OLD = "oldReaderSecret/0123456789AbCdEfGhIjKlMnOp";
const AUDITOR_AKID_NEW = "AKIAKLMNOPQRSTUVWXYZ";
const AUDITOR_SECRET_NEW = "AuditorNewSecret/01234567890AbCdEfGhIjKlMn";
const AUDITOR_AKID_OLD = "ASIAKLMNOPQRSTUVWXYZ";
const AUDITOR_SECRET_OLD = "AuditorOldSecret/AbCdEfGhIjKlMnOpQrStUvWxYz";

// 240-char STS-shaped tokens — three distinct stale tokens (one per
// role) plus an unrelated AWS_SESSION_TOKEN that must survive.
const STALE_OPERATOR_TOKEN =
  "IQoJb3JpZ2luX2VjEJr//////////wEaCXVzLWVhc3QtMSJHMEUCIQD" +
  "OPERATOR+STALE+TOKEN/payload/abc123ABC==xYz9876543210/op" +
  "PLUS+SIGN+BASE64+CONTENT/withSlashes/AAA+BBB+CCC=opOp" +
  "expiredOperatorPaddingToReachRealSTSResponseLengthEE==" +
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuv==OPER";
const STALE_READER_TOKEN =
  "IQoJb3JpZ2luX2VjEJr//////////wEaCXVzLWVhc3QtMSJHMEUCIQD" +
  "READER+STALE+TOKEN/payload/123abc/ABC==xYz=readerToken" +
  "PLUS+SIGN+BASE64+CONTENT/withSlashes/RRR+EEE+AAA=readr" +
  "expiredReaderPaddingToReachRealSTSResponseLengthFFF==" +
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuv==READ";
const STALE_AUDITOR_TOKEN =
  "IQoJb3JpZ2luX2VjEJr//////////wEaCXVzLWVhc3QtMSJHMEUCIQD" +
  "AUDITOR+STALE+TOKEN/payload/auditPayload/ABC==xYz/audit" +
  "PLUS+SIGN+BASE64+CONTENT/withSlashes/UUU+DDD+TTT=audit" +
  "expiredAuditorPaddingToReachRealSTSResponseLengthGGG==" +
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuv==AUDT";
const AWS_SESSION_TOKEN_PRESERVE =
  "IQoJb3JpZ2luX2VjEJr//////////wEaCXVzLWVhc3QtMSJHMEUCIQD" +
  "AWS+EXPORT+TOKEN+EXAMPLE/payload/awsSso/ABC==xYz0/awsX" +
  "PLUS+SIGN+BASE64+CONTENT/withSlashes/AAA+WWW+SSS=awsToken" +
  "awsExportPaddingToReachRealSTSResponseLengthEE==EE==EE" +
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuv==AWSX";
const AWS_AKID_PRESERVE = "ASIAQRSTUVWXYZ123456";

describe("env-cascade-integration: assignee setup → load → resolve", () => {
  let tmpDir: string;
  let envPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "env-cascade-"));
    envPath = path.join(tmpDir, ".env");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("user's actual scenario: rotate 3 roles + load .env + resolve creds", () => {
    // ── Step 1 fixture: the user's pre-setup .env shape ──────────
    // Matches the user-reported state: prior `aws sso login` + manual
    // export populated all three role session tokens; AWS_REGION and a
    // separate AWS_* SSO triple coexist alongside the assignee creds.
    const initialEnv =
      `AWS_REGION=us-east-1\n` +
      `AWS_ACCESS_KEY_ID=${AWS_AKID_PRESERVE}\n` +
      `AWS_SESSION_TOKEN=${AWS_SESSION_TOKEN_PRESERVE}\n` +
      `ASSIGNEE_OPERATOR_ACCESS_KEY_ID=${OPERATOR_AKID_OLD}\n` +
      `ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY=${OPERATOR_SECRET_OLD}\n` +
      `ASSIGNEE_OPERATOR_SESSION_TOKEN=${STALE_OPERATOR_TOKEN}\n` +
      `ASSIGNEE_READER_ACCESS_KEY_ID=${READER_AKID_OLD}\n` +
      `ASSIGNEE_READER_SECRET_ACCESS_KEY=${READER_SECRET_OLD}\n` +
      `ASSIGNEE_READER_SESSION_TOKEN=${STALE_READER_TOKEN}\n` +
      `ASSIGNEE_AUDITOR_ACCESS_KEY_ID=${AUDITOR_AKID_OLD}\n` +
      `ASSIGNEE_AUDITOR_SECRET_ACCESS_KEY=${AUDITOR_SECRET_OLD}\n` +
      `ASSIGNEE_AUDITOR_SESSION_TOKEN=${STALE_AUDITOR_TOKEN}\n` +
      `BEDROCK_MODEL_ID=us.anthropic.claude-sonnet-4-5-20250929-v1:0\n`;
    fs.writeFileSync(envPath, initialEnv);

    // ── Step 2: emulate `assignee setup` rotation payload ────────
    // Shape mirrors apps/cli/src/commands/setup/summary.ts —
    // writeEnvAndSummary(envUpdates) — which is fed AKID + SECRET for
    // every role processed by provision-users. Critically NO
    // *_SESSION_TOKEN keys: setup creates long-term IAM access keys.
    mergeEnvFile(envPath, {
      ASSIGNEE_OPERATOR_ACCESS_KEY_ID: OPERATOR_AKID_NEW,
      ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY: OPERATOR_SECRET_NEW,
      ASSIGNEE_READER_ACCESS_KEY_ID: READER_AKID_NEW,
      ASSIGNEE_READER_SECRET_ACCESS_KEY: READER_SECRET_NEW,
      ASSIGNEE_AUDITOR_ACCESS_KEY_ID: AUDITOR_AKID_NEW,
      ASSIGNEE_AUDITOR_SECRET_ACCESS_KEY: AUDITOR_SECRET_NEW,
    });

    // ── Step 3: assert disk shape ────────────────────────────────
    const written = fs.readFileSync(envPath, "utf-8");

    // a) all 3 stale session tokens evicted
    expect(written).not.toContain("ASSIGNEE_OPERATOR_SESSION_TOKEN");
    expect(written).not.toContain("ASSIGNEE_READER_SESSION_TOKEN");
    expect(written).not.toContain("ASSIGNEE_AUDITOR_SESSION_TOKEN");
    expect(written).not.toContain(STALE_OPERATOR_TOKEN);
    expect(written).not.toContain(STALE_READER_TOKEN);
    expect(written).not.toContain(STALE_AUDITOR_TOKEN);

    // b) all 3 new AKIDs landed
    expect(written).toContain(
      `ASSIGNEE_OPERATOR_ACCESS_KEY_ID=${OPERATOR_AKID_NEW}`,
    );
    expect(written).toContain(
      `ASSIGNEE_READER_ACCESS_KEY_ID=${READER_AKID_NEW}`,
    );
    expect(written).toContain(
      `ASSIGNEE_AUDITOR_ACCESS_KEY_ID=${AUDITOR_AKID_NEW}`,
    );
    // and old AKIDs gone
    expect(written).not.toContain(OPERATOR_AKID_OLD);
    expect(written).not.toContain(READER_AKID_OLD);
    expect(written).not.toContain(AUDITOR_AKID_OLD);

    // c) all 3 new SECRETs landed
    expect(written).toContain(
      `ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY=${OPERATOR_SECRET_NEW}`,
    );
    expect(written).toContain(
      `ASSIGNEE_READER_SECRET_ACCESS_KEY=${READER_SECRET_NEW}`,
    );
    expect(written).toContain(
      `ASSIGNEE_AUDITOR_SECRET_ACCESS_KEY=${AUDITOR_SECRET_NEW}`,
    );

    // d) AWS_REGION + AWS_SESSION_TOKEN survive (BEDROCK_MODEL_ID too).
    // NOTE: AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY are in
    // env-writer's DEPRECATED_KEYS — they SHOULD be evicted; mirroring
    // existing behavior means the user's separate `aws sso` creds are
    // intentionally pruned from .env. AWS_SESSION_TOKEN is NOT in
    // DEPRECATED_KEYS, so it survives. This is the existing contract.
    expect(written).toContain("AWS_REGION=us-east-1");
    expect(written).toContain(
      `AWS_SESSION_TOKEN=${AWS_SESSION_TOKEN_PRESERVE}`,
    );
    expect(written).toContain(
      "BEDROCK_MODEL_ID=us.anthropic.claude-sonnet-4-5-20250929-v1:0",
    );
    // AWS_ACCESS_KEY_ID intentionally evicted by DEPRECATED_KEYS path.
    expect(written).not.toContain("AWS_ACCESS_KEY_ID=");

    // ── Step 4: parse via process.loadEnvFile in a clean child ───
    // Spawn a fresh Node process with no inherited credentials, ask it
    // to load the rotated .env, and have it print the resolved keys
    // we care about as a JSON object. Asserts that loadEnvFile parses
    // the file cleanly AND that no stale token survives the round trip.
    const probe = spawnSync(
      process.execPath,
      [
        "-e",
        // Inline probe: load env file, dump the assignee-relevant keys.
        // process.loadEnvFile is Node 20.6+ stable.
        `process.loadEnvFile(${JSON.stringify(envPath)});` +
          "const keys = [" +
          "'ASSIGNEE_OPERATOR_ACCESS_KEY_ID'," +
          "'ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY'," +
          "'ASSIGNEE_OPERATOR_SESSION_TOKEN'," +
          "'ASSIGNEE_READER_ACCESS_KEY_ID'," +
          "'ASSIGNEE_READER_SECRET_ACCESS_KEY'," +
          "'ASSIGNEE_READER_SESSION_TOKEN'," +
          "'ASSIGNEE_AUDITOR_ACCESS_KEY_ID'," +
          "'ASSIGNEE_AUDITOR_SECRET_ACCESS_KEY'," +
          "'ASSIGNEE_AUDITOR_SESSION_TOKEN'," +
          "'AWS_REGION','AWS_SESSION_TOKEN'," +
          "];" +
          "const out = {};" +
          "for (const k of keys) out[k] = process.env[k] === undefined ? null : process.env[k];" +
          "process.stdout.write(JSON.stringify(out));",
      ],
      {
        encoding: "utf-8",
        // Strip parent ASSIGNEE_*/AWS_* env so the child's process.env
        // starts empty and reflects ONLY what loadEnvFile sets.
        env: stripAwsEnv(process.env),
      },
    );

    expect(probe.status).toBe(0);
    expect(probe.stderr).toBe("");
    const loaded = JSON.parse(probe.stdout) as Record<string, string | null>;

    // a) New AKIDs reflected in process.env
    expect(loaded["ASSIGNEE_OPERATOR_ACCESS_KEY_ID"]).toBe(OPERATOR_AKID_NEW);
    expect(loaded["ASSIGNEE_READER_ACCESS_KEY_ID"]).toBe(READER_AKID_NEW);
    expect(loaded["ASSIGNEE_AUDITOR_ACCESS_KEY_ID"]).toBe(AUDITOR_AKID_NEW);

    // b) New SECRETs reflected in process.env
    expect(loaded["ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY"]).toBe(
      OPERATOR_SECRET_NEW,
    );
    expect(loaded["ASSIGNEE_READER_SECRET_ACCESS_KEY"]).toBe(READER_SECRET_NEW);
    expect(loaded["ASSIGNEE_AUDITOR_SECRET_ACCESS_KEY"]).toBe(
      AUDITOR_SECRET_NEW,
    );

    // c) NO ASSIGNEE_*_SESSION_TOKEN keys land in process.env — the
    // load-bearing assertion. If this fails, the cascade is broken
    // and the SDK client would receive a stale token.
    expect(loaded["ASSIGNEE_OPERATOR_SESSION_TOKEN"]).toBeNull();
    expect(loaded["ASSIGNEE_READER_SESSION_TOKEN"]).toBeNull();
    expect(loaded["ASSIGNEE_AUDITOR_SESSION_TOKEN"]).toBeNull();

    // d) AWS_REGION and AWS_SESSION_TOKEN survive
    expect(loaded["AWS_REGION"]).toBe("us-east-1");
    expect(loaded["AWS_SESSION_TOKEN"]).toBe(AWS_SESSION_TOKEN_PRESERVE);

    // ── Step 5: requireAssigneeCredentials returns clean creds ───
    // Resolve operator creds against a config adapter backed by the
    // child-process-loaded env state. If the eviction is real, the
    // returned object MUST NOT carry sessionToken — that is the
    // property the SDK relies on to avoid the user's bug.
    const childEnv = Object.fromEntries(
      Object.entries(loaded).filter(([, v]) => v !== null),
    ) as Record<string, string>;
    // Inline minimal ConfigPort to avoid loading the real adapter
    // (which reads process.env of the test runner, not our loaded
    // child-process state).
    const config = {
      get: (k: string) => childEnv[k],
      getRequired: (k: string) => {
        const v = childEnv[k];
        if (v === undefined) throw new Error(`missing ${k}`);
        return v;
      },
      getInt: () => undefined,
      getBool: () => undefined,
    } as unknown as Parameters<
      typeof import("@assignee/core").requireAssigneeCredentials
    >[1];

    // Lazy-import core so test boot stays cheap when this file is
    // collected but not selected.
    return import("@assignee/core").then(({ requireAssigneeCredentials }) => {
      for (const role of ["operator", "reader", "auditor"] as const) {
        const creds = requireAssigneeCredentials(role, config);
        expect(creds.accessKeyId).toMatch(/^AKIA/); // long-term keys
        expect(creds.secretAccessKey.length).toBeGreaterThan(20);
        // The fix proof: NO sessionToken even though stale ones existed
        // on disk before mergeEnvFile ran.
        expect(creds.sessionToken).toBeUndefined();
      }
    });
  });
});

/**
 * Build a child-process env that strips any inherited AWS_* /
 * ASSIGNEE_* / BEDROCK_* keys so the child starts from a clean slate.
 * Mirrors the user's actual flow: they ran `assignee setup` in a fresh
 * shell where the parent had no env exports — only what the prior .env
 * had loaded into the running process.
 */
function stripAwsEnv(parent: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const cleaned: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(parent)) {
    if (
      k.startsWith("AWS_") ||
      k.startsWith("ASSIGNEE_") ||
      k.startsWith("BEDROCK_") ||
      k === "MCP_AWS_ACCESS_KEY_ID" ||
      k === "MCP_AWS_SECRET_ACCESS_KEY"
    ) {
      continue;
    }
    if (v !== undefined) cleaned[k] = v;
  }
  return cleaned;
}
