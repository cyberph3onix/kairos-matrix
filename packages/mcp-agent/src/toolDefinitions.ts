// Single source of truth for the MCP server's tool definitions (name, description, input
// schema). index.ts registers exactly these on the MCP server; the backend's public
// /api/pipeline/mcp route imports them to show the real tool surface. Importing this module has
// no side effects (no Turnkey/keystore access, no server start).
import { z } from 'zod';
import { executeActionSchema } from './tools/executeAction.js';
import { spendFundsSchema } from './tools/spendFunds.js';

export interface KairosMcpToolDefinition {
  name: string;
  description: string;
  /** zod raw shape handed to McpServer.tool(). */
  shape: z.ZodRawShape;
}

export const TOOL_DEFINITIONS: Record<'get_agent_pubkey' | 'list_my_delegations' | 'spend_funds' | 'execute_action', KairosMcpToolDefinition> = {
  get_agent_pubkey: {
    name: 'get_agent_pubkey',
    description:
      "Returns this agent's id and Stellar public key. A delegator must create a Kairos " +
      'delegation with this address as the `delegate` (with spend-limit/target-whitelist/' +
      'time-restriction caveats) before this agent can spend anything. Each agent identity ' +
      '(KAIROS_AGENT_ID) has its own MPC-backed private key and must be delegated to separately.',
    shape: {},
  },
  list_my_delegations: {
    name: 'list_my_delegations',
    description:
      'Lists the delegations currently granted to this agent (exported to the local ' +
      'delegations directory and not disabled on-chain), including their caveats.',
    shape: {},
  },
  spend_funds: {
    name: 'spend_funds',
    description:
      'Transfers a SEP-41 token amount from the delegation wallet to a destination address, ' +
      "gated by this agent's spend-limit caveat for that token.",
    shape: spendFundsSchema,
  },
  execute_action: {
    name: 'execute_action',
    description:
      'Invokes an arbitrary contract function on behalf of the delegation wallet, gated by ' +
      "this agent's target-whitelist caveat. Prefer spend_funds for plain token transfers.",
    shape: executeActionSchema,
  },
};

// Minimal zod -> JSON Schema for the field kinds these tools use (string/number/boolean/array/union).
function toJson(t: z.ZodTypeAny): Record<string, unknown> {
  const def = (t as { _def: { typeName: string; description?: string; type?: z.ZodTypeAny; options?: z.ZodTypeAny[]; innerType?: z.ZodTypeAny } })._def;
  const base: Record<string, unknown> = {};
  switch (def.typeName) {
    case 'ZodString': base.type = 'string'; break;
    case 'ZodNumber': base.type = 'number'; break;
    case 'ZodBoolean': base.type = 'boolean'; break;
    case 'ZodArray': base.type = 'array'; base.items = toJson(def.type!); break;
    case 'ZodUnion': base.anyOf = def.options!.map(toJson); break;
    case 'ZodOptional': return toJson(def.innerType!);
    default: base.type = 'unknown';
  }
  if (def.description) base.description = def.description;
  return base;
}

export function describeTools() {
  return Object.values(TOOL_DEFINITIONS).map((tool) => {
    const entries = Object.entries(tool.shape);
    return {
      name: tool.name,
      description: tool.description,
      inputSchema: {
        type: 'object',
        properties: Object.fromEntries(entries.map(([k, v]) => [k, toJson(v as z.ZodTypeAny)])),
        required: entries.filter(([, v]) => !(v as z.ZodTypeAny).isOptional()).map(([k]) => k),
      },
    };
  });
}
