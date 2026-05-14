import { describe, it, expect } from "vitest";
import { extractDbInstanceClass } from "./compute-extractors.js";
import { isValidDbInstanceClass } from "../validators/token-validators.js";

/**
 * Unit tests for `extractDbInstanceClass` (SX-3 / PH1-F-1 + DF-E1).
 *
 * Closure criteria:
 *   - User-asserted `db.t4g.*` / `db.r6g.*` tokens are captured VERBATIM.
 *   - All documented family prefixes are accepted.
 *   - Default `db.t3.micro` fallback is NOT the extractor's job — the
 *     extractor simply leaves `DBInstanceClass` absent when no class is
 *     mentioned; downstream defaults fill that gap.
 *   - Unknown families emit a user-visible error, NOT a silent fallback.
 *
 * Probe variations (spec §"Probe plan"):
 *   A — Graviton class explicit    (db.t4g.micro)
 *   B — Memory-optimised class     (db.r6g.large)
 *   C — General-purpose            (db.m5.xlarge)
 *   D — Default fallback           (no class in intent → DBInstanceClass absent)
 *   E — Invalid class              (db.zz.xxlarge → error)
 *   F — Class followed by env hint (db.t4g.micro for staging → still captured)
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function run(intent: string): {
  elicited: Record<string, unknown>;
  errors: string[];
} {
  const elicited: Record<string, unknown> = {};
  const errors: string[] = [];
  extractDbInstanceClass(intent, intent.toLowerCase(), elicited, errors);
  return { elicited, errors };
}

// ---------------------------------------------------------------------------
// isValidDbInstanceClass validator
// ---------------------------------------------------------------------------

describe("isValidDbInstanceClass", () => {
  it("accepts db.t3.micro (classic default)", () => {
    expect(isValidDbInstanceClass("db.t3.micro")).toBe(true);
  });

  it("accepts db.t4g.micro (Graviton burstable)", () => {
    expect(isValidDbInstanceClass("db.t4g.micro")).toBe(true);
  });

  it("accepts db.r6g.large (Graviton memory-optimised)", () => {
    expect(isValidDbInstanceClass("db.r6g.large")).toBe(true);
  });

  it("accepts db.m5.xlarge (general-purpose)", () => {
    expect(isValidDbInstanceClass("db.m5.xlarge")).toBe(true);
  });

  it("accepts db.m6i.2xlarge (general-purpose Intel)", () => {
    expect(isValidDbInstanceClass("db.m6i.2xlarge")).toBe(true);
  });

  it("accepts db.m7g.large (general-purpose Graviton 3)", () => {
    expect(isValidDbInstanceClass("db.m7g.large")).toBe(true);
  });

  it("accepts db.r5.large (memory-optimised Intel)", () => {
    expect(isValidDbInstanceClass("db.r5.large")).toBe(true);
  });

  it("accepts db.r6i.xlarge (memory-optimised Intel v2)", () => {
    expect(isValidDbInstanceClass("db.r6i.xlarge")).toBe(true);
  });

  it("accepts db.r7g.2xlarge (memory-optimised Graviton 3)", () => {
    expect(isValidDbInstanceClass("db.r7g.2xlarge")).toBe(true);
  });

  it("accepts db.x1e.xlarge (extreme memory)", () => {
    expect(isValidDbInstanceClass("db.x1e.xlarge")).toBe(true);
  });

  it("accepts db.x2g.large (Graviton2 extreme memory)", () => {
    expect(isValidDbInstanceClass("db.x2g.large")).toBe(true);
  });

  it("rejects plain t3.micro (missing db. prefix)", () => {
    expect(isValidDbInstanceClass("t3.micro")).toBe(false);
  });

  it("rejects db.zz.xxlarge (unknown family)", () => {
    expect(isValidDbInstanceClass("db.zz.xxlarge")).toBe(false);
  });

  it("rejects db.t4g.huge (unknown size suffix)", () => {
    expect(isValidDbInstanceClass("db.t4g.huge")).toBe(false);
  });

  it("rejects db.t99.micro (hallucinated family number)", () => {
    expect(isValidDbInstanceClass("db.t99.micro")).toBe(false);
  });

  it("is case-insensitive (DB.T4G.MICRO accepted)", () => {
    expect(isValidDbInstanceClass("DB.T4G.MICRO")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// extractDbInstanceClass — Variation A: Graviton burstable class explicit
// ---------------------------------------------------------------------------

describe("extractDbInstanceClass — Variation A (Graviton explicit)", () => {
  it("captures db.t4g.micro verbatim", () => {
    const { elicited, errors } = run("Create an RDS Postgres db.t4g.micro");
    expect(errors).toHaveLength(0);
    expect(elicited["DBInstanceClass"]).toBe("db.t4g.micro");
  });

  it("does NOT demote db.t4g.micro to db.t3.micro", () => {
    const { elicited } = run("Create an RDS Postgres db.t4g.micro for staging");
    expect(elicited["DBInstanceClass"]).not.toBe("db.t3.micro");
    expect(elicited["DBInstanceClass"]).toBe("db.t4g.micro");
  });
});

// ---------------------------------------------------------------------------
// Variation B: Memory-optimised class
// ---------------------------------------------------------------------------

describe("extractDbInstanceClass — Variation B (memory-optimised)", () => {
  it("captures db.r6g.large", () => {
    const { elicited, errors } = run("RDS Postgres db.r6g.large");
    expect(errors).toHaveLength(0);
    expect(elicited["DBInstanceClass"]).toBe("db.r6g.large");
  });

  it("captures db.r5.xlarge", () => {
    const { elicited, errors } = run(
      "Set up an RDS MySQL db.r5.xlarge instance",
    );
    expect(errors).toHaveLength(0);
    expect(elicited["DBInstanceClass"]).toBe("db.r5.xlarge");
  });
});

// ---------------------------------------------------------------------------
// Variation C: General-purpose class
// ---------------------------------------------------------------------------

describe("extractDbInstanceClass — Variation C (general-purpose)", () => {
  it("captures db.m5.xlarge", () => {
    const { elicited, errors } = run("RDS MySQL db.m5.xlarge");
    expect(errors).toHaveLength(0);
    expect(elicited["DBInstanceClass"]).toBe("db.m5.xlarge");
  });

  it("captures db.m6g.large (Graviton general)", () => {
    const { elicited, errors } = run(
      "Provision an RDS instance db.m6g.large postgres",
    );
    expect(errors).toHaveLength(0);
    expect(elicited["DBInstanceClass"]).toBe("db.m6g.large");
  });

  it("captures db.m7g.2xlarge (Graviton 3 general)", () => {
    const { elicited, errors } = run("New RDS aurora db.m7g.2xlarge");
    expect(errors).toHaveLength(0);
    expect(elicited["DBInstanceClass"]).toBe("db.m7g.2xlarge");
  });
});

// ---------------------------------------------------------------------------
// Variation D: Default fallback — no class in intent
// ---------------------------------------------------------------------------

describe("extractDbInstanceClass — Variation D (default fallback)", () => {
  it("leaves DBInstanceClass absent when intent has no db.*.* token", () => {
    const { elicited, errors } = run(
      "Create an RDS Postgres database for production",
    );
    expect(errors).toHaveLength(0);
    expect("DBInstanceClass" in elicited).toBe(false);
  });

  it("leaves DBInstanceClass absent for a plain 'RDS Postgres' intent", () => {
    const { elicited, errors } = run("RDS Postgres");
    expect(errors).toHaveLength(0);
    expect("DBInstanceClass" in elicited).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Variation E: Invalid class — should emit error, NOT silent fallback
// ---------------------------------------------------------------------------

describe("extractDbInstanceClass — Variation E (invalid class)", () => {
  it("emits error for db.zz.xxlarge (unknown family)", () => {
    const { elicited, errors } = run("Create an RDS Postgres db.zz.xxlarge");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/Unknown RDS DB instance class/);
    expect(errors[0]).toMatch(/db\.zz\.xxlarge/i);
    expect("DBInstanceClass" in elicited).toBe(false);
  });

  it("emits error for db.t4g.huge (unknown size suffix)", () => {
    const { elicited, errors } = run("RDS MySQL db.t4g.huge");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/Unknown RDS DB instance class/);
    expect("DBInstanceClass" in elicited).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Variation F: Class followed by environment hint
// ---------------------------------------------------------------------------

describe("extractDbInstanceClass — Variation F (trailing env clause)", () => {
  it("captures db.t4g.micro regardless of trailing 'for staging'", () => {
    const { elicited, errors } = run(
      "Create an RDS Postgres db.t4g.micro for staging",
    );
    expect(errors).toHaveLength(0);
    expect(elicited["DBInstanceClass"]).toBe("db.t4g.micro");
  });

  it("captures db.r6i.xlarge when followed by environment noise", () => {
    const { elicited, errors } = run(
      "Provision RDS MySQL db.r6i.xlarge for the production workload",
    );
    expect(errors).toHaveLength(0);
    expect(elicited["DBInstanceClass"]).toBe("db.r6i.xlarge");
  });
});

// ---------------------------------------------------------------------------
// Guard: extractor is a no-op for non-RDS intents
// ---------------------------------------------------------------------------

describe("extractDbInstanceClass — non-RDS guard", () => {
  it("does nothing for an EC2 intent that happens to mention a dotted token", () => {
    // ec2 alone doesn't trigger mentionsDatabaseEngine
    const { elicited, errors } = run(
      "Create EC2 t3.micro with hostname db.internal.example",
    );
    expect(errors).toHaveLength(0);
    expect("DBInstanceClass" in elicited).toBe(false);
  });
});
