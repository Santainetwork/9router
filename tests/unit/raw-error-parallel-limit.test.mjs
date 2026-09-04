import test from "node:test";
import assert from "node:assert/strict";
import { createErrorResult, isParallelLimitError } from "../../open-sse/utils/error.js";

test("createErrorResult retains rawError distinct from custom masked message", () => {
  const masked = "Terjadi kendala pada penyedia AI upstream. Silakan coba beberapa saat lagi.";
  const raw = "Anda menjalankan 5 permintaan sekaligus, melebihi batas 5 request paralel";
  
  const result = createErrorResult(429, masked, null, raw);
  assert.equal(result.error, masked);
  assert.equal(result.rawError, raw);
  assert.equal(result.status, 429);
});

test("isParallelLimitError detects concurrency errors on rawError string", () => {
  const rawIndonesian = "Anda menjalankan 5 permintaan sekaligus, melebihi batas 5 request paralel";
  assert.equal(isParallelLimitError(rawIndonesian), true);

  const rawStandard = "concurrency limit reached for your account";
  assert.equal(isParallelLimitError(rawStandard), true);

  const masked = "Terjadi kendala pada penyedia AI upstream. Silakan coba beberapa saat lagi.";
  assert.equal(isParallelLimitError(masked), false);
});
