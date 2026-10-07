// Guards the deploy path that once shipped a stale pre-migration bundle: the
// live service serves .next-tailadmin (build:tailadmin), not .next, and the
// served CSS must carry friend-variant semantic tokens that differ per theme.
// Requires the service on :20128 plus a built .next-tailadmin; skips otherwise.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const RELEASE = process.env.RELEASE_DIR || '/opt/9router-release'
const BASE = process.env.BASE_URL || 'http://127.0.0.1:20128'

const isUp = async () => {
  try {
    return (await fetch(`${BASE}/api/health`)).ok
  } catch {
    return false
  }
}

test('deployed bundle is the tailadmin (friend) build', async (t) => {
  if (!(await isUp())) return t.skip('9router not reachable')
  const dist = existsSync(join(RELEASE, '.dist-dir'))
    ? readFileSync(join(RELEASE, '.dist-dir'), 'utf8').trim()
    : '.next-tailadmin'
  // cp -a standalone/. lands server.js at the release root; $DIST holds manifests.
  assert.ok(existsSync(join(RELEASE, dist, 'BUILD_ID')), `${RELEASE}/${dist} missing`)
  const server = readFileSync(join(RELEASE, 'server.js'), 'utf8')
  const distDir = server.match(/"distDir":"([^"]+)"/)[1]
  assert.match(distDir, /tailadmin/, `deployed bundle resolves distDir to ${distDir}`)
})

test('served CSS overrides every semantic token for the friend variant', async (t) => {
  if (!(await isUp())) return t.skip('9router not reachable')

  const html = await (await fetch(`${BASE}/login`)).text()
  const hrefs = [...new Set([...html.matchAll(/_next\/static\/css\/([\w-]+)\.css/g)].map((m) => m[1]))]
  assert.ok(hrefs.length, 'no css hrefs on /login')
  const css = (
    await Promise.all(hrefs.map((h) => fetch(`${BASE}/_next/static/css/${h}.css`).then((r) => r.text())))
  ).join('\n')

  // Split into rule fragments so a dark selector never satisfies a light lookup.
  const rules = css.split('}').map((s) => s.trim()).filter(Boolean)
  const value = (sel, tok) => {
    // Exact selector token so `html.dark[...]` cannot satisfy the light query.
    const rule = rules.find((r) => {
      const sels = r.split('{')[0]
      return sels.split(',').some((s) => s.trim() === sel) && r.includes(`${tok}:`)
    })
    const m = rule && rule.match(new RegExp(`${tok}:([^;}]+)`))
    return m && m[1].trim()
  }

  for (const tok of ['--color-danger', '--color-success', '--color-warning', '--color-info']) {
    const light = value('html[data-ui-variant=friend]', tok)
    const dark = value('html.dark[data-ui-variant=friend]', tok)
    assert.ok(light, `${tok} missing from friend light block`)
    assert.ok(dark, `${tok} missing from friend dark block`)
    assert.notEqual(light, dark, `${tok} identical in friend light and dark`)
  }

  // Literal-sweep coverage lives in friend-ui-semantic-tokens.test.mjs: the
  // served bundle intentionally keeps literals on the exempt brand palettes
  // (usage-check, landing, the pink Header donate pill).
})
