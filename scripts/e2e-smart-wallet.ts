/**
 * End-to-end smart-wallet onboarding check — does exactly what the browser does with Freighter,
 * but with a throwaway friendbot-funded TESTNET keypair standing in for the user's wallet.
 *
 *   pnpm dev                        # in one terminal (backend :4001 + web)
 *   pnpm e2e:smart-wallet           # in another
 *
 * Env overrides: WEB_URL (default http://localhost:${WEB_PORT:-3000}), BACKEND_URL (default
 * http://localhost:4001). Contract IDs are read from configs/contracts.testnet.json.
 *
 * Flow (mirrors apps/web/app/lib/agentsAuth.ts, services/onboarding/OnboardingService.ts):
 *   1. POST backend /api/auth/challenge          -> message
 *   2. sign SEP-53 digest sha256("Stellar Signed Message:\n"+message), base64   (Freighter signMessage)
 *   3. POST backend /api/auth/verify             -> session JWT
 *   4. POST web /api/connect/check               -> "new"
 *   5. POST web /api/connect/prepare             -> unsigned Soroban auth entry
 *   6. authorizeEntry() with sha256(preimage) signed by the owner key (Freighter signAuthEntry)
 *   7. POST web /api/connect/submit              -> deploys wallet, writes + verifies registry, saves DB row
 *   8. verify: contract exists on RPC, owner() == owner, backend GET /api/smart-wallets,
 *      on-chain registry get_smart_wallet(owner), /api/connect/check now "existing"
 */
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { Address, Keypair, Networks, rpc, scValToNative, authorizeEntry, xdr, Contract, TransactionBuilder, BASE_FEE, Account } from '@stellar/stellar-sdk';

const WEB_URL = process.env.WEB_URL || `http://localhost:${process.env.WEB_PORT || 3000}`;
const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:4001';
const RPC_URL = process.env.SOROBAN_RPC_URL || 'https://soroban-testnet.stellar.org';
const PASSPHRASE = Networks.TESTNET;
const contracts = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../configs/contracts.testnet.json'), 'utf8'));
const server = new rpc.Server(RPC_URL);

let failures = 0;
function step(n: string) { console.log(`\n[${n}]`); }
function check(label: string, ok: boolean, detail = '') {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}
function sep53Digest(message: string): Buffer {
  return createHash('sha256').update(`Stellar Signed Message:\n${message}`, 'utf8').digest();
}
async function post(url: string, body: unknown, token?: string) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  const data: any = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

async function readRegistry(owner: string): Promise<string | null> {
  const src = Keypair.random().publicKey(); // simulation only; account need not exist for read sims
  const tx = new TransactionBuilder(new Account(src, '0'), { fee: BASE_FEE, networkPassphrase: PASSPHRASE })
    .addOperation(new Contract(contracts.registry).call('get_smart_wallet', new Address(owner).toScVal()))
    .setTimeout(30).build();
  const sim: any = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) throw new Error(sim.error);
  const v = sim.result?.retval ? scValToNative(sim.result.retval) : null;
  return v ?? null;
}

async function main() {
  console.log(`web=${WEB_URL} backend=${BACKEND_URL} rpc=${RPC_URL}`);
  const kp = Keypair.random();
  const owner = kp.publicKey();
  console.log(`throwaway owner (stands in for Freighter): ${owner}`);

  step('0 fund owner via friendbot');
  const fb = await fetch(`https://friendbot.stellar.org/?addr=${owner}`);
  check('friendbot funded', fb.ok, `HTTP ${fb.status}`);

  step('1-3 wallet-signature login');
  const ch = await post(`${BACKEND_URL}/api/auth/challenge`, { publicKey: owner });
  check('challenge issued', ch.ok && !!ch.data.message, `HTTP ${ch.status}`);
  const signature = kp.sign(sep53Digest(ch.data.message)).toString('base64');
  const ver = await post(`${BACKEND_URL}/api/auth/verify`, { publicKey: owner, signature });
  check('signature verified, session token issued', ver.ok && !!ver.data.token, ver.ok ? '' : JSON.stringify(ver.data));
  const token: string = ver.data.token;
  if (!token) throw new Error('no session token — cannot continue');

  step('negative: wrong signature must be rejected');
  const ch2 = await post(`${BACKEND_URL}/api/auth/challenge`, { publicKey: owner });
  const bad = await post(`${BACKEND_URL}/api/auth/verify`, { publicKey: owner, signature: Keypair.random().sign(sep53Digest(ch2.data.message)).toString('base64') });
  check('bad signature rejected', !bad.ok, `HTTP ${bad.status}`);

  step('4 /api/connect/check (before)');
  const c1 = await post(`${WEB_URL}/api/connect/check`, {}, token);
  check('status is "new"', c1.ok && c1.data.status === 'new', `HTTP ${c1.status} ${JSON.stringify(c1.data)}`);

  step('5 /api/connect/prepare');
  const prep = await post(`${WEB_URL}/api/connect/prepare`, { owner }, token);
  check('prepared sponsored deploy', prep.ok && !!prep.data.unsignedEntryXdr, prep.ok ? `wallet will be ${prep.data.smartWalletAddress}` : JSON.stringify(prep.data));
  if (!prep.ok) throw new Error('prepare failed');

  step('6 sign auth entry as owner (Freighter signAuthEntry equivalent)');
  const entry = xdr.SorobanAuthorizationEntry.fromXDR(prep.data.unsignedEntryXdr, 'base64');
  const signedEntry = await authorizeEntry(
    entry,
    async (preimage) => kp.sign(createHash('sha256').update(preimage.toXDR()).digest()),
    prep.data.validUntilLedgerSeq,
    PASSPHRASE
  );
  const signedEntryXdr = signedEntry.toXDR('base64');
  check('auth entry signed', !!signedEntryXdr);

  step('7 /api/connect/submit (deploy + registry + DB)');
  const sub = await post(`${WEB_URL}/api/connect/submit`, { owner, saltHex: prep.data.saltHex, signedEntryXdr }, token);
  check('wallet deployed', sub.ok && sub.data.status === 'created', sub.ok ? '' : `HTTP ${sub.status} ${JSON.stringify(sub.data)}`);
  const wallet: string = sub.data.smartWallet;
  check('submit returned the predicted address', wallet === prep.data.smartWalletAddress, wallet);

  step('8 verification');
  // contract instance on RPC
  const key = xdr.LedgerKey.contractData(new xdr.LedgerKeyContractData({
    contract: new Address(wallet).toScAddress(), key: xdr.ScVal.scvLedgerKeyContractInstance(), durability: xdr.ContractDataDurability.persistent(),
  }));
  const ledger = await server.getLedgerEntries(key);
  check('contract instance exists on testnet RPC', ledger.entries.length === 1);
  // on-chain owner()
  const ownerSim: any = await server.simulateTransaction(
    new TransactionBuilder(new Account(owner, '0'), { fee: BASE_FEE, networkPassphrase: PASSPHRASE })
      .addOperation(new Contract(wallet).call('owner')).setTimeout(30).build());
  const onchainOwner = ownerSim.result?.retval ? scValToNative(ownerSim.result.retval) : null;
  check('wallet.owner() == throwaway owner', onchainOwner === owner, String(onchainOwner));
  // backend list
  const list: any = await (await fetch(`${BACKEND_URL}/api/smart-wallets`, { headers: { Authorization: `Bearer ${token}` } })).json();
  check('backend GET /api/smart-wallets returns it', list.owner === owner && list.wallets?.some((w: any) => w.address === wallet));
  // registry
  const reg = await readRegistry(owner);
  check('registry get_smart_wallet(owner) == wallet', reg === wallet, String(reg));
  // check again
  const c2 = await post(`${WEB_URL}/api/connect/check`, {}, token);
  check('/api/connect/check now "existing"', c2.ok && c2.data.status === 'existing' && c2.data.smartWallet === wallet);
  // register retry idempotency (also part of the flow)
  const rg = await post(`${WEB_URL}/api/connect/register`, { smartWallet: wallet }, token);
  check('/api/connect/register idempotent retry succeeds', rg.ok && rg.data.status === 'created', rg.ok ? '' : JSON.stringify(rg.data));

  // creation tx hash for the report: newest tx of the wallet's ledger entry
  // Find the deploy tx: the sponsoring funder (== deployer key) submitted it in the ledger the
  // instance was created in. Best-effort lookup via Horizon.
  const createdLedger = (ledger.entries[0] as any)?.lastModifiedLedgerSeq;
  let txHash = 'unknown';
  try {
    const funder = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../configs/deployment.testnet.json'), 'utf8')).deployer;
    const h: any = await (await fetch(`https://horizon-testnet.stellar.org/accounts/${funder}/transactions?order=desc&limit=10`)).json();
    txHash = h._embedded.records.find((t: any) => t.ledger === createdLedger)?.hash ?? 'unknown';
  } catch { /* informational only */ }
  console.log('\n--- summary ---');
  console.log(`owner:         ${owner}`);
  console.log(`smart wallet:  ${wallet}`);
  console.log(`explorer:      https://stellar.expert/explorer/testnet/contract/${wallet}`);
  console.log(`deploy tx:     ${txHash} (ledger ${createdLedger})`);
  console.log(failures === 0 ? '\nRESULT: PASS' : `\nRESULT: FAIL (${failures} check(s) failed)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('\nE2E aborted:', e); process.exit(1); });
