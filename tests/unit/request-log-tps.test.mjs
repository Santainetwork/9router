import test from "node:test";
import assert from "node:assert/strict";
import { computeInputTps, computeTps } from "../../src/lib/requestLogTps.js";

// Input TPS = prompt tokens divided by the time to first token. The request log
// table shows it next to the output TPS so a slow prompt (long context, cold
// cache) is distinguishable from a slow generation.

test("computeInputTps divides prompt tokens by TTFT in seconds", () => {
  // 2000 tok in 2s = 1000 tok/s
  assert.equal(computeInputTps(2000, 2000), 1000);
  // 175000 tok in 25s = 7000 tok/s
  assert.equal(computeInputTps(175000, 25000), 7000);
  // rounds to one decimal below 100
  assert.equal(computeInputTps(1000, 3000), 333.3);
});

test("computeInputTps yields 0 when either input is missing", () => {
  assert.equal(computeInputTps(0, 2000), 0);
  assert.equal(computeInputTps(2000, 0), 0);
  assert.equal(computeInputTps(undefined, 2000), 0);
  assert.equal(computeInputTps(2000, undefined), 0);
});

test("computeTps still measures the streaming generation window only", () => {
  // Streaming: output tokens over (duration - ttft).
  assert.equal(computeTps(802, 23531, 22698, true), 962.8);
  // Non-streaming: whole duration is the window.
  assert.equal(computeTps(100, 1000, 1000, false), 100);
});
