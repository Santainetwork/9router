// Guards the completion of the friend UI migration: no literal Tailwind palette
// color classes may remain in the dashboard shell (the friend/santai variants).
// Static hex baked at build time defeats runtime variant switching; the values
// must come from the html[data-ui-variant] token blocks in globals.css.
//
// Exemptions (documented in AGENTS.md):
//   - src/app/landing/**       brand landing pages, fixed brand palettes
//   - src/app/usage-check/**   standalone public portal, brand palettes
//   - Header.js / HeaderAlt.js pink donate pill (brand accent)
//   - basic-chat dark canvas   deliberately dark surface, no theme tokens
//   - traffic-light dots       macOS window dots in Modal.js and Sidebar.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

const SRC = resolve(dirname(new URL(import.meta.url).pathname), '..', '..', 'src')
const REPO_ROOT = resolve(SRC, '..')

const EXEMPT_PREFIX = [
  'src/app/landing/',
  'src/app/usage-check/',
]

const EXEMPT_FILES = new Set([
  'src/shared/components/Header.js',
  'src/shared/components/HeaderAlt.js',
  'src/shared/components/Modal.js',
  'src/shared/components/Sidebar.js',
  'src/app/(dashboard)/dashboard/basic-chat/BasicChatPageClient.js',
])

const walk = (dir, out = []) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const s = statSync(p)
    if (s.isDirectory()) walk(p, out)
    else if (/\.(jsx?|mjs)$/.test(name)) out.push(p)
  }
  return out
}

const rel = (p) => relative(REPO_ROOT, p)
const exempt = (p) => {
  const r = rel(p)
  return EXEMPT_PREFIX.some((pre) => r.startsWith(pre)) || EXEMPT_FILES.has(r)
}

// Any Tailwind utility that paints, plus the full palette name list.
const PAINTERS = 'bg|text|border|ring|divide|outline|from|to|via|fill|stroke|shadow|decoration|accent|caret|placeholder'
const PALETTE =
  'slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose'

const files = walk(SRC).filter((f) => f.endsWith('.js') || f.endsWith('.jsx'))

test('friend UI carries no literal palette classes', () => {
  const hits = []
  for (const f of files) {
    if (exempt(f)) continue
    const lines = readFileSync(f, 'utf8').split('\n')
    // -NNN / -NN / -N shades, with optional /alpha opacity.
    const shade = new RegExp(`\\b(${PAINTERS})-(${PALETTE})-[0-9]{1,3}(/[0-9]+)?\\b`, 'g')
    // Unnumbered status colors (danger, red, etc.) are allowed: they map to tokens.
    for (let i = 0; i < lines.length; i += 1) {
      const m = lines[i].match(shade)
      if (m) hits.push(`${rel(f)}:${i + 1}  ${m.join(' ')}`)
    }
  }
  assert.equal(hits.length, 0, `literal palette classes remain:\n${hits.join('\n')}`)
})

test('friend UI carries no arbitrary hex color values', () => {
  const hits = []
  for (const f of files) {
    if (exempt(f)) continue
    const lines = readFileSync(f, 'utf8').split('\n')
    const hex = /\b(?:bg|text|border|ring|fill|stroke|from|to|via|shadow)-\[#[0-9a-fA-F]{3,8}\]/g
    for (let i = 0; i < lines.length; i += 1) {
      const m = lines[i].match(hex)
      if (m) hits.push(`${rel(f)}:${i + 1}  ${m.join(' ')}`)
    }
  }
  assert.equal(hits.length, 0, `arbitrary hex colors remain:\n${hits.join('\n')}`)
})

test('exemptions are still intentional (files listed exist)', () => {
  for (const f of EXEMPT_FILES) {
    assert.ok(files.some((p) => rel(p) === f), `exempt file missing: ${f}`)
  }
})
