#!/usr/bin/env tsx
/**
 * Mock-fixture drift detector — Story 48.2.
 *
 * Compares the frozen `apps/cli/src/test-fixtures/mcp-mock-responses.ts`
 * fixture (snapshotted 2026-03-22) against live AWS CloudFormation
 * `DescribeType` responses for the top-20 supported resource types,
 * so schema changes in production can't silently break the runtime
 * while the fixture-backed tests stay green.
 *
 * ── Top-20 selection ────────────────────────────────────────────────
 * The list is **computed**, never hardcoded. Selection method:
 *   1. Take SUPPORTED_TYPES_ARRAY (single source of truth) in its
 *      declaration order (priority Tier-0/1 first).
 *   2. Intersect with `RawSchemasByType` keys (the types the fixture
 *      actually records a schema for — currently 15).
 *   3. Cap at 20. If the intersection has <20 entries, we check all of
 *      them (and the script logs the count so maintainers notice when
 *      the fixture grows).
 *
 * Rationale: we can only detect drift on types the fixture actually
 * records. SUPPORTED_TYPES_ARRAY order ensures priority types come first
 * when the intersection is larger than 20.
 *
 * ── Exit codes ──────────────────────────────────────────────────────
 *   0  clean — no drift (or skipped because no AWS creds)
 *   1  runtime / AWS error
 *   2  drift detected — see mock-fixture-drift-report.json
 *
 * ── Re-baseline procedure ───────────────────────────────────────────
 * If drift is legitimate (AWS added a property, the fixture is stale):
 *   1. Regenerate the affected fixture entries via the recorder flow
 *      (see apps/cli/scripts/capture-mcp-responses.mjs).
 *   2. Review + commit the fixture diff separately from this script.
 *   3. Re-run this script locally against a dev account to confirm
 *      exit 0.
 *
 * ── Local invocation ────────────────────────────────────────────────
 *   pnpm check:mock-fixture-drift
 * (exits 0 with "skipped" log if no AWS creds are set, so local devs
 *  aren't blocked — per feedback_simulate_ci_no_creds.md)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  CloudFormationClient,
  DescribeTypeCommand,
} from "@aws-sdk/client-cloudformation";

import { SUPPORTED_TYPES_ARRAY } from "../packages/core/dist/index.js";
import { RawSchemasByType } from "../apps/cli/src/test-fixtures/mcp-mock-responses.js";

// Schema fields that legitimately change between DescribeType calls or
// aren't part of the resource contract — strip before comparison to
// avoid spurious drift.
const VOLATILE_TOP_LEVEL_KEYS = new Set<string>([
  "$schema",
  "$comment",
  "sourceUrl",
  "documentationUrl",
  "tagging",
]);

interface DriftEntry {
  type: string;
  missingProperties: string[]; // in fixture, absent in live
  typeChangedProperties: Array<{
    property: string;
    fixtureType: unknown;
    liveType: unknown;
  }>;
}

function hasAwsCredentials(): boolean {
  return Boolean(
    process.env.AWS_ACCESS_KEY_ID ||
      process.env.AWS_PROFILE ||
      process.env.AWS_WEB_IDENTITY_TOKEN_FILE ||
      process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI,
  );
}

function pickTopTypes(): string[] {
  const fixtureKeys = new Set(Object.keys(RawSchemasByType));
  const ordered: string[] = [];
  for (const t of SUPPORTED_TYPES_ARRAY) {
    if (fixtureKeys.has(t)) ordered.push(t);
    if (ordered.length >= 20) break;
  }
  // Fail-fast assertion: every picked type is in both sources by
  // construction, but sanity-check anyway.
  for (const t of ordered) {
    if (!fixtureKeys.has(t)) {
      throw new Error(
        `Selection inconsistency: ${t} not present in RawSchemasByType`,
      );
    }
    if (!(SUPPORTED_TYPES_ARRAY as readonly string[]).includes(t)) {
      throw new Error(
        `Selection inconsistency: ${t} not present in SUPPORTED_TYPES_ARRAY`,
      );
    }
  }
  return ordered;
}

function stripVolatile(schema: Record<string, unknown>): Record<string, unknown> {
  const copy: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema)) {
    if (!VOLATILE_TOP_LEVEL_KEYS.has(k)) copy[k] = v;
  }
  return copy;
}

function diffSchemas(
  type: string,
  fixture: Record<string, unknown>,
  live: Record<string, unknown>,
): DriftEntry | null {
  const f = stripVolatile(fixture);
  const l = stripVolatile(live);

  const fixtureProps = (f.properties ?? {}) as Record<string, { type?: unknown }>;
  const liveProps = (l.properties ?? {}) as Record<string, { type?: unknown }>;

  const missingProperties: string[] = [];
  const typeChangedProperties: DriftEntry["typeChangedProperties"] = [];

  for (const [propName, propDef] of Object.entries(fixtureProps)) {
    if (!(propName in liveProps)) {
      // Property recorded in the fixture no longer exists live — drift.
      missingProperties.push(propName);
      continue;
    }
    // Fixtures are trimmed to a subset of properties, so we can't check
    // the reverse direction (live-only props). We only care about
    // properties the fixture asserts exist + what type they are.
    const fixtureType = (propDef as { type?: unknown })?.type;
    const liveType = (liveProps[propName] as { type?: unknown })?.type;
    if (
      fixtureType !== undefined &&
      JSON.stringify(fixtureType) !== JSON.stringify(liveType)
    ) {
      typeChangedProperties.push({ property: propName, fixtureType, liveType });
    }
  }

  if (missingProperties.length === 0 && typeChangedProperties.length === 0) {
    return null;
  }
  return { type, missingProperties, typeChangedProperties };
}

async function describeLiveSchema(
  client: CloudFormationClient,
  typeName: string,
): Promise<Record<string, unknown>> {
  const out = await client.send(
    new DescribeTypeCommand({ Type: "RESOURCE", TypeName: typeName }),
  );
  if (!out.Schema) {
    throw new Error(`DescribeType returned no Schema for ${typeName}`);
  }
  return JSON.parse(out.Schema) as Record<string, unknown>;
}

async function main(): Promise<number> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(
      "Usage: pnpm check:mock-fixture-drift\n\n" +
        "Exits 0 when clean, 2 when drift detected, 1 on runtime error.\n" +
        "Skips (exit 0) if no AWS credentials are configured.",
    );
    return 0;
  }

  if (!hasAwsCredentials()) {
    console.log("skipped: no AWS credentials — drift check requires cloudformation:DescribeType");
    return 0;
  }

  const types = pickTopTypes();
  console.log(`Checking ${types.length} types against live CloudFormation DescribeType...`);
  console.log(types.map((t) => `  - ${t}`).join("\n"));

  const region = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "us-east-1";
  const client = new CloudFormationClient({ region });

  const drifts: DriftEntry[] = [];
  for (const type of types) {
    try {
      const live = await describeLiveSchema(client, type);
      const fixture = RawSchemasByType[type] as Record<string, unknown>;
      const drift = diffSchemas(type, fixture, live);
      if (drift) {
        drifts.push(drift);
        console.log(
          `  ✗ ${type} — ${drift.missingProperties.length} missing, ${drift.typeChangedProperties.length} type-changed`,
        );
      } else {
        console.log(`  ✓ ${type}`);
      }
    } catch (err) {
      console.error(`::error::Failed to check ${type}: ${(err as Error).message}`);
      return 1;
    }
  }

  if (drifts.length > 0) {
    const report = {
      generatedAt: new Date().toISOString(),
      driftedTypeCount: drifts.length,
      drifts,
    };
    const outPath = path.resolve(process.cwd(), "mock-fixture-drift-report.json");
    fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
    console.error(
      `::error::Drift detected in ${drifts.length} type(s). Report written to ${outPath}`,
    );
    return 2;
  }

  console.log(`✓ Clean — zero drift across ${types.length} types.`);
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error("::error::Unhandled error:", err);
    process.exit(1);
  });
