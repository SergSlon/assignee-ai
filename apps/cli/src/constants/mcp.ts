export const McpServerName = {
  CCAPI: 'ccapi-mcp-server',
  CFN: 'cfn-mcp-server',
  KNOWLEDGE: 'aws-knowledge-mcp-server',
  PRICING: 'aws-pricing-mcp-server',
} as const

export type McpServerNameType = typeof McpServerName[keyof typeof McpServerName]

export const McpCommand = {
  UVX: 'uvx',
} as const
