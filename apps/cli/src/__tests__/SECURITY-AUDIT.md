# Security Audit Report

**Date:** 2026-03-27
**Scope:** Full codebase security and bug audit of assignee.ai CLI
**Auditor:** Automated security review (Claude Code)

---

## Summary

| Severity | Found | Fixed | Remaining |
|----------|-------|-------|-----------|
| CRITICAL | 0     | 0     | 0         |
| HIGH     | 3     | 3     | 0         |
| MEDIUM   | 3     | 1     | 2         |
| LOW      | 4     | 0     | 4         |

---

## FIXED Issues

### SEC-01: Prototype Pollution in deepMergePatch (HIGH) -- FIXED

**File:** `apps/cli/src/nodes/fix-applicator.ts`
**Description:** The `deepMergePatch()` function iterates over all keys from a patch object using `Object.entries()` without filtering dangerous prototype-chain keys. A malicious BP finding with a `desiredStatePatch` containing `__proto__`, `constructor`, or `prototype` keys could inject properties into `Object.prototype`, affecting all objects in the process.

**Fix:** Added guard to skip `__proto__`, `constructor`, and `prototype` keys at the top of the loop.

**Risk before fix:** An attacker who controls BP finding definitions (e.g., through a malicious best-practices package) could achieve prototype pollution, potentially leading to privilege escalation or denial of service within the CLI process.

---

### SEC-02: Sensitive Fields Exposed in Plaintext (HIGH) -- FIXED

**Files:**
- `apps/cli/src/utils/display.ts` (plan box rendering)
- `apps/cli/src/services/checkpoint.ts` (checkpoint serialization)

**Description:** `MasterUserPassword`, `SecretString`, and other sensitive fields from RDS and SecretsManager resources were displayed in plaintext in the plan box output and persisted unredacted in checkpoint JSON files on disk (`~/.assignee/checkpoints/`).

**Impact:**
1. Passwords visible in terminal output, terminal scrollback, and screen recordings.
2. Checkpoint files on disk contain plaintext passwords, readable by any process with user-level access.

**Fix:**
1. `display.ts`: Added `SENSITIVE_FIELDS` set. `formatDesiredState()` now renders `********` for any field in the set.
2. `checkpoint.ts`: Added `redactSensitiveFields()` that replaces sensitive values with `[REDACTED]` before writing checkpoint JSON.

**Note:** The `provisions.json` memory file stores only a `desiredStateHash` (not the full desiredState), so it is not affected.

---

### SEC-03: Credentials Recorded to Disk in Test Fixtures (HIGH) -- FIXED

**File:** `apps/cli/src/utils/recorder.ts`

**Description:** When `ASSIGNEE_RECORD=1` is set, the `RecordingInterceptor` captures ALL MCP tool inputs/outputs and AWS SDK call arguments/responses, writing them as JSON files to `apps/cli/src/test-fixtures/recordings/`. This could capture:
- AWS credentials passed as environment variables in MCP server configs
- Secret values in SDK responses (e.g., SecretsManager GetSecretValue)
- Passwords in desiredState passed to CloudControl CreateResource

These recordings could be accidentally committed to version control.

**Fix:** Added `redactSensitive()` recursive function that strips known credential/password keys before `recordCall()` writes to disk. The `REDACTED_KEYS` set covers AWS credential env vars, ASSIGNEE_* credential env vars, and database/secret password fields.

---

### SEC-04: TOCTOU Race in Memory Lock Mechanism (MEDIUM) -- FIXED

**File:** `apps/cli/src/services/memory.ts`

**Description:** The `acquireLock()` method used a non-atomic stat-then-write pattern:
1. `stat()` to check if lock exists
2. `writeFile()` to create the lock

Between steps 1 and 2, another process could create the same lock file, leading to two concurrent writers both believing they hold the lock, which could corrupt `provisions.json`, `failures.json`, or `patterns.json`.

**Fix:** Replaced `writeFile()` with `fs.open()` using `O_CREAT | O_EXCL | O_WRONLY` flags. `O_EXCL` makes the open syscall fail atomically if the file already exists, eliminating the race window.

---

## Documented Issues (Not Fixed)

### SEC-05: Unvalidated MCP Security Posture Responses (MEDIUM)

**File:** `apps/cli/src/nodes/result-formatter.ts:59`

**Description:** The `checkSecurityPosture()` function parses MCP tool responses with `JSON.parse(unwrapMcpText(result))` and then accesses `.findings` without schema validation. A malicious or buggy MCP server could return unexpected structures causing runtime errors.

**Mitigation:** The function is wrapped in a try/catch and findings are display-only (non-blocking). However, adding Zod validation would be a defense-in-depth improvement.

**Recommendation:** Add a Zod schema for the security posture response and validate before accessing fields.

---

### SEC-06: Error Messages May Leak Internal Paths (MEDIUM)

**File:** `apps/cli/src/services/checkpoint.ts:79,114`

**Description:** Checkpoint error messages include full file paths (e.g., `Corrupt checkpoint file (invalid JSON): /Users/john/.assignee/checkpoints/checkpoint-xxx.json`). While this is useful for debugging, it leaks the user's home directory path.

**Mitigation:** These are local CLI errors shown to the local user who owns the files, so the risk is LOW in practice. In a future SaaS/telemetry context, these should be sanitized before transmission.

---

### SEC-07: Advisory Lock Not Released on Process Crash (LOW)

**File:** `apps/cli/src/services/memory.ts`

**Description:** If the CLI process crashes (SIGKILL, OOM) between acquiring a lock and releasing it, the lock file remains on disk. The 10-second stale-lock timeout mitigates this, but during those 10 seconds, concurrent CLI invocations will skip the write.

**Mitigation:** The 10-second timeout is adequate for a CLI tool. For a server process, a PID-based liveness check would be needed.

---

### SEC-08: Floating-Point Precision in Pricing (LOW)

**File:** `apps/cli/src/utils/pricing-lookup.ts:37`

**Description:** `parseFloat()` is used for USD price parsing. For very small prices (e.g., $0.0000002/hr for Lambda), IEEE 754 floating-point can introduce rounding artifacts. The code uses `toFixed()` for display which mitigates visible rounding, but intermediate calculations could accumulate error.

**Mitigation:** For a cost estimation tool (not billing), this precision level is acceptable. Exact decimal arithmetic (e.g., using integer cents) would be needed for billing applications.

---

### SEC-09: MCP Server Command Injection (LOW -- Not Exploitable)

**File:** `apps/cli/src/config/mcp-servers.ts`

**Description:** MCP server commands are hardcoded constants (`uvx`, `npx`) with static arguments. No user input flows into `command` or `args` arrays. The `@langchain/mcp-adapters` library spawns these as child processes.

**Assessment:** NOT EXPLOITABLE. All command strings are compile-time constants. No `child_process.exec()` or shell interpolation is used anywhere in the CLI source.

---

### SEC-10: No Path Traversal in File Operations (LOW -- Not Exploitable)

**Files:** `apps/cli/src/services/memory.ts`, `apps/cli/src/services/checkpoint.ts`, `apps/cli/src/services/price-cache.ts`

**Description:** Memory files use a fixed directory (`~/.assignee/memory/`). Checkpoint files use `runId` (UUID format, validated by Zod schema). Cache files use MD5 hashes of service codes. No user-controlled path components flow into `path.join()`.

**Assessment:** NOT EXPLOITABLE. File paths are constructed from validated UUIDs, hash digests, and constant directory names. No user-supplied filenames or path segments.

---

## Positive Findings

The following security controls are already well-implemented:

1. **IAM Least Privilege:** The `iam-policies.ts` generates scoped policies with CloudControl actions conditioned on `StringEquals: cloudcontrol:TypeName`. No `*:*` or `AdministratorAccess`. The IAM role plugin explicitly warns against `AdministratorAccess` in `configHints`.

2. **Input Sanitization:** `sanitize.ts` strips null bytes, control characters, Unicode direction overrides, and template injection sequences (`${`) from user intent before LLM prompt injection. Max length enforced at 500 chars.

3. **No `child_process` Usage:** Zero instances of `exec()`, `execSync()`, `spawn()`, or `child_process` imports in CLI source. MCP servers are spawned by the `@langchain/mcp-adapters` library via a structured API.

4. **No Console Logging:** Zero `console.log/warn/error` calls in production source files. All logging goes through the structured `logger.ts` which is gated behind `--verbose` opt-in.

5. **Credential Separation:** Three-user IAM model (operator/reader/auditor) with dedicated env var namespaces (`ASSIGNEE_OPERATOR_*`, `ASSIGNEE_READER_*`, `ASSIGNEE_AUDITOR_*`) prevents credential leakage between privilege levels.

6. **Zod Schema Validation:** Checkpoint files, memory files, and config files are validated with Zod schemas before use. Invalid data is rejected gracefully.

7. **No Hardcoded Credentials:** No AWS access keys, secret keys, or passwords appear in source code. All credentials come from environment variables.

8. **Prompt Injection Defense:** Plan generator XML-wraps user intent (`<user_intent>...</user_intent>`) and strips closing tags to prevent user intent from escaping the XML boundary.

9. **Atomic File Writes:** Memory service uses write-to-temp-then-rename pattern (`atomicWrite()`) to prevent corruption from partial writes.

10. **Error Message Hygiene:** The `ErrorMessageRegistry` provides structured WHAT/WHY/HOW-TO-FIX messages that never expose raw AWS SDK error details, account IDs, or ARNs to end users.
