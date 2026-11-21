/**
 * 文本日志读取：命名组正则提取，或按分隔符切分列。
 *
 * 日志文件是分析里最「自由」的数据源，也是最容易把模型带偏的数据源。
 * 因此这里的约束是硬的：
 * - 正则只来自声明式配置，用 `new RegExp(regex, flags)` 构造，绝不 `eval`；
 * - 正则源码长度上限 500；
 * - 拒绝 `(a+)+` 这类嵌套量词模式，避免灾难性回溯把进程钉死；
 * - 不匹配的行记 issue 并跳过，而不是让整份日志解析失败。
 *
 * @module src/formats/textlog
 */

import {inferKind} from '../core/value.js';

/** 默认行数上限，与契约第 2 节一致。 */
export const DEFAULT_MAX_ROWS = 200000;

/** 正则源码长度上限。 */
export const MAX_PATTERN_LENGTH = 500;

/** 允许的正则标志：g / y 会带来 lastIndex 状态残留，直接拒绝。 */
const ALLOWED_FLAGS = new Set(['d', 'i', 'm', 's', 'u', 'v']);

/** 每列最多参与 kind 推断的样本行数。 */
const KIND_SAMPLE_LIMIT = 500;

/** 单个文件最多记录的 issue 条数。 */
const MAX_ISSUES = 1000;

/**
 * 解析文本日志为统一表格结构。
 *
 * @param {string} text 已解码的文本。
 * @param {{
 *   pattern?: {regex: string, flags?: string}|RegExp|null,
 *   delimiter?: string|null, maxRows?: number, rowOffset?: number,
 *   encoding?: string|null,
 * }} [options] 解析选项。
 *   - `pattern`：`{regex, flags}`，命名组即列名。
 *   - `delimiter`：无 pattern 时的切分符；缺省按空白切分。
 *   - `maxRows`：数据行上限，超出置 `meta.truncated`。
 *   - `rowOffset`：文本之前已读取的物理行数，用于保持原始行号。
 *   - `encoding`：实际编码，仅写进 `meta`。
 * @returns {import('./index.js').ParsedTable} 解析结果。
 * @throws {TypeError} text 不是字符串时抛出。
 * @throws {Error} pattern 非法、过长或含嵌套量词时抛出。
 */
export function parseTextLog(text, options = {}) {
  if (typeof text !== 'string') throw new TypeError('parseTextLog 需要字符串文本');
  const maxRows = normalizeMaxRows(options.maxRows);
  const rowOffset = normalizeRowOffset(options.rowOffset);
  const delimiter = typeof options.delimiter === 'string' && options.delimiter !== '' ? options.delimiter : null;
  const pattern = options.pattern === undefined || options.pattern === null ? null : compileGuardedPattern(options.pattern);
  const source = normalizeSource(text);
  const issueLog = createIssueLog();

  /** @type {{cells: (string|null)[], line: number}[]} 先收单元格，列名最后统一决定。 */
  const entries = [];
  let maxCells = 0;
  let truncated = false;

  const lines = source.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1 + rowOffset;
    const line = lines[index];
    if (line.trim() === '') continue; // 空行跳过，但不打乱原始行号

    let cells;
    if (pattern !== null) {
      const match = pattern.regexp.exec(line);
      if (match === null) {
        issueLog.push({row: lineNumber, message: '该行不匹配配置的日志正则，已跳过'});
        continue;
      }
      cells = pattern.names === null
        ? match.slice(1).map((value) => value ?? null)
        : pattern.names.map((name) => match.groups[name] ?? null);
    } else {
      cells = delimiter === null ? line.trim().split(/\s+/) : line.split(delimiter);
    }

    if (entries.length >= maxRows) {
      truncated = true;
      break;
    }
    entries.push({cells, line: lineNumber});
    if (cells.length > maxCells) maxCells = cells.length;
  }

  const columns = pattern !== null && pattern.names !== null
    ? [...pattern.names]
    : Array.from({length: maxCells}, (_, position) => `column_${position + 1}`);
  const rows = entries.map((entry) => buildRow(columns, entry.cells));
  const rowNumbers = entries.map((entry) => entry.line);

  return {
    columns,
    fields: buildFields(columns, rows),
    rows,
    rowNumbers,
    issues: issueLog.finish(),
    meta: {
      format: 'text',
      sheet: null,
      encoding: typeof options.encoding === 'string' && options.encoding !== '' ? options.encoding : null,
      delimiter,
      rowCount: rows.length,
      truncated,
      formulaCells: 0,
      uncomputableCells: 0,
    },
  };
}

/**
 * 把一段文本编译成受限正则；长度、标志、嵌套量词都在这里把关。
 *
 * @param {RegExp|{regex: string, flags?: string}} pattern 配置的模式。
 * @returns {{regexp: RegExp, names: string[]|null}} 编译结果与命名组顺序。
 * @throws {Error} 模式不合法时抛出。
 */
export function compileGuardedPattern(pattern) {
  if (pattern instanceof RegExp) {
    if (pattern.source.length > MAX_PATTERN_LENGTH) {
      throw new Error(`日志正则过长（${pattern.source.length} > ${MAX_PATTERN_LENGTH}），请拆分成更简单的模式`);
    }
    if (pattern.flags.includes('g') || pattern.flags.includes('y')) {
      throw new Error('日志正则不允许使用 g / y 标志（会造成跨行状态残留）');
    }
    assertNoNestedQuantifier(pattern.source);
    return {regexp: pattern, names: namedGroupNames(pattern.source)};
  }
  if (pattern === null || typeof pattern !== 'object') throw new TypeError('textPattern 需要 {regex, flags} 形式');
  const source = pattern.regex;
  const flags = pattern.flags === undefined || pattern.flags === null ? '' : String(pattern.flags);
  if (typeof source !== 'string' || source === '') throw new TypeError('textPattern.regex 必须是非空字符串');
  if (source.length > MAX_PATTERN_LENGTH) {
    throw new Error(`日志正则过长（${source.length} > ${MAX_PATTERN_LENGTH}），请拆分成更简单的模式`);
  }
  const invalidFlag = [...flags].find((flag) => !ALLOWED_FLAGS.has(flag));
  if (invalidFlag !== undefined) throw new Error(`日志正则使用了不支持的标志：${invalidFlag}`);
  assertNoNestedQuantifier(source);
  let regexp;
  try {
    regexp = new RegExp(source, flags);
  } catch (error) {
    throw new Error(`日志正则无法编译：${error instanceof Error ? error.message : String(error)}`);
  }
  return {regexp, names: namedGroupNames(source)};
}

/**
 * 从正则源码里读出命名组顺序（`(?<name>` 的出现顺序）。
 *
 * @param {string} source 正则源码。
 * @returns {string[]|null} 命名组顺序；没有命名组时返回 null。
 */
function namedGroupNames(source) {
  const names = [];
  const regexp = /\(\?<([A-Za-z_$][A-Za-z0-9_$]*)>/g;
  let match;
  while ((match = regexp.exec(source)) !== null) names.push(match[1]);
  return names.length > 0 ? names : null;
}

/**
 * 拒绝嵌套量词模式（如 `(a+)+`、`(.*)*`），它们是灾难性回溯的典型来源。
 *
 * 只把无界量词（`+`、`*`、`{n,}`）当作风险来源：`(\\d{2})+` 这类有界重复
 * 每轮消费固定长度，不会指数爆炸，因此不误伤。
 *
 * @param {string} source 正则源码。
 * @returns {void}
 * @throws {Error} 发现可疑嵌套量词时抛出。
 */
function assertNoNestedQuantifier(source) {
  const stack = [];
  let inClass = false;
  let escaped = false;
  let lastClosedGroupHadUnboundedQuantifier = false;
  let lastTokenWasGroupClose = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (escaped) {
      escaped = false;
      lastTokenWasGroupClose = false;
      continue;
    }
    if (character === '\\') {
      escaped = true;
      lastTokenWasGroupClose = false;
      continue;
    }
    if (inClass) {
      if (character === ']') inClass = false;
      continue;
    }
    if (character === '[') {
      inClass = true;
      lastTokenWasGroupClose = false;
      continue;
    }
    if (character === '(') {
      stack.push({unbounded: false});
      lastTokenWasGroupClose = false;
      continue;
    }
    if (character === ')') {
      const frame = stack.pop() ?? {unbounded: false};
      lastClosedGroupHadUnboundedQuantifier = frame.unbounded;
      lastTokenWasGroupClose = true;
      continue;
    }
    if (character === '+' || character === '*') {
      if (character === '+' && source[index - 1] === '(') {
        // `(?<name>` 等组标志，不是量词。
        lastTokenWasGroupClose = false;
        continue;
      }
      if (lastTokenWasGroupClose && lastClosedGroupHadUnboundedQuantifier) throwNestedError(source, index);
      if (stack.length > 0) stack[stack.length - 1].unbounded = true;
      lastTokenWasGroupClose = false;
      continue;
    }
    if (character === '{') {
      const quantifier = /^\{\d+(?:,)?\d*\}/.exec(source.slice(index));
      if (quantifier !== null) {
        const unbounded = quantifier[0].includes(',');
        if (unbounded && lastTokenWasGroupClose && lastClosedGroupHadUnboundedQuantifier) throwNestedError(source, index);
        if (unbounded && stack.length > 0) stack[stack.length - 1].unbounded = true;
        index += quantifier[0].length - 1;
        lastTokenWasGroupClose = false;
        continue;
      }
      lastTokenWasGroupClose = false;
      continue;
    }
    lastTokenWasGroupClose = false;
  }
}

/**
 * 抛出带位置信息的嵌套量词错误。
 *
 * @param {string} source 正则源码。
 * @param {number} index 触发位置。
 * @returns {never} 总是抛出。
 */
function throwNestedError(source, index) {
  throw new Error(
    `日志正则疑似包含嵌套量词（位置 ${index}），可能触发灾难性回溯，已拒绝：${source.slice(0, 120)}`,
  );
}

/**
 * 把文本归一为 LF 换行并去掉可能残留的 BOM。
 *
 * @param {string} text 原始文本。
 * @returns {string} 归一后的文本。
 */
function normalizeSource(text) {
  const withoutBom = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  return withoutBom.replace(/\r\n?/g, '\n');
}

/**
 * 规范化 `maxRows`。
 *
 * @param {unknown} value 调用方传入的上限。
 * @returns {number} 正整数上限。
 */
function normalizeMaxRows(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_MAX_ROWS;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MAX_ROWS;
  return Math.floor(parsed);
}

/**
 * 规范化行号偏移量。
 *
 * @param {unknown} value 调用方传入的偏移。
 * @returns {number} 非负整数偏移。
 */
function normalizeRowOffset(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

/**
 * 写一个自有属性，避免列名 `__proto__` 改写对象原型。
 *
 * @param {Record<string, unknown>} target 目标行对象。
 * @param {string} key 列名。
 * @param {unknown} value 单元格值。
 * @returns {void}
 */
function setOwn(target, key, value) {
  if (key === '__proto__') {
    Object.defineProperty(target, key, {value, enumerable: true, writable: true, configurable: true});
    return;
  }
  target[key] = value;
}

/**
 * 按列名把一组单元格组装成行对象；缺列补 null。
 *
 * @param {string[]} columns 列名。
 * @param {(string|null)[]} cells 单元格。
 * @returns {Record<string, string|null>} 行对象。
 */
function buildRow(columns, cells) {
  const row = {};
  for (let index = 0; index < columns.length; index += 1) {
    setOwn(row, columns[index], index < cells.length ? cells[index] ?? null : null);
  }
  return row;
}

/**
 * 创建有上限的 issue 收集器。
 *
 * @param {number} [limit] 逐条记录的上限。
 * @returns {{issues: object[], push: (issue: object) => void, finish: () => object[]}} 收集器。
 */
function createIssueLog(limit = MAX_ISSUES) {
  const issues = [];
  let omitted = 0;
  return {
    issues,
    push(issue) {
      if (issues.length < limit) issues.push(issue);
      else omitted += 1;
    },
    finish() {
      if (omitted > 0) {
        issues.push({row: 0, message: `另有 ${omitted} 条同类解析问题因数量上限未逐条记录`});
      }
      return issues;
    },
  };
}

/**
 * 用 `inferKind` 推断每列的值类型。
 *
 * @param {string[]} columns 列名。
 * @param {Record<string, string|null>[]} rows 数据行。
 * @returns {{name: string, kind: string}[]} 字段描述。
 */
function buildFields(columns, rows) {
  const sample = rows.slice(0, KIND_SAMPLE_LIMIT);
  return columns.map((name) => ({name, kind: inferKind(sample.map((row) => row[name]))}));
}
