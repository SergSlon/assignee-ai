/**
 * Live-context interpolation for error messages (Wave 4 F4).
 *
 * Replaces `{region}` / `{account}` / `{profile}` / `{arn}` tokens
 * in a howToFix string with live context, and optionally expands the
 * compound `{CTX}` token into a human-friendly "Context: …" sentence
 * when any context is available.
 *
 * Unknown/absent individual tokens collapse to empty string so the
 * result never shows "{region}" to users; `{CTX}` collapses to empty
 * string when no context is supplied — keeping legacy single-arg
 * `resolve(error)` callsites byte-identical (preserving old tests).
 *
 * Conditional-segment syntax (Story 48.5): `{?key: literal segment with {key}}`
 * emits the entire segment ONLY if `key` resolves non-empty. This lets
 * templates weave inline tokens (e.g. " in region {region}") without
 * leaving orphan filler like "in region ." when context is absent.
 */

import type { ErrorMessageEntry, ErrorResolveContext } from "./types.js";

export function interpolateContext(
  template: string,
  ctx: ErrorResolveContext | undefined,
): string {
  const scalar = (key: keyof ErrorResolveContext): string => {
    if (!ctx) return "";
    const v = ctx[key];
    return typeof v === "string" && v.length > 0 ? v : "";
  };

  // Process conditional segments FIRST so inner {key} tokens inside the
  // segment are handled correctly. The segment body allows one level of
  // nested `{key}` token (e.g. `{?region: in region {region}}`).
  let out = template.replace(
    /\{\?(region|account|profile|arn):((?:[^{}]|\{[^{}]*\})*)\}/g,
    (_, key: string, segment: string) => {
      const v = scalar(key as keyof ErrorResolveContext);
      if (!v) return "";
      return segment.replace(`{${key}}`, v);
    },
  );

  out = out.replace(/\{(region|account|profile|arn)\}/g, (_, key) =>
    scalar(key as keyof ErrorResolveContext),
  );

  if (out.includes("{CTX}")) {
    const parts: string[] = [];
    const region = scalar("region");
    const account = scalar("account");
    const profile = scalar("profile");
    if (region) parts.push(`region=${region}`);
    if (account) parts.push(`account=${account}`);
    if (profile) parts.push(`profile=${profile}`);
    const replacement = parts.length > 0 ? ` Context: ${parts.join(" ")}.` : "";
    out = out.replace(/\{CTX\}/g, replacement);
  }

  return out;
}

/** Apply live-context interpolation to every context-aware field of an entry. */
export function applyContext(
  entry: ErrorMessageEntry,
  ctx: ErrorResolveContext | undefined,
): ErrorMessageEntry {
  const howToFix = interpolateContext(entry.howToFix, ctx);
  if (howToFix === entry.howToFix) return entry;
  return { ...entry, howToFix };
}
