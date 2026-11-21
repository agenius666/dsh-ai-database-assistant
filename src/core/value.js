/**
 * Deterministic value normalization and comparison.
 *
 * Every value in this plugin — from a database cell, a CSV field, or an XLSX
 * cell — is handled as a string. Nothing is coerced through IEEE-754 binary
 * floats, because analysis reconciliation of money, big identifiers, and
 * timestamped records breaks silently when that happens.
 *
 * The functions here are pure, allocation-light, and free of `Date` formatting
 * or locale, so the same inputs always produce the same comparison result on
 * every machine.
 *
 * @module src/core/value
 */

/** Fields whose comparison is decided numerically. */
export const NUMERIC_KINDS = Object.freeze(['decimal', 'integer']);
/** Fields whose comparison is decided by a parsed calendar instant. */
export const DATE_KINDS = Object.freeze(['date', 'datetime', 'timestamp']);

/**
 * Default accepted date/time layouts. Deliberately explicit: guessing between
 * `03/04/2026` (March 4th or April 3rd) is a value-quality decision the user
 * must make, not something this module may decide on its own.
 */
export const DEFAULT_DATE_FORMATS = Object.freeze([
  'YYYY-MM-DD',
  'YYYY-MM-DD HH:mm:ss',
  'YYYY-MM-DD HH:mm:ss.SSS',
  'YYYY/MM/DD',
  'YYYY/MM/DD HH:mm:ss',
  'YYYYMMDD',
  'YYYYMMDDHHmmss',
  'YYYY-MM-DDTHH:mm:ss',
  'YYYY-MM-DDTHH:mm:ss.SSSZ',
]);

/**
 * Whether a cell should be treated as absent.
 *
 * `0`, `false`, and `'0'` are values, never "blank"; conflating them with
 * absence is the classic way an analysis total silently changes.
 *
 * @param {unknown} value raw cell value.
 * @returns {boolean} true when the cell carries no value.
 */
export function isBlank(value) {
  return value === null || value === undefined || (typeof value === 'string' && value.trim() === '');
}

/**
 * Normalize one text value according to mapping options.
 *
 * @param {string} value raw text.
 * @param {{trim?: boolean, caseInsensitive?: boolean, collapseSpaces?: boolean}} [options] text rules.
 * @returns {string} normalized text.
 */
export function normalizeText(value, options = {}) {
  const {trim = true, caseInsensitive = false, collapseSpaces = false} = options;
  let out = String(value);
  if (trim) out = out.trim();
  if (collapseSpaces) out = out.replace(/\s+/g, ' ');
  if (caseInsensitive) out = out.toLowerCase();
  return out;
}

/**
 * Parse a decimal literal into sign, digits, and scale without floating point.
 *
 * Accepts an optional leading `+`/`-`, ASCII digits, an optional single decimal
 * separator, and (only when `allowGrouping` is set) `,` group separators.
 * Rejects exponents, empty fractions, and stray characters: a value like
 * `1,20` is only a number when the user declared the file uses `,` grouping.
 *
 * @param {unknown} raw value to parse.
 * @param {{allowGrouping?: boolean, decimalSeparator?: string}} [options] parsing rules.
 * @returns {{negative: boolean, digits: string, scale: number} | null} parsed decimal or null.
 */
export function parseDecimal(raw, options = {}) {
  const {allowGrouping = false, decimalSeparator = '.'} = options;
  if (raw === null || raw === undefined) return null;
  let text = String(raw).trim();
  if (text === '') return null;
  let negative = false;
  if (text[0] === '+' || text[0] === '-') {
    negative = text[0] === '-';
    text = text.slice(1);
  }
  if (allowGrouping && decimalSeparator === '.') text = text.replace(/,/g, '');
  else if (allowGrouping && decimalSeparator === ',') text = text.replace(/\./g, '');
  if (decimalSeparator !== '.') text = text.replace(decimalSeparator === ',' ? ',' : decimalSeparator, '.');
  if (!/^\d*\.?\d*$/.test(text) || text === '' || text === '.') return null;
  const dot = text.indexOf('.');
  const intPart = (dot === -1 ? text : text.slice(0, dot)).replace(/^0+(?=\d)/, '');
  const fracPart = dot === -1 ? '' : text.slice(dot + 1).replace(/0+$/, '');
  const digits = `${intPart === '' ? '0' : intPart}${fracPart}`;
  return {negative: negative && !/^0+$/.test(digits), digits, scale: fracPart.length};
}

/**
 * Render a parsed decimal as an exact `bigint` at a requested scale.
 *
 * @param {{negative: boolean, digits: string, scale: number}} parsed parsed decimal.
 * @param {number} scale target fractional digits (must be >= parsed scale).
 * @returns {bigint} exact scaled integer.
 */
function toScaled(parsed, scale) {
  const padded = parsed.digits.padEnd(parsed.digits.length + (scale - parsed.scale), '0');
  const magnitude = BigInt(padded === '' ? '0' : padded);
  return parsed.negative ? -magnitude : magnitude;
}

/**
 * Parse a tolerance literal (for example `0.01`) at a fixed scale.
 *
 * @param {unknown} raw tolerance.
 * @returns {{scale: number, value: bigint} | null} tolerance or null when unusable.
 */
export function parseTolerance(raw) {
  const parsed = parseDecimal(raw, {allowGrouping: false});
  if (parsed === null || parsed.negative) return null;
  return {scale: parsed.scale, value: toScaled(parsed, parsed.scale)};
}

/**
 * Compare two decimal values exactly, within an optional absolute tolerance.
 *
 * @param {unknown} left left value.
 * @param {unknown} right right value.
 * @param {{tolerance?: unknown, allowGrouping?: boolean, decimalSeparator?: string}} [options] compare rules.
 * @returns {{equal: boolean, reason: string, left?: string, right?: string, difference?: string} | null} comparison, or null when a side is not numeric.
 */
export function compareDecimal(left, right, options = {}) {
  const lp = parseDecimal(left, options);
  const rp = parseDecimal(right, options);
  if (lp === null || rp === null) return null;
  const scale = Math.max(lp.scale, rp.scale);
  const a = toScaled(lp, scale);
  const b = toScaled(rp, scale);
  const diff = a > b ? a - b : b - a;
  let tolerance = 0n;
  if (options.tolerance !== undefined && options.tolerance !== null && String(options.tolerance).trim() !== '') {
    const tol = parseTolerance(options.tolerance);
    if (tol !== null) tolerance = tol.scale <= scale ? tol.value * 10n ** BigInt(scale - tol.scale) : tol.value / 10n ** BigInt(tol.scale - scale);
  }
  const equal = diff <= tolerance;
  return {
    equal,
    reason: equal ? 'numeric-equal' : 'numeric-different',
    left: formatScaled(a, scale),
    right: formatScaled(b, scale),
    difference: formatScaled(diff, scale),
  };
}

/**
 * Format an exact scaled integer back into a plain decimal string.
 *
 * @param {bigint} value scaled integer.
 * @param {number} scale fractional digits.
 * @returns {string} decimal text.
 */
export function formatScaled(value, scale) {
  const negative = value < 0n;
  let digits = (negative ? -value : value).toString();
  if (scale === 0) return (negative ? '-' : '') + digits;
  digits = digits.padStart(scale + 1, '0');
  const head = digits.slice(0, digits.length - scale);
  const tail = digits.slice(digits.length - scale);
  return `${negative ? '-' : ''}${head}.${tail}`;
}

/**
 * Parse a date/time value with an explicit layout list.
 *
 * @param {unknown} raw value to parse.
 * @param {readonly string[]} [formats] accepted layouts.
 * @returns {{epochMs: number, matchedFormat: string} | null} parsed instant or null.
 */
export function parseDateTime(raw, formats = DEFAULT_DATE_FORMATS) {
  if (raw === null || raw === undefined) return null;
  const text = String(raw).trim();
  if (text === '') return null;
  if (/^\d{13}$/.test(text)) return {epochMs: Number(text), matchedFormat: 'epoch-ms'};
  if (/^\d{10}$/.test(text)) return {epochMs: Number(text) * 1000, matchedFormat: 'epoch-s'};
  for (const format of formats) {
    const parsed = matchFormat(text, format);
    if (parsed !== null) return {epochMs: parsed, matchedFormat: format};
  }
  // Up to nine fractional digits: SQL Server/Oracle commonly expose 6–7, and
  // dropping them made a microsecond timestamp unparseable instead of unequal.
  const isoMatch = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?)?(Z|[+-]\d{2}:?\d{2})?$/.exec(text);
  if (isoMatch !== null) {
    const [, year, month, day, hour = '0', minute = '0', second = '0', fraction = '', zone] = isoMatch;
    const numbers = [year, month, day, hour, minute, second].map(Number);
    if (numbers[1] < 1 || numbers[1] > 12 || numbers[2] < 1 || numbers[2] > 31) return null;
    if (numbers[3] > 23 || numbers[4] > 59 || numbers[5] > 59) return null;
    const millis = Number(fraction.slice(0, 3).padEnd(3, '0'));
    // Carry the digits beyond milliseconds separately so .123456 and .123457
    // compare as different instants without a floating-point hack.
    const fractionMicros = Number(fraction.padEnd(6, '0').slice(3, 6));
    let epoch = Date.UTC(numbers[0], numbers[1] - 1, numbers[2], numbers[3], numbers[4], numbers[5], millis);
    const check = new Date(epoch);
    if (check.getUTCFullYear() !== numbers[0] || check.getUTCMonth() !== numbers[1] - 1 || check.getUTCDate() !== numbers[2]) return null;
    if (zone !== undefined && zone !== 'Z') {
      const sign = zone.startsWith('-') ? -1 : 1;
      const [zoneHour, zoneMinute] = zone.slice(1).replace(':', '').match(/\d{2}/g).map(Number);
      epoch -= sign * (zoneHour * 60 + zoneMinute) * 60_000;
    }
    return {epochMs: epoch, subMillisecond: fractionMicros, matchedFormat: 'iso'};
  }
  return null;
}

/**
 * Match one token layout against a text value and return a UTC instant.
 *
 * All layouts are interpreted as UTC so the comparison never shifts with the
 * operator's machine timezone.
 *
 * @param {string} text value.
 * @param {string} format layout tokens.
 * @returns {number | null} epoch milliseconds, or null when the text does not match.
 */
function matchFormat(text, format) {
  const tokens = [];
  let regex = '^';
  for (let index = 0; index < format.length; index += 1) {
    const rest = format.slice(index);
    const token = ['YYYY', 'SSS', 'MM', 'DD', 'HH', 'mm', 'ss'].find((name) => rest.startsWith(name));
    if (token !== undefined) {
      tokens.push(token);
      regex += token === 'YYYY' ? '(\\d{4})' : '(\\d{2})';
      index += token.length - 1;
      continue;
    }
    const character = format[index];
    if (character === 'Z') {
      regex += 'Z';
      continue;
    }
    regex += character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  regex += '$';
  const match = new RegExp(regex).exec(text);
  if (match === null) return null;
  const parts = {YYYY: 1970, MM: 1, DD: 1, HH: 0, mm: 0, ss: 0, SSS: 0};
  tokens.forEach((token, position) => {
    parts[token] = Number(match[position + 1]);
  });
  const {YYYY, MM, DD, HH, mm, ss, SSS} = parts;
  if (MM < 1 || MM > 12 || DD < 1 || DD > 31 || HH > 23 || mm > 59 || ss > 59) return null;
  const epoch = Date.UTC(YYYY, MM - 1, DD, HH, mm, ss, SSS);
  const check = new Date(epoch);
  if (check.getUTCFullYear() !== YYYY || check.getUTCMonth() !== MM - 1 || check.getUTCDate() !== DD) return null;
  return epoch;
}

/**
 * Compare two values with a typed strategy.
 *
 * @param {unknown} left left value.
 * @param {unknown} right right value.
 * @param {{
 *   kind?: string, trim?: boolean, caseInsensitive?: boolean,
 *   nullEquals?: 'equal'|'unequal', tolerance?: unknown,
 *   allowGrouping?: boolean, decimalSeparator?: string,
 *   dateFormats?: readonly string[], allowLeadingZeroInsensitive?: boolean,
 * }} [options] compare options.
 * @returns {{equal: boolean, reason: string, left: string|null, right: string|null}} result.
 */
export function compareValues(left, right, options = {}) {
  const kind = options.kind ?? 'text';
  const nullEquals = options.nullEquals ?? 'equal';
  const leftBlank = isBlank(left);
  const rightBlank = isBlank(right);
  if (leftBlank && rightBlank) return {equal: nullEquals === 'equal', reason: 'both-blank', left: null, right: null};
  if (leftBlank || rightBlank) return {equal: false, reason: 'one-blank', left: leftBlank ? null : String(left), right: rightBlank ? null : String(right)};

  if (NUMERIC_KINDS.includes(kind)) {
    const numeric = compareDecimal(left, right, {
      tolerance: options.tolerance,
      allowGrouping: options.allowGrouping ?? false,
      decimalSeparator: options.decimalSeparator ?? '.',
    });
    if (numeric === null) {
      // A non-numeric cell where the mapping promised a number is a value
      // quality finding, not an equal value.
      return {equal: false, reason: 'unparseable-number', left: String(left).trim(), right: String(right).trim()};
    }
    return {equal: numeric.equal, reason: numeric.reason, left: numeric.left ?? null, right: numeric.right ?? null};
  }

  if (DATE_KINDS.includes(kind)) {
    const a = parseDateTime(left, options.dateFormats);
    const b = parseDateTime(right, options.dateFormats);
    if (a === null || b === null) {
      return {equal: false, reason: 'unparseable-date', left: String(left).trim(), right: String(right).trim()};
    }
    const sameInstant = a.epochMs === b.epochMs && (a.subMillisecond ?? 0) === (b.subMillisecond ?? 0);
    return {
      equal: sameInstant,
      reason: sameInstant ? 'date-equal' : 'date-different',
      left: String(a.epochMs),
      right: String(b.epochMs),
    };
  }

  let a = normalizeText(left, options);
  let b = normalizeText(right, options);
  if (options.allowLeadingZeroInsensitive === true) {
    if (/^-?\d+$/.test(a) && /^-?\d+$/.test(b)) {
      a = a.replace(/^(-?)0+(?=\d)/, '$1');
      b = b.replace(/^(-?)0+(?=\d)/, '$1');
    }
  }
  return {equal: a === b, reason: a === b ? 'text-equal' : 'text-different', left: a, right: b};
}

/**
 * Build a deterministic composite key from mapped fields.
 *
 * @param {Readonly<Record<string, string|null>>} parts key parts.
 * @param {{caseInsensitive?: boolean, trim?: boolean}} [options] text rules.
 * @returns {string} canonical key text that is stable across runs.
 */
export function buildKey(parts, options = {}) {
  const values = [];
  for (const [name, raw] of Object.entries(parts)) {
    const normalized = isBlank(raw) ? '\u0000NULL' : normalizeText(raw, options);
    // Length prefixes make the encoding injective: without them a value that
    // itself contains the separators could collide with a different tuple.
    values.push(`${name.length}:${name}\u0001${normalized.length}:${normalized}`);
  }
  return values.join('\u0002');
}

/**
 * Infer a column's value kind from observed samples.
 *
 * The inference is advisory only: the inference never changes how a value is compared
 * unless the user accepts the inference into the mapping.
 *
 * @param {readonly (string|null)[]} samples observed cells.
 * @returns {'integer'|'decimal'|'date'|'datetime'|'text'} inferred kind.
 */
export function inferKind(samples) {
  const values = samples.filter((sample) => !isBlank(sample)).map(String);
  if (values.length === 0) return 'text';
  if (values.every((value) => /^[+-]?\d+$/.test(value.trim()))) return 'integer';
  if (values.every((value) => parseDecimal(value, {allowGrouping: false}) !== null)) return 'decimal';
  const dates = values.map((value) => parseDateTime(value));
  if (dates.every((entry) => entry !== null)) {
    const allDayOnly = values.every((value) => !/\d[ T]\d{1,2}:\d{2}/.test(value));
    return allDayOnly ? 'date' : 'datetime';
  }
  return 'text';
}
