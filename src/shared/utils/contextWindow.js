// Per-combo override for the published context window.
//
// A combo entry in `/v1/models` normally advertises the smallest window across
// its seats, because any seat can serve the request. That derived value is
// sometimes wrong for the combo as a product (and clients cache it), so a combo
// may carry an explicit override instead.
//
// Stored in `combos.contextWindow` as an INTEGER; `null` means "no override" and
// the derived min is published. Kept dependency-free so both the server routes
// and the dashboard bundle can import it.

/**
 * Lenient coercion for values already stored in the DB: anything that is not a
 * positive finite number becomes `null` (i.e. "no override").
 * @param {unknown} value
 * @returns {number|null}
 */
export function normalizeContextWindow(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(String(value).trim());
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.trunc(n);
}

/**
 * Strict variant for user input (API bodies, restore payloads): a malformed
 * value is reported instead of silently dropped, so the caller can reject it.
 * `null` / `""` / absent are valid and mean "clear the override".
 * @param {unknown} value
 * @returns {{ok: true, value: number|null} | {ok: false, error: string}}
 */
export function validateContextWindowInput(value) {
  if (value === null || value === undefined || value === "") return { ok: true, value: null };
  const n = typeof value === "number" ? value : Number(String(value).trim());
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    return { ok: false, error: "contextWindow must be a positive integer, or null to clear it" };
  }
  return { ok: true, value: n };
}
