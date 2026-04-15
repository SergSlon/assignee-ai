import type { OptionMetadata } from "../../types.js";

/**
 * Formats a Lambda memory option label. Dollar amounts are intentionally
 * omitted here — all price rendering must go through the Pricing MCP at
 * runtime. Option labels surface capacity only so the wizard stays sync.
 */
export function memoryLabel(memoryMb: number): string {
  const mb = String(memoryMb).padStart(4);
  return `${mb} MB`;
}

/** Runtime option definition with optional deprecation flag. */
export type RuntimeOption = { value: string; label: string } & OptionMetadata;

/**
 * All Lambda runtime options. Deprecated runtimes (past AWS EOL) are
 * flagged and will be sorted to the bottom of the list with a
 * [DEPRECATED] label suffix.
 */
export const runtimeOptions: RuntimeOption[] = [
  {
    value: "nodejs22.x",
    label: "Node.js 22.x",
    fitHint: "Latest LTS, best cold start",
    recommended: true,
  },
  { value: "nodejs20.x", label: "Node.js 20.x", fitHint: "Stable LTS" },
  {
    value: "python3.13",
    label: "Python 3.13",
    fitHint: "Latest, ML/data workloads",
  },
  {
    value: "python3.12",
    label: "Python 3.12",
    fitHint: "Stable, wide library support",
  },
  {
    value: "java21",
    label: "Java 21",
    fitHint: "Enterprise, slower cold start",
  },
  { value: "dotnet8", label: ".NET 8", fitHint: "Cross-platform, enterprise" },
  { value: "ruby3.3", label: "Ruby 3.3", fitHint: "Scripting, web apps" },
  {
    value: "provided.al2023",
    label: "Custom runtime (Go/Rust/C++)",
    fitHint: "Bring your own runtime",
  },
];

/**
 * Sorts runtime options: non-deprecated first (preserving order),
 * deprecated last. Appends " [DEPRECATED]" suffix to deprecated option
 * labels.
 */
export function sortedRuntimeOptions(
  options: readonly RuntimeOption[],
): RuntimeOption[] {
  const active = options.filter((o) => !o.deprecated);
  const deprecated = options
    .filter((o) => o.deprecated)
    .map((o) => ({ ...o, label: `${o.label} [DEPRECATED]` }));
  return [...active, ...deprecated];
}

/** Exported for test use. */
export const sortedRuntimes = sortedRuntimeOptions(runtimeOptions);

/** Generates the configHints Runtime string from the options array. */
export function buildRuntimeHint(options: readonly RuntimeOption[]): string {
  const active = options.filter((o) => !o.deprecated);
  const deprecated = options.filter((o) => o.deprecated);
  const activeList = active.map((o) => o.value).join(", ");
  let hint = `Lambda Runtime MUST be one of: ${activeList}.`;
  if (deprecated.length > 0) {
    const deprecatedList = deprecated.map((o) => o.value).join(", ");
    hint += ` NEVER use deprecated runtimes (${deprecatedList}).`;
  } else {
    hint += " NEVER use deprecated runtimes.";
  }
  return hint;
}
