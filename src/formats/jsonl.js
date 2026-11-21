/**
 * JSON / JSONL 读取：顶层数组、单对象、逐行解析，列取首次出现顺序的并集。
 *
 * 数字保真是这里的重点：`JSON.parse` 会先把 `1.10` 变成 `1.1`、把超长整数截成
 * 双精度值。Node 的 `JSON.parse` 提供了 reviver 的 `context.source`，可以在不
 * 自己写扫描器的前提下拿到数字的原始字面量，因此 `1.10`、`12345678901234567890`
 * 都按文件里的写法输出。
 *
 * @module src/formats/jsonl
 */

import {inferKind} from '../core/value.js';

/** 默认行数上限，与契约第 2 节一致。 */
export const DEFAULT_MAX_ROWS = 200000;

/** 每列最多参与 kind 推断的样本行数。 */
const KIND_SAMPLE_LIMIT = 500;

/** 单个文件最多记录的 issue 条数。 */
const MAX_ISSUES = 1000;

/** 「嵌套值已字符串化」issue 的条数上限（契约第 5 节）。 */
const MAX_NESTED_ISSUES = 20;

/**
 * 数字字面量包装：只在进程内流转，保证输出时仍是文件里的原始写法。
 *
 * @private
 */
class RawNumber {
  /**
   * @param {string} raw 数字在 JSON 里的原始字面量。
   */
  constructor(raw) {
    /** @type {string} */
    this.raw = raw;
  }
}

/**
 * 解析 JSON 文档或 JSONL 文本为统一表格结构。
 *
 * @param {string} text 已解码的文本。
 * @param {{maxRows?: number, format?: 'json'|'jsonl'|'auto', encoding?: string|null}} [options] 解析选项。
 *   - `maxRows`：数据行上限，超出置 `meta.truncated`。
 *   - `format`：`json` 整文档、`jsonl` 逐行、`auto` 先试整文档再退逐行。
 *   - `encoding`：实际编码，仅写进 `meta`。
 * @returns {import('./index.js').ParsedTable} 解析结果。
 * @throws {TypeError} text 不是字符串时抛出。
 */
export function parseJsonRecords(text, options = {}) {
  if (typeof text !== 'string') throw new TypeError('parseJsonRecords 需要字符串文本');
  const maxRows = normalizeMaxRows(options.maxRows);
  const requested = options.format === 'json' || options.format === 'jsonl' ? options.format : 'auto';
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const issueLog = createIssueLog();

  /** @type {{value: unknown, row: number}[]|null} */
  let entries = null;
  let format = 'jsonl';

  if (requested !== 'jsonl') {
    try {
      const parsed = parseJsonText(source);
      entries = toRecordEntries(parsed);
      format = 'json';
    } catch (error) {
      issueLog.push({
        row: 1,
        message: `JSON 文档解析失败，按 JSONL 逐行重试：${errorMessage(error)}`,
      });
      entries = null;
    }
  }

  if (entries === null) {
    entries = parseJsonLines(source, issueLog);
    format = 'jsonl';
  }

  const columns = [];
  const seen = new Set();
  const records = entries.map((entry) => {
    const record = normalizeRecord(entry.value, entry.row, issueLog);
    for (const key of Object.keys(record)) {
      if (!seen.has(key)) {
        seen.add(key);
        columns.push(key);
      }
    }
    return {record, row: entry.row};
  });

  const rows = [];
  const rowNumbers = [];
  const nestedIssued = new Set();
  let nestedIssues = 0;
  let truncated = false;
  /** 嵌套值的上报状态：同一列只报第一次，总数不超过 20 条。 */
  const nested = {
    report(column, row) {
      if (nestedIssues >= MAX_NESTED_ISSUES) return;
      if (nestedIssued.has(column)) return;
      nestedIssued.add(column);
      nestedIssues += 1;
      issueLog.push({row, column, message: '该列存在嵌套对象/数组，已字符串化为 JSON 文本'});
    },
  };

  for (const item of records) {
    if (rows.length >= maxRows) {
      truncated = true;
      break;
    }
    const row = {};
    for (const column of columns) {
      const present = Object.prototype.hasOwnProperty.call(item.record, column);
      setOwn(row, column, present ? cellOf(item.record[column], column, item.row, nested) : null);
    }
    rows.push(row);
    rowNumbers.push(item.row);
  }

  return {
    columns,
    fields: buildFields(columns, rows),
    rows,
    rowNumbers,
    issues: issueLog.finish(),
    meta: {
      format,
      sheet: null,
      encoding: typeof options.encoding === 'string' && options.encoding !== '' ? options.encoding : null,
      delimiter: null,
      rowCount: rows.length,
      truncated,
      formulaCells: 0,
      uncomputableCells: 0,
    },
  };
}

/**
 * 用 reviver 的 `context.source` 保留数字原始字面量。
 *
 * 运行环境若不支持 `context.source`（旧版 Node），退化为普通 `JSON.parse`，
 * 数字会按 `String(number)` 输出——这是可接受的降级，但会丢尾数。
 *
 * @param {string} text JSON 文本。
 * @returns {unknown} 解析结果，数字为 {@link RawNumber}。
 * @throws {SyntaxError} JSON 不合法时抛出。
 */
function parseJsonText(text) {
  return JSON.parse(text, (key, value, context) => {
    void key;
    if (typeof value === 'number' && context !== undefined && typeof context.source === 'string') {
      return new RawNumber(context.source);
    }
    return value;
  });
}

/**
 * 把顶层文档拆成记录序列：数组 → 每元素；唯一数组字段的对象 → 该数组。
 *
 * @param {unknown} parsed 顶层解析结果。
 * @returns {{value: unknown, row: number}[]} 记录序列。
 */
function toRecordEntries(parsed) {
  if (Array.isArray(parsed)) return parsed.map((value, index) => ({value, row: index + 1}));
  if (parsed !== null && typeof parsed === 'object' && !(parsed instanceof RawNumber)) {
    const arrayKeys = Object.keys(parsed).filter((key) => Array.isArray(parsed[key]));
    if (arrayKeys.length === 1) {
      return parsed[arrayKeys[0]].map((value, index) => ({value, row: index + 1}));
    }
  }
  return [{value: parsed, row: 1}];
}

/**
 * 逐行解析 JSONL；坏行记 issue 并继续。
 *
 * @param {string} source 已去 BOM 的文本。
 * @param {ReturnType<typeof createIssueLog>} issueLog issue 收集器。
 * @returns {{value: unknown, row: number}[]} 记录序列。
 */
function parseJsonLines(source, issueLog) {
  const entries = [];
  const lines = source.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === '') continue;
    try {
      entries.push({value: parseJsonText(line), row: index + 1});
    } catch (error) {
      issueLog.push({row: index + 1, message: `JSON 行解析失败：${errorMessage(error)}`});
    }
  }
  return entries;
}

/**
 * 把一条记录归一为普通对象；非对象记录按单列 `value` 处理。
 *
 * @param {unknown} value 记录值。
 * @param {number} row 行号。
 * @param {ReturnType<typeof createIssueLog>} issueLog issue 收集器。
 * @returns {Record<string, unknown>} 归一后的记录对象。
 */
function normalizeRecord(value, row, issueLog) {
  if (value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof RawNumber)) {
    return value;
  }
  issueLog.push({row, message: '该记录不是 JSON 对象，已按单列 value 处理'});
  return {value};
}

/**
 * 把单个字段值转成表格单元格：字符串或 null，其余按 JSON 文本表达。
 *
 * @param {unknown} value 字段值。
 * @param {string} column 列名。
 * @param {number} row 行号。
 * @param {{report: (column: string, row: number) => void}} nested 嵌套值上报器。
 * @returns {string|null} 单元格文本。
 */
function cellOf(value, column, row, nested) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (value instanceof RawNumber) return value.raw;
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  nested.report(column, row);
  return stringifyRawJson(value);
}

/**
 * 序列化可能包含 {@link RawNumber} 的 JSON 值，保留嵌套数字的原始字面量。
 *
 * @param {unknown} value 待序列化的值。
 * @returns {string} JSON 文本。
 */
function stringifyRawJson(value) {
  if (value instanceof RawNumber) return value.raw;
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map((item) => stringifyRawJson(item)).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.keys(value).map((key) => `${JSON.stringify(key)}:${stringifyRawJson(value[key])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * 提取错误消息，避免把整个异常对象塞进 issue。
 *
 * @param {unknown} error 任意异常。
 * @returns {string} 单行消息。
 */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
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
 * 写一个自有属性，避免键名 `__proto__` 改写对象原型。
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
