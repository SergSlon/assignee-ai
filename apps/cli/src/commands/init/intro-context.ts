/**
 * Resolves and formats the STS intro context banner for mutating commands.
 *
 * @see R2-C N5 / P2-R2-4
 */

import { DEFAULT_AWS_REGION } from "@assignee/core";

/**
 * Best-effort resolve of account + region + profile for the clack.intro
 * banner. STS is called with a short timeout; any failure (no creds,
 * network, throttling) collapses to region/profile-only output so a
 * mutating command's first line still tells the operator WHICH account
 * they're about to touch.
 */
export async function resolveIntroContext(): Promise<{
  region: string;
  account?: string;
  profile?: string;
}> {
  const region =
    process.env["AWS_REGION"] ??
    process.env["AWS_DEFAULT_REGION"] ??
    DEFAULT_AWS_REGION;
  const profile = process.env["AWS_PROFILE"];

  // Lazy STS import — avoids pulling the SDK into init.ts's module graph
  // when the user only runs `--help`.
  try {
    const { STSClient, GetCallerIdentityCommand } =
      await import("@aws-sdk/client-sts");
    const client = new STSClient({ region });
    const timeoutMs = 2000;
    const identity = (await Promise.race([
      client.send(new GetCallerIdentityCommand({})),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("STS timeout")), timeoutMs),
      ),
    ])) as { Account?: string };
    return {
      region,
      ...(identity.Account ? { account: identity.Account } : {}),
      ...(profile ? { profile } : {}),
    };
  } catch {
    return { region, ...(profile ? { profile } : {}) };
  }
}

/** Render the standard context line for mutating commands. */
export function formatIntroContext(ctx: {
  region: string;
  account?: string;
  profile?: string;
}): string {
  const bits = [`region=${ctx.region}`];
  if (ctx.account) bits.push(`account=${ctx.account}`);
  if (ctx.profile) bits.push(`profile=${ctx.profile}`);
  return bits.join("  ");
}
