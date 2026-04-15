/**
 * Result-envelope helpers for the apply_plan MCP tool.
 *
 * Every response returned from the tool handler is a
 * `CallToolResult`-compatible envelope with a single text content
 * block whose body is a JSON payload. Centralising the envelope shape
 * here keeps the handler focused on control flow.
 */

/** JSON payload shape for a tool response; contents are free-form. */
export type EnvelopeBody = Record<string, unknown>;

/**
 * A CallToolResult-compatible envelope. The MCP SDK expects the
 * `[x: string]: unknown` index signature for arbitrary forward-compat
 * fields, so we declare the shape as a type alias rather than an
 * interface (interfaces can't satisfy the SDK's open-shape constraint).
 */
export type ToolEnvelope = {
  [x: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

/** Wraps a JSON body as an MCP tool text-content envelope. */
function wrap(body: EnvelopeBody, isError: boolean): ToolEnvelope {
  const envelope: ToolEnvelope = {
    content: [{ type: "text" as const, text: JSON.stringify(body) }],
  };
  if (isError) envelope.isError = true;
  return envelope;
}

/** Error envelope with `error: true` and a human-readable message. */
export function errorEnvelope(body: EnvelopeBody): ToolEnvelope {
  return wrap({ error: true, ...body }, true);
}

/** Success envelope — caller supplies the payload shape. */
export function successEnvelope(body: EnvelopeBody): ToolEnvelope {
  return wrap(body, false);
}
