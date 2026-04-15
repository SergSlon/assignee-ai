/**
 * Interactive prompt dispatcher with `?`-help loop and "Other" affordance.
 *
 * Wraps clack prompts and renderOptionPrompt; handles BACK / HELP / OTHER
 * sentinels emitted by display-prompts. Pricing-hint lookup for LLM-suggested
 * values lives in `pricing-hints.ts`.
 */

import * as clack from "@clack/prompts";
import { CfnKey, QuestionTypeName, UserCancelledError } from "@assignee/core";
import type {
  ResourceField,
  ResolvedFieldConfig,
  LlmPort,
} from "@assignee/core";
import type { StructuredTool } from "@langchain/core/tools";
import { UserMessage, WIZARD_NONE_SENTINEL } from "../../config/constants.js";
import {
  renderOptionPrompt,
  renderDocHelp,
  renderTradeoffHelp,
  BACK_SENTINEL,
  HELP_SENTINEL,
  OTHER_SENTINEL,
  REVIEW_SENTINEL,
} from "../display.js";
import { searchAmis } from "../aws-resource-discovery.js";
import { fetchSuggestionPrice } from "./pricing-hints.js";

/**
 * Wraps renderOptionPrompt with a `?` help loop.
 * If the user types `?` at a string/boolean prompt, fetches and displays AWS
 * documentation for the field, then re-presents the same prompt.
 * If the user types `?` at an enum/multi prompt, renders an LLM-powered
 * trade-off analysis instead (Story 10.6).
 *
 * @param field        - The resource field being prompted
 * @param resolved     - Resolved policy/value config for the field
 * @param resourceType - The AWS resource type (e.g. RESOURCE_TYPES.S3_BUCKET)
 * @param tools        - LangChain tools array (passed through from node)
 * @param llmClient    - Optional LLM client forwarded to renderDocHelp/renderTradeoffHelp
 * @param userIntent   - Optional user intent string for context-aware trade-off analysis
 */
export async function promptWithHelp(
  field: ResourceField,
  resolved: ResolvedFieldConfig,
  resourceType: string,
  tools: StructuredTool[],
  llmClient?: LlmPort,
  userIntent?: string,
  showBack = false,
  answers?: Record<string, unknown>,
): Promise<unknown> {
  let cachedHint: string | null = null;

  while (true) {
    // If we have a cached hint from a previous ? press, inject it into the field
    const promptField = cachedHint
      ? {
          ...field,
          question: { ...field.question, hint: cachedHint },
        }
      : field;

    const answer = await renderOptionPrompt(
      promptField,
      resolved,
      showBack,
      answers,
    );

    // Back navigation — return sentinel to caller (handle both scalar and array from multi-select)
    if (
      answer === BACK_SENTINEL ||
      (Array.isArray(answer) && answer.includes(BACK_SENTINEL))
    ) {
      return BACK_SENTINEL;
    }

    // Review-answers affordance — same propagation shape as BACK. Handled at
    // `runPromptLoop` level (opens review UI). See Story 48.7.
    if (
      answer === REVIEW_SENTINEL ||
      (Array.isArray(answer) && answer.includes(REVIEW_SENTINEL))
    ) {
      return REVIEW_SENTINEL;
    }

    // Multi fields: when user selects only '?', trigger help
    const isHelpRequest =
      answer === HELP_SENTINEL ||
      (Array.isArray(answer) && answer.includes(HELP_SENTINEL));

    if (isHelpRequest) {
      const isEnumOrMulti =
        field.question.type === "enum" || field.question.type === "multi";
      const isCategorySelect =
        field.question.type === QuestionTypeName.CATEGORY_SELECT;

      if (isEnumOrMulti && field.question.options && llmClient) {
        cachedHint = await renderTradeoffHelp(
          field.name,
          resourceType,
          [...field.question.options],
          userIntent ?? "",
          tools,
          llmClient,
        );
      } else if (isCategorySelect && field.question.categories && llmClient) {
        // Collect all options from all categories for the trade-off analysis
        const allOpts = field.question.categories.flatMap((c) =>
          c.options.map((o) => ({ value: o.value, label: o.label })),
        );
        cachedHint = await renderTradeoffHelp(
          field.name,
          resourceType,
          allOpts,
          userIntent ?? "",
          tools,
          llmClient,
        );
      } else {
        cachedHint = await renderDocHelp(
          field.name,
          resourceType,
          tools,
          llmClient,
        );
      }
      continue;
    }

    // "Other" — LLM-assisted value input for any enum/categorySelect field
    if (answer === OTHER_SENTINEL) {
      const description = await clack.text({
        message: `${field.question.label} — Describe what you need`,
        placeholder: "e.g., 'GPU for ML training' or enter exact value",
      });
      if (clack.isCancel(description)) {
        clack.cancel(UserMessage.WIZARD_CANCELLED);
        throw new UserCancelledError();
      }
      const userDesc =
        typeof description === "string" ? description.trim() : "";
      if (!userDesc) continue; // re-prompt

      // If it looks like an exact AWS value (e.g., "p3.2xlarge", "ami-0c55b", "db.t3.micro"),
      // return it directly. Must contain a dot, dash-with-digits, or AWS prefix to qualify.
      // Plain words like "linux" or "gpu" are descriptions, not exact values.
      const looksLikeAwsValue =
        !userDesc.includes(" ") &&
        /^[a-z0-9][a-z0-9._-]*$/i.test(userDesc) &&
        (/\./.test(userDesc) || // has dot: t3.small, db.t3.micro
          /^ami-/.test(userDesc) || // AMI ID
          /^subnet-/.test(userDesc) || // subnet ID
          /^sg-/.test(userDesc) || // security group ID
          /^i-/.test(userDesc) || // instance ID
          /^arn:/.test(userDesc) || // ARN
          /^db\./.test(userDesc) || // RDS class
          /\d+\.\d+/.test(userDesc)); // version: 16.4, 8.0
      if (looksLikeAwsValue) {
        return userDesc;
      }

      // Story 20.9: AMI search by description via ec2:DescribeImages
      if (field.name === CfnKey.IMAGE_ID) {
        const amiSpinner = clack.spinner();
        amiSpinner.start("Searching for matching AMIs...");
        const amiResults = await searchAmis(userDesc);
        amiSpinner.stop();

        if (amiResults.length > 0) {
          const amiChoice = await clack.select({
            message: `Found ${amiResults.length} matching AMI${amiResults.length === 1 ? "" : "s"}:`,
            options: [
              ...amiResults.map((ami) => ({
                value: ami.value,
                label: ami.label,
              })),
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
          if (amiChoice !== WIZARD_NONE_SENTINEL) {
            return amiChoice as string;
          }
          // User rejected all results — fall through to LLM suggestion
        }
      }

      // Use LLM to suggest the right value
      if (llmClient) {
        const s = clack.spinner();
        s.start("Finding the best option for you...");
        try {
          // Build field-aware prompt with available options context
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

          if (!err && text) {
            const suggested = text.trim().split("\n")[0]?.trim();
            if (!suggested || suggested.length > 100) {
              // LLM returned empty or a paragraph instead of a short value
              clack.log.warn(
                "Could not determine a suggestion. Please enter an exact value.",
              );
              continue; // re-prompt
            }

            // Fetch price for suggested value (non-blocking)
            let priceHint = "";
            if (suggested) {
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
            }

            const confirm = await clack.confirm({
              message: `Suggested: ${suggested}${priceHint} — use this?`,
              initialValue: true,
            });
            if (clack.isCancel(confirm)) {
              clack.cancel(UserMessage.WIZARD_CANCELLED);
              throw new UserCancelledError();
            }
            if (confirm) return suggested;
            // User rejected suggestion — re-prompt the field
            continue;
          }
        } catch {
          s.stop("Could not get suggestion");
        }
      }

      // Fallback: let user type an exact value
      const manualValue = await clack.text({
        message: `${field.question.label} — Enter the exact value`,
        placeholder: "e.g., t3.medium, p3.2xlarge",
      });
      if (clack.isCancel(manualValue)) {
        clack.cancel(UserMessage.WIZARD_CANCELLED);
        throw new UserCancelledError();
      }
      const val = typeof manualValue === "string" ? manualValue.trim() : "";
      if (val) return val;
      continue; // re-prompt if empty
    }

    return answer;
  }
}
