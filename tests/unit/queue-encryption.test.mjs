// Task 5: dedicated authenticated encryption for token-bearing queue payloads.
// SQLITE_QUEUE_ENCRYPTION_KEY is separate and rotatable; never API_KEY_SECRET or
// the Redis ACL password. Strict key validation, ciphertext-only payloads.
import test from "node:test";
import assert from "node:assert/strict";

const enc = await import("../../src/lib/db/queueEncryption.js");

const HEX_KEY = "a".repeat(64); // 32 bytes hex

test("normalizes a strict 64-hex-char 32-byte key", () => {
  const key = enc.normalizeQueueEncryptionKey(HEX_KEY);
  assert.equal(key.length, 32);
  assert.equal(key.toString("hex"), HEX_KEY);
});

test("rejects missing key", () => {
  assert.throws(() => enc.normalizeQueueEncryptionKey(""), (e) => e.code === "QUEUE_KEY_MISSING");
});

test("rejects weak, wrong-length, and non-hex keys", () => {
  assert.throws(() => enc.normalizeQueueEncryptionKey("short"), (e) => e.code === "QUEUE_KEY_INVALID");
  assert.throws(() => enc.normalizeQueueEncryptionKey("z".repeat(64)), (e) => e.code === "QUEUE_KEY_INVALID");
  assert.throws(() => enc.normalizeQueueEncryptionKey("a".repeat(32)), (e) => e.code === "QUEUE_KEY_INVALID");
});

test("rejects reuse of API_KEY_SECRET or Redis ACL password", () => {
  assert.throws(
    () => enc.normalizeQueueEncryptionKey("endpoint-proxy-api-key-secret", {
      apiKeySecret: "endpoint-proxy-api-key-secret",
    }),
    (e) => e.code === "QUEUE_KEY_REUSE",
  );
  assert.throws(
    () => enc.normalizeQueueEncryptionKey("redis-pass", {
      redisUrl: "redis://:redis-pass@127.0.0.1:6379/0",
    }),
    (e) => e.code === "QUEUE_KEY_REUSE",
  );
});

test("round-trips a JSON payload through AES-256-GCM", () => {
  const key = enc.normalizeQueueEncryptionKey(HEX_KEY);
  const payload = { accessToken: "at-secret", refreshToken: "rt-secret" };
  const token = enc.encryptQueuePayload(key, payload);

  assert.equal(typeof token, "string");
  assert.match(token, /^v1:/);
  assert.equal(token.includes("at-secret"), false);
  assert.equal(token.includes("rt-secret"), false);
  assert.equal(token.includes("sk-"), false);

  assert.deepEqual(enc.decryptQueuePayload(key, token), payload);
});

test("tampering with ciphertext fails authentication", () => {
  const key = enc.normalizeQueueEncryptionKey(HEX_KEY);
  const token = enc.encryptQueuePayload(key, { refreshToken: "rt" });
  const [version, iv, tag, ct] = token.split(":");
  const tampered = [version, iv, tag, Buffer.from(ct, "base64").reverse().toString("base64")].join(":");
  assert.throws(() => enc.decryptQueuePayload(key, tampered), (e) => e.code === "QUEUE_DECRYPT_FAILED");
});

test("decrypting with a different key fails", () => {
  const keyA = enc.normalizeQueueEncryptionKey("a".repeat(64));
  const keyB = enc.normalizeQueueEncryptionKey("b".repeat(64));
  const token = enc.encryptQueuePayload(keyA, { refreshToken: "rt" });
  assert.throws(() => enc.decryptQueuePayload(keyB, token), (e) => e.code === "QUEUE_DECRYPT_FAILED");
});

test("ciphertext is a single opaque string with no plaintext structure", () => {
  const key = enc.normalizeQueueEncryptionKey(HEX_KEY);
  const token = enc.encryptQueuePayload(key, { accessToken: "at", providerSpecificData: { copilotToken: "cp" } });
  const parsed = JSON.parse(JSON.stringify({ ciphertext: token }));
  assert.equal(JSON.stringify(parsed).includes("copilotToken"), false);
});
