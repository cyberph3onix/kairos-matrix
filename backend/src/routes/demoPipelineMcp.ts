// Real MCP tool surface for GET /api/pipeline/mcp. Imports the same TOOL_DEFINITIONS the
// packages/mcp-agent server registers (no hand-written copy) and converts their zod shapes.
export async function loadMcpTools() {
  const mod = await import('@wolf1276/kairos-mcp-agent/tool-definitions');
  return {
    server: { name: 'kairos-agent', package: '@wolf1276/kairos-mcp-agent', transport: 'stdio', source: 'packages/mcp-agent/src/toolDefinitions.ts' },
    tools: mod.describeTools(),
  };
}
