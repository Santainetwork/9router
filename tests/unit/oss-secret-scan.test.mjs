// Pre-publish guard: the tracked tree must never contain operator secrets.
// Run as part of `npm run verify` so a future commit cannot reintroduce one.
//
// Known false positives are allowlisted below with the reason they are safe:
//   - third-party *public* client constants (Firebase web key, Sentry project id,
//     RSA public key). These are public by design, shipped inside the upstream
//     desktop apps, and grant nothing when disclosed.
//   - obvious test fixtures (sk-abcdef..., ghp_abcdef..., private_key "...x...").
//
// What must never appear: a private key, a real credential, a DB password.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'

const tracked = () =>
  execFileSync('git', ['ls-files', '-z'], { cwd: process.cwd(), maxBuffer: 1 << 24 })
    .toString()
    .split('\0')
    .filter(Boolean)

const read = (f) => execFileSync('git', ['show', `HEAD:${f}`], {
  cwd: process.cwd(),
  maxBuffer: 1 << 26,
  stdio: ['ignore', 'pipe', 'ignore'],
}).toString()

test('no .env file is committed (only examples)', () => {
  const bad = tracked().filter((f) => /(^|\/)\.env(\..+)?$/.test(f) && !/\.example/.test(f))
  assert.equal(bad.length, 0, `env files must stay out of git: ${bad.join(', ')}`)
})

test('no private key material is committed', () => {
  const bad = []
  for (const f of tracked()) {
    if (read(f).includes('-----BEGIN') && read(f).includes('PRIVATE KEY-----')) {
      bad.push(f)
    }
  }
  assert.equal(bad.length, 0, `private keys committed: ${bad.join(', ')}`)
})

test('no high-signal credentials are committed', () => {
  // Shapes that only ever look like real credentials.
  const PATTERNS = [
    /\bAKIA[0-9A-Z]{16}\b/,               // AWS access key id
    /\bgh[pousr]_[A-Za-z0-9]{30,}\b/,      // GitHub token
    /\bglpat-[A-Za-z0-9_-]{20,}\b/,        // GitLab PAT
    /\bxox[baprs]-[0-9A-Za-z-]{24,}\b/,     // Slack token
    /\bsk-[A-Za-z0-9]{40,}\b/,             // OpenAI-style key
  ]
  // Test fixtures and documented public values are excluded by path.
  const ALLOWED = new Set(['tests/unit/video-providers.test.js'])

  const bad = []
  for (const f of tracked()) {
    if (ALLOWED.has(f)) continue
    const text = read(f)
    for (const re of PATTERNS) {
      const m = text.match(re)
      if (m) bad.push(`${f}: ${m[0].slice(0, 12)}...`)
    }
  }
  assert.equal(bad.length, 0, `credential shapes found:\n${bad.join('\n')}`)
})

test('env.example values are all obvious placeholders', () => {
  for (const f of ['.env.example', '.env.docker.example']) {
    const text = read(f)
    const secretLines = text
      .split('\n')
      .filter((l) => /^(JWT_SECRET|API_KEY_SECRET|MACHINE_ID_SALT|INITIAL_PASSWORD|DATABASE_URL|POSTGRES_PASSWORD|REDIS_PASSWORD|SQLITE_QUEUE_ENCRYPTION_KEY)=/.test(l))
    for (const line of secretLines) {
      const value = line.split('=').slice(1).join('=').replace(/^["']|["']$/g, '')
      const placeholder = /^(|change-me.*|replace.*|your[-_].*|.*user:password@.*)$/i
      assert.ok(
        placeholder.test(value),
        `${f} ships a non-placeholder value for ${line.split('=')[0]} (${value.slice(0, 8)}...)`,
      )
    }
  }
})

test('no build artifacts or dumps are tracked', () => {
  const EXTS = /\.(sqlite|sqlite3|db|dump|log|pem|key|p12|pfx)$/
  const bad = tracked().filter((f) => EXTS.test(f))
  assert.equal(bad.length, 0, `artifact/data files tracked: ${bad.join(', ')}`)
})

test('engine binaries are not tracked (build from source)', () => {
  const bad = tracked().filter((f) => f.startsWith('hybrid-engine/bin/'))
  assert.equal(bad.length, 0, `compiled binaries tracked: ${bad.join(', ')}`)
})
