# Security Policy

Assignee.ai is an Infrastructure-as-Code (IaC) tool that ingests AWS
credentials and provisions real cloud resources. A vulnerability here can
translate directly into AWS account compromise or unauthorized resource
mutation, so we treat security disclosures with high priority.

## Supported Versions

Assignee.ai is a course-project submission for the Generative AI for
Developers micro-master's program. The `main` branch is supported on a
best-effort basis during the course-grading window. Reference commit
hashes for graders (the exact commit each rubric item was scored
against) are documented in `CONTRIBUTING.md`; that document is the
canonical pointer for which `main` snapshot is "the" submission.

## Reporting a Vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

Report privately via:

- **GitHub Security Advisory**: use the "Report a vulnerability" button on
  the repository's Security tab to open a private advisory.

Include as much of the following as you can:

- A description of the issue and its impact (what an attacker could do).
- Steps to reproduce, including command invocations, config snippets, and
  AWS resource types involved.
- The assignee.ai version (`assignee --version`) and the platform
  (`uname -a`, shell).
- Any proof-of-concept code, log excerpts, or screenshots — **redact
  account IDs, access keys, session tokens, and resource ARNs** before
  sharing.
- Whether the issue is actively being exploited.

## What to Expect

- **Best-effort response from the maintainer.** This is a course project
  with no on-call rotation — there is no guaranteed acknowledgement
  window, no triage SLA, and no committed resolution timeline.
- Critical issues (remote code execution, credential exfiltration) will
  be prioritised; lower-severity reports may sit until the maintainer
  has bandwidth.
- **Coordinated disclosure**: please give the maintainer reasonable time
  to remediate before public disclosure.
- **Credit**: with the reporter's consent, the finder will be credited
  in the `CHANGELOG.md` entry that lands the fix.

## Scope

In-scope:

- The CLI (`apps/cli`), MCP server (`apps/mcp-server`), and core library
  (`packages/core`, `packages/best-practices`) in this repository.
- Documented integration paths (Cursor, Claude Code, Windsurf via MCP).
- The shipped IAM policy templates in
  `packages/core/src/config/iam-policies/`.

Out of scope:

- Vulnerabilities in third-party dependencies **that we do not exploit or
  amplify** — please report those upstream. If a dependency issue is
  exploitable through our surface, it becomes in-scope.
- Issues in AWS services themselves — report to AWS Security.
- Social-engineering, phishing, or physical attacks against maintainers.
- Denial of service via obviously hostile intent (flooding, automated
  abuse of rate-limited APIs).

## Severity Classification

We use a simplified CVSS-inspired bucket to prioritise triage:

| Severity     | Example                                                                                                                                                                                                                                                                              |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Critical** | Arbitrary code execution on the user's machine; exfiltration of AWS credentials or Bedrock API keys                                                                                                                                                                                  |
| **High**     | Bypass of typed-confirm / safety allowlist; cross-account privilege escalation via plan injection                                                                                                                                                                                    |
| **Medium**   | Information disclosure in logs or error messages (account IDs, broken redaction in one of the layered redactors, CVE in a dependency) — escalates to **High** when the redaction is broken across all layers AND the leaked value is observable in the audit log or telemetry export |
| **Low**      | Locally exploitable issues requiring operator cooperation; hardening suggestions                                                                                                                                                                                                     |

## Safe Harbour

Security research conducted in good faith is welcome. We will not pursue
legal action against reporters who:

- Make a reasonable effort to avoid privacy violations, data destruction,
  and service interruptions (denial-of-service is out of scope).
- Only test against AWS accounts they own or have explicit permission to
  test against.
- Do not access, modify, or exfiltrate data beyond the minimum necessary
  to demonstrate the vulnerability.
- Give us reasonable time to remediate before public disclosure.

## Security Hardening Already Shipped

- All shipped MCP server pins are content-hashed in
  `packages/best-practices/manifest.json`.
- Checkpoint files are created with `0o700` directory / `0o600` file
  permissions (see `packages/core/src/checkpoint/store.ts`).
- The destroy path validates the `managed-by=assignee-ai` tag twice to
  close a TOCTOU window against `tag:UntagResources` principals (see
  `docs/explanation/invariants.md` under "Destroy TOCTOU window").
- Preflight rejects LLM-hallucinated placeholder ARNs
  (`arn:aws:iam::123456789012:…`) before they reach CloudControl.
- Bulk-destroy was removed in v1 — the safety-allowlist's existence
  was a tacit admission that bulk-destroy was too dangerous to ship,
  so per-resource `assignee destroy <arn>` is the only supported
  destroy path. The IAM safety-allowlist constants
  (`AssigneeOperator`, `AssigneeReader`, `AssigneeAuditor`,
  `Bedrock*`) are preserved in the codebase against any future
  bulk-sweep features so the no-self-lockout guarantee re-applies
  automatically when (or if) such features are revived.
- LLM invocation body logging to CloudWatch is **off by default**; the
  operator must opt in with `assignee setup --enable-llm-logging`.

See `docs/explanation/invariants.md` for the full list of load-bearing
security invariants.
