/**
 * Unit tests for generate-release-notes.ts
 *
 * Uses synthetic git-log fixtures — NO real git invocations.
 */

import { describe, it, expect, vi } from "vitest";
import {
  stripBmadIds,
  classifyCommit,
  stripTypePrefix,
  buildReleaseNotes,
  renderMarkdown,
  readGitLog,
} from "./generate-release-notes.js";

// ── stripBmadIds ──────────────────────────────────────────────────────────────

describe("stripBmadIds", () => {
  it("strips Epic references", () => {
    expect(stripBmadIds("add EC2 support (Epic-100)")).not.toContain(
      "Epic-100",
    );
    expect(stripBmadIds("add EC2 support (Epic 43)")).not.toContain("Epic 43");
  });

  it("strips Wave-story references", () => {
    expect(stripBmadIds("fix provisioning W9-01")).not.toContain("W9-01");
    expect(stripBmadIds("add SBOM W7-06")).not.toContain("W7-06");
  });

  it("strips planning artifact IDs (P-codes)", () => {
    expect(stripBmadIds("domain verification P060")).not.toContain("P060");
    expect(stripBmadIds("branch protection P020 + P065")).not.toContain("P020");
    expect(stripBmadIds("branch protection P020 + P065")).not.toContain("P065");
  });

  it("strips lane-finding references", () => {
    expect(stripBmadIds("fix L1-F14 + L2-F02")).not.toContain("L1-F14");
    expect(stripBmadIds("resolve L4-S07")).not.toContain("L4-S07");
  });

  it("strips story references", () => {
    expect(stripBmadIds("implement story 42")).not.toContain("story 42");
    expect(stripBmadIds("stories 1-3 done")).not.toContain("stories");
  });

  it("strips parenthetical BMAD blocks", () => {
    const input = "add domain verification (P060 → L1-F37 + L2-F18 + L4-S24)";
    const result = stripBmadIds(input);
    expect(result).not.toContain("P060");
    expect(result).not.toContain("L1-F37");
  });

  it("preserves non-BMAD content", () => {
    const result = stripBmadIds("add SSH key support for EC2");
    expect(result).toBe("add SSH key support for EC2");
  });

  it("returns empty string when entire subject is BMAD IDs", () => {
    const result = stripBmadIds("W9-01 P017 L1-F14");
    expect(result.trim()).toBe("");
  });

  it("is case-insensitive for Epic", () => {
    expect(stripBmadIds("epic-100 fix")).not.toContain("epic-100");
    expect(stripBmadIds("EPIC 50 add")).not.toContain("EPIC 50");
  });

  it("strips R-codes (rounds)", () => {
    expect(stripBmadIds("round R3 cleanup")).not.toContain("R3");
    expect(stripBmadIds("R1 supply chain")).not.toContain("R1");
  });
});

// ── classifyCommit ────────────────────────────────────────────────────────────

describe("classifyCommit", () => {
  it("classifies feat: as Added", () => {
    expect(classifyCommit("feat: add Homebrew formula")).toBe("Added");
  });

  it("classifies feat(scope): as Added", () => {
    expect(classifyCommit("feat(cli): add plan command")).toBe("Added");
  });

  it("classifies fix: as Fixed", () => {
    expect(classifyCommit("fix: resolve MX record timeout")).toBe("Fixed");
  });

  it("classifies fix(scope)!: as Fixed (breaking change)", () => {
    expect(classifyCommit("fix(core)!: change API shape")).toBe("Fixed");
  });

  it("classifies security: as Security", () => {
    expect(classifyCommit("security: pin action SHAs")).toBe("Security");
  });

  it("classifies refactor: as Changed", () => {
    expect(classifyCommit("refactor: extract domain helper")).toBe("Changed");
  });

  it("classifies perf: as Changed", () => {
    expect(classifyCommit("perf: reduce startup time")).toBe("Changed");
  });

  it("suppresses docs:", () => {
    expect(classifyCommit("docs: update README")).toBe("suppressed");
  });

  it("suppresses chore:", () => {
    expect(classifyCommit("chore: bump dependencies")).toBe("suppressed");
  });

  it("suppresses ci:", () => {
    expect(classifyCommit("ci: add workflow step")).toBe("suppressed");
  });

  it("suppresses test:", () => {
    expect(classifyCommit("test: add unit coverage")).toBe("suppressed");
  });

  it("classifies unknown prefix as Changed", () => {
    expect(classifyCommit("bump: version")).toBe("Changed");
  });

  it("classifies no-prefix commit as Changed", () => {
    expect(classifyCommit("improve CLI output formatting")).toBe("Changed");
  });

  it("is case-insensitive", () => {
    expect(classifyCommit("FEAT: add thing")).toBe("Added");
    expect(classifyCommit("Fix: resolve bug")).toBe("Fixed");
  });
});

// ── stripTypePrefix ───────────────────────────────────────────────────────────

describe("stripTypePrefix", () => {
  it("strips feat: prefix", () => {
    expect(stripTypePrefix("feat: add SSH support")).toBe("add SSH support");
  });

  it("strips feat(scope): prefix", () => {
    expect(stripTypePrefix("feat(ec2): add instance types")).toBe(
      "add instance types",
    );
  });

  it("strips fix!: (breaking change)", () => {
    expect(stripTypePrefix("fix!: change output format")).toBe(
      "change output format",
    );
  });

  it("returns subject unchanged when no prefix matches", () => {
    expect(stripTypePrefix("improve performance")).toBe("improve performance");
  });
});

// ── buildReleaseNotes ─────────────────────────────────────────────────────────

describe("buildReleaseNotes", () => {
  it("groups commits by category", () => {
    const commits = [
      { hash: "abc1234", subject: "feat: add Homebrew formula" },
      { hash: "abc1235", subject: "fix: resolve DNS timeout" },
      { hash: "abc1236", subject: "security: pin action SHAs" },
    ];
    const notes = buildReleaseNotes(commits, "v0.1.0", "v0.2.0");
    expect(notes.categories.Added).toHaveLength(1);
    expect(notes.categories.Fixed).toHaveLength(1);
    expect(notes.categories.Security).toHaveLength(1);
    expect(notes.categories.Changed).toHaveLength(0);
  });

  it("suppresses docs: and chore: commits", () => {
    const commits = [
      { hash: "abc1234", subject: "docs: update README" },
      { hash: "abc1235", subject: "chore: bump dependencies" },
      { hash: "abc1236", subject: "feat: real feature" },
    ];
    const notes = buildReleaseNotes(commits, "v0.1.0", "v0.2.0");
    expect(notes.categories.Added).toHaveLength(1);
    // docs and chore should not appear
    const allItems = Object.values(notes.categories).flat();
    expect(allItems.some((i) => i.toLowerCase().includes("readme"))).toBe(
      false,
    );
    expect(allItems.some((i) => i.toLowerCase().includes("bump"))).toBe(false);
  });

  it("strips BMAD IDs from commit subjects", () => {
    const commits = [
      {
        hash: "abc1234",
        subject: "feat: add SBOM generation W7-06 (P017 partial)",
      },
    ];
    const notes = buildReleaseNotes(commits, "v0.1.0", "v0.2.0");
    const items = notes.categories.Added;
    expect(items[0]).not.toContain("W7-06");
    expect(items[0]).not.toContain("P017");
  });

  it("suppresses commits that are empty after BMAD stripping", () => {
    const commits = [{ hash: "abc1234", subject: "feat: W9-01 P017 L1-F14" }];
    const notes = buildReleaseNotes(commits, "v0.1.0", "v0.2.0");
    // After stripping, only internal IDs remained — commit is suppressed
    expect(notes.categories.Added).toHaveLength(0);
  });

  it("handles empty commit range gracefully", () => {
    const notes = buildReleaseNotes([], "v0.1.0", "v0.2.0");
    const allItems = Object.values(notes.categories).flat();
    expect(allItems).toHaveLength(0);
    expect(notes.from).toBe("v0.1.0");
    expect(notes.to).toBe("v0.2.0");
  });

  it("capitalises the first letter of each entry", () => {
    const commits = [{ hash: "abc1234", subject: "feat: add new feature" }];
    const notes = buildReleaseNotes(commits, "v0.1.0", "v0.2.0");
    expect(notes.categories.Added[0]).toMatch(/^[A-Z]/);
  });

  it("handles mixed-case commit type prefixes", () => {
    const commits = [
      { hash: "abc1234", subject: "FEAT: ADD NEW FEATURE" },
      { hash: "abc1235", subject: "Fix: resolve bug" },
    ];
    const notes = buildReleaseNotes(commits, "v0.1.0", "v0.2.0");
    expect(notes.categories.Added).toHaveLength(1);
    expect(notes.categories.Fixed).toHaveLength(1);
  });
});

// ── renderMarkdown ────────────────────────────────────────────────────────────

describe("renderMarkdown", () => {
  it("renders a Keep-a-Changelog section header", () => {
    const notes = {
      from: "v0.1.0",
      to: "v0.2.0",
      categories: {
        Added: ["New Homebrew formula"],
        Changed: [],
        Fixed: [],
        Deprecated: [],
        Removed: [],
        Security: [],
      },
    };
    const md = renderMarkdown(notes);
    expect(md).toContain("## [v0.2.0]");
    expect(md).toContain("### Added");
    expect(md).toContain("- New Homebrew formula");
  });

  it("emits fallback message when no user-facing changes", () => {
    const notes = {
      from: "v0.1.0",
      to: "v0.2.0",
      categories: {
        Added: [],
        Changed: [],
        Fixed: [],
        Deprecated: [],
        Removed: [],
        Security: [],
      },
    };
    const md = renderMarkdown(notes);
    expect(md).toContain("No user-facing changes");
  });

  it("omits empty category sections", () => {
    const notes = {
      from: "v0.1.0",
      to: "v0.2.0",
      categories: {
        Added: ["New feature"],
        Changed: [],
        Fixed: [],
        Deprecated: [],
        Removed: [],
        Security: [],
      },
    };
    const md = renderMarkdown(notes);
    expect(md).not.toContain("### Changed");
    expect(md).not.toContain("### Fixed");
  });

  it("renders Security section when present", () => {
    const notes = {
      from: "v0.1.0",
      to: "v0.2.0",
      categories: {
        Added: [],
        Changed: [],
        Fixed: [],
        Deprecated: [],
        Removed: [],
        Security: ["Pin all action SHAs"],
      },
    };
    const md = renderMarkdown(notes);
    expect(md).toContain("### Security");
    expect(md).toContain("- Pin all action SHAs");
  });
});

// ── readGitLog ────────────────────────────────────────────────────────────────

describe("readGitLog", () => {
  it("parses git log --oneline output into hash + subject", () => {
    const mockExecSync = vi
      .fn()
      .mockReturnValue(
        "abc1234 feat: add Homebrew formula\n" +
          "def5678 fix: resolve DNS timeout\n",
      );

    const commits = readGitLog({
      from: "v0.1.0",
      to: "v0.2.0",
      execSync: mockExecSync,
    });

    expect(commits).toHaveLength(2);
    expect(commits[0]).toEqual({
      hash: "abc1234",
      subject: "feat: add Homebrew formula",
    });
    expect(commits[1]).toEqual({
      hash: "def5678",
      subject: "fix: resolve DNS timeout",
    });
  });

  it("handles empty git log output gracefully", () => {
    const mockExecSync = vi.fn().mockReturnValue("");

    const commits = readGitLog({
      from: "v0.1.0",
      to: "v0.2.0",
      execSync: mockExecSync,
    });

    expect(commits).toHaveLength(0);
  });

  it("uses all commits when from is empty", () => {
    const mockExecSync = vi
      .fn()
      .mockReturnValue("abc1234 feat: initial commit\n");

    const commits = readGitLog({
      from: "",
      to: "HEAD",
      execSync: mockExecSync,
    });

    expect(commits).toHaveLength(1);
    // Command should not include ".." when from is empty
    const cmd = mockExecSync.mock.calls[0][0] as string;
    expect(cmd).not.toContain("..");
    expect(cmd).toContain("HEAD");
  });

  it("throws on git error", () => {
    const mockExecSync = vi.fn().mockImplementation(() => {
      throw new Error("fatal: bad revision");
    });

    expect(() =>
      readGitLog({ from: "bad-ref", to: "HEAD", execSync: mockExecSync }),
    ).toThrow("git log failed");
  });
});
