// build:tailadmin must run copy-standalone-assets.mjs after next build. npm only
// auto-runs `postbuild` for the script named `build`, so the tailadmin build
// shipped a standalone tree without $DIST/static until this was chained on.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

test('build:tailadmin chains the standalone asset copy', () => {
  const s = pkg.scripts['build:tailadmin']
  assert.match(s, /NEXT_DIST_DIR=\.next-tailadmin next build/, `build step wrong: ${s}`)
  assert.match(s, /&&.*copy-standalone-assets\.mjs/, `asset copy not chained: ${s}`)
})

test('verify-release.sh reads the recorded dist dir before defaulting', () => {
  // A plain default lands on .next while the live bundle is .next-tailadmin,
  // which is how the gate once passed on two identically stale builds.
  const sh = readFileSync(join(root, 'scripts', 'verify-release.sh'), 'utf8')
  assert.match(sh, /RECORDED_DIST="\$\(cat "\$RELEASE_DIR\/\.dist-dir"\)"/)
  assert.match(sh, /DIST_DIR_NAME="\$RECORDED_DIST"/)
})
