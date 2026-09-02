import test from 'node:test';
import assert from 'node:assert/strict';
import { selectConnectionsNeedingRefresh, BACKGROUND_REFRESH_LEAD_MS } from '../../src/sse/services/backgroundTokenRefresh.js';

test('selectConnectionsNeedingRefresh filters only due OAuth connections', () => {
  const now = Date.now();
  const testConns = [
    {
      id: 'conn-1-due',
      authType: 'oauth',
      refreshToken: 'rt-1',
      expiresAt: new Date(now + 10 * 60 * 1000).toISOString(), // expires in 10m (< 30m)
      provider: 'codex'
    },
    {
      id: 'conn-2-apikey',
      authType: 'apikey',
      apiKey: 'sk-1',
      provider: 'deepseek'
    },
    {
      id: 'conn-3-not-due',
      authType: 'oauth',
      refreshToken: 'rt-2',
      expiresAt: new Date(now + 7 * 24 * 60 * 60 * 1000).toISOString(), // expires in 7d (> 5d lead)
      provider: 'codex'
    }
  ];

  const due = selectConnectionsNeedingRefresh(testConns, now);
  assert.equal(due.length, 1);
  assert.equal(due[0].id, 'conn-1-due');
});
