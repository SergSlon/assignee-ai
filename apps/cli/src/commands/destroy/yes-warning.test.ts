/**
 * Tests for the shared `--yes`-in-TTY warning helper.
 *
 * Polish item 2 (2026-05-09): the warning was previously emitted by two
 * duplicated blocks (`single-flow.ts` + `destroy.ts:confirmDestroy`) and
 * fired for every per-key iteration of `assignee destroy --all` despite
 * the bulk parent already having collected typed-account-ID
 * confirmation. The helper consolidates the emission and adds a
 * `noConfirm` suppression channel for the bulk-destroy parent to thread
 * through, without introducing a new public CLI flag.
 */

import { describe, it, expect } from "vitest";
import { Writable } from "node:stream";
import { maybeWarnYesInTty } from "./yes-warning.js";

/**
 * In-memory stderr stand-in. Real-data shape: a real `Writable`
 * stream so `maybeWarnYesInTty`'s `stderr.write(string)` call goes
 * through the same code path as production.
 */
function buildStderrCollector(): { stderr: Writable; capture: () => string } {
  const chunks: string[] = [];
  const stderr = new Writable({
    write(
      chunk: Buffer | string,
      _enc: BufferEncoding,
      cb: (err?: Error | null) => void,
    ) {
      chunks.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
      cb();
    },
  });
  return { stderr, capture: () => chunks.join("") };
}

describe("maybeWarnYesInTty", () => {
  const expectedWarning =
    "Warning: --yes flag used in interactive session. Auto-confirming destroy.\n";

  it("emits the warning when yes=true and stdout is a TTY", () => {
    const { stderr, capture } = buildStderrCollector();
    maybeWarnYesInTty({ yes: true }, stderr, true);
    expect(capture()).toBe(expectedWarning);
  });

  it("suppresses the warning when noConfirm=true (bulk-destroy already confirmed)", () => {
    // The bulk-destroy parent (`runBulkDestroyAction`) collects a typed
    // `DESTROY-EVERYTHING` / account-ID confirmation once at the top of
    // the run, then threads `noConfirm: true` into each per-resource
    // invocation. The helper must respect that signal so 5×, 20×, 100×
    // bulk runs don't print the per-key warning that cluttered the
    // pre-polish output.
    const { stderr, capture } = buildStderrCollector();
    maybeWarnYesInTty({ yes: true, noConfirm: true }, stderr, true);
    expect(capture()).toBe("");
  });

  it("suppresses the warning when yes is unset (the warning is yes-specific)", () => {
    const { stderr, capture } = buildStderrCollector();
    maybeWarnYesInTty({ yes: false }, stderr, true);
    expect(capture()).toBe("");
  });

  it("suppresses the warning when yes is undefined", () => {
    const { stderr, capture } = buildStderrCollector();
    maybeWarnYesInTty({}, stderr, true);
    expect(capture()).toBe("");
  });

  it("suppresses the warning when stdout is not a TTY (CI/CD context)", () => {
    // Non-TTY runs are CI/CD by definition; the warning is a human-
    // readable nudge that doesn't belong in pipe-friendly output.
    const { stderr, capture } = buildStderrCollector();
    maybeWarnYesInTty({ yes: true }, stderr, false);
    expect(capture()).toBe("");
  });

  it("suppresses both gates together (noConfirm=true + non-TTY) without double-effect", () => {
    const { stderr, capture } = buildStderrCollector();
    maybeWarnYesInTty({ yes: true, noConfirm: true }, stderr, false);
    expect(capture()).toBe("");
  });

  it("emits exactly once per call (no accidental fan-out)", () => {
    const { stderr, capture } = buildStderrCollector();
    maybeWarnYesInTty({ yes: true }, stderr, true);
    const out = capture();
    // Count occurrences of the unique substring "Warning:" — one call
    // → one warning, even if the wording changes later.
    const matches = out.match(/Warning:/g) ?? [];
    expect(matches.length).toBe(1);
  });
});
