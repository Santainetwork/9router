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
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const tracked = () =>
  execFileSync('git', ['ls-files', '-z'], { cwd: process.cwd(), maxBuffer: 1 << 24 })
    .toString()
    .split('\0')
    .filter(Boolean)

// Read from the working tree, not git HEAD, so the check validates exactly what
// a commit will contain even before it lands.
const read = (f) => readFileSync(join(process.cwd(), f), 'utf8')

// A match is a placeholder, not a secret, when its body is trivial: repeated
// filler, sequential alphabet/digits, or an obvious documentation word. Real
// credentials never read "replace_with_your_own" or "change_me_in_production".
//
// Words that also start legitimate credential *labels* (secret, user, pass,
// admin, key, access) are deliberately excluded: `aws_secret_access_key = <real>`
// would otherwise be waved through as documentation.
const PLACEHOLDER_WORDS =
  /^(x{2,}|y{2,}|0{2,}|a{4,}|test|example|placeholder|your|abc|123|replace|redact|mask|insert|todo|sample|dummy|fake|foobar|changeme|changethis|yourkey|keyvalue)/i

// Only strip real credential prefixes. A generic `^[a-z]+_` also strips the
// documented words themselves ("replace_with_" -> "with_with...").
const CREDENTIAL_PREFIX = /^(glpat|sk|xox[baprs]|hf|gsk|r8|AIza|npm|SG)-?/i

const looksLikeDocumentationWord = (v) =>
  PLACEHOLDER_WORDS.test(v.replace(/[^A-Za-z0-9]/g, '')) || /^(change|replace|your|put|enter|use)[-_ ]/i.test(v)

const looksPlaceholder = (s) => {
  // A credential inside a URL sits in the userinfo segment, so the whole URL's
  // body ("postgres9routerreplacewith...") never starts with a placeholder
  // word. Judge the password itself too.
  const inlinePassword = s.match(/[a-z][a-z0-9+.-]*:\/\/[^/\s:@]*:([^@\s/]{1,})@/i)?.[1]
  if (inlinePassword && looksLikeDocumentationWord(inlinePassword)) return true
  const body = s.replace(CREDENTIAL_PREFIX, '').replace(/[^A-Za-z0-9]/g, '')
  if (body.length < 12) return true
  if (PLACEHOLDER_WORDS.test(body)) return true
  if (/abcdef|9876543210/i.test(body)) return true
  // A long run of one character is filler, not entropy (e.g. T00000000B00000000).
  if (/(.)\1{5,}/.test(body)) return true
  // Low distinct-character ratio => filler.
  const distinct = new Set(body.toLowerCase()).size
  return distinct / body.length < 0.25
}

// Boundary test for looksPlaceholder: the two failure modes are a real credential
// waved through because the heuristic called it documentation filler, and an
// obvious doc placeholder flagged as a hit. Both are covered by MUST/MUST_NOT in
// the guard self-test; this pins the exact line each way for the cases the
// length and ratio rules alone get wrong.
test('placeholder heuristic stays on the boundary', () => {
  const isPlaceholder = (s) => looksPlaceholder(s)
  // Real credentials: high distinct ratio, no documentation word.
  assert.equal(isPlaceholder('Qm7xK2pL9vR4tY8wZ3nB6cD1fG5hJ0kM2sP7qW9'), false)
  assert.equal(
    isPlaceholder('wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLQK9mP2qL7vR4tY8wZ3'),
    false,
    'EXAMPL substring inside a high-entropy body is still a real-looking secret',
  )
  // Documentation filler: reads like an instruction, not a credential.
  assert.equal(isPlaceholder('replace_with_your_long_random_secret_here'), true)
  assert.equal(isPlaceholder('changeme_in_production_1234567890abcdef'), true)
  assert.equal(isPlaceholder('xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'), true)
  // Credential-shaped but short: below the 12-body threshold.
  assert.equal(isPlaceholder('sk-secret1'), true)
  // A long documented value that happens to be long: still filler by ratio.
  assert.equal(isPlaceholder('T00000000B0000000000000000000000000'), true)
})

const SKIP = new Set([
  'tests/unit/oss-secret-scan.test.mjs',
  'tests/unit/video-providers.test.js',
])

test('no .env file is committed (only examples)', () => {
  const bad = tracked().filter((f) => /(^|\/)\.env(\..+)?$/.test(f) && !/\.example/.test(f))
  assert.equal(bad.length, 0, `env files must stay out of git: ${bad.join(', ')}`)
})

test('no private key material is committed', () => {
  const bad = []
  for (const f of tracked()) {
    if (SKIP.has(f)) continue
    const text = read(f)
    // Only real key bodies count: skip docs describing the header and test stubs
    // whose payload is a single filler char.
    const re = /-----BEGIN [A-Z ]*PRIVATE KEY-----([\s\S]{40,}?)-----END/g
    for (const m of text.matchAll(re)) {
      if (!looksPlaceholder(m[1])) bad.push(f)
    }
  }
  assert.equal(bad.length, 0, `private keys committed: ${[...new Set(bad)].join(', ')}`)
})

// Shapes that only ever look like real credentials.
const CREDENTIAL_PATTERNS = [
    /\bAKIA[0-9A-Z]{16}\b/,               // AWS access key id
    /\bgh[pousr]_[A-Za-z0-9]{30,}\b/,      // GitHub token
    /\bglpat-[A-Za-z0-9_-]{20,}\b/,        // GitLab PAT
    /\bxox[baprs]-[0-9A-Za-z-]{24,}\b/,     // Slack token
    /\bsk-[A-Za-z0-9]{40,}\b/,             // OpenAI-style key
    /\bsk-(proj|ant|svcacct|live|test)-[A-Za-z0-9_-]{20,}\b/, // OpenAI/Anthropic/Stripe prefixed variants
    /\bya29\.[A-Za-z0-9_-]{20,}\b/,          // Google OAuth access token
    /:_authToken[=:]npm_[A-Za-z0-9]{30,}\b/,  // npm authToken
    /hooks\.slack\.com\/services\/[A-Z0-9]{9,}\/[A-Z0-9]{9,}/, // Slack incoming webhook
    /\bSK[0-9a-f]{32}\b/,                     // Twilio API key
    /\bSG\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/, // SendGrid API key
    /discord(app)?\.com\/api\/webhooks\/[0-9]{10,}\/[A-Za-z0-9_-]{20,}/, // Discord webhook
    /(?:\bbot)?[0-9]{8,10}:[A-Za-z0-9_-]{35}\b/, // Telegram bot token (bare or bot<id>:<hash>)
    /aws_secret_access_key[\s]*[=:][\s]*[A-Za-z0-9/+=]{40}/, // AWS secret key (labelled, 40-char body)
    /\bAIza[0-9A-Za-z_-]{35}\b/,                // Google API key
    /\bhf_[A-Za-z0-9]{34,}\b/,                  // Hugging Face token
    /\bgsk_[A-Za-z0-9]{40,}\b/,                 // Groq API key
    /\br8_[A-Za-z0-9]{30,}\b/,                  // Replicate API token
    /[a-z][a-z0-9+.-]*:\/\/[^/\s:@]{1,32}:(?![^@/\s]{0,8}@)[^@/\s]{24,}@[^\s/]+/, // DB/broker URL with a long inline password
]

test('no high-signal credentials are committed', () => {
  const PATTERNS = CREDENTIAL_PATTERNS
  // Test fixtures and documented public values are excluded by path.
  const ALLOWED = new Set([
    'tests/unit/sqlite-mutation-protocol.test.mjs',
    'tests/unit/provider-footer-detection.test.mjs',
    'src/shared/components/GitLabAuthModal.js',
    // Windsurf's Firebase web API key: public client constant shipped inside the
    // upstream desktop app, not an operator secret. Same class as the Firebase
    // key already allowlisted in oss-secret-scan's header comment.
    'src/lib/oauth/constants/oauth.js',
    'open-sse/providers/registry/windsurf.js',
  ])

  const bad = []
  for (const f of tracked()) {
    if (SKIP.has(f) || ALLOWED.has(f)) continue
    const text = read(f)
    for (const re of PATTERNS) {
      for (const m of text.matchAll(new RegExp(re, 'g'))) {
        if (!looksPlaceholder(m[0])) bad.push(`${f}: ${m[0].slice(0, 12)}...`)
      }
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
      const placeholder = /^(|change[-_ ].*|replace[-_ ].*|your[-_].*|.*user:password@.*|.*replace_with.*)$/i
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

// Self-test: the patterns above must actually fire on realistic credentials,
// and must stay silent on the filler values that appear in docs and tests.
// Guards against a future edit accidentally neutering detection.
test('credential patterns still fire (guard self-test)', () => {
  const MUST_MATCH = [
    'AKIAZ7Y4KQ2M9P3XW1RD',
    'ghp_K9mP2qL7vR4tY8wZ3nB6cD1fG5hJ0kM2sP7',
    'glpat-K9mP2qL7vR4tY8wZ3nB6c',
    'xoxb-K9mP2qL7vR4tY8wZ3nB6cD1fG5hJ0kM2sP7qW9eR4tY8wZ3',
    'sk-proj-Qm7xK2pL9vR4tY8wZ3nB6cD1fG5hJ0kM2sP7qW9eR4tY',
    'sk-ant-api03-Xk9mP2qL7vR4tY8wZ3nB6cD1fG5hJ0kM2sP7qW9eR4tY8wZ3nB6cD',
    'ya29.a0AfH6SMBxK9mP2qL7vR4tY8wZ3nB6cD1fG5hJ0kM2sP7qW9eR4t',
    '//registry.npmjs.org/:_authToken=npm_K9mP2qL7vR4tY8wZ3nB6cD1fG5hJ0kM2sP7',
    'https://hooks.slack.com' + '/services/T7K2M9P4Q/B3N8R5X1Z/' + 'Qm7xK2pL9vR4tY8wZ3nB6cD1',
    'SK' + '9f2b7c4e1a8d5f3b6c9e2a7d4f1b8c3d',
    'SG.Qm7xK2pL9vR4tY8wZ3nB6cD1.R4tY8wZ3nB6cD1fG5hJ0kM2sP7qW9eR4t',
    'https://discord.com/api/webhooks/8472910356/Qm7xK2pL9vR4tY8wZ3nB6cD1fG5hJ0kM',
    'https://api.telegram.org/bot8472910356:AAFQm7xK2pL9vR4tY8wZ3nB6cD1fG5hJ0kM',
    '8472910356:AAFQm7xK2pL9vR4tY8wZ3nB6cD1fG5hJ0kM',
    'aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLQK9mP2qL7vR4',
    'AIzaQm7xK2pL9vR4tY8wZ3nB6cD1fG5hJ0kM3nB',
    'hf_Qm7xK2pL9vR4tY8wZ3nB6cD1fG5hJ0kM2s',
    'gsk_Qm7xK2pL9vR4tY8wZ3nB6cD1fG5hJ0kM2sP7qW9eR4t',
    'postgres://svc:Qm7xK2pL9vR4tY8wZ3nB6cD1fG5h@db.internal:5432/app',
  ]
  const MUST_NOT_MATCH = [
    'sk-abcdefabcdefabcdefabcdefabcdefabcdefabcd',
    'ghp_abcdefghijklmnopqrstuvwxyz',
    'AKIAXXXXXXXXXXXXXXXX',
    'xoxb-0000000000-0000000000-0000000000-abcdefabcdefabcdefabcdefabcdef',
    'Configuration: "AKIA...replace with your key"',
    'https://hooks.slack.com' + '/services/T00000000/B00000000/xxxxxxxxxxxxxxxxxxxxxxxx',
    'time is 12:00:00',
    'SG.example.example',
    'port 20128',
    '_authToken=npm_yourtokenhere',
    'bot123:GET_YOUR_TOKEN',
    'postgres://user:password@host:5432/9router',
    'postgres://9router:replace_with_a_long_random_secret@postgres:5432/9router',
    'postgres://u:p@db.example.com:5432/9router',
  ]

  for (const s of MUST_MATCH) {
    const hit = CREDENTIAL_PATTERNS.some((re) => re.test(s)) && !looksPlaceholder(s.match(CREDENTIAL_PATTERNS.find((re) => re.test(s)))[0])
    assert.ok(hit, `pattern set must detect a realistic credential: ${s.slice(0, 40)}...`)
  }
  for (const s of MUST_NOT_MATCH) {
    const m = s.match(CREDENTIAL_PATTERNS.find((re) => re.test(s)))
    assert.ok(
      !m || looksPlaceholder(m[0]),
      `pattern set must not flag documented placeholder as credential: ${s.slice(0, 40)}...`,
    )
  }
})
