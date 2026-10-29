import { readFile, stat } from 'node:fs/promises';
import { privateKeyToAccount } from 'viem/accounts';
import type { Hex } from '../types.js';
import { ExecutionGateError } from '../errors.js';
import { ATLANTIC } from '../network.js';

export interface UnsignedTestnetTransaction {
  chainId: 688689; nonce: number; to?: Hex; data: Hex; value: bigint;
  gas: bigint; gasPrice: bigint; type: 'legacy';
}
export interface TestnetSigner { sign(tx: UnsignedTestnetTransaction): Promise<Hex> }

/** ONLY the gated runner calls this, after approval + read-only preflight. */
export async function loadLocalSigner(envFile: string, expectedAddress: Hex): Promise<TestnetSigner> {
  if ((await stat(envFile)).size > 65_536) throw new ExecutionGateError('Local signing configuration file exceeds size limit.');
  const text = await readFile(envFile, 'utf8');
  const variable = (name: string): string | undefined => {
    const matches = text.split(/\r?\n/).filter((line) => new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=`).test(line));
    if (matches.length > 1) throw new ExecutionGateError('Duplicate signing configuration variable.');
    const raw = matches[0]?.slice(matches[0].indexOf('=') + 1).trim();
    if (raw === undefined) return undefined;
    return raw.replace(/^(['"])(.*)\1$/, '$2');
  };
  const rpc = variable('RPC_URL');
  if (rpc !== undefined && rpc !== ATLANTIC.rpcUrl) throw new ExecutionGateError('Local configuration RPC does not match official Atlantic Testnet.');
  const key = variable('PRIVATE_KEY');
  if (key === undefined || !/^(?:0x)?[0-9a-fA-F]{64}$/.test(key)) throw new ExecutionGateError('Local signing key is missing or malformed; do not paste it in chat.');
  let account;
  try { account = privateKeyToAccount((key.startsWith('0x') ? key : `0x${key}`) as Hex); }
  catch { throw new ExecutionGateError('Local signing key is invalid.'); }
  if (account.address.toLowerCase() !== expectedAddress.toLowerCase()) throw new ExecutionGateError('Signing account does not match the explicitly approved public sender.');
  return { async sign(tx) {
    if (tx.chainId !== 688689 || tx.type !== 'legacy') throw new ExecutionGateError('Signer refuses non-Atlantic/non-legacy transaction.');
    try { return await account.signTransaction(tx); }
    catch { throw new ExecutionGateError('Offline transaction signing failed; no sensitive exception logged.'); }
  } };
}
