/**
 * Row normalization, key construction, and field comparison.
 *
 * A "key" is the reconciliation identity. Blank key parts never match: an
 * employee id of NULL cannot be equated with another NULL, and pretending
 * otherwise invents a match that the rows do not contain. Such rows are
 * reported as their own finding instead.
 *
 * @module src/engine/normalize
 */
import {buildKey, compareValues, isBlank, normalizeText} from '../core/value.js';

/**
 * Resolve the canonical key column names from a rule mapping.
 *
 * @param {object} rule normalized rule.
 * @returns {{left: string, right: string}[]} key pairs.
 */
export function keyPairsOf(rule) {
  return (rule.key?.pairs ?? []).map((pair) => ({left: pair.left, right: pair.right ?? pair.left}));
}

/**
 * Compute the reconciliation key of one row.
 *
 * @param {Record<string, string|null>} row row.
 * @param {{left: string, right: string}[]} pairs key pairs.
 * @param {'left'|'right'} side side.
 * @param {object} options rule options.
 * @returns {{key: string|null, parts: Record<string, string|null>, blankColumns: string[]}} key result.
 */
export function keyOf(row, pairs, side, options) {
  const parts = {};
  const blankColumns = [];
  for (const pair of pairs) {
    const column = side === 'left' ? pair.left : pair.right;
    const value = row[column] ?? null;
    if (isBlank(value)) {
      blankColumns.push(column);
      parts[pair.left] = null;
      continue;
    }
    parts[pair.left] = normalizeText(value, options);
  }
  if (blankColumns.length > 0) return {key: null, parts, blankColumns};
  return {key: buildKey(parts, options), parts, blankColumns};
}

/**
 * Index one dataset by reconciliation key.
 *
 * @param {import('./dataset.js').Dataset} dataset dataset.
 * @param {{left: string, right: string}[]} pairs key pairs.
 * @param {'left'|'right'} side side.
 * @param {object} options rule options.
 * @returns {{
 *   index: Map<string, {row: Record<string, string|null>, rowNumber: number}[]>,
 *   blank: {row: Record<string, string|null>, rowNumber: number, columns: string[]}[],
 *   order: string[],
 * }} index.
 */
export function indexByKey(dataset, pairs, side, options) {
  const index = new Map();
  const blank = [];
  const order = [];
  dataset.rows.forEach((row, position) => {
    const result = keyOf(row, pairs, side, options);
    if (result.key === null) {
      blank.push({row, rowNumber: dataset.rowNumbers[position] ?? position + 1, columns: result.blankColumns});
      return;
    }
    if (!index.has(result.key)) {
      index.set(result.key, []);
      order.push(result.key);
    }
    index.get(result.key).push({row, rowNumber: dataset.rowNumbers[position] ?? position + 1});
  });
  return {index, blank, order};
}

/**
 * Validate that every column a rule references exists in its dataset.
 *
 * @param {import('./dataset.js').Dataset} dataset dataset.
 * @param {string[]} columns referenced columns.
 * @param {string} label side label for the error message.
 */
export function assertColumns(dataset, columns, label) {
  if (dataset.columns.length === 0 && dataset.rowCount === 0) {
    // Nothing to validate: the side legitimately returned no rows and (for an
    // ad-hoc SQL source) no schema could be resolved. The dataset carries a
    // warning that the columns were not checked.
    return;
  }
  const missing = [...new Set(columns)].filter((column) => !dataset.columns.includes(column));
  if (missing.length > 0) {
    const error = new Error(`${label}数据源「${dataset.sourceName}」缺少列：${missing.join('、')}`);
    error.code = 'invalid-input';
    error.details = {missing, available: dataset.columns};
    throw error;
  }
}

/**
 * Compare one mapped field pair for one matched row pair.
 *
 * @param {Record<string, string|null>} leftRow left row.
 * @param {Record<string, string|null>} rightRow right row.
 * @param {{left: string, right?: string, type?: string, tolerance?: unknown, caseInsensitive?: boolean, trim?: boolean, label?: string}} field field mapping.
 * @param {object} options rule options.
 * @returns {{equal: boolean, reason: string, left: string|null, right: string|null, column: string, rightColumn: string}} comparison.
 */
export function compareField(leftRow, rightRow, field, options) {
  const rightColumn = field.right ?? field.left;
  const merged = {
    kind: field.type ?? 'text',
    tolerance: field.tolerance ?? options.numericTolerance,
    caseInsensitive: field.caseInsensitive ?? options.caseInsensitive,
    trim: field.trim ?? options.trim,
    collapseSpaces: options.collapseSpaces,
    nullEquals: options.nullEquals,
    allowGrouping: options.allowGrouping,
    allowLeadingZeroInsensitive: options.allowLeadingZeroInsensitive,
    dateFormats: options.dateFormats,
  };
  const result = compareValues(leftRow[field.left] ?? null, rightRow[rightColumn] ?? null, merged);
  return {...result, column: field.left, rightColumn};
}

/**
 * Collect every column a rule reads from one side.
 *
 * @param {object} rule normalized rule.
 * @param {'left'|'right'} side side.
 * @returns {string[]} column names.
 */
export function referencedColumns(rule, side) {
  const columns = new Set();
  const add = (name) => {
    if (typeof name === 'string' && name !== '') columns.add(name);
  };
  for (const pair of rule.key?.pairs ?? []) add(side === 'left' ? pair.left : pair.right ?? pair.left);
  for (const field of rule.fields ?? []) add(side === 'left' ? field.left : field.right ?? field.left);
  for (const group of rule.groupBy ?? []) add(side === 'left' ? group.left : group.right ?? group.left);
  if (rule.kind === 'required') for (const field of rule.fields ?? []) add(field.left);
  if (rule.kind === 'time') {
    add(rule.time?.column);
    add(rule.time?.referenceColumn);
  }
  if (rule.kind === 'threshold' && rule.threshold?.column !== undefined) add(rule.threshold.column);
  for (const column of rule[side]?.dataset?.columns ?? []) add(column);
  return [...columns];
}
