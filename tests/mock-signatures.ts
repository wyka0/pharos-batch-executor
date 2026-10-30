/** SYNTHETIC identifiers only: no keys, signatures or Ethereum serialization. */
import { toHex, type Address, type Hex } from 'viem';
import type * as realViem from 'viem';
import { vi } from 'vitest';
import type { UnsignedTestnetTransaction } from '../src/testnet/signer.js';

const fixtures = vi.hoisted(() =>
  new Map<Hex, { sender: Address; tx: UnsignedTestnetTransaction }>());
let sequence = 0;

vi.mock('viem', async (original) => {
  const actual = (await original<void>()) as unknown as typeof realViem;
  return {
    ...actual,
    parseTransaction: (raw: Hex) => fixtures.has(raw) ? structuredClone(fixtures.get(raw)!.tx) : actual.parseTransaction(raw),
    recoverTransactionAddress: (args: { serializedTransaction: Hex }) => fixtures.has(args.serializedTransaction)
      ? Promise.resolve(fixtures.get(args.serializedTransaction)!.sender)
      : actual.recoverTransactionAddress(args as never),
  };
});

export function fakeSign(tx: UnsignedTestnetTransaction, sender: Address): Hex {
  const identifier = toHex(`SYNTHETIC-NOT-AN-ETHEREUM-TRANSACTION-${++sequence}`);
  fixtures.set(identifier, { sender, tx: structuredClone(tx) });
  return identifier;
}

export function clearFakeSignatures(): void { fixtures.clear(); }
