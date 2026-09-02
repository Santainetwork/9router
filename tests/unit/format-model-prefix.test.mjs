import test from 'node:test';
import assert from 'node:assert/strict';
import { formatModelWithProviderPrefix } from '../../src/lib/db/repos/usageRepo.js';

test('formatModelWithProviderPrefix respects pre-existing slash in requestedModel or upstreamModel', () => {
  assert.equal(
    formatModelWithProviderPrefix('gemini-3.7-flash', 'antigravity', { requestedModel: 'ag/gemini-3.7-flash' }),
    'ag/gemini-3.7-flash'
  );
  assert.equal(
    formatModelWithProviderPrefix('qwen3.8-max', 'openai-compatible-chat-123', { upstreamModel: 'amanai/qwen3.8-max' }),
    'amanai/qwen3.8-max'
  );
});

test('formatModelWithProviderPrefix auto-attaches provider short prefix when model has no slash', () => {
  assert.equal(
    formatModelWithProviderPrefix('gemini-3.7-flash-high', 'antigravity', {}),
    'ag/gemini-3.7-flash-high'
  );
  assert.equal(
    formatModelWithProviderPrefix('deepseek-v4-pro', 'qoder', {}),
    'qoder/deepseek-v4-pro'
  );
  assert.equal(
    formatModelWithProviderPrefix('claude-sonnet-4-6', 'claude', {}),
    'claude/claude-sonnet-4-6'
  );
});
