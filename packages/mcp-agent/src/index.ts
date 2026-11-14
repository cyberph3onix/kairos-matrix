#!/usr/bin/env node
import type { Caveat } from '@wolf1276/kairos-sdk';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { getAgentId } from './config.js';
import { getKairosClient } from './client.js';
import { loadEligibleDelegations, type EligibleDelegation } from './delegations.js';
import { loadOrCreateAgentSigner } from './keystore.js';
import { executeActionHandler } from './tools/executeAction.js';
import { spendFundsHandler } from './tools/spendFunds.js';
import { TOOL_DEFINITIONS as T } from './toolDefinitions.js';

// Each MCP agent process is one identity, keyed by KAIROS_AGENT_ID (defaults to "default"
// for single-agent setups). Run multiple agents by starting this server multiple times with
// different KAIROS_AGENT_ID values — each gets its own MPC-backed (Turnkey) private key
// (keystore.ts) and must be granted its own delegation by the delegator. The private key
// material never exists in this process; every `sign()` is a round-trip to Turnkey.
const agentId = getAgentId();
const sessionSigner = await loadOrCreateAgentSigner(agentId);

const server = new McpServer({
  name: `kairos-agent:${agentId}`,
  version: '0.1.0',
});

server.tool(
  T.get_agent_pubkey.name,
  T.get_agent_pubkey.description,
  T.get_agent_pubkey.shape,
  async () => ({
    content: [{ type: 'text' as const, text: JSON.stringify({ agentId, publicKey: sessionSigner.publicKey() }) }],
  })
);

server.tool(
  T.list_my_delegations.name,
  T.list_my_delegations.description,
  T.list_my_delegations.shape,
  async () => {
    const client = getKairosClient();
    const eligible = await loadEligibleDelegations(client, sessionSigner.publicKey());
    const described = eligible.map(({ hash, delegation }: EligibleDelegation) => ({
      hash,
      delegator: delegation.delegator,
      caveats: delegation.caveats.map((c: Caveat) => {
        try {
          return client.policy.decode(c);
        } catch {
          return { type: 'unknown' };
        }
      }),
    }));
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(described, null, 2) }],
    };
  }
);

server.tool(
  T.spend_funds.name,
  T.spend_funds.description,
  T.spend_funds.shape,
  async (input) => spendFundsHandler(input, sessionSigner)
);

server.tool(
  T.execute_action.name,
  T.execute_action.description,
  T.execute_action.shape,
  async (input) => executeActionHandler(input, sessionSigner)
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error('kairos-mcp-agent failed to start:', error);
  process.exit(1);
});
