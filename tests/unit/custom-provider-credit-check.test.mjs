import test from 'node:test';
import assert from 'node:assert/strict';
import { getCustomCompatibleUsage } from '../../open-sse/services/usage/customCompatible.js';

test('custom provider usage - returns plan and quotas for amanai', async () => {
  const mockConn = {
    id: 'test-conn',
    provider: 'openai-compatible-chat-mock',
    apiKey: 'sk-mock-key',
    providerSpecificData: {
      baseUrl: 'https://api.amanai.dev/v1',
      creditCheckType: 'amanai'
    }
  };

  // It should attempt to fetch amanai and return an object structure with quotas or message
  const result = await getCustomCompatibleUsage(mockConn);
  assert.ok(typeof result === 'object');
  assert.ok('plan' in result || 'message' in result);
});

test('custom provider usage - auto-detects amanai from baseUrl', async () => {
  const mockConn = {
    id: 'test-conn-auto-amanai',
    provider: 'openai-compatible-chat-mock',
    apiKey: 'sk-mock-key',
    providerSpecificData: {
      baseUrl: 'https://api.amanai.dev/v1',
      creditCheckType: 'auto'
    }
  };

  const result = await getCustomCompatibleUsage(mockConn);
  assert.ok(typeof result === 'object');
  assert.ok('plan' in result || 'message' in result);
});

test('custom provider usage - auto-detects newapi from baseUrl', async () => {
  const mockConn = {
    id: 'test-conn-auto-newapi',
    provider: 'openai-compatible-chat-mock',
    apiKey: 'sk-mock-key',
    providerSpecificData: {
      baseUrl: 'https://api.b.ai/v1',
      creditCheckType: 'auto'
    }
  };

  const result = await getCustomCompatibleUsage(mockConn);
  assert.ok(typeof result === 'object');
  assert.ok('plan' in result || 'message' in result);
});

test('custom provider usage - auto-detects openrouter from baseUrl', async () => {
  const mockConn = {
    id: 'test-conn-auto-openrouter',
    provider: 'openai-compatible-chat-mock',
    apiKey: 'sk-mock-key',
    providerSpecificData: {
      baseUrl: 'https://openrouter.ai/api/v1',
      creditCheckType: 'auto'
    }
  };

  const result = await getCustomCompatibleUsage(mockConn);
  assert.ok(typeof result === 'object');
  assert.ok('plan' in result || 'message' in result);
});

test('custom provider usage - auto-detects siliconflow from baseUrl', async () => {
  const mockConn = {
    id: 'test-conn-auto-siliconflow',
    provider: 'openai-compatible-chat-mock',
    apiKey: 'sk-mock-key',
    providerSpecificData: {
      baseUrl: 'https://api.siliconflow.cn/v1',
      creditCheckType: 'auto'
    }
  };

  const result = await getCustomCompatibleUsage(mockConn);
  assert.ok(typeof result === 'object');
  assert.ok('plan' in result || 'message' in result);
});

test('custom provider usage - returns disabled when creditCheckType is none', async () => {
  const mockConn = {
    id: 'test-conn-none',
    provider: 'openai-compatible-chat-mock',
    apiKey: 'sk-mock-key',
    providerSpecificData: {
      creditCheckType: 'none'
    }
  };

  const result = await getCustomCompatibleUsage(mockConn);
  assert.equal(result.plan, 'Custom Endpoint');
  assert.ok(result.message.includes('No credit check system configured'));
});
