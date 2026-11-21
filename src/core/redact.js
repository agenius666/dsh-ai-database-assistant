/**
 * Credential redaction at every output boundary.
 *
 * The plugin never stores a database password, but a client's error text can
 * echo one (for example `Access denied for user 'root' (using password: YES)`,
 * or an `argv` dump). Every string that leaves the execution layer passes
 * through here.
 *
 * @module src/core/redact
 */

/** Placeholder written in place of a secret. */
export const REDACTED = '[REDACTED]';

/**
 * Replace every occurrence of each secret with the placeholder.
 *
 * @param {string} text text to clean.
 * @param {readonly (string | undefined | null)[]} secrets secret values.
 * @returns {string} cleaned text.
 */
export function redactText(text, secrets) {
  let out = String(text ?? '');
  for (const secret of secrets) {
    if (typeof secret !== 'string' || secret.length < 3) continue;
    out = out.split(secret).join(REDACTED);
    const encoded = encodeURIComponent(secret);
    if (encoded !== secret) out = out.split(encoded).join(REDACTED);
  }
  return out;
}

/**
 * Recursively redact strings inside a JSON-compatible value.
 *
 * @param {unknown} value value to clean.
 * @param {readonly (string | undefined | null)[]} secrets secret values.
 * @returns {unknown} cleaned copy.
 */
export function redactDeep(value, secrets) {
  if (typeof value === 'string') return redactText(value, secrets);
  if (Array.isArray(value)) return value.map((entry) => redactDeep(entry, secrets));
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const [key, entry] of Object.entries(value)) {
      if (/^(password|passwd|pwd|secret|token|dsn|connectionstring|connection_string|apikey|api_key)$/i.test(key)) {
        out[key] = entry === undefined || entry === null || entry === '' ? entry : REDACTED;
        continue;
      }
      out[key] = redactDeep(entry, secrets);
    }
    return out;
  }
  return value;
}

/**
 * Assert that a text contains none of the given secrets.
 *
 * Used by tests and by the evidence-pack writer as a last line of defense.
 *
 * @param {string} text text to check.
 * @param {readonly (string | undefined | null)[]} secrets secret values.
 * @returns {boolean} true when no secret appears.
 */
export function containsNoSecret(text, secrets) {
  const haystack = String(text ?? '');
  return secrets.every((secret) => typeof secret !== 'string' || secret.length < 3 || !haystack.includes(secret));
}
