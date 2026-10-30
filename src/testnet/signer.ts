import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { privateKeyToAccount } from 'viem/accounts';
import type { Hex } from '../types.js';
import { ExecutionGateError } from '../errors.js';
import { ATLANTIC } from '../network.js';

export interface UnsignedTestnetTransaction {
  chainId: 688689; nonce: number; to?: Hex; data: Hex; value: bigint;
  gas: bigint; gasPrice: bigint; type: 'legacy';
}
export interface TestnetSigner { readonly address: Hex; sign(tx: UnsignedTestnetTransaction): Promise<Hex> }

interface LocalSignerAccount {
  address: Hex;
  signTransaction(tx: UnsignedTestnetTransaction): Promise<Hex>;
}

export interface LocalSignerDependencies {
  accountFromPrivateKey(key: Hex): LocalSignerAccount;
}

const DEFAULT_DEPENDENCIES: LocalSignerDependencies = {
  accountFromPrivateKey: (key) => privateKeyToAccount(key) as LocalSignerAccount,
};

/** Explicit local file only. Validation may call this without invoking sign(). */
export async function loadLocalSigner(
  envFile: string, expectedAddress: Hex, dependencies: LocalSignerDependencies = DEFAULT_DEPENDENCIES,
): Promise<TestnetSigner> {
  if (typeof envFile !== 'string' || !path.isAbsolute(envFile)) {
    throw new ExecutionGateError('An explicitly selected absolute signer configuration path is required.', {
      code: 'SIGNER_SOURCE_FAILED', safeCause: 'SIGNER_FILE_OR_FORMAT',
    });
  }
  let info;
  try { info = await lstat(envFile); }
  catch { throw new ExecutionGateError('Explicit signer configuration cannot be safely inspected.', { code: 'SIGNER_SOURCE_FAILED', safeCause: 'SIGNER_FILE_OR_FORMAT' }); }
  if (!info.isFile() || info.isSymbolicLink()) throw new ExecutionGateError('Signer configuration must be a regular non-symlink file.', {
    code: 'SIGNER_SOURCE_FAILED', safeCause: 'SIGNER_FILE_OR_FORMAT',
  });
  if (info.size > 65_536) throw new ExecutionGateError('Local signing configuration file exceeds size limit.', {
    code: 'SIGNER_SOURCE_FAILED', safeCause: 'SIGNER_FILE_OR_FORMAT',
  });
  let text: string;
  try { text = await readFile(envFile, 'utf8'); }
  catch { throw new ExecutionGateError('Explicit signer configuration cannot be safely read.', { code: 'SIGNER_SOURCE_FAILED', safeCause: 'SIGNER_FILE_OR_FORMAT' }); }
  const variable = (name: string): string | undefined => {
    const matches = text.split(/\r?\n/).filter((line) => new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=`).test(line));
    if (matches.length > 1) throw new ExecutionGateError('Duplicate signing configuration variable.', { code: 'SIGNER_SOURCE_FAILED', safeCause: 'SIGNER_FILE_OR_FORMAT' });
    const raw = matches[0]?.slice(matches[0].indexOf('=') + 1).trim();
    if (raw === undefined) return undefined;
    return raw.replace(/^(['"])(.*)\1$/, '$2');
  };
  const rpc = variable('RPC_URL');
  if (rpc !== undefined && rpc !== ATLANTIC.rpcUrl) throw new ExecutionGateError('Local configuration RPC does not match official Atlantic Testnet.', {
    code: 'SIGNER_SOURCE_FAILED', safeCause: 'SIGNER_FILE_OR_FORMAT',
  });
  const key = variable('PRIVATE_KEY');
  if (key === undefined || !/^(?:0x)?[0-9a-fA-F]{64}$/.test(key)) throw new ExecutionGateError('Local signing key is missing or malformed; do not paste it in chat.', {
    code: 'SIGNER_SOURCE_FAILED', safeCause: 'SIGNER_FILE_OR_FORMAT',
  });
  let account;
  try { account = dependencies.accountFromPrivateKey((key.startsWith('0x') ? key : `0x${key}`) as Hex); }
  catch { throw new ExecutionGateError('Local signing key is invalid.', { code: 'SIGNER_SOURCE_FAILED', safeCause: 'SIGNER_FILE_OR_FORMAT' }); }
  if (account.address.toLowerCase() !== expectedAddress.toLowerCase()) throw new ExecutionGateError('Signing account does not match the explicitly approved public sender.', {
    code: 'SIGNER_ADDRESS_MISMATCH', safeCause: 'SIGNER_PUBLIC_ADDRESS',
  });
  return { address: account.address, async sign(tx) {
    if (tx.chainId !== 688689 || tx.type !== 'legacy') throw new ExecutionGateError('Signer refuses non-Atlantic/non-legacy transaction.');
    try { return await account.signTransaction(tx); }
    catch { throw new ExecutionGateError('Offline transaction signing failed; no sensitive exception logged.'); }
  } };
}
