/**
 * Custom Error Message Resolver
 * Maps upstream/gateway errors to clean custom messages when enabled in settings.
 */

export function resolveCustomErrorMessage(statusCode, defaultMsg, settings = {}) {
  if (!settings || settings.customErrorResponseEnabled !== true) {
    return defaultMsg;
  }

  const code = Number(statusCode) || 500;

  if (code === 429) {
    return settings.customError429Message || defaultMsg;
  }
  if (code === 502) {
    return settings.customError502Message || defaultMsg;
  }
  if (code === 503) {
    return settings.customError503Message || defaultMsg;
  }

  return settings.customErrorFallbackMessage || defaultMsg;
}
