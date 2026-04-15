/**
 * Plaintext markers that indicate the input is NOT already base64-encoded.
 * If a string starts with any of these, it must be plaintext (shebang,
 * cloud-init, or MIME multipart) and we should auto-encode it before
 * sending to CloudFormation.
 *
 * Item 3a (2026-04-09): CloudFormation's `AWS::EC2::Instance.UserData`
 * expects a base64-encoded string. Raw plaintext passes through but
 * cloud-init / the EC2 boot process silently fails to execute it,
 * producing an instance that starts successfully but never ran the
 * user's script. Detection here encodes plaintext so the user's
 * script actually runs.
 */
const USER_DATA_PLAINTEXT_MARKERS = [
  "#!", // bash / sh shebang
  "#cloud-config", // cloud-init YAML
  "Content-Type:", // multipart MIME (cloud-init multi-user-data)
] as const;

/**
 * Valid base64 characters: A-Z, a-z, 0-9, +, /, with optional = padding.
 * A string is "base64-shaped" if every non-whitespace character matches
 * this alphabet and the total length (stripped) is a multiple of 4.
 */
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Decide whether a UserData input string is plaintext (needs encoding)
 * or already base64-encoded (pass through).
 *
 * Returns:
 *   - "plaintext"    — needs encoding (shebang / cloud-init / MIME / non-base64 chars / too-short)
 *   - "base64"       — valid base64, decode produces bytes we can't identify
 *   - "double-base64" — valid base64 whose decoded output is itself plaintext.
 *                       This is almost always a user error (they base64-encoded
 *                       the script themselves and we'd double-encode it).
 */
export function classifyUserData(
  input: string,
): "plaintext" | "base64" | "double-base64" {
  const trimmed = input.trim();
  if (trimmed.length === 0) return "plaintext";

  for (const marker of USER_DATA_PLAINTEXT_MARKERS) {
    if (trimmed.startsWith(marker)) return "plaintext";
  }

  const stripped = trimmed.replace(/\s+/g, "");
  if (stripped.length === 0) return "plaintext";
  if (stripped.length % 4 !== 0) return "plaintext";
  if (!BASE64_RE.test(stripped)) return "plaintext";

  let decoded: string;
  try {
    decoded = Buffer.from(stripped, "base64").toString("utf8");
  } catch {
    return "plaintext";
  }
  for (const marker of USER_DATA_PLAINTEXT_MARKERS) {
    if (decoded.startsWith(marker)) return "double-base64";
  }
  return "base64";
}

/**
 * Encode a UserData string for CloudFormation. If already base64, returns
 * the stripped value unchanged. If plaintext, base64-encodes it. If
 * double-base64 is detected, throws a user-facing error with a hint.
 */
export function encodeUserData(input: string): string {
  const classification = classifyUserData(input);
  if (classification === "double-base64") {
    throw new Error(
      "UserData looks like it's already base64-encoded AND the decoded content is itself a shell script or cloud-init config. " +
        "It looks like you already base64-encoded this — pass the raw script text, Assignee handles encoding automatically.",
    );
  }
  if (classification === "base64") {
    return input.trim().replace(/\s+/g, "");
  }
  return Buffer.from(input, "utf8").toString("base64");
}
