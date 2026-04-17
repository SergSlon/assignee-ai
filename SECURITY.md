# Security Policy

Assignee.ai is an Infrastructure-as-Code (IaC) tool that ingests AWS
credentials and provisions real cloud resources. A vulnerability here can
translate directly into AWS account compromise or unauthorized resource
mutation, so we treat security disclosures with high priority.

## Supported Versions

The project is pre-1.0 and under active development. Only the `main` branch
is supported for security fixes. Tagged releases older than 90 days may not
receive patches — upgrade to the latest `main` or the most recent release.

| Version       | Supported          |
| ------------- | ------------------ |
| `main` branch | Yes                |
| `0.1.x`       | Yes (latest patch) |
| Older         | No                 |

## Reporting a Vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

Report privately via one of the following channels:

- **Email**: `security@assignee.ai` (preferred).
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

### PGP

If you need to send an encrypted report, request the current project PGP
key over the same email channel and we will send it out-of-band.

## What to Expect

- **Acknowledgement**: within **72 hours** of receipt.
- **Initial triage**: within **7 days** — severity assignment, scope
  confirmation, and a planned remediation window.
- **Resolution window**: we aim to ship a fix or a documented mitigation
  within **90 days** of acknowledgement. Critical issues (remote code
  execution, credential exfiltration, cross-tenant data access in SaaS
  deployments) target **30 days** or faster.
- **Coordinated disclosure**: we will coordinate a public disclosure date
  with the reporter. Default window is **90 days** from the initial
  report, or earlier if a fix is already shipped and adopted.
- **Credit**: with the reporter's consent, we credit the finder in the
  release notes and the `CHANGELOG.md` entry.

## Scope

In-scope:

- The CLI (`apps/cli`), MCP server (`apps/mcp-server`), and core library
  (`packages/core`, `packages/best-practices`) in this repository.
- Documented integration paths (Cursor, Claude Code, Windsurf via MCP).
- The shipped IAM policy templates in
  `packages/core/src/config/iam-policies.ts`.

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

| Severity     | Example                                                                                             |
| ------------ | --------------------------------------------------------------------------------------------------- |
| **Critical** | Arbitrary code execution on the user's machine; exfiltration of AWS credentials or Bedrock API keys |
| **High**     | Bypass of typed-confirm / safety allowlist; cross-account privilege escalation via plan injection   |
| **Medium**   | Information disclosure in logs or error messages (PII, account IDs), broken redaction, CVE in dep   |
| **Low**      | Locally exploitable issues requiring operator cooperation; hardening suggestions                    |

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
- IAM-role safety allowlist prevents `destroy --include-iam` from
  self-locking the operator (feature also removed in Story 50-3 — the
  threat is now mitigated by absence).
- LLM invocation body logging to CloudWatch is **off by default**; the
  operator must opt in with `assignee setup --enable-llm-logging`.

See `docs/explanation/invariants.md` for the full list of load-bearing
security invariants.
