// Enforcement proof: SIMULATES (never submits) a delegated redemption through the SDK, as the demo
// agent, and reports whether the on-chain delegation-manager + policy contracts would allow it.
// The delegation (spend-limit / target-whitelist / time-restriction caveats) is created by the
// user's smart wallet via the same SDK calls the frontend uses (/api/delegate-sdk); this endpoint
// only reads/simulates. No funds move and nothing is signed with the agent key.
import { Address, Keypair, xdr } from '@stellar/stellar-sdk';
import { Asset } from '@stellar/stellar-sdk';
import type { Request, Response } from 'express';
import type { Delegation } from '@wolf1276/kairos-sdk';
import { getKairosClient } from '../kairos.js';
import { getNetwork } from '../config.js';

interface JsonSafeDelegation {
  delegate: string;
  delegator: string;
  authority: string;
  salt: string;
  nonce: string;
  signature: string;
  caveats: { enforcer: string; terms: number[] }[];
}

function deserialize(d: JsonSafeDelegation): Delegation {
  return {
    ...d,
    salt: BigInt(d.salt),
    nonce: BigInt(d.nonce),
    caveats: d.caveats.map((c) => ({ enforcer: c.enforcer, terms: new Uint8Array(c.terms) })),
  } as unknown as Delegation;
}

export function getDemoAgentKeypair(): Keypair | null {
  const secret = process.env.DEMO_AGENT_SECRET;
  return secret ? Keypair.fromSecret(secret) : null;
}

// Cross-contract panics only surface as Error(Contract, #n); the policy contract and the delegation
// manager each number their errors from 1, so the diagnostic hook name decides which table applies.
// (Same tables as packages/mcp-agent/src/errors.ts, which owns the canonical wording.)
async function explain(raw: string): Promise<{ contractError: string; code: number | null; source: 'policy' | 'delegation-manager' | null }> {
  const { mapThrownError } = await import('@wolf1276/kairos-mcp-agent/errors');
  const m = raw.match(/Error\(Contract, #(\d+)\)/);
  const policy = /before_hook|before_all|after_hook|after_all/.test(raw);
  return { contractError: mapThrownError(new Error(raw)), code: m ? Number(m[1]) : null, source: m ? (policy ? 'policy' : 'delegation-manager') : null };
}

export function createEnforceHandlers() {
  return {
    agent(_req: Request, res: Response) {
      const kp = getDemoAgentKeypair();
      if (!kp) return res.status(503).json({ error: 'DEMO_AGENT_SECRET is not configured' });
      res.json({ agentPublicKey: kp.publicKey(), network: getNetwork(), note: 'Create a delegation from your smart wallet TO this address (delegate), then POST /api/pipeline/enforce.' });
    },

    async enforce(req: Request, res: Response) {
      const agent = getDemoAgentKeypair();
      if (!agent) return res.status(503).json({ error: 'DEMO_AGENT_SECRET is not configured' });
      if (getNetwork() !== 'testnet') return res.status(403).json({ error: 'enforce is testnet-only' });

      const { smartWallet, delegation, amount, asset, target } = (req.body ?? {}) as {
        smartWallet?: string; delegation?: JsonSafeDelegation; amount?: string | number; asset?: string; target?: string;
      };
      if (!smartWallet || !delegation || amount === undefined || !target) {
        return res.status(400).json({ error: 'smartWallet, delegation (JSON-safe struct from SUBMIT_DELEGATION), amount (XLM units, e.g. "5"), and target (recipient address) are required' });
      }
      try {
        Address.fromString(smartWallet);
        Address.fromString(target);
      } catch {
        return res.status(400).json({ error: 'smartWallet/target must be valid Stellar addresses' });
      }
      if (delegation.delegator !== smartWallet) return res.status(400).json({ error: 'delegation.delegator does not match smartWallet' });
      if (delegation.delegate !== agent.publicKey()) {
        return res.status(400).json({ error: `delegation.delegate must be the demo agent (${agent.publicKey()}) — see GET /api/pipeline/agent` });
      }
      const units = String(amount);
      if (!/^\d+(\.\d{1,7})?$/.test(units)) return res.status(400).json({ error: 'amount must be a positive decimal (max 7 places), in whole asset units' });
      const [whole, frac = ''] = units.split('.');
      const stroops = BigInt(whole) * 10_000_000n + BigInt(frac.padEnd(7, '0'));

      const client = getKairosClient();
      const token = !asset || asset.toUpperCase() === 'XLM' ? Asset.native().contractId(client.networkPassphrase) : asset;
      const hi = xdr.Int64.fromString(BigInt.asIntN(64, stroops >> 64n).toString());
      const lo = xdr.Uint64.fromString(BigInt.asUintN(64, stroops).toString());
      const request = { delegate: agent.publicKey(), token, from: smartWallet, to: target, amountStroops: stroops.toString(), amount: units, function: 'transfer' };

      try {
        const sim = await client.execution.simulate({
          redeemerAddress: agent.publicKey(),
          delegationChains: [[deserialize(delegation)]],
          executions: [{
            target: token,
            function: 'transfer',
            args: [Address.fromString(smartWallet).toScVal(), Address.fromString(target).toScVal(), xdr.ScVal.scvI128(new xdr.Int128Parts({ hi, lo }))],
          }],
        });
        const ok = sim as unknown as { minResourceFee?: string; latestLedger?: number; cost?: unknown };
        return res.json({
          allowed: true,
          simulated: true,
          submitted: false,
          network: 'testnet',
          request,
          simulationResult: { status: 'SUCCESS', minResourceFee: ok.minResourceFee ?? null, latestLedger: ok.latestLedger ?? null, cost: ok.cost ?? null },
          note: 'Simulation only: the delegation manager and policy contracts accepted this redemption. Nothing was submitted.',
        });
      } catch (err) {
        const raw = err instanceof Error ? err.message : (() => { try { return JSON.stringify(err); } catch { return String(err); } })();
        const detail = (err as { simulation?: { error?: string; events?: unknown[] } })?.simulation;
        const text = `${raw} ${detail?.error ?? ''}`;
        if (/Error\(Contract, #\d+\)/.test(text)) {
          const e = await explain(text);
          return res.json({
            allowed: false,
            simulated: true,
            submitted: false,
            network: 'testnet',
            request,
            contractError: e.contractError,
            contractErrorCode: e.code,
            contractErrorSource: e.source,
            simulationResult: { status: 'REJECTED_BY_CONTRACT', raw: text.slice(0, 1200) },
          });
        }
        return res.status(502).json({ allowed: null, simulated: false, error: `simulation could not be completed: ${text.slice(0, 600)}`, request });
      }
    },
  };
}
