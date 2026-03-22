/**
 * AWS credential and region auto-detection for `assignee init`.
 *
 * Detects credentials from (in priority order):
 * 1. `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` env vars
 * 2. `~/.aws/credentials` default profile (or `AWS_PROFILE`)
 * 3. AWS SSO active session via `~/.aws/sso/cache/` token files
 *
 * Also detects region from env vars or `~/.aws/config`.
 *
 * @see Story 18.1, AC #1, #2, #8
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

/** Credential source types returned by the detector. */
export type CredentialSource = "env" | "file" | "sso";

/** Result of credential detection. */
export interface CredentialDetectionResult {
  /** Whether AWS credentials were found. */
  detected: boolean;
  /** Source of the detected credentials (`undefined` when `detected` is false). */
  source?: CredentialSource;
  /** AWS profile name (e.g., "default"). */
  profile?: string;
  /** Reason for failure when `detected` is false. */
  reason?: string;
}

/** Result of region detection. */
export interface RegionDetectionResult {
  /** Detected AWS region, or `undefined` if not found. */
  region?: string;
}

/**
 * Parse a simple INI file (AWS credentials / config format).
 * Returns a map of section name → key-value pairs.
 */
export function parseIniFile(
  content: string,
): Record<string, Record<string, string>> {
  const sections: Record<string, Record<string, string>> = {};
  let currentSection = "";

  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();

    // Skip empty lines and comments
    if (line === "" || line.startsWith("#") || line.startsWith(";")) {
      continue;
    }

    // Section header: [profile-name] or [profile profile-name]
    const sectionMatch = line.match(/^\[(.+)\]$/);
    if (sectionMatch?.[1]) {
      currentSection = sectionMatch[1].trim();
      // AWS config uses [profile xyz] syntax; normalize to just the name
      if (currentSection.startsWith("profile ")) {
        currentSection = currentSection.slice("profile ".length).trim();
      }
      if (!sections[currentSection]) {
        sections[currentSection] = {};
      }
      continue;
    }

    // Key-value pair: key = value
    const kvMatch = line.match(/^([^=]+)=(.*)$/);
    if (kvMatch?.[1] && kvMatch[2] !== undefined && currentSection) {
      const key = kvMatch[1].trim();
      const value = kvMatch[2].trim();
      const section = sections[currentSection];
      if (section) {
        section[key] = value;
      }
    }
  }

  return sections;
}

/**
 * Detect AWS credentials from environment, credential file, or SSO cache.
 *
 * @param homeDir - Override for the user's home directory (used in tests). Defaults to `os.homedir()`.
 * @returns Detection result indicating whether credentials were found and their source.
 */
export async function detectCredentials(
  homeDir?: string,
): Promise<CredentialDetectionResult> {
  const home = homeDir ?? os.homedir();

  // Priority 1: Environment variables
  const accessKeyId = process.env["AWS_ACCESS_KEY_ID"];
  const secretAccessKey = process.env["AWS_SECRET_ACCESS_KEY"];

  if (accessKeyId && secretAccessKey) {
    return {
      detected: true,
      source: "env",
      profile: process.env["AWS_PROFILE"] ?? "default",
    };
  }

  // Priority 2: ~/.aws/credentials file
  const targetProfile = process.env["AWS_PROFILE"] ?? "default";
  const credentialsPath = path.join(home, ".aws", "credentials");

  try {
    const content = await fs.readFile(credentialsPath, "utf-8");
    const sections = parseIniFile(content);
    const profileSection = sections[targetProfile];

    if (
      profileSection &&
      profileSection["aws_access_key_id"] &&
      profileSection["aws_secret_access_key"]
    ) {
      return {
        detected: true,
        source: "file",
        profile: targetProfile,
      };
    }
  } catch {
    // File not found or not readable — continue to next source
  }

  // Priority 3: AWS SSO active session
  const ssoCachePath = path.join(home, ".aws", "sso", "cache");
  try {
    const files = await fs.readdir(ssoCachePath);
    const jsonFiles = files.filter((f) => f.endsWith(".json"));

    for (const file of jsonFiles) {
      try {
        const content = await fs.readFile(
          path.join(ssoCachePath, file),
          "utf-8",
        );
        const parsed: unknown = JSON.parse(content);

        if (
          parsed !== null &&
          typeof parsed === "object" &&
          "accessToken" in parsed &&
          "expiresAt" in parsed
        ) {
          const tokenData = parsed as {
            accessToken: string;
            expiresAt: string;
          };
          const expiresAt = new Date(tokenData.expiresAt);

          if (expiresAt > new Date()) {
            return {
              detected: true,
              source: "sso",
              profile: targetProfile,
            };
          }
        }
      } catch {
        // Skip malformed JSON files
      }
    }
  } catch {
    // SSO cache directory not found — continue
  }

  return {
    detected: false,
    reason:
      "No AWS credentials found. Configure credentials via:\n" +
      "  1) AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY environment variables\n" +
      "  2) ~/.aws/credentials file\n" +
      "  3) AWS SSO login (aws sso login)",
  };
}

/**
 * Detect AWS region from environment variables or `~/.aws/config`.
 *
 * @param homeDir - Override for the user's home directory (used in tests). Defaults to `os.homedir()`.
 * @returns Detected region or `undefined`.
 */
export async function detectRegion(
  homeDir?: string,
): Promise<RegionDetectionResult> {
  const home = homeDir ?? os.homedir();

  // Priority 1: AWS_REGION env var
  const awsRegion = process.env["AWS_REGION"];
  if (awsRegion) {
    return { region: awsRegion };
  }

  // Priority 2: AWS_DEFAULT_REGION env var
  const awsDefaultRegion = process.env["AWS_DEFAULT_REGION"];
  if (awsDefaultRegion) {
    return { region: awsDefaultRegion };
  }

  // Priority 3: ~/.aws/config file
  const targetProfile = process.env["AWS_PROFILE"] ?? "default";
  const configPath = path.join(home, ".aws", "config");

  try {
    const content = await fs.readFile(configPath, "utf-8");
    const sections = parseIniFile(content);
    const profileSection = sections[targetProfile];

    if (profileSection && profileSection["region"]) {
      return { region: profileSection["region"] };
    }
  } catch {
    // Config file not found or not readable
  }

  return { region: undefined };
}
