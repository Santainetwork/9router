import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = (path) => readFileSync(new URL(`../../src/${path}`, import.meta.url), 'utf8');
const details = source('app/(dashboard)/dashboard/usage/components/RequestDetailsTab.js');
const models = source('app/(dashboard)/dashboard/providers/components/ModelsCard.js');
const providers = source('app/(dashboard)/dashboard/providers/page.js');

test('request details has a bounded named keyboard-scroll region and sticky header', () => {
  assert.match(details, /aria-label="Request details table"/);
  assert.match(details, /tabIndex=\{0\}/);
  assert.match(details, /max-h-\[70vh\].*overflow-auto/);
  assert.match(details, /<thead className="sticky top-0/);
  assert.match(details, /colSpan=\{9\}/);
  assert.match(details, /<TableSkeleton rows=\{5\} columns=\{9\}/);
});

test('filter requests cancel stale responses and surface errors instead of empty success', () => {
  assert.match(details, /new AbortController\(\)/);
  assert.match(details, /controller\.abort\(\)/);
  assert.match(details, /signal\?\.aborted/);
  assert.match(details, /if \(!res\.ok\)/);
  assert.match(details, /role="alert"/);
});

test('model list supports a labelled search and reachable named actions', () => {
  assert.match(models, /type="search"/);
  assert.match(models, /aria-label="Search models"/);
  assert.match(models, /No models match/);
  for (const action of ['Test', 'Copy', 'Remove']) {
    assert.match(models, new RegExp(`aria-label=\\{\\x60${action} `));
  }
  assert.match(models, /min-w-0.*flex-1/);
  assert.match(models, /break-all/);
  assert.match(models, /TableSkeleton/);
});

test('provider status filter uses semantic surfaces and visible focus', () => {
  assert.match(providers, /aria-label="Filter providers by connection status"/);
  assert.match(providers, /focus-visible:ring-2/);
  assert.doesNotMatch(providers, /text-text-primary outline-none/);
});

test('primary and compatible model lists support search with visible named actions', () => {
  const primary = source('app/(dashboard)/dashboard/providers/[id]/page.js');
  const row = source('app/(dashboard)/dashboard/providers/[id]/ModelRow.js');
  const compatible = source('app/(dashboard)/dashboard/providers/[id]/CompatibleModelsSection.js');
  assert.match(primary, /aria-label="Search available models"/);
  assert.match(primary, /matchesModelSearch/);
  assert.match(compatible, /aria-label="Search compatible models"/);
  assert.match(row, /aria-label=\{`Copy /);
  assert.doesNotMatch(row, /sm:opacity-0/);
});
