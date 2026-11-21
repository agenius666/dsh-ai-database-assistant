/**
 * Stable identifiers, content hashing, and filename safety.
 *
 * Result determinism depends on these helpers never including wall-clock time
 * or randomness in the values that enter a content hash.
 *
 * @module src/core/ids
 */
import {createHash, randomUUID} from 'node:crypto';

/**
 * SHA-256 of text or bytes, as lowercase hex.
 *
 * @param {string | Uint8Array} input content.
 * @returns {string} hex digest.
 */
export function sha256Hex(input) {
  return createHash('sha256').update(input).digest('hex');
}

/**
 * Serialize a value with sorted object keys so the same logical content always
 * produces the same text.
 *
 * @param {unknown} value any JSON-compatible value.
 * @returns {string} canonical JSON.
 */
export function canonicalJson(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : 'null';
  if (typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  if (typeof value === 'object') {
    const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return 'null';
}

/**
 * Content hash of a JSON value.
 *
 * @param {unknown} value content.
 * @returns {string} hex digest.
 */
export function contentHash(value) {
  return sha256Hex(canonicalJson(value));
}

/**
 * Create an identifier that is unique but carries a readable prefix.
 *
 * Randomness keeps ids unique and never enters a content hash.
 *
 * @param {string} prefix short kind prefix such as `P` or `RUN`.
 * @returns {string} identifier.
 */
export function newId(prefix) {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  return `${prefix}-${stamp}-${randomUUID().slice(0, 8)}`;
}

/**
 * Current time in ISO form (metadata only; never mixed into content hashes).
 *
 * @returns {string} ISO timestamp.
 */
export function isoNow() {
  return new Date().toISOString();
}

/**
 * Reduce arbitrary text to a safe file-name segment.
 *
 * @param {string} text source text, for example a user-supplied title.
 * @param {number} [maxLength] maximum length.
 * @returns {string} single path segment without separators or control characters.
 */
export function safeSegment(text, maxLength = 60) {
  const cleaned = String(text ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/^\.+/, '')
    .slice(0, maxLength);
  return cleaned === '' ? 'untitled' : cleaned;
}

/**
 * Short stable fingerprint of a rule definition, used to detect semantic drift
 * between a run and the rule version the run claims to use.
 *
 * @param {object} definition rule definition.
 * @returns {string} 16-hex-character fingerprint.
 */
export function fingerprintOf(definition) {
  return contentHash(definition).slice(0, 16);
}
