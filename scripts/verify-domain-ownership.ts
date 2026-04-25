/**
 * verify-domain-ownership.ts — W9-03 (P060 → L1-F37 + L2-F18 + L4-S24)
 *
 * Checks TXT records for a domain-ownership proof string. Used to verify
 * that assignee.ai and app.assignee.ai are under the expected team's control.
 *
 * Usage:
 *   npx tsx scripts/verify-domain-ownership.ts --domain assignee.ai --proof "assignee-verification=<token>"
 *   npx tsx scripts/verify-domain-ownership.ts --domain app.assignee.ai --proof "assignee-verification=<token>"
 *
 * Output (stdout, JSON):
 *   {
 *     "domain": "assignee.ai",
 *     "proof": "assignee-verification=abc123",
 *     "found": true,
 *     "records": ["assignee-verification=abc123", "v=spf1 ..."],
 *     "ok": true
 *   }
 *
 * Exit codes:
 *   0 — proof string found in TXT records
 *   1 — proof string not found / DNS error / bad arguments
 *
 * The proof string is placed in DNS as a TXT record by the domain owner.
 * See docs/explanation/domain-ownership.md for the full verification flow
 * and remediation instructions.
 *
 * WARNING: Do NOT import from @assignee/core or workspace packages here.
 * This script runs outside the workspace build.
 */

import * as dns from "node:dns/promises";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface OwnershipResult {
  domain: string;
  proof: string;
  found: boolean;
  records: string[];
  ok: boolean;
  error?: string;
}

// ── Core logic (exported for unit tests) ─────────────────────────────────────

/**
 * Flatten nested TXT record arrays into a flat string array.
 * DNS TXT records are returned as string[][] (each record is an array of
 * character strings that should be concatenated).
 */
export function flattenTxtRecords(rawRecords: string[][]): string[] {
  return rawRecords.map((chunks) => chunks.join(""));
}

/**
 * Check whether `proof` appears in any of the TXT records for `domain`.
 * Returns a structured result.
 */
export async function verifyOwnership(
  domain: string,
  proof: string,
  resolver: {
    resolveTxt: (domain: string) => Promise<string[][]>;
  } = dns,
): Promise<OwnershipResult> {
  const rawRecords = await resolver.resolveTxt(domain);
  const records = flattenTxtRecords(rawRecords);
  const found = records.some((r) => r.includes(proof));
  return {
    domain,
    proof,
    found,
    records,
    ok: found,
  };
}

// ── CLI ───────────────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): { domain?: string; proof?: string } {
  const args: { domain?: string; proof?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--domain" && i + 1 < argv.length) {
      args.domain = argv[++i];
    } else if (argv[i] === "--proof" && i + 1 < argv.length) {
      args.proof = argv[++i];
    }
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (!args.domain || !args.proof) {
    console.error(
      "verify-domain-ownership: error — pass --domain <domain> --proof <proof-string>",
    );
    console.error(
      '  Example: npx tsx scripts/verify-domain-ownership.ts --domain assignee.ai --proof "assignee-verification=abc123"',
    );
    console.error(
      "  See docs/explanation/domain-ownership.md for the proof string.",
    );
    process.exit(1);
  }

  const { domain, proof } = args;

  let result: OwnershipResult;
  try {
    result = await verifyOwnership(domain, proof);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    result = {
      domain,
      proof,
      found: false,
      records: [],
      ok: false,
      error: msg,
    };
  }

  console.log(JSON.stringify(result, null, 2));

  if (!result.ok) {
    const detail = result.error
      ? `DNS error: ${result.error}`
      : `proof string "${proof}" not found in TXT records`;
    console.error(`verify-domain-ownership: FAIL — ${detail}`);
    console.error("  Remediation steps:");
    console.error(`    1. Log in to the DNS provider for ${domain}.`);
    console.error(`    2. Add a TXT record with value: ${proof}`);
    console.error("    3. Wait for DNS propagation (up to 48 hours).");
    console.error("    4. Re-run this script.");
    console.error("  See docs/explanation/domain-ownership.md for details.");
    process.exit(1);
  }

  console.error(
    `verify-domain-ownership: OK — proof found in TXT records for ${domain}`,
  );
}

// Only run main() when executed directly (not when imported by tests)
const isMain =
  process.argv[1]?.endsWith("verify-domain-ownership.ts") ||
  process.argv[1]?.endsWith("verify-domain-ownership.js");
if (isMain) {
  main().catch((err: unknown) => {
    console.error("verify-domain-ownership: unexpected error:", err);
    process.exit(1);
  });
}
