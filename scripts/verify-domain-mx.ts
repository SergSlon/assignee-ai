/**
 * verify-domain-mx.ts — W9-03 (P060 → L1-F37 + L2-F18 + L4-S24)
 *
 * Resolves MX records for a given domain (or the domain part of an email
 * address) and emits structured JSON. Exits 0 on success / non-zero on
 * failure with an actionable error message.
 *
 * Usage:
 *   npx tsx scripts/verify-domain-mx.ts --domain assignee.ai
 *   npx tsx scripts/verify-domain-mx.ts --email security@assignee.ai
 *   npx tsx scripts/verify-domain-mx.ts --domain app.assignee.ai
 *
 * Output (stdout, JSON):
 *   {
 *     "domain": "assignee.ai",
 *     "records": [
 *       { "exchange": "mx1.example.com", "priority": 10 }
 *     ],
 *     "ok": true
 *   }
 *
 * Exit codes:
 *   0 — at least one MX record found
 *   1 — no MX records / DNS error / bad arguments
 *
 * Pre-signing acquirer task: run this script to confirm
 * security@assignee.ai is reachable before signing.
 * See docs/explanation/domain-ownership.md for the full verification flow.
 *
 * WARNING: Do NOT import from @assignee/core or workspace packages here.
 * This script runs outside the workspace build.
 */

import * as dns from "node:dns/promises";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface MxRecord {
  exchange: string;
  priority: number;
}

export interface MxResult {
  domain: string;
  records: MxRecord[];
  ok: boolean;
  error?: string;
}

// ── Core logic (exported for unit tests) ─────────────────────────────────────

/**
 * Extract the domain part from an email address or pass through a bare domain.
 */
export function extractDomain(emailOrDomain: string): string {
  const trimmed = emailOrDomain.trim();
  const atIdx = trimmed.indexOf("@");
  return atIdx >= 0 ? trimmed.slice(atIdx + 1) : trimmed;
}

/**
 * Resolve MX records for a domain. Returns a structured result.
 * Throws if `resolveMx` itself throws (caller catches and wraps).
 */
export async function resolveMxRecords(
  domain: string,
  resolver: { resolveMx: (domain: string) => Promise<MxRecord[]> } = dns,
): Promise<MxResult> {
  const records = await resolver.resolveMx(domain);
  const sorted = [...records].sort((a, b) => a.priority - b.priority);
  return {
    domain,
    records: sorted.map((r) => ({
      exchange: r.exchange,
      priority: r.priority,
    })),
    ok: sorted.length > 0,
  };
}

// ── CLI ───────────────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): { domain?: string; email?: string } {
  const args: { domain?: string; email?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--domain" && i + 1 < argv.length) {
      args.domain = argv[++i];
    } else if (argv[i] === "--email" && i + 1 < argv.length) {
      args.email = argv[++i];
    }
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (!args.domain && !args.email) {
    console.error(
      "verify-domain-mx: error — pass --domain <domain> or --email <address>",
    );
    console.error(
      "  Example: npx tsx scripts/verify-domain-mx.ts --domain assignee.ai",
    );
    process.exit(1);
  }

  const raw = (args.email ?? args.domain) as string;
  const domain = extractDomain(raw);

  let result: MxResult;
  try {
    result = await resolveMxRecords(domain);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    result = {
      domain,
      records: [],
      ok: false,
      error: msg,
    };
  }

  console.log(JSON.stringify(result, null, 2));

  if (!result.ok) {
    console.error(
      `verify-domain-mx: FAIL — no MX records for ${domain}${result.error ? `: ${result.error}` : ""}`,
    );
    console.error("  Remediation: check DNS configuration for the domain.");
    console.error("  See docs/explanation/domain-ownership.md for details.");
    process.exit(1);
  }

  console.error(
    `verify-domain-mx: OK — ${result.records.length} MX record(s) for ${domain}`,
  );
}

// Only run main() when executed directly (not when imported by tests)
const isMain =
  process.argv[1]?.endsWith("verify-domain-mx.ts") ||
  process.argv[1]?.endsWith("verify-domain-mx.js");
if (isMain) {
  main().catch((err: unknown) => {
    console.error("verify-domain-mx: unexpected error:", err);
    process.exit(1);
  });
}
