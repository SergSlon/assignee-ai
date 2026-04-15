/**
 * AWS SDK v3 middleware that records every command invocation.
 * Extracted from recorder.ts (Wave 6d F5).
 */
import type { RecordingInterceptor } from "./session.js";

/** Minimal types for AWS SDK v3 middleware (avoids @smithy/types dependency). */
interface SdkMiddlewareArgs {
  input?: unknown;
}
interface SdkMiddlewareResult {
  output?: unknown;
}
interface SdkMiddlewareContext {
  commandName?: string;
}
type SdkNextHandler = (args: SdkMiddlewareArgs) => Promise<SdkMiddlewareResult>;
type SdkMiddlewareFn = (
  next: SdkNextHandler,
  context: SdkMiddlewareContext,
) => (args: SdkMiddlewareArgs) => Promise<SdkMiddlewareResult>;

/**
 * AWS SDK v3 client with a middleware stack we can hook into.
 *
 * REG-N8: The real @aws-sdk/types `MiddlewareStack#add` is a heavily-
 * overloaded generic. Only `any[]` accepts every concrete CloudControl/EC2/
 * STS/etc client without pulling in the full @aws-sdk/types dep. Type-safety
 * for our own usage is enforced by the typed callback below.
 */
export interface SdkClientWithMiddleware {
  middlewareStack: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- AWS SDK v3 MiddlewareStack#add is a heavily overloaded generic; only `any[]` accepts every CloudControl/EC2/STS/etc client without forcing each caller to cast. The lambda passed at the call site below is fully typed via SdkMiddlewareFn so callers still get full safety inside the recorded middleware body.
    add: (...args: any[]) => void;
  };
}

/**
 * Adds recording middleware to an AWS SDK v3 client's middleware stack.
 * Captures command name, input, output, duration, and errors.
 */
export function addRecordingMiddleware(
  client: SdkClientWithMiddleware,
  recorder: RecordingInterceptor,
  serviceName: string,
): void {
  const recordingMiddleware: SdkMiddlewareFn =
    (next: SdkNextHandler, context: SdkMiddlewareContext) =>
    async (args: SdkMiddlewareArgs) => {
      const start = Date.now();
      const operationName = context.commandName ?? "Unknown";
      try {
        const result = await next(args);
        recorder.recordCall({
          type: "sdk",
          service: serviceName,
          operation: operationName,
          input: args.input,
          output: result.output,
          durationMs: Date.now() - start,
          timestamp: new Date().toISOString(),
        });
        return result;
      } catch (error) {
        recorder.recordCall({
          type: "sdk",
          service: serviceName,
          operation: operationName,
          input: args.input,
          error: String(error),
          durationMs: Date.now() - start,
          timestamp: new Date().toISOString(),
        });
        throw error;
      }
    };
  client.middlewareStack.add(recordingMiddleware, {
    step: "deserialize",
    name: "recordingMiddleware",
    priority: "low",
  });
}
