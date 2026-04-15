/**
 * Setup-command intro context: renders the "which account/region/profile
 * this setup will mutate" banner up front.
 *
 * INVARIANT: under --dry-run or --disable-llm-logging callers MUST NOT
 * touch AWS (tests assert zero STS calls), so this module supports a
 * `suppressSts` mode that synthesizes an env-only context without
 * calling GetCallerIdentity. Wave 5 F2 introduced the fallback.
 */

import * as clack from "@clack/prompts";
import { resolveIntroContext, formatIntroContext } from "../init.js";
import { AWS_REGION } from "../../config/constants.js";

export async function printSetupIntro(opts: {
  profile?: string | undefined;
  suppressSts: boolean;
}): Promise<void> {
  const displayProfile =
    opts.profile ?? process.env["AWS_PROFILE"] ?? undefined;
  const introCtx = opts.suppressSts
    ? {
        region: AWS_REGION,
        ...(displayProfile ? { profile: displayProfile } : {}),
      }
    : await resolveIntroContext();
  clack.intro(
    `Assignee.ai — IAM Setup  [${formatIntroContext({
      region: introCtx.region,
      ...(introCtx.account ? { account: introCtx.account } : {}),
      ...(displayProfile ? { profile: displayProfile } : {}),
    })}]`,
  );
}
