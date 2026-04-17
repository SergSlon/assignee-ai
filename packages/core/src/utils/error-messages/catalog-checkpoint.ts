/** Checkpoint error message catalog. */

import { ErrorCode } from "../../constants/errors.js";
import type { ErrorMessageEntry } from "./types.js";

export const CHECKPOINT_ERROR_MESSAGES: Record<string, ErrorMessageEntry> = {
  [ErrorCode.CHECKPOINT_NOT_FOUND]: {
    code: ErrorCode.CHECKPOINT_NOT_FOUND,
    what: "No plan checkpoint file found.",
    why: "The specified checkpoint file does not exist at the given path.",
    howToFix:
      "Run `assignee plan` first to create a checkpoint, then use `assignee apply --checkpoint <path>` to apply it.",
  },
  [ErrorCode.CHECKPOINT_EXPIRED]: {
    code: ErrorCode.CHECKPOINT_EXPIRED,
    what: "The plan checkpoint has expired.",
    why: "Checkpoints have a TTL to ensure plans reflect current AWS state. This checkpoint was created too long ago.",
    howToFix: "Run `assignee plan` to generate a fresh plan, then apply it.",
  },
  [ErrorCode.CHECKPOINT_INVALID]: {
    code: ErrorCode.CHECKPOINT_INVALID,
    what: "The checkpoint file is corrupted or has an incompatible format.",
    why: "The checkpoint file could not be parsed or does not match the expected schema version.",
    howToFix:
      "Delete the corrupted checkpoint and run `assignee plan` to create a new one.",
  },
};
