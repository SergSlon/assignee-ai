/**
 * Shared types for result-formatter sub-modules.
 */

import type { StructuredTool } from "@langchain/core/tools";
import type { AgentState } from "../../services/graph.js";

export interface FormatterContext {
  state: AgentState;
  tools?: StructuredTool[];
}

/**
 * All formatters return a partial state update (possibly empty). The dispatcher
 * composes these to build the node's final return.
 */
export type FormatterResult = Partial<AgentState>;

export type Formatter = (ctx: FormatterContext) => Promise<FormatterResult>;
