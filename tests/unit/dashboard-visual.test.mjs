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
// The TailAdmin ("friend") variant overrides every semantic token in its own
// scoped blocks, so :root/.dark checks above do not cover it. Regression here
// means friend-light/dark text drops below AA on real surfaces.
for (const [mode, selector] of [['friend-light', 'html[data-ui-variant="friend"] {'], ['friend-dark', 'html.dark[data-ui-variant="friend"] {']]) {
  test(`${mode} variant semantic foregrounds meet AA on variant surfaces`, () => {
    const start = css.indexOf(selector);
    assert.ok(start !== -1, `missing ${selector} token block`);
    const block = css.slice(start + selector.length).split('}')[0];
    const colors = Object.fromEntries([...block.matchAll(/--color-([\w-]+):\s*(#[a-f\d]{6})\s*;/gi)].map(m => [m[1], m[2]]));
    for (const text of ['text-main', 'text-muted', 'text-subtle', 'success', 'warning', 'danger', 'info']) {
      for (const surface of ['bg', 'surface', 'surface-2']) {
        const a = luminance(colors[text]), b = luminance(colors[surface]);
        const ratio = (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
        assert.ok(ratio >= 4.5, `${mode} ${text} on ${surface}: ${ratio.toFixed(2)}:1`);
      }
    }
  });
}
test('friend variant status badges stay readable on their translucent tints', () => {
  const header = read('shared/components/HeaderAlt.js');
  const sidebar = read('shared/components/SidebarAlt.js');
  // Health badge: emerald-500/10 tint over a light surface needs the darker
  // emerald + a dark-mode override; emerald-500 alone measured 2.25:1.
  assert.match(header, /bg-emerald-500\/10 text-emerald-800 dark:text-emerald-400/);
  assert.match(header, /bg-red-500\/10 text-red-800 dark:text-red-300/);
  // NEW badge: green-400 on green-500/15 tint measured 1.55:1 in light mode.
  assert.doesNotMatch(sidebar, /bg-green-500\/15 text-green-400/);
  assert.match(sidebar, /bg-green-500\/15 text-green-800 dark:bg-green-500\/20 dark:text-green-400/);
  // Section labels rendered at /60 opacity failed in both variants.
  for (const file of [header, sidebar, read('shared/components/Sidebar.js')]) {
    assert.doesNotMatch(file, /text-text-muted\/60/);
  }
});
test('donate pill foreground keeps AA on the pink-500/10 tint in both variants', () => {
  for (const path of ['shared/components/Header.js', 'shared/components/HeaderAlt.js']) {
    const header = read(path);
    assert.match(header, /bg-pink-500\/10 text-pink-800 dark:text-pink-300/);
    assert.doesNotMatch(header, /bg-pink-500\/10 text-pink-600/);
  }
});
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
