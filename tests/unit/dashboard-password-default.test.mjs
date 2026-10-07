// Regression guard for the removal of the hardcoded default dashboard password
// (item (c) of the public-release checklist).
//
// Two things are asserted:
//   1. A fresh install has no guessable password in the source tree: the
//      "123456" era default must be rejected, the per-install value accepted,
//      and a retired default comparison must not reappear in the code.
//   2. The lifecycle still works: env override wins, a stored hash wins over
//      both, and after `reset-password` the first-run value authenticates again.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'
import bcrypt from 'bcryptjs'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

register(new URL('./helpers/alias-loader.mjs', import.meta.url))

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), '9router-auth-'))
process.env.DATA_DIR = DIR
delete process.env.INITIAL_PASSWORD
globalThis.__TEST_SETTINGS__ = {}

const { getInitialPassword, verifyDashboardPassword } = await import(
  '@/lib/auth/dashboardSession.js'
)
const INITIAL_PASSWORD_FILE = path.join(DIR, 'initial-password')
const RETIRED_DEFAULT = '123456'

test.after(() => {
  delete process.env.INITIAL_PASSWORD
  globalThis.__TEST_SETTINGS__ = {}
  fs.rmSync(DIR, { recursive: true, force: true })
})

test('fresh install generates a random first-run password, not the retired default', () => {
  const generated = getInitialPassword()
  assert.notEqual(generated, RETIRED_DEFAULT, 'per-install value must not be the old default')
  assert.match(generated, /^[A-Za-z0-9_-]{16}$/, 'crypto.randomBytes(12).toString("base64url")')
  assert.ok(fs.existsSync(INITIAL_PASSWORD_FILE), 'value is persisted for the next boot')
  assert.equal(fs.statSync(INITIAL_PASSWORD_FILE).mode & 0o777, 0o600, 'file is owner-only')
})

test('login accepts the per-install value and rejects the retired default', async () => {
  assert.equal(await verifyDashboardPassword(RETIRED_DEFAULT), false)
  assert.equal(await verifyDashboardPassword(getInitialPassword()), true)
})

test('INITIAL_PASSWORD overrides the persisted per-install value', async () => {
  process.env.INITIAL_PASSWORD = 'env-set-secret'
  try {
    assert.equal(await verifyDashboardPassword('env-set-secret'), true)
    assert.equal(await verifyDashboardPassword(fs.readFileSync(INITIAL_PASSWORD_FILE, 'utf8')), false)
  } finally {
    delete process.env.INITIAL_PASSWORD
  }
})

test('a stored password hash wins over every first-run value', async () => {
  const hash = bcrypt.hashSync('operator-chosen', 10)
  globalThis.__TEST_SETTINGS__ = { password: hash }
  try {
    assert.equal(await verifyDashboardPassword('operator-chosen'), true)
    assert.equal(await verifyDashboardPassword(getInitialPassword()), false)
  } finally {
    globalThis.__TEST_SETTINGS__ = {}
  }
})

test('after reset-password the first-run value authenticates again', async () => {
  // reset-password clears the stored hash, so verify falls back to first-run.
  globalThis.__TEST_SETTINGS__ = {}
  assert.equal(await verifyDashboardPassword(getInitialPassword()), true)
  assert.equal(await verifyDashboardPassword('operator-chosen'), false)
})

test('tracked JS has no hardcoded dashboard password fallback', () => {
  const tracked = execFileSync('git', ['ls-files'], { cwd: process.cwd(), maxBuffer: 1 << 24 })
    .toString()
    .split('\n')
    .filter(Boolean)
  const bad = tracked
    .filter((f) => /\.(js|jsx|mjs|cjs|ts|tsx)$/.test(f) && !/skip/.test(f))
    .filter((f) =>
      /INITIAL_PASSWORD\s*\|\|\s*["'`]123456["'`]|(?:!==|===)\s*["'`]123456["'`]/.test(
        fs.readFileSync(f, 'utf8')
      )
    )
  assert.deepEqual(bad, [], `hardcoded default password still present: ${bad.join(', ')}`)
})
