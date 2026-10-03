import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeModelDisplay } from '../../src/lib/db/repos/usageRepo.js';

// RED: nama bare tanpa slash (alias client atau nama combo) tidak boleh
// ditempeli prefix provider. Prefix mengarang identitas yang tidak dikirim
// client: `gpt-5.6-sol` tertulis `sr/gpt-5.6-sol` di label via.
test('normalizeModelDisplay keeps bare names prefix-free (combo alias reporting)', () => {
  assert.equal(normalizeModelDisplay('gpt-5.6-sol', 'openai-compatible-chat-abc'), 'gpt-5.6-sol');
  assert.equal(normalizeModelDisplay('sr/auto', 'openai-compatible-chat-abc'), 'sr/auto');
});
