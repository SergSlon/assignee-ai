/**
 * Epic 35 — Actionable Findings test matrix.
 * Tests for: formatFindings display (TTY + non-TTY), formatAutoFixHint via
 * renderPlanBox, promptFixSelection, FixCommandResolver with real BP data,
 * and deepMergePatch prototype pollution guard.
 *
 * Split from display.test.ts (W19-S1).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { BPFinding } from "@assignee/best-practices";
import {
  captureStream,
  mockState,
  s3PublicAccessFinding,
  s3PublicPolicyFinding,
  s3IgnorePublicAclsFinding,
  s3RestrictPublicBucketsFinding,
  s3EncryptionFinding,
  ec2EbsEncryptionFinding,
  s3LifecycleFinding,
  s3VersioningInfoFinding,
  manualFindingWithHint,
} from "./__tests__/display-test-utils.js";
import { resolveAction } from "./fix-command-resolver.js";

// ── @clack/prompts mock ───────────────────────────────────────────────────────

vi.mock("@clack/prompts", () => ({
  confirm: vi.fn(),
  select: vi.fn(),
  text: vi.fn(),
  multiselect: vi.fn(),
  autocomplete: vi.fn(),
  autocompleteMultiselect: vi.fn(),
  isCancel: vi.fn(() => false),
  cancel: vi.fn(),
  note: vi.fn(),
  log: { info: vi.fn() },
}));

const { select, isCancel } = await import("@clack/prompts");

// ── Epic 35 test matrix ───────────────────────────────────────────────────────

describe("Epic 35 — Actionable Findings test matrix", () => {
  // ── A. formatFindings display ──────────────────────────────────────────────

  describe("A. formatFindings display", () => {
    describe("TTY mode", () => {
      beforeEach(() => {
        Object.defineProperty(process.stdout, "isTTY", {
          value: true,
          configurable: true,
        });
      });
      afterEach(() => {
        Object.defineProperty(process.stdout, "isTTY", {
          value: undefined,
          configurable: true,
        });
      });

      it("1. findings show title on first line, hint on second line with → prefix", async () => {
        const { formatFindings } = await import("./display.js");
        const result = formatFindings([s3PublicAccessFinding]);
        const lines = result.split("\n");
        // First line is summary, then finding title, then hint
        // Tier C: dropped redundant toBeDefined() — find!()
        const titleLine = lines.find((l) =>
          l.includes("Block S3 Public Access"),
        )!;
        const titleIdx = lines.indexOf(titleLine);
        const hintLine = lines[titleIdx + 1];
        expect(hintLine).toContain("→");
      });

      it("includes ⚠ Risk: line when finding has consequence (TTY)", async () => {
        const { formatFindings } = await import("./display.js");
        const findingWithConsequence: BPFinding = {
          practiceId: "BP-S3-001",
          title: "Block S3 Public Access",
          severity: "CRITICAL",
          category: "security",
          message: "S3 bucket allows public access via ACLs",
          remediation: "Enable PublicAccessBlockConfiguration on the bucket",
          blocking: true,
          autoFixable: true,
          propertyPath: "PublicAccessBlockConfiguration.BlockPublicAcls",
          consequence:
            "Anyone on the internet can read bucket contents via ACLs.",
          desiredStatePatch: {
            PublicAccessBlockConfiguration: { BlockPublicAcls: true },
          },
        };
        const result = formatFindings([findingWithConsequence]);
        expect(result).toContain("Risk:");
        expect(result.toLowerCase()).toContain(
          "anyone on the internet can read bucket contents via acls",
        );
      });

      it("omits Risk line when finding has no consequence (TTY)", async () => {
        const { formatFindings } = await import("./display.js");
        const result = formatFindings([s3PublicAccessFinding]);
        expect(result).not.toContain("Risk:");
      });
    });

    describe("non-TTY mode", () => {
      beforeEach(() => {
        Object.defineProperty(process.stdout, "isTTY", {
          value: false,
          configurable: true,
        });
      });
      afterEach(() => {
        Object.defineProperty(process.stdout, "isTTY", {
          value: undefined,
          configurable: true,
        });
      });

      it("2. findings show title with [SEVERITY] marker, hint with -> prefix", async () => {
        const { formatFindings } = await import("./display.js");
        const result = formatFindings([
          s3LifecycleFinding,
          s3VersioningInfoFinding,
        ]);
        expect(result).toContain("[MEDIUM] Configure S3 Lifecycle Rules");
        expect(result).toContain("[INFO] Enable Versioning for Backup");
        // Hints use -> prefix in non-TTY
        const lines = result.split("\n");
        const hintLines = lines.filter((l) => l.includes("->"));
        expect(hintLines.length).toBeGreaterThanOrEqual(2);
      });

      it("3. summary shows '(N fixable)' count when fixable findings exist", async () => {
        const { formatFindings } = await import("./display.js");
        const result = formatFindings([
          s3PublicAccessFinding,
          s3EncryptionFinding,
          s3LifecycleFinding,
        ]);
        // 2 auto-fixable findings (PublicAccess + Encryption)
        expect(result).toMatch(/\(2 fixable\)/);
      });

      it("4. summary does NOT show '(fixable)' when 0 findings are fixable", async () => {
        const { formatFindings } = await import("./display.js");
        const result = formatFindings([
          s3LifecycleFinding,
          s3VersioningInfoFinding,
        ]);
        expect(result).not.toContain("fixable");
      });

      it("5. blocking findings NOT double-counted in medium/info severity", async () => {
        const { formatFindings } = await import("./display.js");
        // s3PublicAccessFinding is blocking + CRITICAL — should appear as blocking, not critical
        const result = formatFindings([
          s3PublicAccessFinding,
          s3LifecycleFinding,
        ]);
        expect(result).toContain("1 blocking");
        expect(result).toContain("1 medium");
        // Should NOT have "1 critical" since the CRITICAL finding is blocking
        expect(result).not.toContain("1 critical");
      });

      it("includes ! Risk: line when finding has consequence (non-TTY)", async () => {
        const { formatFindings } = await import("./display.js");
        const findingWithConsequence: BPFinding = {
          practiceId: "BP-S3-001",
          title: "Block S3 Public Access",
          severity: "CRITICAL",
          category: "security",
          message: "S3 bucket allows public access via ACLs",
          remediation: "Enable PublicAccessBlockConfiguration on the bucket",
          blocking: true,
          autoFixable: true,
          propertyPath: "PublicAccessBlockConfiguration.BlockPublicAcls",
          consequence:
            "Anyone on the internet can read bucket contents via ACLs.",
          desiredStatePatch: {
            PublicAccessBlockConfiguration: { BlockPublicAcls: true },
          },
        };
        const result = formatFindings([findingWithConsequence]);
        expect(result).toContain("! Risk:");
        expect(result).toContain(
          "Anyone on the internet can read bucket contents via ACLs.",
        );
      });

      it("omits Risk line when finding has no consequence (non-TTY)", async () => {
        const { formatFindings } = await import("./display.js");
        const result = formatFindings([s3LifecycleFinding]);
        expect(result).not.toContain("Risk:");
      });

      it("6. each hint line has exactly one of: Fix:, Manual:, Info: prefix", async () => {
        const { formatFindings } = await import("./display.js");
        const result = formatFindings([
          s3PublicAccessFinding, // auto-fixable → Fix:
          s3LifecycleFinding, // manual → Manual:
          s3VersioningInfoFinding, // awareness → Info:
        ]);
        const lines = result.split("\n");
        const hintLines = lines.filter((l) => l.trim().startsWith("->"));
        expect(hintLines.length).toBe(3);
        for (const hl of hintLines) {
          const prefixMatches = [
            hl.includes("Fix:"),
            hl.includes("Manual:"),
            hl.includes("Info:"),
          ].filter(Boolean);
          expect(prefixMatches.length).toBe(1);
        }
      });
    });
  });

  // ── B. formatAutoFixHint ───────────────────────────────────────────────────

  describe("B. formatAutoFixHint (via renderPlanBox)", () => {
    beforeEach(() => {
      Object.defineProperty(process.stdout, "isTTY", {
        value: false,
        configurable: true,
      });
      Object.defineProperty(process.stderr, "isTTY", {
        value: false,
        configurable: true,
      });
    });
    afterEach(() => {
      vi.restoreAllMocks();
      Object.defineProperty(process.stdout, "isTTY", {
        value: undefined,
        configurable: true,
      });
      Object.defineProperty(process.stderr, "isTTY", {
        value: undefined,
        configurable: true,
      });
    });

    it("7. returns null (no hint line) when autoFixEnabled=true", async () => {
      const { renderPlanBox } = await import("./display.js");
      const { chunks, restore } = captureStream(process.stdout);

      renderPlanBox({
        ...mockState,
        autoFixEnabled: true,
        bpFindings: [s3PublicAccessFinding],
      });
      restore();

      const output = chunks.join("");
      expect(output).not.toContain("assignee init");
      expect(output).not.toContain("can be auto-fixed");
    });

    it("8. returns null (no hint line) when no auto-fixable findings", async () => {
      const { renderPlanBox } = await import("./display.js");
      const { chunks, restore } = captureStream(process.stdout);

      renderPlanBox({
        ...mockState,
        autoFixEnabled: false,
        bpFindings: [s3LifecycleFinding, s3VersioningInfoFinding],
      });
      restore();

      const output = chunks.join("");
      expect(output).not.toContain("assignee init");
      expect(output).not.toContain("can be auto-fixed");
    });

    it("9. shows correct count and 'assignee init' message when autoFix disabled + auto-fixable present", async () => {
      const { renderPlanBox } = await import("./display.js");
      const { chunks, restore } = captureStream(process.stdout);

      renderPlanBox({
        ...mockState,
        autoFixEnabled: false,
        bpFindings: [
          s3PublicAccessFinding,
          s3EncryptionFinding,
          s3LifecycleFinding,
        ],
      });
      restore();

      const output = chunks.join("");
      expect(output).toContain("2 findings can be auto-fixed");
      expect(output).toContain("assignee init");
    });

    it("10. shows correct pluralization ('1 finding' vs '2 findings')", async () => {
      const { renderPlanBox } = await import("./display.js");

      // Single auto-fixable
      const { chunks: chunks1, restore: restore1 } = captureStream(
        process.stdout,
      );
      renderPlanBox({
        ...mockState,
        autoFixEnabled: false,
        bpFindings: [s3PublicAccessFinding],
      });
      restore1();
      const output1 = chunks1.join("");
      expect(output1).toContain("1 finding can be auto-fixed");
      expect(output1).not.toContain("1 findings");

      // Multiple auto-fixable
      const { chunks: chunks2, restore: restore2 } = captureStream(
        process.stdout,
      );
      renderPlanBox({
        ...mockState,
        autoFixEnabled: false,
        bpFindings: [s3PublicAccessFinding, s3EncryptionFinding],
      });
      restore2();
      const output2 = chunks2.join("");
      expect(output2).toContain("2 findings can be auto-fixed");
    });
  });

  // ── C. promptFixSelection ──────────────────────────────────────────────────

  describe("C. promptFixSelection", () => {
    it("11. returns null when non-TTY (process.stdin.isTTY = false)", async () => {
      Object.defineProperty(process.stdin, "isTTY", {
        value: false,
        configurable: true,
      });
      const { promptFixSelection } = await import("./display.js");
      const result = await promptFixSelection({
        ...mockState,
        bpFindings: [s3PublicAccessFinding],
      });
      expect(result).toBeNull();
      Object.defineProperty(process.stdin, "isTTY", {
        value: undefined,
        configurable: true,
      });
    });

    it("12. returns null when autoApprove=true", async () => {
      Object.defineProperty(process.stdin, "isTTY", {
        value: true,
        configurable: true,
      });
      const { promptFixSelection } = await import("./display.js");
      const result = await promptFixSelection({
        ...mockState,
        autoApprove: true,
        bpFindings: [s3PublicAccessFinding],
      });
      expect(result).toBeNull();
      Object.defineProperty(process.stdin, "isTTY", {
        value: undefined,
        configurable: true,
      });
    });

    it("13. returns null when no fixable findings", async () => {
      Object.defineProperty(process.stdin, "isTTY", {
        value: true,
        configurable: true,
      });
      const { promptFixSelection } = await import("./display.js");
      const result = await promptFixSelection({
        ...mockState,
        bpFindings: [s3VersioningInfoFinding],
      });
      expect(result).toBeNull();
      Object.defineProperty(process.stdin, "isTTY", {
        value: undefined,
        configurable: true,
      });
    });

    it("14. returns null when no findings have desiredStatePatch (fixable but no patch)", async () => {
      Object.defineProperty(process.stdin, "isTTY", {
        value: true,
        configurable: true,
      });
      const noPatchFinding: BPFinding = {
        practiceId: "BP-S3-050",
        title: "Manual fix only",
        severity: "HIGH",
        category: "security",
        message: "Needs manual intervention",
        blocking: false,
        autoFixable: false,
        propertyPath: "SomeProperty",
      };
      const { promptFixSelection } = await import("./display.js");
      const result = await promptFixSelection({
        ...mockState,
        bpFindings: [noPatchFinding],
      });
      expect(result).toBeNull();
      Object.defineProperty(process.stdin, "isTTY", {
        value: undefined,
        configurable: true,
      });
    });

    it("15. returns null when user chooses 'skip'", async () => {
      Object.defineProperty(process.stdin, "isTTY", {
        value: true,
        configurable: true,
      });
      vi.mocked(select).mockResolvedValueOnce("skip");
      vi.mocked(isCancel).mockReturnValueOnce(false);

      const { promptFixSelection } = await import("./display.js");
      const result = await promptFixSelection({
        ...mockState,
        desiredState: { BucketName: "my-bucket" },
        bpFindings: [s3PublicAccessFinding],
      });
      expect(result).toBeNull();
      Object.defineProperty(process.stdin, "isTTY", {
        value: undefined,
        configurable: true,
      });
    });

    it("16. 'Fix all' applies all patches and returns updated state with correct counts", async () => {
      Object.defineProperty(process.stdin, "isTTY", {
        value: true,
        configurable: true,
      });
      vi.mocked(select).mockResolvedValueOnce("all");
      vi.mocked(isCancel).mockReturnValue(false);

      const { promptFixSelection } = await import("./display.js");
      const result = await promptFixSelection({
        ...mockState,
        desiredState: { BucketName: "my-bucket" },
        bpFindings: [
          s3PublicAccessFinding,
          s3EncryptionFinding,
          s3LifecycleFinding,
        ],
      });

      expect(result).not.toBeNull();
      // Only 2 fixable findings were applied (lifecycle has no patch)
      expect(result!.appliedFixes.length).toBe(2);
      // Residual findings should only contain the non-fixable lifecycle finding
      expect(result!.bpFindings.length).toBe(1);
      expect(result!.bpFindings[0]!.practiceId).toBe("BP-S3-010");
      // Desired state should contain the merged patches
      expect(result!.desiredState).toHaveProperty("BucketName", "my-bucket");
      expect(result!.desiredState).toHaveProperty(
        "PublicAccessBlockConfiguration",
      );
      expect(
        (
          result!.desiredState as {
            PublicAccessBlockConfiguration: { BlockPublicAcls: boolean };
          }
        ).PublicAccessBlockConfiguration.BlockPublicAcls,
      ).toBe(true);
      expect(result!.desiredState).toHaveProperty("BucketEncryption");

      Object.defineProperty(process.stdin, "isTTY", {
        value: undefined,
        configurable: true,
      });
    });

    // ── P0-1: "Choose which" — fix some, skip some ──

    it("P0-1. 'Choose which' applies selected patches and skips others", async () => {
      Object.defineProperty(process.stdin, "isTTY", {
        value: true,
        configurable: true,
      });
      // First select → "choose", then Y for PublicAccess, N for Encryption, Y for PublicPolicy
      vi.mocked(select)
        .mockResolvedValueOnce("choose") // initial menu
        .mockResolvedValueOnce("fix") // finding 1: PublicAccess → fix
        .mockResolvedValueOnce("skip") // finding 2: Encryption → skip
        .mockResolvedValueOnce("fix"); // finding 3: PublicPolicy → fix
      vi.mocked(isCancel).mockReturnValue(false);

      const { promptFixSelection } = await import("./display.js");
      const result = await promptFixSelection({
        ...mockState,
        desiredState: { BucketName: "my-bucket" },
        bpFindings: [
          s3PublicAccessFinding,
          s3EncryptionFinding,
          s3PublicPolicyFinding,
          s3LifecycleFinding, // non-fixable — should stay in residual
        ],
      });

      expect(result).not.toBeNull();
      // Only 2 fixes applied (PublicAccess + PublicPolicy), Encryption was skipped
      expect(result!.appliedFixes.length).toBe(2);
      expect(result!.appliedFixes.map((f) => f.practiceId)).toContain(
        "BP-S3-001",
      );
      expect(result!.appliedFixes.map((f) => f.practiceId)).toContain(
        "BP-S3-001b",
      );
      // Residual: skipped Encryption + non-fixable Lifecycle
      expect(result!.bpFindings.length).toBe(2);
      expect(result!.bpFindings.map((f) => f.practiceId)).toContain(
        "BP-S3-006",
      );
      expect(result!.bpFindings.map((f) => f.practiceId)).toContain(
        "BP-S3-010",
      );
      // DesiredState has patches from fixed findings only
      expect(
        (
          result!.desiredState as {
            PublicAccessBlockConfiguration: { BlockPublicAcls: boolean };
          }
        ).PublicAccessBlockConfiguration.BlockPublicAcls,
      ).toBe(true);
      expect(
        (
          result!.desiredState as {
            PublicAccessBlockConfiguration: { BlockPublicPolicy: boolean };
          }
        ).PublicAccessBlockConfiguration.BlockPublicPolicy,
      ).toBe(true);
      // Encryption patch was skipped — should NOT be in desiredState
      expect(result!.desiredState).not.toHaveProperty("BucketEncryption");

      Object.defineProperty(process.stdin, "isTTY", {
        value: undefined,
        configurable: true,
      });
    });

    // ── P0-2: "Choose which" — skip all → returns null ──

    it("P0-2. 'Choose which' with all skipped returns null", async () => {
      Object.defineProperty(process.stdin, "isTTY", {
        value: true,
        configurable: true,
      });
      vi.mocked(select)
        .mockResolvedValueOnce("choose") // initial menu
        .mockResolvedValueOnce("skip") // finding 1 → skip
        .mockResolvedValueOnce("skip"); // finding 2 → skip
      vi.mocked(isCancel).mockReturnValue(false);

      const { promptFixSelection } = await import("./display.js");
      const result = await promptFixSelection({
        ...mockState,
        desiredState: { BucketName: "my-bucket" },
        bpFindings: [s3PublicAccessFinding, s3EncryptionFinding],
      });

      expect(result).toBeNull();

      Object.defineProperty(process.stdin, "isTTY", {
        value: undefined,
        configurable: true,
      });
    });

    // ── P0-3: Multiple PublicAccessBlock sub-property patches deep-merged ──

    it("P0-3. 'Fix all' merges multiple patches to same top-level key (PublicAccessBlock deep-merge)", async () => {
      Object.defineProperty(process.stdin, "isTTY", {
        value: true,
        configurable: true,
      });
      vi.mocked(select).mockResolvedValueOnce("all");
      vi.mocked(isCancel).mockReturnValue(false);

      const { promptFixSelection } = await import("./display.js");
      const result = await promptFixSelection({
        ...mockState,
        desiredState: { BucketName: "my-bucket" },
        bpFindings: [
          s3PublicAccessFinding,
          s3PublicPolicyFinding,
          s3IgnorePublicAclsFinding,
          s3RestrictPublicBucketsFinding,
        ],
      });

      expect(result).not.toBeNull();
      expect(result!.appliedFixes.length).toBe(4);
      // All 4 findings fixed → residual should be empty
      expect(result!.bpFindings.length).toBe(0);
      // All 4 sub-properties merged into single PublicAccessBlockConfiguration object
      const pab = (
        result!.desiredState as {
          PublicAccessBlockConfiguration: {
            BlockPublicAcls: boolean;
            BlockPublicPolicy: boolean;
            IgnorePublicAcls: boolean;
            RestrictPublicBuckets: boolean;
          };
        }
      ).PublicAccessBlockConfiguration;
      expect(pab.BlockPublicAcls).toBe(true);
      expect(pab.BlockPublicPolicy).toBe(true);
      expect(pab.IgnorePublicAcls).toBe(true);
      expect(pab.RestrictPublicBuckets).toBe(true);

      Object.defineProperty(process.stdin, "isTTY", {
        value: undefined,
        configurable: true,
      });
    });

    // ── P1-4: Cancel during "Choose which" with no fixes yet → returns null ──

    it("P1-4. cancel (stdin closed) during 'Choose which' before any fix returns null", async () => {
      Object.defineProperty(process.stdin, "isTTY", {
        value: true,
        configurable: true,
      });
      // First select → "choose", second select → throws (stdin closed / Ctrl+C)
      vi.mocked(select)
        .mockResolvedValueOnce("choose")
        .mockRejectedValueOnce(new Error("stdin closed"));
      vi.mocked(isCancel).mockReturnValue(false);

      const { promptFixSelection } = await import("./display.js");
      const result = await promptFixSelection({
        ...mockState,
        desiredState: { BucketName: "my-bucket" },
        bpFindings: [s3PublicAccessFinding, s3EncryptionFinding],
      });

      // No fixes were applied before error → null (catch block: fixedIds.size === 0)
      expect(result).toBeNull();

      Object.defineProperty(process.stdin, "isTTY", {
        value: undefined,
        configurable: true,
      });
    });

    // ── P1-5: Cancel during "Choose which" after partial fix → partial result ──

    it("P1-5. cancel during 'Choose which' after partial fix preserves applied fixes", async () => {
      Object.defineProperty(process.stdin, "isTTY", {
        value: true,
        configurable: true,
      });
      // First select → "choose"
      // Second select → "fix" (applies first finding)
      // Third select → cancelled
      vi.mocked(select)
        .mockResolvedValueOnce("choose")
        .mockResolvedValueOnce("fix")
        .mockRejectedValueOnce(new Error("stdin closed")); // simulates Ctrl+C / stdin close
      vi.mocked(isCancel)
        .mockReturnValueOnce(false) // "choose"
        .mockReturnValueOnce(false); // "fix"

      const { promptFixSelection } = await import("./display.js");
      const result = await promptFixSelection({
        ...mockState,
        desiredState: { BucketName: "my-bucket" },
        bpFindings: [s3PublicAccessFinding, s3EncryptionFinding],
      });

      // One fix was applied before the error → partial result preserved
      expect(result).not.toBeNull();
      expect(result!.appliedFixes.length).toBe(1);
      expect(result!.appliedFixes[0]!.practiceId).toBe("BP-S3-001");
      // The fixed finding should be removed from residual
      expect(result!.bpFindings.some((f) => f.practiceId === "BP-S3-001")).toBe(
        false,
      );
      // The unfixed finding should remain
      expect(result!.bpFindings.some((f) => f.practiceId === "BP-S3-006")).toBe(
        true,
      );

      Object.defineProperty(process.stdin, "isTTY", {
        value: undefined,
        configurable: true,
      });
    });
  });

  // ── D. FixCommandResolver with real BP data ────────────────────────────────

  describe("D. FixCommandResolver with real BP data", () => {
    it("17. S3 PublicAccessBlock patches: each sub-property gets its own correct --set flag", () => {
      const actionAcls = resolveAction(s3PublicAccessFinding);
      expect(actionAcls.category).toBe("auto-fixable");
      expect(actionAcls.hint).toContain("--set BlockPublicAcls=true");

      const actionPolicy = resolveAction(s3PublicPolicyFinding);
      expect(actionPolicy.category).toBe("auto-fixable");
      expect(actionPolicy.hint).toContain("--set BlockPublicPolicy=true");

      const actionIgnore = resolveAction(s3IgnorePublicAclsFinding);
      expect(actionIgnore.category).toBe("auto-fixable");
      expect(actionIgnore.hint).toContain("--set IgnorePublicAcls=true");

      const actionRestrict = resolveAction(s3RestrictPublicBucketsFinding);
      expect(actionRestrict.category).toBe("auto-fixable");
      expect(actionRestrict.hint).toContain("--set RestrictPublicBuckets=true");
    });

    it("18. S3 Encryption patch shows --set BucketEncryption=AES256", () => {
      const action = resolveAction(s3EncryptionFinding);
      expect(action.category).toBe("auto-fixable");
      expect(action.fixable).toBe(true);
      expect(action.hint).toContain("--set BucketEncryption=AES256");
    });

    it("19. EC2 EBS encryption patch drills into array to show --set EbsEncrypted=true", () => {
      const action = resolveAction(ec2EbsEncryptionFinding);
      expect(action.category).toBe("auto-fixable");
      expect(action.fixable).toBe(true);
      expect(action.hint).toContain("--set EbsEncrypted=true");
    });

    it("20. Manual finding with fix_hint shows the hint, not raw remediation", () => {
      const action = resolveAction(manualFindingWithHint);
      expect(action.fixable).toBe(false);
      expect(action.hint).toBe(
        "Review CORS requirements for your web application",
      );
      // Must NOT show raw remediation
      expect(action.hint).not.toContain("raw remediation text");
    });
  });

  // ── E. deepMergePatch prototype pollution guard (P2-1) ──────────────────────

  describe("E. deepMergePatch prototype pollution guard", () => {
    it("P2-1. rejects __proto__, constructor, prototype keys in nested patches via promptFixSelection", async () => {
      Object.defineProperty(process.stdin, "isTTY", {
        value: true,
        configurable: true,
      });
      vi.mocked(select).mockResolvedValueOnce("all");
      vi.mocked(isCancel).mockReturnValue(false);

      // Test dangerous keys as NESTED keys inside a safe root key.
      // deepMergePatch recurses into nested objects, so the guard must reject
      // __proto__, constructor, prototype at every depth level.
      // We use a safe root key ("Config") so resolveAction processes it
      // without hitting the wizardKeyMap prototype chain issue.
      const pollutionFinding: BPFinding = {
        practiceId: "BP-POLLUTION-001",
        title: "Prototype pollution test",
        severity: "HIGH",
        category: "security",
        message: "Test finding with nested dangerous keys",
        blocking: false,
        autoFixable: true,
        propertyPath: "Config.SafeNested",
        desiredStatePatch: {
          Config: {
            ["__proto__"]: { polluted: true },
            constructor: { polluted: true },
            prototype: { polluted: true },
            SafeNested: "nested-safe-value",
          },
        },
      };

      const { promptFixSelection } = await import("./display.js");
      const result = await promptFixSelection({
        ...mockState,
        desiredState: { BucketName: "my-bucket", Config: { Existing: "yes" } },
        bpFindings: [pollutionFinding],
      });

      expect(result).not.toBeNull();
      // Global Object.prototype must NOT be polluted
      expect(({} as { polluted?: boolean }).polluted).toBeUndefined();

      // Nested Config object: safe key applied, dangerous keys skipped
      // Tier C: dropped redundant toBeDefined() — .SafeNested access fails
      // naturally on undefined
      const config = (
        result!.desiredState as {
          Config: { SafeNested: string; Existing: string };
        }
      ).Config;
      expect(config.SafeNested).toBe("nested-safe-value");
      expect(config.Existing).toBe("yes"); // original key preserved by deep merge
      expect(Object.keys(config)).not.toContain("__proto__");
      expect(Object.keys(config)).not.toContain("constructor");
      expect(Object.keys(config)).not.toContain("prototype");

      Object.defineProperty(process.stdin, "isTTY", {
        value: undefined,
        configurable: true,
      });
    });
  });
});
