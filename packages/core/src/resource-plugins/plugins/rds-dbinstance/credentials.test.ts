/**
 * Tests for RDS credentials post-processor (RG-1 / DF-E5 — Solution C).
 *
 * Probe variations:
 *   A — no password in elicited or desiredState → placeholder injected
 *   B — explicit --set MasterUserPassword → honoured, no placeholder
 *   C — display masking unit test (placeholder shown, real value masked)
 *   D — audit-log redaction (MasterUserPassword already in SENSITIVE_KEY_NAMES)
 *   E — no-regression on MasterUsername (non-sensitive, renders as-is)
 */

import { describe, it, expect } from "vitest";
import { injectMasterPasswordPlaceholderIfAbsent } from "./credentials.js";
import { RDS_REQUIRED_PASSWORD_PLACEHOLDER } from "@/config/placeholder-passwords.js";
import {
  MASKED_DISPLAY,
  formatDesiredState,
} from "@/utils/display-helpers/format-desired-state.js";
import {
  redactSensitiveFields,
  REDACTED_VALUE,
} from "@/checkpoint/redaction.js";

// ── Variation A — no password provided ──────────────────────────────────────

describe("injectMasterPasswordPlaceholderIfAbsent", () => {
  it("Var-A: injects placeholder when MasterUserPassword absent from both elicited and desiredState", () => {
    const ds: Record<string, unknown> = {
      DBInstanceClass: "db.t3.micro",
      Engine: "postgres",
      MasterUsername: "appuser",
    };
    injectMasterPasswordPlaceholderIfAbsent(ds, {});
    expect(ds["MasterUserPassword"]).toBe(RDS_REQUIRED_PASSWORD_PLACEHOLDER);
  });

  it("Var-A: injects placeholder when elicitedOptions is undefined", () => {
    const ds: Record<string, unknown> = { Engine: "mysql" };
    injectMasterPasswordPlaceholderIfAbsent(ds, undefined);
    expect(ds["MasterUserPassword"]).toBe(RDS_REQUIRED_PASSWORD_PLACEHOLDER);
  });

  // ── Variation B — explicit --set MasterUserPassword honoured ─────────────

  it("Var-B: does NOT inject placeholder when elicitedOptions has a real password (desiredState may also carry it)", () => {
    // When --set MasterUserPassword=secretpass123, the LLM already puts it in desiredState.
    // Here we verify: if desiredState has the real value, nothing is overwritten.
    const ds: Record<string, unknown> = {
      Engine: "postgres",
      MasterUserPassword: "secretpass123",
    };
    injectMasterPasswordPlaceholderIfAbsent(ds, {
      MasterUserPassword: "secretpass123",
    });
    expect(ds["MasterUserPassword"]).toBe("secretpass123");
  });

  it("Var-B: does NOT inject placeholder when desiredState already has a real password", () => {
    const ds: Record<string, unknown> = {
      Engine: "postgres",
      MasterUserPassword: "secretpass123",
    };
    injectMasterPasswordPlaceholderIfAbsent(ds, {});
    expect(ds["MasterUserPassword"]).toBe("secretpass123");
  });

  it("Var-B: treats empty-string elicited as absent — injects placeholder", () => {
    const ds: Record<string, unknown> = { Engine: "postgres" };
    injectMasterPasswordPlaceholderIfAbsent(ds, { MasterUserPassword: "" });
    expect(ds["MasterUserPassword"]).toBe(RDS_REQUIRED_PASSWORD_PLACEHOLDER);
  });
});

// ── Variation C — display masking ────────────────────────────────────────────

describe("formatDesiredState — MasterUserPassword masking", () => {
  it("Var-C: shows placeholder text verbatim (not masked)", () => {
    const result = formatDesiredState({
      Engine: "postgres",
      MasterUserPassword: RDS_REQUIRED_PASSWORD_PLACEHOLDER,
    });
    expect(result).toContain(RDS_REQUIRED_PASSWORD_PLACEHOLDER);
    expect(result).not.toContain(MASKED_DISPLAY);
    expect(result).not.toContain("********");
  });

  it("Var-C: masks real password value as <<masked>>", () => {
    const result = formatDesiredState({
      Engine: "postgres",
      MasterUserPassword: "secretpass123",
    });
    expect(result).toContain(MASKED_DISPLAY);
    expect(result).not.toContain("secretpass123");
  });

  it("Var-C: direct masking — non-placeholder value renders as <<masked>>", () => {
    const r = formatDesiredState({ MasterUserPassword: "realsecret" });
    // The display uses a friendly label (e.g. "Master Password") not the raw key
    expect(r).toContain(MASKED_DISPLAY);
    expect(r).not.toContain("realsecret");
  });

  // ── Variation E — MasterUsername non-regression ──────────────────────────

  it("Var-E: MasterUsername (non-sensitive) renders its value normally", () => {
    const result = formatDesiredState({
      MasterUsername: "appuser",
      MasterUserPassword: RDS_REQUIRED_PASSWORD_PLACEHOLDER,
    });
    expect(result).toContain("appuser");
    // MasterUsername must NOT be masked
    expect(result).not.toMatch(/MasterUsername.*\*{3}/);
    expect(result).not.toMatch(/MasterUsername.*<<masked>>/);
  });
});

// ── Variation D — audit-log redaction ────────────────────────────────────────

describe("audit-log redaction — MasterUserPassword", () => {
  it("Var-D: checkpoint redactor strips MasterUserPassword real value", () => {
    const ds = {
      Engine: "postgres",
      MasterUsername: "appuser",
      MasterUserPassword: "secretpass123",
    };
    const redacted = redactSensitiveFields(ds);
    expect(redacted["MasterUserPassword"]).toBe(REDACTED_VALUE);
    expect(JSON.stringify(redacted)).not.toContain("secretpass123");
  });

  it("Var-D: checkpoint redactor also redacts the placeholder sentinel (belt-and-suspenders)", () => {
    const ds = {
      MasterUserPassword: RDS_REQUIRED_PASSWORD_PLACEHOLDER,
    };
    const redacted = redactSensitiveFields(ds);
    expect(redacted["MasterUserPassword"]).toBe(REDACTED_VALUE);
  });

  it("Var-D: real password does not appear in serialized checkpoint", () => {
    const ds = { MasterUserPassword: "secretpass123" };
    const redacted = redactSensitiveFields(ds);
    expect(JSON.stringify(redacted)).not.toContain("secretpass123");
  });
});
