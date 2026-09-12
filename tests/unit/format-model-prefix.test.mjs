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

test('formatModelWithProviderPrefix prioritizes actual model sent to provider over combo requestedModel alias', () => {
  assert.equal(
    formatModelWithProviderPrefix('gemini-3.8-flash-high', 'antigravity', { requestedModel: 'gemini-3.8-flash' }),
    'ag/gemini-3.8-flash-high'
  );
  assert.equal(
    formatModelWithProviderPrefix('deepseek-v4.1-flash', 'qoder', { requestedModel: 'deepseek-v4-flash' }),
    'qoder/deepseek-v4.1-flash'
  );
  assert.equal(
    formatModelWithProviderPrefix('myr/deepseek-v4.1-flash', 'openai-compatible-chat-123', { requestedModel: 'deepseek-v4-flash' }),
    'myr/deepseek-v4.1-flash'
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
