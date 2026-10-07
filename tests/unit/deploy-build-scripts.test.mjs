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
const agents = readFileSync(join(root, 'AGENTS.md'), 'utf8')
const deployBlock = agents.match(/(# Build standalone production bundle[\s\S]*?api\/health[^\n]*)/)[1]

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

test('documented deploy block stages, records, swaps, gates then restarts', () => {
  // Order matters: the record is written into $STAGE (which becomes
  // $RELEASE_DIR/.dist-dir after the swap), the gate reads that record, and no
  // service may restart before the gate passes. cp -a straight into the live
  // release leaves the old static/<BUILD_ID> behind.
  const iRecord = deployBlock.indexOf('printf')
  const iSwap = deployBlock.indexOf('mv "$STAGE" "$RELEASE_DIR"')
  const iGate = deployBlock.indexOf('bash scripts/verify-release.sh')
  const iRestart = deployBlock.indexOf('systemctl restart 9router\n')
  assert.ok(iRecord > 0 && iSwap > 0 && iGate > 0 && iRestart > 0, 'block missing a record/swap/gate/restart step')
  assert.ok(iRecord < iSwap, 'record must be written into the stage before the swap')
  assert.ok(iSwap < iGate, 'swap must happen before the gate runs')
  assert.ok(iGate < iRestart, 'gate must run before services restart')
  assert.match(deployBlock, /STAGE="\$\{RELEASE_DIR\}\.staging\.\$\$"/, 'must stage in a sibling dir')
  assert.doesNotMatch(deployBlock, /cp -a "\$INSTALL_DIR\/\$DIST\/standalone\/\." "\$RELEASE_DIR\/"/, 'must not cp straight into the live release')
})
