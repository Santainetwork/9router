import test from 'node:test';
import assert from 'node:assert/strict';
import { formatCompactNumber } from '../../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js';

test('formatCompactNumber formats numbers correctly', () => {
  assert.equal(formatCompactNumber(0), '0');
  assert.equal(formatCompactNumber(999), '999');
  assert.equal(formatCompactNumber(12500), '12.5K');
  assert.equal(formatCompactNumber(123142859), '123.1M');
  assert.equal(formatCompactNumber(2500000000), '2.5B');
});
