// Console Log bounds, kept in a leaf module so server code (and its unit tests)
// can read them without pulling the whole provider catalog through config.js.
export const CONSOLE_LOG_CONFIG = {
  maxLines: 200,
  pollIntervalMs: 1000,
};
