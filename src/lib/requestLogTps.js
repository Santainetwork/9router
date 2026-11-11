/**
 * Throughput math for the inbound request log.
 *
 * Kept in its own module with no imports so it can be unit-tested directly
 * (the request log writer pulls in the DB layer, which needs the `@/` alias).
 *
 *   inputTps  — prompt tokens over TTFT. Shows how fast the prompt was ingested;
 *               a long context or a cold prompt cache drops this hard.
 *   tps       — output tokens over the generation window. For a stream that is
 *               (duration - TTFT); for a non-streaming response the whole
 *               duration is the window, since TTFT is the response itself.
 *
 * Both return 0 rather than Infinity/NaN when an input is missing.
 */

export function computeTps(completionTokens, durationMs, ttftMs, stream) {
  const generationMs = stream && durationMs > ttftMs ? durationMs - ttftMs : durationMs;
  return completionTokens && generationMs > 0 ? Math.round((completionTokens / (generationMs / 1000)) * 10) / 10 : 0;
}

export function computeInputTps(promptTokens, ttftMs) {
  return promptTokens && ttftMs > 0 ? Math.round((promptTokens / (ttftMs / 1000)) * 10) / 10 : 0;
}
