/**
 * OTHER-sentinel handler for `promptWithHelp`.
 *
 * The user picked "Other" on an enum/categorySelect prompt. Flow:
 *   1. Read a free-form description from the user.
 *   2. If it looks like an exact AWS value (e.g., "t3.micro"), return it.
 *   3. For AMI fields, try ec2:DescribeImages first (Story 20.9).
 *   4. Otherwise ask the LLM for a suggestion + price hint.
 *   5. Fallback: ask for an exact value manually.
 *
 * Returns `undefined` to signal "re-prompt the same field" (caller
 * `continue`s the loop); returns a string to finalize the field value.
 *
 * @see Story 49.6 (Epic 49) — decompose promptWithHelp god function
 */

import * as clack from "@clack/prompts";
import { CfnKey, UserCancelledError } from "../../../index.js";
import type { LlmPort, ResourceField } from "../../../index.js";
import type { StructuredTool } from "@langchain/core/tools";
import { UserMessage } from "../../../config/constants/ui.js";
import { WIZARD_NONE_SENTINEL } from "../../../config/constants/enums.js";
import { searchAmis } from "../../aws-resource-discovery/index.js";
import { fetchSuggestionPrice } from "../pricing-hints.js";

export interface OtherHandlerParams {
  field: ResourceField;
  resourceType: string;
  tools: StructuredTool[];
  llmClient?: LlmPort;
  userIntent?: string;
}

/**
 * Returns the user-chosen value, or `undefined` when the caller
 * should re-prompt (cancelled inner prompts throw
 * `UserCancelledError`).
 */
export async function handleOtherSentinel(
  params: OtherHandlerParams,
): Promise<string | undefined> {
  const { field, resourceType, tools, llmClient, userIntent } = params;

  const description = await clack.text({
    message: `${field.question.label} — Describe what you need`,
    placeholder: "e.g., 'GPU for ML training' or enter exact value",
  });
  if (clack.isCancel(description)) {
    clack.cancel(UserMessage.WIZARD_CANCELLED);
    throw new UserCancelledError();
  }
  const userDesc = typeof description === "string" ? description.trim() : "";
  if (!userDesc) return undefined; // re-prompt

  // Exact AWS value? Return directly. Plain words like "linux" or
  // "gpu" are descriptions, not exact values — they fall through to
  // the LLM branch below.
  if (looksLikeExactAwsValue(userDesc)) return userDesc;

  // Story 20.9: AMI search by description via ec2:DescribeImages.
  if (field.name === CfnKey.IMAGE_ID) {
    const amiValue = await pickAmiFromSearch(userDesc);
    if (amiValue !== undefined) return amiValue;
    // User rejected all AMI results → fall through to the LLM branch.
  }

  // LLM-assisted suggestion.
  if (llmClient) {
    const suggested = await askLlmForValue({
      userDesc,
      field,
      resourceType,
      userIntent,
      llmClient,
      tools,
    });
    if (suggested === "re-prompt") return undefined;
    if (typeof suggested === "string") return suggested;
    // `undefined` → fall through to manual fallback.
  }

  return askManualValue(field);
}

function looksLikeExactAwsValue(userDesc: string): boolean {
  return (
    !userDesc.includes(" ") &&
    /^[a-z0-9][a-z0-9._-]*$/i.test(userDesc) &&
    (/\./.test(userDesc) || // has dot: t3.small, db.t3.micro
      /^ami-/.test(userDesc) ||
      /^subnet-/.test(userDesc) ||
      /^sg-/.test(userDesc) ||
      /^i-/.test(userDesc) ||
      /^arn:/.test(userDesc) ||
      /^db\./.test(userDesc) ||
      /\d+\.\d+/.test(userDesc)) // version: 16.4, 8.0
  );
}

/** Returns the chosen AMI id, or `undefined` when the user rejected every match. */
async function pickAmiFromSearch(
  userDesc: string,
): Promise<string | undefined> {
  const amiSpinner = clack.spinner();
  amiSpinner.start("Searching for matching AMIs...");
  const amiResults = await searchAmis(userDesc);
  amiSpinner.stop();
  if (amiResults.length === 0) return undefined;

  const amiChoice = await clack.select({
    message: `Found ${amiResults.length} matching AMI${amiResults.length === 1 ? "" : "s"}:`,
    options: [
      ...amiResults.map((ami) => ({ value: ami.value, label: ami.label })),
      {
        value: WIZARD_NONE_SENTINEL,
        label: "None of these — let me try again",
      },
    ],
  });
  if (clack.isCancel(amiChoice)) {
    clack.cancel(UserMessage.WIZARD_CANCELLED);
    throw new UserCancelledError();
  }
  if (amiChoice === WIZARD_NONE_SENTINEL) return undefined;
  return amiChoice as string;
}

interface AskLlmParams {
  userDesc: string;
  field: ResourceField;
  resourceType: string;
  userIntent?: string;
  llmClient: LlmPort;
  tools: StructuredTool[];
}

/**
 * Returns:
 *   - a string when the user confirmed a suggestion
 *   - `"re-prompt"` when the LLM failed / user rejected, requesting a new prompt
 *   - `undefined` when the LLM couldn't produce a usable value (caller should fall through to the manual-value prompt)
 */
async function askLlmForValue(
  params: AskLlmParams,
): Promise<string | "re-prompt" | undefined> {
  const { userDesc, field, resourceType, userIntent, llmClient, tools } =
    params;
  const s = clack.spinner();
  s.start("Finding the best option for you...");
  try {
    const staticOptions = field.question.options ?? [];
    const optionsContext =
      staticOptions.length > 0
        ? `\nAvailable options: ${staticOptions.map((o) => `${o.value} (${o.label})`).join(", ")}\nPick the best matching option value from the list above.`
        : "";
    const prompt = [
      `The user is configuring a ${resourceType} resource.`,
      `They need to set the "${field.name}" field.`,
      `They described what they need as: "${userDesc}"`,
      userIntent ? `Their overall intent: "${userIntent}"` : "",
      optionsContext,
      "",
      "Respond with ONLY the exact value (a single short string, nothing else — no explanation, no sentences).",
      "Examples: p3.2xlarge, amazon-linux-2023, postgres, 16, db.r6g.large",
    ].join("\n");

    const [err, text] = await llmClient.generateText(prompt);
    s.stop();

    if (err || !text) return undefined;
    const suggested = text.trim().split("\n")[0]?.trim();
    if (!suggested || suggested.length > 100) {
      clack.log.warn(
        "Could not determine a suggestion. Please enter an exact value.",
      );
      return "re-prompt";
    }

    let priceHint = "";
    const ps = clack.spinner();
    ps.start("Checking price...");
    const price = await fetchSuggestionPrice(
      suggested,
      field.name,
      resourceType,
      tools,
    );
    ps.stop();
    if (price) priceHint = ` (~${price})`;

    const confirm = await clack.confirm({
      message: `Suggested: ${suggested}${priceHint} — use this?`,
      initialValue: true,
    });
    if (clack.isCancel(confirm)) {
      clack.cancel(UserMessage.WIZARD_CANCELLED);
      throw new UserCancelledError();
    }
    if (confirm) return suggested;
    return "re-prompt";
  } catch {
    s.stop("Could not get suggestion");
    return undefined;
  }
}

async function askManualValue(
  field: ResourceField,
): Promise<string | undefined> {
  const manualValue = await clack.text({
    message: `${field.question.label} — Enter the exact value`,
    placeholder: "e.g., t3.medium, p3.2xlarge",
  });
  if (clack.isCancel(manualValue)) {
    clack.cancel(UserMessage.WIZARD_CANCELLED);
    throw new UserCancelledError();
  }
  const val = typeof manualValue === "string" ? manualValue.trim() : "";
  return val ? val : undefined;
}
