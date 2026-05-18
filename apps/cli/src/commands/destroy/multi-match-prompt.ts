/**
 * Multi-match disambiguation picker for single-resource destroy.
 *
 * Story 48.6: When `assignee infra destroy <name>` matches ≥2 managed resources,
 * we MUST NOT silently pick the first. This module:
 *  - Prints a numbered list of every candidate with ARN + compact metadata.
 *  - Prompts the user (interactive TTY only) to pick by 1-based index or
 *    by pasting the exact ARN from the list.
 *  - Fails fast with an actionable error when `--yes` or non-TTY stdin
 *    would force a silent pick.
 *  - Treats Ctrl-C, empty input, and the literal string `cancel` as an
 *    explicit user cancel (UserCancelledError, zero mutation calls).
 */

import * as clack from "@clack/prompts";
import { AssigneeError, UserCancelledError } from "@assignee/core";
import { UserMessage } from "../../config/constants.js";
import { ErrorCode } from "../../constants/errors.js";
import type {
  AmbiguousResolution,
  ResolvedResource,
} from "../../services/resource-resolver.js";

/** Tag keys that appear on every managed resource — redundant to display. */
const HIDDEN_TAG_KEYS = new Set(["managed-by"]);

/** Priority order for tag display (first these, then alphabetical). */
const PRIORITY_TAG_KEYS = ["Name", "env", "environment", "owner"];

/** Max tags rendered on a match line before truncating with `(+N more)`. */
const MAX_DISPLAYED_TAGS = 3;

/** Formats a tag record into a compact single-line string. */
function formatTagsForDisplay(tags: Record<string, string>): string {
  const entries = Object.entries(tags).filter(
    ([key]) => !HIDDEN_TAG_KEYS.has(key),
  );
  if (entries.length === 0) return "(no tags)";

  const priorityIdx = (key: string): number => {
    const idx = PRIORITY_TAG_KEYS.indexOf(key);
    return idx === -1 ? PRIORITY_TAG_KEYS.length : idx;
  };

  entries.sort((a, b) => {
    const pa = priorityIdx(a[0]);
    const pb = priorityIdx(b[0]);
    if (pa !== pb) return pa - pb;
    return a[0].localeCompare(b[0]);
  });

  const shown = entries.slice(0, MAX_DISPLAYED_TAGS);
  const rendered = shown.map(([k, v]) => `${k}=${v}`).join(" ");
  const extra = entries.length - shown.length;
  return extra > 0 ? `${rendered} (+${extra} more)` : rendered;
}

/** Renders the numbered-list preamble to stdout for an AmbiguousResolution. */
function renderMatchList(resolved: AmbiguousResolution): void {
  process.stdout.write(
    `Multiple managed resources match "${resolved.input}":\n`,
  );
  resolved.matches.forEach((match, idx) => {
    const n = idx + 1;
    process.stdout.write(`[${n}] ${match.arn}\n`);
    process.stdout.write(
      `    type=${match.resourceType} region=${match.region} tags=${formatTagsForDisplay(match.tags)}\n`,
    );
  });
}

/** Builds the AC5 error message for --yes / non-TTY multi-match. */
export function buildMultiMatchError(
  resolved: AmbiguousResolution,
): AssigneeError {
  const arnList = resolved.matches.map((m) => m.arn).join(", ");
  return new AssigneeError(
    `Multiple managed resources match "${resolved.input}"; pass an explicit ARN. Matches: ${arnList}`,
    ErrorCode.DESTROY_ERROR,
  );
}

/**
 * Interactive disambiguation picker. Returns the selected ResolvedResource
 * or throws (AssigneeError for --yes/non-TTY, UserCancelledError for cancel).
 *
 * The user gets ONE retry on invalid input (out-of-range index, ARN not in
 * list). A second invalid answer is treated as cancel — avoids infinite
 * prompt loops on piped-but-nonsense input.
 */
export async function pickFromMatches(
  resolved: AmbiguousResolution,
  opts: { yes?: boolean },
): Promise<ResolvedResource> {
  // ── AC5: --yes OR non-TTY stdin → fail fast, never silently first-pick.
  if (opts.yes === true || !process.stdin.isTTY) {
    throw buildMultiMatchError(resolved);
  }

  // ── Interactive: print the list once, then prompt (with one retry).
  renderMatchList(resolved);

  const matches = resolved.matches;
  let attempt = 0;
  // Two attempts total: first try, then one retry on invalid input.
  while (attempt < 2) {
    attempt++;
    const answer = await clack.text({
      message:
        "Pick a match by index (1-N) or paste an ARN; type 'cancel' to abort:",
    });

    // ── AC4: Ctrl-C, empty, or typed 'cancel' → UserCancelledError.
    if (clack.isCancel(answer)) {
      clack.outro(UserMessage.DESTROY_CANCELLED);
      throw new UserCancelledError(UserMessage.DESTROY_CANCELLED);
    }
    if (typeof answer !== "string") {
      clack.outro(UserMessage.DESTROY_CANCELLED);
      throw new UserCancelledError(UserMessage.DESTROY_CANCELLED);
    }
    const trimmed = answer.trim();
    if (trimmed === "" || trimmed.toLowerCase() === "cancel") {
      clack.outro(UserMessage.DESTROY_CANCELLED);
      throw new UserCancelledError(UserMessage.DESTROY_CANCELLED);
    }

    // ── Numeric index path (1-based).
    if (/^\d+$/.test(trimmed)) {
      const idx = Number.parseInt(trimmed, 10) - 1;
      if (idx >= 0 && idx < matches.length) {
        const picked = matches[idx];
        if (picked) return picked;
      }
      if (attempt < 2) {
        process.stdout.write(
          `Index "${trimmed}" is out of range (expected 1..${matches.length}). Try again, or type 'cancel'.\n`,
        );
        continue;
      }
      // Second invalid → cancel. Mirrors Ctrl-C semantics per AC4.
      clack.outro(UserMessage.DESTROY_CANCELLED);
      throw new UserCancelledError(UserMessage.DESTROY_CANCELLED);
    }

    // ── ARN path: case-sensitive exact match against one of the candidates.
    const exact = matches.find((m) => m.arn === trimmed);
    if (exact) return exact;

    if (attempt < 2) {
      process.stdout.write(
        `"${trimmed}" is not one of the listed ARNs. Try again with an index or an exact ARN, or type 'cancel'.\n`,
      );
      continue;
    }
    clack.outro(UserMessage.DESTROY_CANCELLED);
    throw new UserCancelledError(UserMessage.DESTROY_CANCELLED);
  }

  // Unreachable — the while loop always returns or throws.
  /* c8 ignore next 2 */
  clack.outro(UserMessage.DESTROY_CANCELLED);
  throw new UserCancelledError(UserMessage.DESTROY_CANCELLED);
}
