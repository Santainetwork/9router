import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = (path) => readFileSync(new URL(`../../src/${path}`, import.meta.url), 'utf8');
const css = read('app/globals.css');
const luminance = (hex) => {
  const c = hex.slice(1).match(/../g).map(v => parseInt(v, 16) / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4);
  return c[0] * .2126 + c[1] * .7152 + c[2] * .0722;
};
for (const mode of [':root', '.dark']) {
  test(`${mode} semantic text and status foregrounds meet AA on dashboard surfaces`, () => {
    const block = css.slice(css.indexOf(`${mode} {`)).split('}')[0];
    const colors = Object.fromEntries([...block.matchAll(/--color-([\w-]+):\s*(#[a-f\d]{6})\s*;/gi)].map(m => [m[1], m[2]]));
    for (const text of ['text-main', 'text-muted', 'text-subtle', 'success', 'warning', 'danger', 'info']) {
      for (const surface of ['bg', 'surface', 'surface-2']) {
        const a = luminance(colors[text]), b = luminance(colors[surface]);
        const ratio = (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
        assert.ok(ratio >= 4.5, `${text} on ${surface}: ${ratio.toFixed(2)}:1`);
      }
    }
  });
}
test('compatibility tokens exist and reduced-motion/focus rules use real colors', () => {
  for (const name of ['text-primary', 'bg-subtle', 'bg-hover', 'surface-secondary', 'input', 'error']) assert.ok(css.includes(`--color-${name}:`), name);
  assert.ok(css.includes('@media (prefers-reduced-motion: reduce)'));
  assert.doesNotMatch(css, /var\(--color-primary-500\)/);
});
test('static badges do not create tab stops or unsolicited live announcements', () => {
  const badge = read('shared/components/Badge.js');
  assert.doesNotMatch(badge, /tabIndex|role="status"/);
});
test('overview does not assert healthy ports without telemetry', () => {
  const overview = read('app/(dashboard)/dashboard/DashboardOverviewClient.js');
  assert.doesNotMatch(overview, /Port 20128 Active/);
  assert.match(overview, /queueError/);
  assert.match(overview, /upstreamModel/);
  for (const path of ['shared/components/Card.js', 'app/(dashboard)/dashboard/DashboardOverviewClient.js']) assert.doesNotMatch(read(path), /transition-all/);
});
