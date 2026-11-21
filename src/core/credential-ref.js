/**
 * Credential-reference naming rules.
 *
 * DSH's local credential provider accepts only environment-style names:
 *   ^[A-Za-z_][A-Za-z0-9_]*$
 *
 * A source id contains hyphens, so the source id must never be interpolated directly into
 * a credential ref (that was the `ai-database-assistant/S-...` startup failure).
 *
 * @module src/core/credential-ref
 */

/** Exact DSH credential reference grammar. */
export const CREDENTIAL_REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * @param {unknown} value candidate.
 * @returns {boolean} whether DSH can load this ref.
 */
export function isCredentialRef(value) {
  return typeof value === 'string' && CREDENTIAL_REF_PATTERN.test(value);
}

/**
 * Build the plugin-owned credential ref for one source.
 *
 * @param {string} sourceId database source id (S-...).
 * @returns {string} safe ref, e.g. `ai_database_assistant_S_2026...`.
 */
export function credentialRefForSource(sourceId) {
  const raw = String(sourceId ?? '').trim();
  const suffix = raw.replace(/[^A-Za-z0-9_]/g, '_');
  const safe = suffix === '' ? 'unknown' : suffix;
  return `ai_database_assistant_${safe}`;
}

/**
 * Make an arbitrary label safe for the DSH credential grammar.
 *
 * Collisions are the caller's responsibility; the migration tool adds suffixes.
 *
 * @param {string} label label.
 * @returns {string} safe ref.
 */
export function sanitizeCredentialRef(label) {
  const raw = String(label ?? '').trim();
  let safe = raw.replace(/[^A-Za-z0-9_]/g, '_');
  safe = safe.replace(/^_+/, '');
  if (safe === '') safe = 'credential';
  if (!/^[A-Za-z_]/.test(safe)) safe = `ref_${safe}`;
  return safe;
}
