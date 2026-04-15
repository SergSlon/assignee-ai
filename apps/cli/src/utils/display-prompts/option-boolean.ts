/**
 * Boolean question handler — clack.confirm for simple yes/no; clack.select
 * when Back navigation is needed so the back option fits.
 */
import * as clack from "@clack/prompts";
import type { ResourceField } from "@assignee/core";
import type { BackOption } from "./shared-helpers.js";

export async function promptBoolean(
  field: ResourceField,
  defaultValue: unknown,
  backOption: BackOption[],
  showBack: boolean,
): Promise<unknown> {
  const boolDefault =
    defaultValue === true || defaultValue === "true" ? true : false;

  if (showBack) {
    // When back navigation is available, use select to fit the back option
    return clack.select({
      message: field.question.label,
      options: [
        ...backOption,
        { value: "true", label: "Yes" },
        { value: "false", label: "No" },
      ],
      initialValue: boolDefault ? "true" : "false",
    });
  }
  const confirmed = await clack.confirm({
    message: field.question.label,
    initialValue: boolDefault,
  });
  return clack.isCancel(confirmed) ? confirmed : confirmed ? "true" : "false";
}
