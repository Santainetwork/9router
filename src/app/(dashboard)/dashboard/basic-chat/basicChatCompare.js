/**
 * Pure selection and result-state helpers for Basic Chat Compare mode.
 * Compare state is ephemeral: it is never persisted or attached to sessions.
 */

export const MAX_COMPARE_MODELS = 4;

/**
 * Add a model to the compare selection, deduping by id.
 * Refuses to add a model beyond MAX_COMPARE_MODELS (keeps existing four).
 * @param {Array<{id: string}>} models
 * @param {{id: string}} model
 * @returns {Array<{id: string}>}
 */
export function addCompareModel(models, model) {
  if (models.some((m) => m.id === model.id)) return models;
  if (models.length >= MAX_COMPARE_MODELS) return models;
  return [...models, model];
}

/**
 * Remove a model from the compare selection by id.
 * @param {Array<{id: string}>} models
 * @param {string} modelId
 * @returns {Array<{id: string}>}
 */
export function removeCompareModel(models, modelId) {
  return models.filter((m) => m.id !== modelId);
}

/**
 * Whether a compare run can start: 2-4 models and either trimmed text
 * or at least one attachment.
 * @param {Array<{id: string}>} models
 * @param {string} draft
 * @param {Array<*>} attachments
 * @returns {boolean}
 */
export function canStartCompare(models, draft, attachments) {
  if (!Array.isArray(models)) return false;
  if (models.length < 2 || models.length > MAX_COMPARE_MODELS) return false;
  const hasText = typeof draft === "string" && draft.trim().length > 0;
  const hasAttachment = Array.isArray(attachments) && attachments.length > 0;
  return hasText || hasAttachment;
}

/**
 * Create a new compare run. Copies prompt and attachments arrays so later
 * composer changes cannot mutate a started run. Each result starts pending.
 * No `sessions` or `session` field is ever present.
 * @param {string} prompt
 * @param {Array<*>} attachments
 * @param {Array<{id: string}>} models
 * @returns {{ prompt: string, attachments: Array<*>, results: Array<Object> }}
 */
export function createCompareRun(prompt, attachments, models) {
  return {
    prompt,
    attachments: [...attachments],
    results: models.map((model) => ({
      modelId: model.id,
      model: { ...model },
      status: "pending",
      text: "",
      error: null,
      responseMeta: null,
    })),
  };
}

/**
 * Immutably update a single result card by model id. Returns a new run;
 * other cards and the original run are untouched.
 * @param {{ results: Array<Object> }} run
 * @param {string} modelId
 * @param {Object} patch
 * @returns {{ results: Array<Object> }}
 */
export function updateCompareResult(run, modelId, patch) {
  return {
    ...run,
    results: run.results.map((result) =>
      result.model.id === modelId ? { ...result, ...patch } : result
    ),
  };
}

/**
 * Reset one card to pending, clearing text/error/responseMeta. Immutable.
 * @param {{ results: Array<Object> }} run
 * @param {string} modelId
 * @returns {{ results: Array<Object> }}
 */
export function resetCompareResult(run, modelId) {
  return updateCompareResult(run, modelId, {
    status: "pending",
    text: "",
    error: null,
    responseMeta: null,
  });
}

/**
 * Mark one card as stopped, preserving any partial text. Immutable.
 * @param {{ results: Array<Object> }} run
 * @param {string} modelId
 * @returns {{ results: Array<Object> }}
 */
export function markCompareStopped(run, modelId) {
  return updateCompareResult(run, modelId, { status: "stopped" });
}
