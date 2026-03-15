import { generateText, Output } from 'ai'
import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock'
import { z } from 'zod'
import { SUPPORTED_POC_TYPES } from '../config/constants.js'
import { ExecutionStatus } from '@assignee/core'
import type { AgentState } from '../services/graph.js'

const bedrock = createAmazonBedrock({ region: process.env['AWS_REGION'] ?? 'eu-west-1' })

const intentParserSchema = z.object({
  resourceType: z.enum(['AWS::S3::Bucket', 'AWS::SSM::Parameter', 'AWS::IAM::Role', 'UNSUPPORTED']),
})

export async function intentParserNode(state: AgentState): Promise<Partial<AgentState>> {
  const { output } = await generateText({
    model: bedrock('amazon.nova-lite-v1:0'),
    output: Output.object({ schema: intentParserSchema }),
    // @ts-expect-error NFR-15: maxTokens might not be defined in this version's types
    maxTokens: 1024,
    messages: [{
      role: 'user',
      content: `Classify this AWS infrastructure request into one of these types: ${SUPPORTED_POC_TYPES.join(', ')} or UNSUPPORTED.\n\nRequest: "${state.userIntent}"`,
    }],
  })

  if (output.resourceType === 'UNSUPPORTED') {
    return {
      executionStatus: ExecutionStatus.UNSUPPORTED_RESOURCE,
      errorMessage: `Unsupported resource type. Supported in POC: ${SUPPORTED_POC_TYPES.join(', ')}.`,
    }
  }

  // Type safe cast since zod enum aligns with SupportedPocType via our hardcoded array
  return { resourceType: output.resourceType }
}
