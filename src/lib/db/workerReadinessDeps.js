export async function buildWorkerReadyDeps({ isWorker, redisManager, limiterHealth }) {
  if (!isWorker()) return {};
  let redis = null;
  try { redis = await redisManager().command(); } catch {}
  return { redis, goLimiterHealth: limiterHealth };
}
