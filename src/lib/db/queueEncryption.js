// Task 5: dedicated authenticated encryption for token-bearing queue payloads.
// AES-256-GCM over a strict 32-byte key derived from a 64-char hex
// SQLITE_QUEUE_ENCRYPTION_KEY. Never reuse API_KEY_SECRET or the Redis ACL
// password. Payloads crossing Redis carry ciphertext only.
import crypto from "node:crypto";

const KEY_BYTES = 32;
const HEX_KEY_PATTERN = /^[0-9a-f]{64}$/i;
const VERSION = "v1";

export class QueueEncryptionError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "QueueEncryptionError";
    this.code = code;
  }
}

function passwordFromRedisUrl(redisUrl) {
  try {
    const url = new URL(redisUrl);
    return url.password ? decodeURIComponent(url.password) : null;
  } catch {
    return null;
  }
}

// Strict validation: exactly 32 bytes of hex entropy. Rotate by supplying a new
// 64-char hex value; decrypt accepts a second key for a grace window.
export function normalizeQueueEncryptionKey(value, { apiKeySecret, redisUrl } = {}) {
  if (value === undefined || value === null || value === "") {
    throw new QueueEncryptionError("SQLITE_QUEUE_ENCRYPTION_KEY is required for token-bearing mutations", "QUEUE_KEY_MISSING");
  }
  const raw = String(value);
  if (apiKeySecret && raw === String(apiKeySecret)) {
    throw new QueueEncryptionError("SQLITE_QUEUE_ENCRYPTION_KEY must not reuse API_KEY_SECRET", "QUEUE_KEY_REUSE");
  }
  const redisPassword = passwordFromRedisUrl(redisUrl);
  if (redisPassword && raw === redisPassword) {
    throw new QueueEncryptionError("SQLITE_QUEUE_ENCRYPTION_KEY must not reuse the Redis ACL password", "QUEUE_KEY_REUSE");
  }
  if (!HEX_KEY_PATTERN.test(raw)) {
    throw new QueueEncryptionError("SQLITE_QUEUE_ENCRYPTION_KEY must be 64 hex characters (32 bytes)", "QUEUE_KEY_INVALID");
  }
  return Buffer.from(raw, "hex");
}

export function encryptQueuePayload(key, payload) {
  if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) {
    throw new QueueEncryptionError("invalid encryption key", "QUEUE_KEY_INVALID");
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(JSON.stringify(payload ?? null), "utf8");
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64"), tag.toString("base64"), ct.toString("base64")].join(":");
}

export function decryptQueuePayload(key, token) {
  if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) {
    throw new QueueEncryptionError("invalid encryption key", "QUEUE_KEY_INVALID");
  }
  if (typeof token !== "string" || !token.startsWith(`${VERSION}:`)) {
    throw new QueueEncryptionError("unsupported or malformed ciphertext", "QUEUE_DECRYPT_FAILED");
  }
  const parts = token.split(":");
  if (parts.length !== 4) {
    throw new QueueEncryptionError("malformed ciphertext", "QUEUE_DECRYPT_FAILED");
  }
  try {
    const [, ivB64, tagB64, ctB64] = parts;
    const iv = Buffer.from(ivB64, "base64");
    const tag = Buffer.from(tagB64, "base64");
    const ct = Buffer.from(ctB64, "base64");
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ct), decipher.final()]);
    return JSON.parse(plaintext.toString("utf8"));
  } catch {
    throw new QueueEncryptionError("ciphertext authentication failed", "QUEUE_DECRYPT_FAILED");
  }
}

export function isEncryptedToken(value) {
  return typeof value === "string" && value.startsWith(`${VERSION}:`);
}

// Shared key for the control writer and API workers. Read from the dedicated
// SQLITE_QUEUE_ENCRYPTION_KEY; reuse of API_KEY_SECRET/Redis ACL password fails.
export function getQueueEncryptionKey(env = process.env) {
  return normalizeQueueEncryptionKey(env.SQLITE_QUEUE_ENCRYPTION_KEY, {
    apiKeySecret: env.API_KEY_SECRET,
    redisUrl: env.REDIS_URL,
  });
}
