import test from 'node:test';
import assert from 'node:assert/strict';
import { parseQuotaData } from '../../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js';

test('parseQuotaData preserves remainingPercentage and unlimited for custom providers', () => {
  const customData = {
    plan: 'Amanai (active)',
    quotas: {
      'Credits Remaining': {
        used: 0,
        total: 123142859,
        remainingPercentage: 100,
        resetAt: null,
        unlimited: true
      }
    }
  };

  const parsed = parseQuotaData('openai-compatible-chat-custom', customData);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].name, 'Credits Remaining');
  assert.equal(parsed[0].total, 123142859);
  assert.equal(parsed[0].remainingPercentage, 100);
  assert.equal(parsed[0].unlimited, true);
});
