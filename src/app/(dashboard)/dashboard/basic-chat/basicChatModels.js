export function restoreSessionModel(session, modelIndex, fallback = null) {
  if (!session?.modelId) return fallback;
  if (modelIndex.has(session.modelId)) return modelIndex.get(session.modelId);
  return {
    id: session.modelId,
    requestModel: session.modelId,
    name: session.modelName || session.modelId,
    providerId: session.providerId,
    providerName: session.providerName,
    source: "custom",
  };
}
