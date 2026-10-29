import { describe, expect, it } from 'vitest';

import { preparePlan } from '../src/plan.js';
import { validateActions } from '../src/validation.js';
import { threeActions } from './fixtures.js';

describe('preparePlan', () => {
  it('produces deterministic calldata and approval hash', () => {
    const actions = validateActions(threeActions());
    expect(preparePlan(actions)).toEqual(preparePlan(actions));
    expect(preparePlan(actions).batchCalldata).toMatch(/^0x[0-9a-f]+$/);
    expect(preparePlan(actions).planHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('binds the hash to action order, target, value, and calldata', () => {
    const original = validateActions(threeActions());
    const reordered = validateActions([threeActions()[1]!, threeActions()[0]!, threeActions()[2]!]);
    expect(preparePlan(original).planHash).not.toBe(preparePlan(reordered).planHash);
  });
});
