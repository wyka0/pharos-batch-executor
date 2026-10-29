import { describe, expect, it } from 'vitest';

import { ActionValidationError } from '../src/errors.js';
import { validateActions } from '../src/validation.js';
import { threeActions } from './fixtures.js';

describe('validateActions', () => {
  it('accepts and normalizes at least three independent actions', () => {
    const actions = validateActions(threeActions());
    expect(actions).toHaveLength(3);
    expect(actions[0]?.idBytes32).toMatch(/^0x[0-9a-f]{64}$/);
    expect(actions.every((action) => action.value === 0n)).toBe(true);
  });

  it.each([
    { label: 'zero actions', actions: [] },
    { label: 'one action', actions: threeActions().slice(0, 1) },
    { label: 'two actions', actions: threeActions().slice(0, 2) },
  ])('rejects fewer than three: $label', ({ actions }) => {
    expect(() => validateActions(actions)).toThrow(/at least 3/);
  });

  it('rejects duplicate identifiers and identifies both occurrences', () => {
    const actions = threeActions();
    actions[2] = { ...actions[2]!, id: 'one' };
    expect(() => validateActions(actions)).toThrow(/duplicate action id "one".*action 0/);
  });

  it.each([
    ['missing target', '', /valid EVM address/],
    ['short target', '0x1234', /valid EVM address/],
    ['zero target', '0x0000000000000000000000000000000000000000', /zero address/],
    ['non-hex target', '0xzz11111111111111111111111111111111111111', /valid EVM address/],
  ])('rejects malformed address: %s', (_label, target, pattern) => {
    const actions = threeActions();
    actions[1] = { ...actions[1]!, target };
    expect(() => validateActions(actions)).toThrow(pattern);
  });

  it.each([
    ['no prefix', '12345678', /start with 0x/],
    ['odd length', '0x123456789', /odd hex length/],
    ['non-hex', '0x123456zz', /non-hex/],
    ['short selector', '0x1234', /shorter than a 4-byte/],
  ])('rejects malformed calldata: %s', (_label, calldata, pattern) => {
    const actions = threeActions();
    actions[1] = { ...actions[1]!, calldata };
    expect(() => validateActions(actions)).toThrow(pattern);
  });

  it('normalizes empty calldata for plain value transfers', () => {
    const actions = threeActions();
    actions[1] = { ...actions[1]!, calldata: '', value: '1' };
    expect(validateActions(actions)[1]?.calldata).toBe('0x');
  });

  it.each([
    ['negative', -1],
    ['fractional', 1.2],
    ['scientific string', '1e18'],
    ['hex string', '0x10'],
    ['empty', ''],
  ])('rejects malformed value: %s', (_label, value) => {
    const actions = threeActions();
    actions[0] = { ...actions[0]!, value };
    expect(() => validateActions(actions)).toThrow(ActionValidationError);
  });

  it('rejects more than the on-chain maximum', () => {
    const base = threeActions()[0]!;
    const actions = Array.from({ length: 33 }, (_, i) => ({ ...base, id: `id-${i}` }));
    expect(() => validateActions(actions)).toThrow(/limit of 32/);
  });

  it.each([null, {}, 'not-array', 123])('rejects a non-array input: %s', (input) => {
    expect(() => validateActions(input)).toThrow(/array/);
  });

  it('rejects null or non-object actions', () => {
    expect(() => validateActions([null, ...threeActions().slice(1)])).toThrow(/object/);
  });

  it('requires explicit independence and rejects dependency fields', () => {
    const actions = threeActions();
    expect(() => validateActions([{ ...actions[0], independent: false }, ...actions.slice(1)])).toThrow(/explicitly true/);
    expect(() => validateActions([{ ...actions[0], dependsOn: 'two' }, ...actions.slice(1)])).toThrow(/dependent/);
  });

  it.each([0, 24_999, 1_000_001, 'bad'])('rejects invalid per-action gas limit: %s', (gasLimit) => {
    expect(() => validateActions([{ ...threeActions()[0], gasLimit }, ...threeActions().slice(1)])).toThrow(/gasLimit/);
  });

  it('enforces uint256 and calldata size limits', () => {
    expect(() => validateActions([{ ...threeActions()[0], value: (1n << 256n).toString() }, ...threeActions().slice(1)])).toThrow(/uint256/);
    expect(() => validateActions([{ ...threeActions()[0], calldata: `0x${'ff'.repeat(4097)}` }, ...threeActions().slice(1)])).toThrow(/4096/);
  });

  it('rejects null values rather than silently defaulting them', () => {
    expect(() => validateActions([{ ...threeActions()[0], value: null }, ...threeActions().slice(1)])).toThrow(/value/);
  });
});
