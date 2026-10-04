// Mutation protocol for the single-writer SQLite bridge (Task 3).
// docs/superpowers/plans/2026-09-24-sqlite-redis-multicore.md
//
// Pure validation + envelope construction. No Redis, no SQLite, no repository
// imports, so both the API-worker producer and the control writer can share it.
// The command union is a closed allowlist: no arbitrary SQL, no dynamic
// repo/function names, no raw headers/cookies/bodies ever reach Redis.

export const MUTATION_PROTOCOL_VERSION = 1;

// 64 KiB matches the documented bounded payload cap (spec "Backpressure":
// bounded payload and timeout limits). Oversized telemetry is dropped and
// counted by the caller rather than trimmed.
export const MAX_MUTATION_BYTES = 64 * 1024;

export const RECEIPT_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

// Retention is a pruning horizon for the receipt ledger, not an expiry gate:
// a duplicate inside the window must stay a no-op.
export const MAX_RECEIPT_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const DEFAULT_RECEIPT_RETENTION = 10000;

export const CONSISTENCY_MODES = Object.freeze(["async", "sync"]);

export class MutationValidationError extends Error {
  constructor(message, code = "MUTATION_INVALID") {
    super(message);
    this.name = "MutationValidationError";
    this.code = code;
  }
}

// Envelope keys are exact; anything else (handler, fn, repo, sql, ...) is a
// rejected attempt to smuggle dispatch instructions.
const ENVELOPE_KEYS = ["schemaVersion", "type", "receiptId", "workerId", "createdAt", "payload", "consistency"];

// Sensitive field names are matched exactly (or by normalized key). There is
// deliberately no generic "key"/"token" substring ban: usage payloads carry
// `tokens` counts and opaque `apiKeyId`/`connectionId` row references that the
// aggregate transaction needs. Raw credential material is named explicitly.
const FORBIDDEN_KEY_EXACT = new Set([
  "authorization", "authorizationheader", "cookie", "setcookie", "headers",
  "apikey", "apikeyraw", "apikeysecret", "apikeyheader", "xapikey",
  "rawbody", "requestbody", "responsebody", "providerrequestbody", "providerresponsebody",
  "rawrequest", "rawresponse", "rawprompt", "rawcompletion",
  "body", "request", "response", "providerrequest", "providerresponse",
  "messages", "prompt", "completion", "content",
]);
const FORBIDDEN_KEY_PARTS = ["secret", "password", "credential", "authorization", "cookie", "refreshtoken", "accesstoken", "privatekey"];

const SECRET_VALUE_PATTERNS = [
  /bearer\s+[a-z0-9._~+/=-]{8,}/i,
  /sk-[a-z0-9]{20,}/i,
  // JWT/JWS/JWE: base64url header segment starting with eyJ. Catches token
  // material smuggled under an unlisted key name (opaque to the key scan).
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/,
  // Well-known opaque token prefixes (GitHub, Slack, and friends).
  /(?:ghp|gho|ghu|ghs|github_pat|xox[abposr])[-_][A-Za-z0-9-]{20,}/,
  // Slack tokens use xoxb-<digits>-<digits>-<opaque>.
  /xox[abposr]-\d{8,}-\d{8,}-[A-Za-z0-9-]{16,}/,
];

// Closed allowlist. `required` fields are what the control-side handler needs to
// replay the exact repository mutation; `allowed` bounds everything else.
//
// requestDetail.save is metadata-only: the plan requires that raw request and
// provider response bodies never enter Redis. `request`, `providerRequest`,
// `providerResponse`, `response` and `headers` are rejected outright, so the
// worker-side producer must persist detail metadata, not bodies.
export const MUTATION_SPECS = Object.freeze({
  "usage.save": {
    consistency: "async",
    required: ["timestamp", "model"],
    allowed: [
      "timestamp", "provider", "model", "connectionId", "apiKeyId", "endpoint",
      "promptTokens", "completionTokens", "cost", "status", "tokens",
      "requestedModel", "upstreamModel", "meta", "latency", "duration", "stream",
    ],
  },
  "requestDetail.save": {
    consistency: "async",
    required: ["model"],
    allowed: [
      "id", "timestamp", "provider", "model", "connectionId", "status", "latency",
      "tokens", "cost", "endpoint", "apiKeyId", "requestedModel", "upstreamModel",
      "pxpipe", "truncated", "bytesIn", "bytesOut",
    ],
  },
  "requestLog.save": {
    consistency: "async",
    required: ["timestamp", "method", "path"],
    allowed: ["timestamp", "apiKeyId", "apiKeyName", "apiKeyMasked", "ip", "method", "path", "endpointKind", "model", "provider", "resolvedModel", "status", "stream", "promptTokens", "completionTokens", "durationMs", "ttftMs", "tps", "userAgent", "error"],
  },
  "footerLog.add": {
    consistency: "async",
    required: ["provider", "model", "referralText"],
    allowed: ["timestamp", "provider", "model", "referralText"],
  },
  // Synchronous provider-state mutation (Task 5). The `updates` object carries
  // only routing/health/cooldown/lock fields. Token-bearing keys are rejected by
  // the deep secret scan, so a worker that needs a credential update must keep
  // that provider control-only. connectionId is an opaque row id, never a key.
  "connection.update": {
    consistency: "sync",
    required: ["connectionId", "updates"],
    // `ciphertext` carries token-bearing credential fields encrypted with the
    // dedicated queue key; plaintext secrets are rejected by the deep scan.
    allowed: ["connectionId", "updates", "ciphertext"],
  },
});

export const MUTATION_TYPES = Object.freeze(Object.keys(MUTATION_SPECS));

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function normalizeKey(key) {
  return String(key).toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isForbiddenKey(key) {
  const norm = normalizeKey(key);
  if (FORBIDDEN_KEY_EXACT.has(norm)) return true;
  return FORBIDDEN_KEY_PARTS.some((part) => norm.includes(part));
}

// Walks the payload once: rejects non-JSON values and any sensitive key or
// secret-looking string at any depth. Returns the canonical JSON string.
function scanJson(value, path, seen) {
  if (value === null) return "null";
  const type = typeof value;
  if (type === "string") {
    for (const pattern of SECRET_VALUE_PATTERNS) {
      if (pattern.test(value)) {
        throw new MutationValidationError(`sensitive value rejected at ${path}`, "MUTATION_SENSITIVE_FIELD");
      }
    }
    return JSON.stringify(value);
  }
  if (type === "number") {
    if (!Number.isFinite(value)) throw new MutationValidationError(`non-json number at ${path}`, "MUTATION_NOT_JSON");
    return JSON.stringify(value);
  }
  if (type === "boolean") return String(value);
  if (type === "undefined") throw new MutationValidationError(`non-json value (undefined) at ${path}`, "MUTATION_NOT_JSON");
  if (type === "function") throw new MutationValidationError(`non-json value (function) at ${path}`, "MUTATION_NOT_JSON");
  if (type === "bigint") throw new MutationValidationError(`non-json value (bigint) at ${path}`, "MUTATION_NOT_JSON");
  if (type === "symbol") throw new MutationValidationError(`non-json value (symbol) at ${path}`, "MUTATION_NOT_JSON");
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new MutationValidationError(`circular payload at ${path}`, "MUTATION_NOT_JSON");
    seen.add(value);
    const parts = value.map((item, i) => scanJson(item, `${path}[${i}]`, seen));
    seen.delete(value);
    return `[${parts.join(",")}]`;
  }
  if (!isPlainObject(value)) throw new MutationValidationError(`non-json value (${value?.constructor?.name || "object"}) at ${path}`, "MUTATION_NOT_JSON");
  if (seen.has(value)) throw new MutationValidationError(`circular payload at ${path}`, "MUTATION_NOT_JSON");
  seen.add(value);
  const parts = [];
  for (const [key, item] of Object.entries(value)) {
    if (isForbiddenKey(key)) throw new MutationValidationError(`sensitive field rejected: ${path}.${key}`, "MUTATION_SENSITIVE_FIELD");
    parts.push(`${JSON.stringify(key)}:${scanJson(item, `${path}.${key}`, seen)}`);
  }
  seen.delete(value);
  return `{${parts.join(",")}}`;
}

export function newReceiptId() {
  return `m-${crypto.randomUUID()}`;
}

export function isReceiptId(value) {
  return typeof value === "string" && RECEIPT_ID_PATTERN.test(value);
}

function assertPayloadShape(type, payload) {
  const spec = MUTATION_SPECS[type];
  if (!isPlainObject(payload)) {
    throw new MutationValidationError(`${type} payload must be a JSON object`, "MUTATION_PAYLOAD_INVALID");
  }
  for (const field of spec.required) {
    const value = payload[field];
    const ok = typeof value === "string" ? value.length > 0 : value !== undefined && value !== null;
    if (!ok) throw new MutationValidationError(`${type} payload requires ${field}`, "MUTATION_PAYLOAD_INVALID");
  }
  // A usage row must stay attributable without carrying the raw key: the opaque
  // API-key row id or the provider connection id is enough for aggregation.
  if (type === "usage.save" && !payload.apiKeyId && !payload.connectionId) {
    throw new MutationValidationError("usage.save payload requires apiKeyId or connectionId", "MUTATION_PAYLOAD_INVALID");
  }
  for (const key of Object.keys(payload)) {
    if (!spec.allowed.includes(key)) {
      throw new MutationValidationError(`${type} payload has unsupported field: ${key}`, "MUTATION_PAYLOAD_INVALID");
    }
  }
}

// Serializes and size-checks. The byte count is what actually crosses Redis.
// The deep scan runs first so a nested secret or non-JSON value is reported as
// such instead of being masked by the shallower allowlist error.
export function measureMutationPayload(type, payload) {
  if (!isPlainObject(payload)) {
    throw new MutationValidationError(`${type} payload must be a JSON object`, "MUTATION_PAYLOAD_INVALID");
  }
  const json = scanJson(payload, "payload", new Set());
  const bytes = Buffer.byteLength(json, "utf8");
  if (bytes > MAX_MUTATION_BYTES) {
    throw new MutationValidationError(`payload too large for ${type}: ${bytes} bytes exceeds ${MAX_MUTATION_BYTES}`, "MUTATION_TOO_LARGE");
  }
  assertPayloadShape(type, payload);
  return bytes;
}

export function buildMutation({ type, payload, workerId, receiptId, consistency, createdAt, schemaVersion } = {}) {
  const mutation = {
    schemaVersion: schemaVersion ?? MUTATION_PROTOCOL_VERSION,
    type,
    receiptId: receiptId ?? newReceiptId(),
    workerId,
    createdAt: createdAt ?? new Date().toISOString(),
    payload,
    consistency: consistency ?? MUTATION_SPECS[type]?.consistency ?? "async",
  };
  validateMutation(mutation);
  return mutation;
}

export function validateMutation(mutation) {
  if (!isPlainObject(mutation)) {
    throw new MutationValidationError("mutation must be a JSON object", "MUTATION_ENVELOPE_INVALID");
  }
  for (const key of Object.keys(mutation)) {
    if (!ENVELOPE_KEYS.includes(key)) {
      throw new MutationValidationError(`unexpected field on mutation envelope: ${key}`, "MUTATION_ENVELOPE_INVALID");
    }
  }
  if (mutation.schemaVersion !== MUTATION_PROTOCOL_VERSION) {
    throw new MutationValidationError(`unsupported schema version: ${mutation.schemaVersion}`, "MUTATION_VERSION_UNSUPPORTED");
  }
  if (typeof mutation.type !== "string" || !MUTATION_SPECS[mutation.type]) {
    throw new MutationValidationError(`unknown mutation type: ${mutation.type}`, "MUTATION_TYPE_UNKNOWN");
  }
  if (!isReceiptId(mutation.receiptId)) {
    throw new MutationValidationError(`invalid receipt id: ${mutation.receiptId}`, "MUTATION_RECEIPT_INVALID");
  }
  if (typeof mutation.workerId !== "string" || mutation.workerId.length === 0) {
    throw new MutationValidationError("worker id is required", "MUTATION_WORKER_INVALID");
  }
  if (typeof mutation.createdAt !== "string" || Number.isNaN(Date.parse(mutation.createdAt))) {
    throw new MutationValidationError(`invalid createdAt timestamp: ${mutation.createdAt}`, "MUTATION_TIMESTAMP_INVALID");
  }
  if (!CONSISTENCY_MODES.includes(mutation.consistency)) {
    throw new MutationValidationError(`invalid consistency: ${mutation.consistency}`, "MUTATION_CONSISTENCY_INVALID");
  }
  measureMutationPayload(mutation.type, mutation.payload);
  return true;
}

// Duplicates inside the retention window are no-ops, never "expired". An
// unparseable timestamp is treated as not expired so a bad row cannot silently
// drop a replay.
export function isReceiptExpired(receipt, { now = Date.now(), maxAgeMs = MAX_RECEIPT_AGE_MS } = {}) {
  const appliedAt = Date.parse(receipt?.appliedAt ?? receipt?.createdAt ?? "");
  if (Number.isNaN(appliedAt)) return false;
  return now - appliedAt > maxAgeMs;
}

// Keeps the newest `retention` receipts and returns the rest for deletion.
export function selectReceiptsToPrune(receipts, { retention = DEFAULT_RECEIPT_RETENTION } = {}) {
  if (!Array.isArray(receipts) || retention < 0) return [];
  const sorted = [...receipts].sort((a, b) => {
    const at = Date.parse(a?.appliedAt ?? a?.createdAt ?? "") || 0;
    const bt = Date.parse(b?.appliedAt ?? b?.createdAt ?? "") || 0;
    return bt - at;
  });
  return sorted.slice(retention);
}
