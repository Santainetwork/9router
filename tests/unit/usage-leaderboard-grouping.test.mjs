import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../../src/app/api/usage/leaderboard/route.js', import.meta.url), 'utf8');

const queryNames = [
  'getProvidersByUsage',
  'getProvidersByCost',
  'getKeysByRequests',
  'getKeysByCost',
];

test('leaderboard queries group every provider identity column for PostgreSQL', () => {
  for (const queryName of queryNames) {
    const query = source.slice(source.indexOf(`async function ${queryName}`), source.indexOf('\n}', source.indexOf(`async function ${queryName}`)));
    const groupBy = query.match(/GROUP BY([\s\S]*?)(?:HAVING|ORDER BY)/)?.[1] || '';

    assert.match(groupBy, /uh\.provider/, `${queryName} must group raw provider identity`);
    assert.doesNotMatch(query, /HAVING\s+(?:total_cost|total_requests)\b/i, `${queryName} must not use SELECT aliases in PostgreSQL HAVING`);
    if (queryName.startsWith('getKeys')) {
      assert.match(groupBy, /uh\.connectionId/, `${queryName} must group connection identity`);
      assert.match(groupBy, /pc\.name/, `${queryName} must group key display name`);
      assert.match(groupBy, /pc\.provider/, `${queryName} must group provider display name`);
      assert.match(groupBy, /pn\.name/, `${queryName} must group provider node name`);
    } else {
      assert.match(groupBy, /pn\.name/, `${queryName} must group provider display name`);
    }
  }
});
