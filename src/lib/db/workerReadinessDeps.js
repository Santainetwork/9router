export async function buildWorkerReadyDeps({ isWorker, redisManager, limiterHealth }) {
  if (!isWorker()) return {};
  let redis = null;
  try { redis = await redisManager().command(); } catch {}
  const { getWorkerTelemetryStatus } = await import("./workerMutation.js");
  return { redis, goLimiterHealth: limiterHealth, telemetryStatus: getWorkerTelemetryStatus };
}
