/**
 * sanitize.ts — Input sanitization for user intent strings before LLM injection.
 * NFR-16: Prompt Injection Protection (POC-safe layer).
 * Pure functions only — no I/O, no side effects.
 */

export const MAX_INTENT_LENGTH = 500;

/**
 * Role tags / chat-template tokens used by various LLM frameworks.
 * Stripping these prevents an attacker from spoofing a system or assistant
 * turn from inside a user_intent block.
 *
 * @see SECURITY-AUDIT.md — M-S3
 */
const ROLE_TAG_PATTERN =
  /<\/?(system|assistant|human|user|tool|context|user_intent)[^>]*>/gi;

/**
 * Llama-style instruction markers (`[INST]`, `[/INST]`, `[SYS]`, `[/SYS]`).
 */
const INST_TAG_PATTERN = /\[\/?(INST|SYS)\]/gi;

/**
 * Common prompt-injection role prefixes anchored to a line start. We strip
 * the prefix entirely so the surrounding text is preserved but the role hint
 * is gone.
 */
const ROLE_PREFIX_PATTERN = /(^|\n)\s*(System|Assistant|Human|User):/gi;

/**
 * Sanitizes a user-supplied intent string before it is injected into a Bedrock prompt.
 *
 * Strips:
 * - Null bytes (\0)
 * - Control characters except \n, \t, \r (U+0001–U+0008, U+000B, U+000C, U+000E–U+001F, U+007F)
 * - Unicode direction-override and isolate characters (U+200E, U+200F, U+202A–U+202E, U+2066–U+2069)
 * - Role-tag and chat-template injections (`<system>`, `[INST]`, `Human:`, etc.)
 * - Escapes ${ template-injectable sequences
 *
 * Truncates to MAX_INTENT_LENGTH characters.
 */
export function sanitizeUserIntent(input: string): string {
  return input
    .replace(/\0/g, "")
    .replace(/[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
    .replace(/[\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, "")
    .replace(ROLE_TAG_PATTERN, "")
    .replace(INST_TAG_PATTERN, "")
    .replace(ROLE_PREFIX_PATTERN, "$1")
    .replace(/\$\{/g, "$ {")
    .slice(0, MAX_INTENT_LENGTH);
}
