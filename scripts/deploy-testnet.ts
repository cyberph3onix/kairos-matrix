/**
 * Fresh Stellar TESTNET deploy of the whole Kairos contract suite.
 *
 *   pnpm deploy:testnet                       # uses identity "kairos-matrix-deployer"
 *   DEPLOYER_ALIAS=my-key pnpm deploy:testnet # use another `stellar keys` identity
 *
 * Requires: Rust + `wasm32v1-none` target, the Stellar CLI, and a funded testnet identity
 * (`stellar keys generate <alias> --network testnet --fund`).
 *
 * Writes:
 *   configs/contracts.testnet.json    contract IDs + custom-account wasm hash (read by tooling/docs)
 *   configs/deployment.testnet.json   deployer PUBLIC key, wasm hashes, deploy tx hashes, timestamp
 */
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const DEPLOYER_ALIAS = process.env.DEPLOYER_ALIAS || 'kairos-matrix-deployer';
const NETWORK = 'testnet';
const ROOT = path.resolve(__dirname, '..');
const CONTRACTS_DIR = path.join(ROOT, 'contracts/soroban');
const CONFIG_DIR = path.join(ROOT, 'configs');
const CONFIG_FILE = path.join(CONFIG_DIR, 'contracts.testnet.json');
const DEPLOYMENT_FILE = path.join(CONFIG_DIR, 'deployment.testnet.json');
const WASM_DIR = 'target/wasm32v1-none/release';

function run(cmd: string, args: string[], cwd = ROOT): { stdout: string; stderr: string } {
  console.log(`$ ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { encoding: 'utf8', cwd });
  if (r.stdout) console.log(r.stdout.trim());
  if (r.stderr) console.error(r.stderr.trim());
  if (r.status !== 0) throw new Error(`${cmd} ${args[0]} failed (exit ${r.status})`);
  return { stdout: r.stdout.trim(), stderr: r.stderr };
}

/** All tx hashes in CLI output, in order (a deploy may first emit a wasm-install tx, then the deploy tx). */
function txHashes(stderr: string): string[] {
  return [...stderr.matchAll(/explorer\/testnet\/tx\/([a-f0-9]{64})/gi)].map((m) => m[1]);
}

function deploy(wasm: string, ctorArgs: string[]) {
  const r = run('stellar', [
    'contract', 'deploy',
    '--wasm', `${WASM_DIR}/${wasm}`,
    '--source', DEPLOYER_ALIAS, '--network', NETWORK,
    '--', ...ctorArgs,
  ], CONTRACTS_DIR);
  const id = r.stdout.match(/(C[A-Z2-7]{55})/)?.[1];
  if (!id) throw new Error(`Could not parse contract id for ${wasm}: ${r.stdout}`);
  const hashes = txHashes(r.stderr);
  return { id, tx: hashes[hashes.length - 1] ?? null, wasmInstallTx: hashes.length > 1 ? hashes[0] : null };
}

function upload(wasm: string) {
  const r = run('stellar', [
    'contract', 'upload',
    '--wasm', `${WASM_DIR}/${wasm}`,
    '--source', DEPLOYER_ALIAS, '--network', NETWORK,
  ], CONTRACTS_DIR);
  const hash = r.stdout.match(/([a-f0-9]{64})/i)?.[1];
  if (!hash) throw new Error(`Could not parse wasm hash for ${wasm}: ${r.stdout}`);
  return { hash, tx: txHashes(r.stderr)[0] ?? null };
}

function main() {
  console.log('Building Soroban contracts...');
  run('stellar', ['contract', 'build'], CONTRACTS_DIR);

  const deployerAddress = run('stellar', ['keys', 'address', DEPLOYER_ALIAS]).stdout;
  console.log(`Deployer: ${deployerAddress}`);

  // CustomAccount wasm is uploaded on its own: the backend deploys one smart wallet per user
  // from this hash (CUSTOM_ACCOUNT_WASM_HASH).
  const wasm = upload('custom_account.wasm');

  // Constructors run atomically inside the deploy tx (CreateContractV2): no uninitialised window.
  const manager = deploy('delegation_manager.wasm', ['--owner', deployerAddress]);
  const policies = deploy('policies.wasm', ['--delegation_manager', manager.id]);
  const account = deploy('custom_account.wasm', ['--owner', deployerAddress, '--delegation_manager', manager.id]);
  const registry = deploy('registry.wasm', ['--admin', deployerAddress]);

  // Link the policy engine into the manager (owner-only). redeem_delegations rejects any caveat
  // enforcer other than this configured policies contract, so without this step no delegation
  // could ever be redeemed.
  const link = run('stellar', [
    'contract', 'invoke', '--id', manager.id,
    '--source', DEPLOYER_ALIAS, '--network', NETWORK,
    '--', 'set_policies_contract', '--policies', policies.id,
  ], CONTRACTS_DIR);
  const linkTx = txHashes(link.stderr).pop() ?? null;

  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify({
    delegationManager: manager.id,
    policyEngine: policies.id,
    customAccount: account.id,
    customAccountWasmHash: wasm.hash,
    registry: registry.id,
  }, null, 2) + '\n');
  fs.writeFileSync(DEPLOYMENT_FILE, JSON.stringify({
    network: NETWORK,
    deployedAt: new Date().toISOString(),
    deployer: deployerAddress,
    customAccountWasmHash: wasm.hash,
    transactions: {
      customAccountWasmUpload: wasm.tx,
      delegationManager: manager.tx,
      policyEngine: policies.tx,
      customAccount: account.tx,
      registry: registry.tx,
      setPoliciesContract: linkTx,
    },
  }, null, 2) + '\n');
  console.log(`\nWrote ${path.relative(ROOT, CONFIG_FILE)} and ${path.relative(ROOT, DEPLOYMENT_FILE)}`);
  console.log(fs.readFileSync(CONFIG_FILE, 'utf8'));
}

try {
  main();
} catch (e) {
  console.error('Deployment failed:', e);
  process.exit(1);
}
