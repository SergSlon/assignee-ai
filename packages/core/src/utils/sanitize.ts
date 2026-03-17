/**
 * sanitize.ts — Input sanitization for user intent strings before LLM injection.
 * NFR-16: Prompt Injection Protection (POC-safe layer).
 * Pure functions only — no I/O, no side effects.
 */

export const MAX_INTENT_LENGTH = 500;

/**
 * Sanitizes a user-supplied intent string before it is injected into a Bedrock prompt.
 *
 * Strips:
 * - Null bytes (\0)
 * - Control characters except \n, \t, \r (U+0001–U+0008, U+000B, U+000C, U+000E–U+001F, U+007F)
 * - Unicode direction-override and isolate characters (U+200E, U+200F, U+202A–U+202E, U+2066–U+2069)
 * - Escapes ${ template-injectable sequences
 *
 * Truncates to MAX_INTENT_LENGTH characters.
 */
export function sanitizeUserIntent(input: string): string {
  return input
    .replace(/\0/g, "")
    .replace(/[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
    .replace(/[\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, "")
    .replace(/\$\{/g, "$ {")
    .slice(0, MAX_INTENT_LENGTH);
}
