import test from 'node:test';
import assert from 'node:assert/strict';
import { getPricingForModel, calculateCostFromTokens } from '../../open-sse/providers/pricing.js';

test('getPricingForModel matches Qoder model aliases', () => {
  // qmodel_38max -> Qwen 3.8 Max pricing
  const p1 = getPricingForModel('qoder', 'qmodel_38max');
  assert.ok(p1, 'Expected pricing for qmodel_38max');
  assert.equal(p1.input, 2.00);
  assert.equal(p1.output, 6.00);

  // dmodel -> DeepSeek pricing
  const p2 = getPricingForModel('qoder', 'dmodel');
  assert.ok(p2, 'Expected pricing for dmodel');
  assert.equal(p2.input, 0.14);
  assert.equal(p2.output, 0.28);

  // dfmodel -> DeepSeek flash pricing
  const p3 = getPricingForModel('qoder', 'dfmodel');
  assert.ok(p3, 'Expected pricing for dfmodel');
  assert.equal(p3.input, 0.14);
});

test('calculateCostFromTokens calculates positive cost for Qoder models', () => {
  const pricing = getPricingForModel('qoder', 'qmodel_38max');
  const cost = calculateCostFromTokens({ prompt_tokens: 1000000, completion_tokens: 1000000 }, pricing);
  assert.equal(cost, 8.00); // 2.00 + 6.00
});
