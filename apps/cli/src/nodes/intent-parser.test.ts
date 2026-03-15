import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ExecutionStatus } from '@assignee/core';
import type { AgentState } from '../services/graph.js';
import { SUPPORTED_POC_TYPES } from '../config/constants.js';

// Automock the ai module
vi.mock('ai');

// Mock bedrock to prevent initialization side-effects
vi.mock('@ai-sdk/amazon-bedrock', () => ({
  createAmazonBedrock: vi.fn(() => vi.fn()),
}));

import { intentParserNode } from './intent-parser.js';
import { generateText } from 'ai';

describe('intentParserNode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('identifies valid POC resource type', async () => {
    vi.mocked(generateText).mockResolvedValue({
      output: { resourceType: 'AWS::S3::Bucket' }
    } as any);

    const state = { userIntent: 'create an S3 bucket' } as AgentState;
    const result = await intentParserNode(state);

    expect(result.resourceType).toBe('AWS::S3::Bucket');
    expect(result.executionStatus).toBeUndefined();
  });

  it('rejects unsupported resource types', async () => {
    vi.mocked(generateText).mockResolvedValue({
      output: { resourceType: 'UNSUPPORTED' }
    } as any);

    const state = { userIntent: 'create an unknown resource' } as AgentState;
    const result = await intentParserNode(state);

    expect(result.executionStatus).toBe(ExecutionStatus.UNSUPPORTED_RESOURCE);
    expect(result.errorMessage).toBe(`Unsupported resource type. Supported in POC: ${SUPPORTED_POC_TYPES.join(', ')}.`);
    expect(result.resourceType).toBeUndefined();
  });
});
