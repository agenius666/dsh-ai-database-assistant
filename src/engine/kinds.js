/**
 * Rule kinds.
 *
 * Each handler is a pure function over already-loaded datasets. The handler never
 * performs I/O, never reads the clock, and never iterates a `Map` in a way that
 * depends on hash order: the iteration order always comes from a dataset's row
 * order, so two runs over the same snapshot produce the same findings.
 *
 * @module src/engine/kinds
 */
import {formatScaled, isBlank, normalizeText, parseDateTime, parseDecimal} from '../core/value.js';
import {assertColumns, compareField, indexByKey, keyOf, keyPairsOf, referencedColumns} from './normalize.js';

/**
 * @typedef {Object} EngineContext
 * @property {object} rule normalized rule.
 * @property {object} options rule options.
 * @property {import('./dataset.js').Dataset} left left dataset.
 * @property {import('./dataset.js').Dataset|null} right right dataset.
 * @property {(finding: object) => void} emit finding sink.
 * @property {Record<string, number>} stats mutable counters.
 * @property {string[]} warnings mutable warnings.
 */

/**
 * Exact decimal accumulator.
 *
 * Keeps a scaled BigInt plus its scale, rescaling when a value with more
 * fractional digits arrives, so adding 200k money values never drifts.
 */
class DecimalAccumulator {
  /** @type {bigint} */
  #value = 0n;
  /** @type {number} */
  #scale = 0;
  /** @type {number} */
  #count = 0;

  /**
   * Add one raw value.
   *
   * @param {unknown} raw value.
   * @returns {boolean} whether the value was numeric.
   */
  add(raw) {
    if (isBlank(raw)) return false;
    const parsed = parseDecimal(raw);
    if (parsed === null) return false;
    if (parsed.scale > this.#scale) {
      this.#value *= 10n ** BigInt(parsed.scale - this.#scale);
      this.#scale = parsed.scale;
    }
    const magnitude = BigInt(parsed.digits === '' ? '0' : parsed.digits) * 10n ** BigInt(this.#scale - parsed.scale);
    this.#value += parsed.negative ? -magnitude : magnitude;
    this.#count += 1;
    return true;
  }

  /** Reset the accumulator. */
  reset() {
    this.#value = 0n;
    this.#scale = 0;
    this.#count = 0;
  }

  /** @returns {number} number of numeric values added. */
  get count() {
    return this.#count;
  }

  /** @returns {string} exact decimal text. */
  text() {
    return formatScaled(this.#value, this.#scale);
  }

  /**
   * Compare with another raw value.
   *
   * @param {unknown} raw other value.
   * @returns {number} -1, 0, or 1 (equal when 0).
   */
  compareTo(raw) {
    const parsed = parseDecimal(raw);
    if (parsed === null) return 1;
    const scale = Math.max(this.#scale, parsed.scale);
    const left = this.#value * 10n ** BigInt(scale - this.#scale);
    const magnitude = BigInt(parsed.digits === '' ? '0' : parsed.digits) * 10n ** BigInt(scale - parsed.scale);
    const right = parsed.negative ? -magnitude : magnitude;
    return left === right ? 0 : left > right ? 1 : -1;
  }
}

/**
 * Emit a finding about rows whose reconciliation key is incomplete.
 *
 * @param {EngineContext} context engine context.
 * @param {'left'|'right'} side side.
 * @param {{rowNumber: number, columns: string[]}[]} blank blank key rows.
 */
function reportBlankKeys(context, side, blank) {
  for (const entry of blank) {
    context.stats.blankKeys += 1;
    context.emit({
      kind: 'blank-key',
      side,
      message: `主键字段为空，无法参与核对：${entry.columns.join('、')}`,
      keys: Object.fromEntries(entry.columns.map((column) => [column, null])),
      values: null,
      leftRows: side === 'left' ? [entry.rowNumber] : [],
      rightRows: side === 'right' ? [entry.rowNumber] : [],
    });
  }
}

/**
 * Group rows by a set of mapped columns.
 *
 * @param {import('./dataset.js').Dataset} dataset dataset.
 * @param {{left: string, right: string}[]} pairs group mapping.
 * @param {'left'|'right'} side side.
 * @param {object} options rule options.
 * @returns {{order: string[], groups: Map<string, {parts: Record<string, string|null>, rows: {row: object, rowNumber: number}[]}>}} groups.
 */
function groupRows(dataset, pairs, side, options) {
  const groups = new Map();
  const order = [];
  dataset.rows.forEach((row, position) => {
    const parts = {};
    for (const pair of pairs) {
      const column = side === 'left' ? pair.left : pair.right;
      parts[pair.left] = isBlank(row[column]) ? null : normalizeText(row[column], options);
    }
    const key = JSON.stringify(parts);
    if (!groups.has(key)) {
      groups.set(key, {parts, rows: []});
      order.push(key);
    }
    groups.get(key).rows.push({row, rowNumber: dataset.rowNumbers[position] ?? position + 1});
  });
  return {order, groups};
}

/**
 * `total`: compare record counts, amount totals, and per-category aggregates.
 *
 * @param {EngineContext} context engine context.
 */
function runTotal(context) {
  const {rule, left, right, options, stats} = context;
  if (right === null) throw new Error('总量核对需要左右两个数据源。');
  const groupBy = rule.groupBy ?? [];
  // Validate every mapped column before aggregating: a typo used to produce a
  // silently blank total (and a false exception) instead of an input error.
  if (groupBy.length > 0) {
    assertColumns(left, groupBy.map((group) => group.left), '左侧');
    assertColumns(right, groupBy.map((group) => group.right ?? group.left), '右侧');
  }
  const fields = rule.fields ?? [];
  assertColumns(left, fields.map((field) => field.left), '左侧');
  assertColumns(right, fields.map((field) => field.right ?? field.left), '右侧');
  const leftGroups = groupRows(left, groupBy, 'left', options);
  const rightGroups = groupRows(right, groupBy, 'right', options);
  const leftKeys = leftGroups.order;
  const seen = new Set(leftKeys);
  const allKeys = [...leftKeys, ...rightGroups.order.filter((key) => !seen.has(key))];
  for (const key of allKeys) {
    const leftGroup = leftGroups.groups.get(key);
    const rightGroup = rightGroups.groups.get(key);
    const leftCount = leftGroup?.rows.length ?? 0;
    const rightCount = rightGroup?.rows.length ?? 0;
    const leftParts = leftGroup?.parts ?? rightGroup?.parts ?? {};
    stats.groupsCompared += 1;
    let differs = leftCount !== rightCount;
    /** @type {Record<string, {left: string|null, right: string|null}>} */
    const values = {};
    if (leftCount !== rightCount) {
      values['记录数'] = {left: String(leftCount), right: String(rightCount)};
    }
    for (const field of rule.fields ?? []) {
      const label = field.label ?? field.left;
      const leftSum = new DecimalAccumulator();
      const rightSum = new DecimalAccumulator();
      for (const entry of leftGroup?.rows ?? []) leftSum.add(entry.row[field.left]);
      for (const entry of rightGroup?.rows ?? []) rightSum.add(entry.row[field.right ?? field.left]);
      const leftText = leftSum.text();
      const rightText = rightSum.text();
      values[label] = {left: leftText, right: rightText};
      if (leftSum.compareTo(rightText) !== 0) differs = true;
      const nonNumeric =
        (leftGroup?.rows.length ?? 0) - leftSum.count + ((rightGroup?.rows.length ?? 0) - rightSum.count);
      if (nonNumeric > 0) {
        context.warnings.push(`分组 ${JSON.stringify(leftParts)} 的字段「${label}」有 ${nonNumeric} 个非数值单元格，未计入合计。`);
      }
    }
    if (differs) {
      stats.totalMismatches += 1;
      context.emit({
        kind: groupBy.length === 0 ? 'total-mismatch' : 'group-mismatch',
        side: 'both',
        message:
          groupBy.length === 0
            ? `总量不一致：记录数 左 ${leftCount} / 右 ${rightCount}`
            : `分组 ${groupBy.map((group) => `${group.left}=${leftParts[group.left] ?? '∅'}`).join('，')} 合计不一致`,
        keys: leftParts,
        values,
        leftRows: (leftGroup?.rows ?? []).map((entry) => entry.rowNumber).slice(0, 50),
        rightRows: (rightGroup?.rows ?? []).map((entry) => entry.rowNumber).slice(0, 50),
      });
    }
  }
  stats.leftRows = left.rowCount;
  stats.rightRows = right.rowCount;
}

/**
 * `match` / `field` / `history`: compare mapped fields on keyed row pairs.
 *
 * @param {EngineContext} context engine context.
 */
function runFieldCompare(context) {
  const {rule, left, right, options, stats} = context;
  if (right === null) throw new Error(`${rule.kind} 需要左右两个数据源。`);
  const pairs = keyPairsOf(rule);
  assertColumns(left, referencedColumns({key: rule.key}, 'left'), '左侧');
  assertColumns(right, referencedColumns({key: rule.key}, 'right'), '右侧');
  assertColumns(left, (rule.fields ?? []).map((field) => field.left), '左侧');
  assertColumns(right, (rule.fields ?? []).map((field) => field.right ?? field.left), '右侧');
  const leftIndex = indexByKey(left, pairs, 'left', options);
  const rightIndex = indexByKey(right, pairs, 'right', options);
  reportBlankKeys(context, 'left', leftIndex.blank);
  reportBlankKeys(context, 'right', rightIndex.blank);
  stats.leftDistinctKeys = leftIndex.index.size;
  stats.rightDistinctKeys = rightIndex.index.size;
  let unmatchedLeft = 0;
  let unmatchedRight = 0;
  for (const [key, rightEntries] of rightIndex.index) {
    const leftEntries = leftIndex.index.get(key);
    if (leftEntries === undefined) {
      unmatchedRight += rightEntries.length;
      continue;
    }
    const paired = Math.min(leftEntries.length, rightEntries.length);
    for (let index = 0; index < paired; index += 1) {
      const leftEntry = leftEntries[index];
      const rightEntry = rightEntries[index];
      stats.matchedRows += 1;
      for (const field of rule.fields) {
        const comparison = compareField(leftEntry.row, rightEntry.row, field, options);
        if (comparison.equal) continue;
        stats.fieldDifferences += 1;
        const label = field.label ?? field.left;
        context.emit({
          kind: rule.kind === 'history' ? 'history-change' : 'field-difference',
          side: 'both',
          message: `${rule.kind === 'history' ? '历史记录变化' : '字段不一致'}：${label}（${comparison.reason}）`,
          keys: keyOf(leftEntry.row, pairs, 'left', options).parts,
          values: {[label]: {left: comparison.left, right: comparison.right, reason: comparison.reason}},
          leftRows: [leftEntry.rowNumber],
          rightRows: [rightEntry.rowNumber],
        });
      }
    }
    if (leftEntries.length !== rightEntries.length) {
      stats.multiplicity += Math.abs(leftEntries.length - rightEntries.length);
    }
  }
  for (const [key, leftEntries] of leftIndex.index) {
    if (!rightIndex.index.has(key)) unmatchedLeft += leftEntries.length;
  }
  stats.unmatchedLeft = unmatchedLeft;
  stats.unmatchedRight = unmatchedRight;
  if (unmatchedLeft + unmatchedRight > 0) {
    context.warnings.push(
      `有 ${unmatchedLeft} 条左侧记录和 ${unmatchedRight} 条右侧记录未配对，本规则只比较双方都存在的记录；缺失检查请使用「缺失检查」规则。`,
    );
  }
  if (stats.multiplicity > 0) {
    context.warnings.push(`存在主键重复，${stats.multiplicity} 条记录未参与字段比较；请另用「重复检查」规则。`);
  }
}

/**
 * `missing`: report keys that exist on only one side.
 *
 * @param {EngineContext} context engine context.
 */
function runMissing(context) {
  const {rule, left, right, options, stats} = context;
  if (right === null) throw new Error('缺失检查需要左右两个数据源。');
  const pairs = keyPairsOf(rule);
  const leftIndex = indexByKey(left, pairs, 'left', options);
  const rightIndex = indexByKey(right, pairs, 'right', options);
  reportBlankKeys(context, 'left', leftIndex.blank);
  reportBlankKeys(context, 'right', rightIndex.blank);
  for (const [key, entries] of leftIndex.index) {
    if (rightIndex.index.has(key)) continue;
    const parts = keyOf(entries[0].row, pairs, 'left', options).parts;
    stats.missingRight += entries.length;
    context.emit({
      kind: 'missing-right',
      side: 'left',
      message: `仅左侧存在（右侧缺失 ${entries.length} 条）：${Object.values(parts).join(' / ')}`,
      keys: parts,
      values: null,
      leftRows: entries.map((entry) => entry.rowNumber),
      rightRows: [],
    });
  }
  for (const [key, entries] of rightIndex.index) {
    if (leftIndex.index.has(key)) continue;
    const parts = keyOf(entries[0].row, pairs, 'right', options).parts;
    stats.missingLeft += entries.length;
    context.emit({
      kind: 'missing-left',
      side: 'right',
      message: `仅右侧存在（左侧缺失 ${entries.length} 条）：${Object.values(parts).join(' / ')}`,
      keys: parts,
      values: null,
      leftRows: [],
      rightRows: entries.map((entry) => entry.rowNumber),
    });
  }
}

/**
 * `duplicate`: report repeated reconciliation keys per side.
 *
 * @param {EngineContext} context engine context.
 */
function runDuplicate(context) {
  const {rule, left, right, options, stats} = context;
  const pairs = keyPairsOf(rule);
  const sides = [['left', left]];
  if (right !== null) sides.push(['right', right]);
  for (const [side, dataset] of sides) {
    const index = indexByKey(dataset, pairs, side, options);
    reportBlankKeys(context, side, index.blank);
    for (const [key, entries] of index.index) {
      if (entries.length < 2) continue;
      const parts = keyOf(entries[0].row, pairs, side, options).parts;
      stats.duplicates += entries.length;
      context.emit({
        kind: `duplicate-${side}`,
        side,
        message: `${side === 'left' ? '左侧' : '右侧'}主键重复 ${entries.length} 次：${Object.values(parts).join(' / ')}`,
        keys: parts,
        values: {'重复次数': {left: side === 'left' ? String(entries.length) : null, right: side === 'right' ? String(entries.length) : null}},
        leftRows: side === 'left' ? entries.map((entry) => entry.rowNumber) : [],
        rightRows: side === 'right' ? entries.map((entry) => entry.rowNumber) : [],
      });
    }
  }
}

/**
 * `required`: report blank values in required columns.
 *
 * @param {EngineContext} context engine context.
 */
function runRequired(context) {
  const {rule, left, stats} = context;
  const columns = (rule.fields ?? []).map((field) => field.left);
  const selected = columns.length > 0 ? columns : (rule.left.dataset.columns ?? left.columns);
  assertColumns(left, selected, '');
  left.rows.forEach((row, position) => {
    for (const column of selected) {
      if (!isBlank(row[column])) continue;
      stats.requiredBlank += 1;
      context.emit({
        kind: 'required-blank',
        side: 'left',
        message: `关键字段为空：${column}`,
        keys: {[column]: null},
        values: {[column]: {left: null, right: undefined}},
        leftRows: [left.rowNumbers[position] ?? position + 1],
        rightRows: [],
      });
    }
  });
}

/**
 * `referential`: report child rows whose parent key is absent.
 *
 * @param {EngineContext} context engine context.
 */
function runReferential(context) {
  const {rule, left, right, options, stats} = context;
  if (right === null) throw new Error('关联完整性检查需要左侧子表与右侧主表。');
  const pairs = keyPairsOf(rule);
  const childIndex = indexByKey(left, pairs, 'left', options);
  const parentIndex = indexByKey(right, pairs, 'right', options);
  reportBlankKeys(context, 'left', childIndex.blank);
  for (const [key, entries] of childIndex.index) {
    if (parentIndex.index.has(key)) continue;
    const parts = keyOf(entries[0].row, pairs, 'left', options).parts;
    stats.orphans += entries.length;
    context.emit({
      kind: 'orphan',
      side: 'left',
      message: `孤立记录：主表中不存在对应键 ${Object.values(parts).join(' / ')}`,
      keys: parts,
      values: null,
      leftRows: entries.map((entry) => entry.rowNumber),
      rightRows: [],
    });
  }
}

/**
 * `time`: report rows violating an explicit time condition.
 *
 * Semantics (the condition describes the *finding*):
 *   before        value < referenceValue
 *   after         value > referenceValue
 *   within-days   |value - reference| > days
 *   order         value > referenceColumn  (for example 审批时间 晚于 实施时间)
 *
 * @param {EngineContext} context engine context.
 */
function runTime(context) {
  const {rule, left, options, stats} = context;
  const config = rule.time;
  assertColumns(left, [config.column, config.referenceColumn].filter(Boolean), '');
  const referenceParsed = config.referenceValue === undefined ? null : parseDateTime(config.referenceValue, options.dateFormats);
  if (config.referenceValue !== undefined && referenceParsed === null) {
    throw new Error(`time.referenceValue 无法解析为时间：${config.referenceValue}`);
  }
  const constantReference = referenceParsed === null ? null : referenceParsed.epochMs;
  left.rows.forEach((row, position) => {
    const rowNumber = left.rowNumbers[position] ?? position + 1;
    const actual = parseDateTime(row[config.column], options.dateFormats);
    if (actual === null) {
      stats.unparseableDates += 1;
      context.emit({
        kind: 'unparseable-date',
        side: 'left',
        message: `时间无法解析：${config.column}=${row[config.column] ?? '空'}`,
        keys: {[config.column]: row[config.column] ?? null},
        values: {[config.column]: {left: row[config.column] ?? null, right: null}},
        leftRows: [rowNumber],
        rightRows: [],
      });
      return;
    }
    let reference = constantReference;
    if (config.op === 'order') {
      const parsedReference = parseDateTime(row[config.referenceColumn], options.dateFormats);
      if (parsedReference === null) {
        stats.unparseableDates += 1;
        context.emit({
          kind: 'unparseable-date',
          side: 'left',
          message: `参考时间无法解析：${config.referenceColumn}=${row[config.referenceColumn] ?? '空'}`,
          keys: {[config.referenceColumn]: row[config.referenceColumn] ?? null},
          values: {[config.referenceColumn]: {left: row[config.referenceColumn] ?? null, right: null}},
          leftRows: [rowNumber],
          rightRows: [],
        });
        return;
      }
      reference = parsedReference.epochMs;
    }
    let violated = false;
    if (config.op === 'before') violated = reference !== null && actual.epochMs < reference;
    else if (config.op === 'after') violated = reference !== null && actual.epochMs > reference;
    else if (config.op === 'within-days') {
      violated = reference !== null && Math.abs(actual.epochMs - reference) > config.days * 86_400_000;
    } else if (config.op === 'order') violated = reference !== null && actual.epochMs > reference;
    if (!violated) return;
    stats.timeViolations += 1;
    context.emit({
      kind: 'time-violation',
      side: 'left',
      message: `时间条件不满足：${config.label ?? config.column}`,
      keys: {[config.column]: row[config.column] ?? null},
      values: {
        [config.column]: {
          left: new Date(actual.epochMs).toISOString(),
          right: reference === null ? null : new Date(reference).toISOString(),
        },
      },
      leftRows: [rowNumber],
      rightRows: [],
    });
  });
}

/**
 * `threshold`: report an explicit aggregate threshold violation.
 *
 * The threshold describes the *finding*: `count > 100` reports when the count
 * exceeds 100.
 *
 * @param {EngineContext} context engine context.
 */
function runThreshold(context) {
  const {rule, left, options, stats} = context;
  const threshold = rule.threshold;
  if (threshold.column !== undefined) assertColumns(left, [threshold.column], '');
  let actual;
  /** @type {string|null} */
  let actualText = null;
  if (threshold.aggregate === 'count') {
    actual = left.rowCount;
    actualText = String(actual);
  } else if (threshold.aggregate === 'distinct') {
    const set = new Set();
    for (const row of left.rows) if (!isBlank(row[threshold.column])) set.add(normalizeText(row[threshold.column], options));
    actual = set.size;
    actualText = String(actual);
  } else {
    const accumulator = new DecimalAccumulator();
    let numericCount = 0;
    for (const entry of left.rows) {
      if (accumulator.add(entry[threshold.column])) numericCount += 1;
    }
    if (numericCount === 0) {
      context.warnings.push(`阈值检查的列「${threshold.column}」没有可解析的数值。`);
      stats.thresholdViolations = 0;
      return;
    }
    if (threshold.aggregate === 'sum' || threshold.aggregate === 'avg') {
      actualText = accumulator.text();
      if (threshold.aggregate === 'avg') {
        // Keep six fractional digits for an average; the threshold check uses
        // this same rounded value so the receipt and the decision agree.
        const scaled = Number(accumulator.text()) / numericCount;
        actual = scaled;
        actualText = scaled.toFixed(6);
      } else {
        actual = Number(actualText);
      }
    } else {
      let extreme = null;
      const current = new DecimalAccumulator();
      for (const entry of left.rows) {
        const candidate = entry[threshold.column];
        if (isBlank(candidate) || parseDecimal(candidate) === null) continue;
        if (extreme === null) {
          extreme = candidate;
          current.add(candidate);
          continue;
        }
        const comparison = current.compareTo(candidate);
        if ((threshold.aggregate === 'min' && comparison > 0) || (threshold.aggregate === 'max' && comparison < 0)) {
          extreme = candidate;
          current.reset();
          current.add(candidate);
        }
      }
      actual = extreme === null ? 0 : Number(extreme);
      actualText = extreme ?? '0';
    }
  }
  const target = typeof threshold.value === 'string' ? Number(threshold.value) : threshold.value;
  if (!Number.isFinite(target)) throw new Error(`threshold.value 不是有效数字：${threshold.value}`);
  const violated =
    threshold.op === 'gt' ? actual > target
      : threshold.op === 'gte' ? actual >= target
        : threshold.op === 'lt' ? actual < target
          : threshold.op === 'lte' ? actual <= target
            : actual === target;
  if (!violated) return;
  stats.thresholdViolations += 1;
  context.emit({
    kind: 'threshold-violation',
    side: 'left',
    message: `${threshold.label ?? `${threshold.aggregate}(${threshold.column ?? '*'})`} = ${actualText}，触发阈值 ${threshold.op} ${target}`,
    keys: {aggregate: threshold.aggregate, column: threshold.column ?? null},
    values: {实际值: {left: actualText, right: String(target)}},
    leftRows: [],
    rightRows: [],
  });
}

/** Handler registry. */
export const KIND_HANDLERS = Object.freeze({
  total: runTotal,
  match: runFieldCompare,
  field: runFieldCompare,
  history: runFieldCompare,
  missing: runMissing,
  duplicate: runDuplicate,
  required: runRequired,
  referential: runReferential,
  time: runTime,
  threshold: runThreshold,
});
