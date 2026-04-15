/**
 * Pre-checks existing IAM users and collects access-key rotation
 * decisions interactively. Prompts cannot run in parallel, so we
 * gather decisions sequentially BEFORE the parallel IAM work begins.
 *
 * Skipped when --yes is passed (non-interactive CI path).
 */

import * as clack from "@clack/prompts";
import {
  type IAMClient,
  GetUserCommand,
  ListAccessKeysCommand,
} from "@aws-sdk/client-iam";
import { UserMessage } from "../../config/constants.js";
import { ROLES } from "./constants.js";

export interface RotationResult {
  decisions: Map<string, boolean>;
  cancelled: boolean;
}

export async function collectRotationDecisions(
  iam: IAMClient,
): Promise<RotationResult> {
  const decisions = new Map<string, boolean>();
  for (const role of ROLES) {
    try {
      await iam.send(new GetUserCommand({ UserName: role.userName }));
      const existingKeys = await iam.send(
        new ListAccessKeysCommand({ UserName: role.userName }),
      );
      const hasKeys = (existingKeys.AccessKeyMetadata ?? []).length > 0;
      if (hasKeys) {
        const rotate = await clack.confirm({
          message: `User ${role.userName} already has access keys. Rotate them?`,
          initialValue: false,
        });
        if (clack.isCancel(rotate)) {
          clack.outro(UserMessage.SETUP_CANCELLED);
          return { decisions, cancelled: true };
        }
        decisions.set(role.userName, !!rotate);
      }
    } catch {
      // User doesn't exist yet — will be created; no prompt needed
    }
  }
  return { decisions, cancelled: false };
}
