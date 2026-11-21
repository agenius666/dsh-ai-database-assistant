/**
 * Rule contract validation.
 *
 * A rule is configuration, never code. Validation is strict and hand-written (the plugin
 * has no third-party dependencies): unknown properties are rejected so a rule
 * cannot smuggle an option that the engine silently ignores, and every numeric
 * or enum field is bounded.
 *
 * @module src/core/rule-schema
 */
import {AssistantError, ERROR_CODES} from './errors.js';

/** Rule kinds implemented by the engine. */
export const RULE_KINDS = Object.freeze([
  'total',
  'match',
  'missing',
  'duplicate',
  'field',
  'required',
  'referential',
  'time',
  'threshold',
  'history',
]);

/** Kinds that only read the left dataset. */
export const SINGLE_SIDED_KINDS = Object.freeze(['required', 'time', 'threshold']);

/** Kinds that require a primary-key mapping. */
export const KEYED_KINDS = Object.freeze(['match', 'missing', 'duplicate', 'field', 'referential', 'history']);

/** Rule lifecycle status. */
export const RULE_STATUSES = Object.freeze(['draft', 'pending', 'confirmed', 'disabled']);

/** Comparison operators for filters. */
export const FILTER_OPS = Object.freeze(['eq', 'ne', 'in', 'gt', 'gte', 'lt', 'lte', 'between', 'like', 'isnull', 'notnull']);
/** Comparison operators for thresholds. */
export const THRESHOLD_OPS = Object.freeze(['gt', 'gte', 'lt', 'lte', 'eq']);
/** Aggregations for threshold rules. */
export const AGGREGATES = Object.freeze(['count', 'distinct', 'sum', 'min', 'max', 'avg']);
/** Field comparison types. */
export const FIELD_TYPES = Object.freeze(['text', 'integer', 'decimal', 'date', 'datetime']);
/** Duplicate handling policies. */
export const DUPLICATE_POLICIES = Object.freeze(['report', 'first-wins', 'all-pairs']);

/**
 * Throw a validation error with a path pointing at the offending property.
 *
 * @param {string} path property path.
 * @param {string} message reason.
 * @returns {never} always throws.
 */
function invalid(path, message) {
  throw new AssistantError(ERROR_CODES.invalidInput, `规则校验失败：${path} ${message}`, {details: {path}});
}

/**
 * Assert a plain object with no unknown keys.
 *
 * @param {unknown} value candidate.
 * @param {string} path property path.
 * @param {readonly string[]} allowed allowed keys.
 * @returns {Record<string, unknown>} the object.
 */
function objectOf(value, path, allowed) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid(path, '必须是对象。');
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) invalid(`${path}.${key}`, '不是允许的属性。');
  }
  return /** @type {Record<string, unknown>} */ (value);
}

/**
 * Assert a non-empty bounded string.
 *
 * @param {unknown} value candidate.
 * @param {string} path property path.
 * @param {number} [maxLength] maximum length.
 * @returns {string} the string.
 */
function stringOf(value, path, maxLength = 400) {
  if (typeof value !== 'string') invalid(path, '必须是字符串。');
  const text = value.trim();
  if (text === '') invalid(path, '不能为空。');
  if (text.length > maxLength) invalid(path, `长度不能超过 ${maxLength}。`);
  return text;
}

/**
 * Assert one of a fixed set of values.
 *
 * @param {unknown} value candidate.
 * @param {string} path property path.
 * @param {readonly string[]} allowed allowed values.
 * @returns {string} the value.
 */
function enumOf(value, path, allowed) {
  if (typeof value !== 'string' || !allowed.includes(value)) invalid(path, `必须是 ${allowed.join(' / ')} 之一。`);
  return value;
}

/**
 * Assert a bounded integer.
 *
 * @param {unknown} value candidate.
 * @param {string} path property path.
 * @param {{min?: number, max?: number}} [bounds] bounds.
 * @returns {number} the integer.
 */
function integerOf(value, path, bounds = {}) {
  if (typeof value !== 'number' || !Number.isInteger(value)) invalid(path, '必须是整数。');
  if (bounds.min !== undefined && value < bounds.min) invalid(path, `不能小于 ${bounds.min}。`);
  if (bounds.max !== undefined && value > bounds.max) invalid(path, `不能大于 ${bounds.max}。`);
  return value;
}

/**
 * Assert a boolean.
 *
 * @param {unknown} value candidate.
 * @param {string} path property path.
 * @returns {boolean} the boolean.
 */
function booleanOf(value, path) {
  if (typeof value !== 'boolean') invalid(path, '必须是布尔值。');
  return value;
}

/**
 * Validate one rule side: a source binding plus its dataset.
 *
 * @param {unknown} value candidate.
 * @param {string} path property path.
 * @returns {object} normalized side.
 */
function sideOf(value, path) {
  const side = objectOf(value, path, ['sourceId', 'dataset', 'label']);
  stringOf(side.sourceId, `${path}.sourceId`, 100);
  datasetOf(side.dataset, `${path}.dataset`);
  if (side.label !== undefined) stringOf(side.label, `${path}.label`, 100);
  return side;
}

/**
 * Validate a dataset specification.
 *
 * @param {unknown} value candidate.
 * @param {string} path property path.
 * @returns {object} normalized dataset spec.
 */
function datasetOf(value, path) {
  const dataset = objectOf(value, path, ['kind', 'table', 'fileId', 'sheet', 'sql', 'columns', 'filters', 'orderBy']);
  const kind = enumOf(dataset.kind, `${path}.kind`, ['table', 'file', 'sql']);
  if (kind === 'table') {
    stringOf(dataset.table, `${path}.table`);
    if (dataset.sql !== undefined) invalid(`${path}.sql`, '表数据源不能同时给出 SQL。');
  } else if (kind === 'sql') {
    const sql = stringOf(dataset.sql, `${path}.sql`, 20_000);
    if (!/^\s*(select|with)\b/i.test(sql)) invalid(`${path}.sql`, '只能是 SELECT / WITH 查询。');
    if (dataset.table !== undefined) invalid(`${path}.table`, 'SQL 数据源不能同时给出表名。');
  } else {
    stringOf(dataset.fileId, `${path}.fileId`);
  }
  if (dataset.columns !== undefined) {
    if (!Array.isArray(dataset.columns) || dataset.columns.length === 0) invalid(`${path}.columns`, '必须是非空数组。');
    dataset.columns.forEach((column, index) => stringOf(column, `${path}.columns[${index}]`, 200));
  }
  if (dataset.filters !== undefined) {
    if (!Array.isArray(dataset.filters)) invalid(`${path}.filters`, '必须是数组。');
    dataset.filters.forEach((filter, index) => filterOf(filter, `${path}.filters[${index}]`));
  }
  if (dataset.orderBy !== undefined) {
    if (!Array.isArray(dataset.orderBy)) invalid(`${path}.orderBy`, '必须是数组。');
    dataset.orderBy.forEach((column, index) => stringOf(column, `${path}.orderBy[${index}]`, 200));
  }
  return dataset;
}

/**
 * Validate one filter.
 *
 * @param {unknown} value candidate.
 * @param {string} path property path.
 * @returns {object} normalized filter.
 */
function filterOf(value, path) {
  const filter = objectOf(value, path, ['column', 'op', 'value']);
  stringOf(filter.column, `${path}.column`, 200);
  const op = enumOf(filter.op, `${path}.op`, FILTER_OPS);
  if (op === 'isnull' || op === 'notnull') {
    if (filter.value !== undefined) invalid(`${path}.value`, `${op} 不接受值。`);
    return filter;
  }
  if (filter.value === undefined) invalid(`${path}.value`, '缺少比较值。');
  if (op === 'in' || op === 'between') {
    if (!Array.isArray(filter.value) || filter.value.length < 2) invalid(`${path}.value`, '必须是至少两个元素的数组。');
  }
  return filter;
}

/**
 * Validate one field mapping/comparison entry.
 *
 * @param {unknown} value candidate.
 * @param {string} path property path.
 * @returns {object} normalized entry.
 */
function fieldOf(value, path) {
  const field = objectOf(value, path, ['left', 'right', 'type', 'tolerance', 'caseInsensitive', 'trim', 'label']);
  stringOf(field.left, `${path}.left`, 200);
  if (field.right !== undefined) stringOf(field.right, `${path}.right`, 200);
  if (field.type !== undefined) enumOf(field.type, `${path}.type`, FIELD_TYPES);
  if (field.tolerance !== undefined && typeof field.tolerance !== 'string' && typeof field.tolerance !== 'number') {
    invalid(`${path}.tolerance`, '必须是字符串或数字。');
  }
  if (field.caseInsensitive !== undefined) booleanOf(field.caseInsensitive, `${path}.caseInsensitive`);
  if (field.trim !== undefined) booleanOf(field.trim, `${path}.trim`);
  // An empty label is filled from the mapped columns by normalizeRule.
  if (field.label !== undefined && field.label !== '') stringOf(field.label, `${path}.label`, 100);
  return field;
}

/**
 * Validate the shared options block.
 *
 * @param {unknown} value candidate.
 * @param {string} path property path.
 * @returns {object} normalized options.
 */
function optionsOf(value, path) {
  const options = objectOf(value, path, [
    'caseInsensitive', 'trim', 'collapseSpaces', 'nullEquals', 'numericTolerance',
    'dateFormats', 'allowGrouping', 'duplicatePolicy', 'maxRowsPerSource',
    'batchSize', 'allowLeadingZeroInsensitive',
  ]);
  for (const key of ['caseInsensitive', 'trim', 'collapseSpaces', 'allowGrouping', 'allowLeadingZeroInsensitive']) {
    if (options[key] !== undefined) booleanOf(options[key], `${path}.${key}`);
  }
  if (options.nullEquals !== undefined) enumOf(options.nullEquals, `${path}.nullEquals`, ['equal', 'unequal']);
  if (options.duplicatePolicy !== undefined) enumOf(options.duplicatePolicy, `${path}.duplicatePolicy`, DUPLICATE_POLICIES);
  if (options.numericTolerance !== undefined && typeof options.numericTolerance !== 'string' && typeof options.numericTolerance !== 'number') {
    invalid(`${path}.numericTolerance`, '必须是字符串或数字。');
  }
  if (options.dateFormats !== undefined) {
    if (!Array.isArray(options.dateFormats) || options.dateFormats.length === 0) invalid(`${path}.dateFormats`, '必须是非空数组。');
    options.dateFormats.forEach((format, index) => stringOf(format, `${path}.dateFormats[${index}]`, 40));
  }
  if (options.maxRowsPerSource !== undefined) integerOf(options.maxRowsPerSource, `${path}.maxRowsPerSource`, {min: 1, max: 5_000_000});
  if (options.batchSize !== undefined) integerOf(options.batchSize, `${path}.batchSize`, {min: 100, max: 100_000});
  return options;
}

/**
 * Validate a complete rule definition.
 *
 * @param {unknown} input rule candidate.
 * @returns {object} a frozen, normalized copy.
 * @throws {AssistantError} when invalid.
 */
export function validateRule(input) {
  const rule = objectOf(input, 'rule', [
    'id', 'version', 'projectId', 'name', 'description', 'kind', 'status',
    'left', 'right', 'key', 'fields', 'options', 'time', 'threshold', 'groupBy',
    'createdAt', 'createdBy', 'updatedAt', 'confirmedAt', 'confirmedBy', 'notes', 'template',
  ]);
  const kind = enumOf(rule.kind, 'kind', RULE_KINDS);
  stringOf(rule.name, 'name', 200);
  if (rule.id !== undefined) stringOf(rule.id, 'id', 100);
  if (rule.projectId !== undefined) stringOf(rule.projectId, 'projectId', 100);
  if (rule.version !== undefined) integerOf(rule.version, 'version', {min: 1, max: 1_000_000});
  if (rule.status !== undefined) enumOf(rule.status, 'status', RULE_STATUSES);
  if (rule.description !== undefined) stringOf(rule.description, 'description', 2000);
  if (rule.template !== undefined) stringOf(rule.template, 'template', 100);
  if (rule.notes !== undefined) stringOf(rule.notes, 'notes', 4000);

  sideOf(rule.left, 'left');
  const singleSided = SINGLE_SIDED_KINDS.includes(kind);
  if (singleSided) {
    if (rule.right !== undefined) invalid('right', `${kind} 规则只读取左侧数据源。`);
  } else if (rule.right === undefined && kind === 'duplicate') {
    // Duplicate detection may target one side only, so the right side is
    // optional for this kind.
  } else {
    sideOf(rule.right, 'right');
  }

  if (rule.options !== undefined) optionsOf(rule.options, 'options');

  if (KEYED_KINDS.includes(kind)) {
    const key = objectOf(rule.key, 'key', ['pairs', 'label']);
    if (!Array.isArray(key.pairs) || key.pairs.length === 0) invalid('key.pairs', '必须是非空数组。');
    key.pairs.forEach((pair, index) => {
      const entry = objectOf(pair, `key.pairs[${index}]`, ['left', 'right']);
      stringOf(entry.left, `key.pairs[${index}].left`, 200);
      // A one-sided duplicate rule reconciles inside a single dataset, so the
      // right column is optional and defaults to the left one.
      if (entry.right !== undefined) stringOf(entry.right, `key.pairs[${index}].right`, 200);
    });
    if (key.label !== undefined) stringOf(key.label, 'key.label', 100);
  } else if (rule.key !== undefined && kind !== 'total' && (rule.key?.pairs ?? []).length > 0) {
    invalid('key', `${kind} 规则不接受主键映射。`);
  }

  if (kind === 'match' || kind === 'field' || kind === 'history') {
    if (!Array.isArray(rule.fields) || rule.fields.length === 0) invalid('fields', '必须是非空数组。');
    rule.fields.forEach((field, index) => fieldOf(field, `fields[${index}]`));
  } else if (kind === 'required') {
    if (rule.fields !== undefined) {
      if (!Array.isArray(rule.fields) || rule.fields.length === 0) invalid('fields', '必须是非空数组。');
      rule.fields.forEach((field, index) => fieldOf(field, `fields[${index}]`));
    }
  } else if (rule.fields !== undefined && kind !== 'total' && !(Array.isArray(rule.fields) && rule.fields.length === 0)) {
    invalid('fields', `${kind} 规则不接受字段比较。`);
  }

  if (kind === 'total') {
    if (rule.groupBy !== undefined) {
      if (!Array.isArray(rule.groupBy) || rule.groupBy.length === 0) invalid('groupBy', '必须是非空数组。');
      rule.groupBy.forEach((group, index) => {
        const entry = objectOf(group, `groupBy[${index}]`, ['left', 'right']);
        stringOf(entry.left, `groupBy[${index}].left`, 200);
        if (entry.right !== undefined) stringOf(entry.right, `groupBy[${index}].right`, 200);
      });
    }
    if (rule.fields !== undefined) {
      if (!Array.isArray(rule.fields)) invalid('fields', '必须是数组。');
      rule.fields.forEach((field, index) => fieldOf(field, `fields[${index}]`));
    }
  }

  if (kind === 'time') {
    const time = objectOf(rule.time, 'time', ['column', 'op', 'referenceColumn', 'referenceValue', 'days', 'label']);
    stringOf(time.column, 'time.column', 200);
    enumOf(time.op, 'time.op', ['before', 'after', 'within-days', 'order']);
    if (time.op === 'within-days') {
      integerOf(time.days, 'time.days', {min: 0, max: 36_500});
      if (time.referenceColumn === undefined && time.referenceValue === undefined) invalid('time.referenceColumn', 'within-days 需要参考列或参考值。');
    }
    if (time.referenceColumn !== undefined) stringOf(time.referenceColumn, 'time.referenceColumn', 200);
    if (time.referenceValue !== undefined) stringOf(time.referenceValue, 'time.referenceValue', 100);
  }

  if (kind === 'threshold') {
    const threshold = objectOf(rule.threshold, 'threshold', ['aggregate', 'column', 'op', 'value', 'label']);
    enumOf(threshold.aggregate, 'threshold.aggregate', AGGREGATES);
    if (threshold.aggregate !== 'count') stringOf(threshold.column, 'threshold.column', 200);
    enumOf(threshold.op, 'threshold.op', THRESHOLD_OPS);
    if (threshold.value === undefined) invalid('threshold.value', '缺少阈值。');
    if (typeof threshold.value !== 'number' && typeof threshold.value !== 'string') invalid('threshold.value', '必须是数字或数字字符串。');
    if (threshold.label !== undefined) stringOf(threshold.label, 'threshold.label', 100);
  }

  return deepFreeze(JSON.parse(JSON.stringify(rule)));
}

/**
 * Freeze a JSON value deeply so a rule cannot be mutated after validation.
 *
 * @template T
 * @param {T} value value to freeze.
 * @returns {T} the same value.
 */
export function deepFreeze(value) {
  if (value !== null && typeof value === 'object') {
    for (const entry of Object.values(value)) deepFreeze(entry);
    Object.freeze(value);
  }
  return value;
}

/**
 * Normalize a rule to the shape the engine consumes, filling defaults.
 *
 * @param {object} rule validated rule.
 * @returns {object} normalized rule.
 */
export function normalizeRule(rule) {
  const options = {
    trim: true,
    caseInsensitive: false,
    collapseSpaces: false,
    nullEquals: 'equal',
    duplicatePolicy: 'report',
    allowGrouping: false,
    allowLeadingZeroInsensitive: false,
    maxRowsPerSource: 200_000,
    batchSize: 5_000,
    ...(rule.options ?? {}),
  };
  return {
    ...rule,
    version: rule.version ?? 1,
    status: rule.status ?? 'draft',
    options,
    // A missing display label is a presentation gap, not an invalid rule: fill
    // the value from the mapped columns so a mapping-generated draft can be saved
    // without forcing the user to retype what they just selected.
    fields: (rule.fields ?? []).map((field) => {
      const label = typeof field.label === 'string' && field.label.trim() !== ''
        ? field.label
        : (typeof field.right === 'string' && field.right !== '' ? `${field.left} 与 ${field.right}` : String(field.left ?? ''));
      return {...field, type: field.type ?? 'text', label};
    }),
    key: rule.key ?? {pairs: []},
    // Only synthesize `groupBy` when the rule declared the field: a total rule without
    // grouping compares a single overall bucket, and `[]` would be rejected by
    // validation as an empty grouping list.
    ...(rule.groupBy === undefined ? {} : {groupBy: rule.groupBy.map((group) => ({right: group.left, ...group}))}),
  };
}
