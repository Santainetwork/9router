import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveProviderIconId, getProviderIconSrc } from '../../src/shared/utils/providerIcon.js';

test('resolveProviderIconId normalizes custom/compatible provider IDs to openai icon', () => {
  assert.equal(resolveProviderIconId('openai-compatible-chat-12345'), 'openai');
  assert.equal(resolveProviderIconId('custom-embedding-abc'), 'openai');
  assert.equal(getProviderIconSrc('openai-compatible-chat-12345'), '/providers/openai.png');
});

test('resolveProviderIconId resolves standard aliases', () => {
  assert.equal(resolveProviderIconId('perplexity-agent'), 'perplexity');
  assert.equal(resolveProviderIconId('claude'), 'claude');
});
