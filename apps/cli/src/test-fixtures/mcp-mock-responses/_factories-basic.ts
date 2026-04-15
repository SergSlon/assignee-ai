// AUTO-GENERATED — split from monolith mcp-mock-responses.ts (story 48-10).
import { vi } from "vitest";
import type { StructuredTool } from "@langchain/core/tools";

export function createMockTool(
  name: string,
  response: unknown,
): StructuredTool {
  return {
    name,
    description: "",
    invoke: vi.fn().mockResolvedValue(response),
  } as unknown as StructuredTool;
}

export function createFailingMockTool(
  name: string,
  error: Error = new Error("Tool execution failed"),
): StructuredTool {
  return {
    name,
    description: "",
    invoke: vi.fn().mockRejectedValue(error),
  } as unknown as StructuredTool;
}

export function createHangingMockTool(name: string): StructuredTool {
  return {
    name,
    description: "",
    invoke: vi.fn(() => new Promise<never>(() => {})),
  } as unknown as StructuredTool;
}

export function createDelayedMockTool(
  name: string,
  response: unknown,
  delayMs: number,
): StructuredTool {
  return {
    name,
    description: "",
    invoke: vi.fn(
      () =>
        new Promise((resolve) => setTimeout(() => resolve(response), delayMs)),
    ),
  } as unknown as StructuredTool;
}

export function createNullMockTool(name: string): StructuredTool {
  return {
    name,
    description: "",
    invoke: vi.fn().mockResolvedValue(null),
  } as unknown as StructuredTool;
}

export function createSequenceMockTool(
  name: string,
  responses: unknown[],
): StructuredTool {
  const mockFn = vi.fn();
  responses.forEach((response) => {
    if (response instanceof Error) {
      mockFn.mockRejectedValueOnce(response);
    } else {
      mockFn.mockResolvedValueOnce(response);
    }
  });
  return {
    name,
    description: "",
    invoke: mockFn,
  } as unknown as StructuredTool;
}
