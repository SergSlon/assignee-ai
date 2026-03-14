import { describe, it, expect } from 'vitest';
import { createMcpClient, getMcpTools } from './mcp-client.js';

// Skip in CI unless MCP servers are explicitly available
describe.skipIf(!!process.env['CI'])('MCP integration', () => {
  it('fetches S3 schema from cfn-mcp-server', async () => {
    // 1. Initialize client (this spawns the 4 servers using standard uvx commands)
    const client = await createMcpClient();
    expect(client).toBeDefined();

    // 2. Fetch tools
    const tools = await getMcpTools(client);
    expect(tools.length).toBeGreaterThan(0);

    // 3. Find the get_resource_schema tool from cfn-mcp-server
    // Standard tools/list returns LangChain-compatible StructuredTools
    const getSchemaTool = tools.find((t) => t.name === 'get_resource_schema');
    expect(getSchemaTool).toBeDefined();

    if (!getSchemaTool) throw new Error('Tool not found');

    // 4. Call the tool to get the AWS::S3::Bucket schema
    // Tools return string JSON per LangChain adapter spec
    const responseString = await getSchemaTool.invoke({ typeName: 'AWS::S3::Bucket' });
    const response = JSON.parse(responseString);

    expect(response).toHaveProperty('properties');
    expect(response.properties).toBeDefined();
  }, 20000); // 20s timeout since 'uvx' might need to download the package on the first run
});
