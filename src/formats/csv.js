/**
 * CSV / TSV 读取：编码探测、引号感知的分隔符嗅探、原始行号保真。
 *
 * 这是分析导入的第一道关口。所有单元格都保持文件里的原始文本：
 * 一旦让 `1.10` 或 `00123` 过一遍 `Number`，金额尾数和凭证号就会在核对之前
 * 被悄悄改写，而这种改写不会报错，只会让核对结果对不上。
 *
 * 解析过程中的异常一律进入 `issues`（行号 + 原因），绝不静默吞掉。
 *
 * @module src/formats/csv
 */

import {inferKind} from '../core/value.js';

/** 默认行数上限，与契约第 2 节一致。 */
export const DEFAULT_MAX_ROWS = 200000;

/** 嗅探分隔符时最多观察的物理行数。 */
const SNIFF_LINE_LIMIT = 20;

/** 候选分隔符，数组顺序即分数完全相同时的优先级。 */
const CANDIDATE_DELIMITERS = Object.freeze([',', ';', '\t', '|']);

/** 每列最多参与 kind 推断的样本行数。 */
const KIND_SAMPLE_LIMIT = 500;

/** 单个文件最多记录的 issue 条数，避免脏文件把内存吃光。 */
const MAX_ISSUES = 1000;

/** 「数据比表头宽」告警的上限条数。 */
const MAX_WIDTH_ISSUES = 50;

/**
 * 把二进制内容解码为文本，并如实报告实际使用的编码。
 *
 * 顺序：UTF-8 BOM → UTF-16 BOM → 严格 UTF-8 → GB18030 回退。
 * 用严格模式解码 UTF-8 是关键：宽松解码会把 GBK 字节变成一堆 U+FFFD，
 * 中文字段全部变成乱码却「看起来解析成功」。
 *
 * @param {Buffer|Uint8Array} buffer 原始字节。
 * @returns {{text: string, encoding: string}} 解码文本与实际编码。
 * @throws {TypeError} buffer 为空值或不是字节序列时抛出。
 */
export function decodeText(buffer) {
  if (buffer === null || buffer === undefined) throw new TypeError('decodeText 需要一个字节序列');
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);

  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return {text: new TextDecoder('utf-8').decode(bytes.subarray(3)), encoding: 'utf-8'};
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return {text: new TextDecoder('utf-16le').decode(bytes.subarray(2)), encoding: 'utf-16le'};
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return {text: new TextDecoder('utf-16be').decode(bytes.subarray(2)), encoding: 'utf-16be'};
  }

  try {
    const text = new TextDecoder('utf-8', {fatal: true}).decode(bytes);
    return {text, encoding: 'utf-8'};
  } catch {
    try {
      return {text: new TextDecoder('gb18030').decode(bytes), encoding: 'gb18030'};
    } catch {
      // 运行环境没有 gb18030 解码器时退回宽松 UTF-8，并把真实编码记录下来。
      return {text: new TextDecoder('utf-8').decode(bytes), encoding: 'utf-8'};
    }
  }
}

/**
 * 解析 CSV / TSV 文本为统一表格结构。
 *
 * @param {string} text 已解码的文本（可带 BOM、CRLF 或 CR 换行）。
 * @param {{
 *   delimiter?: string, maxRows?: number, rowOffset?: number,
 *   encoding?: string|null, format?: string,
 * }} [options] 解析选项。
 *   - `delimiter`：显式分隔符；缺省时自动嗅探。
 *   - `maxRows`：数据行上限，超出置 `meta.truncated`。
 *   - `rowOffset`：文本之前已经被读取的物理行数，用于保持原始行号。
 *   - `encoding`：实际编码，仅写进 `meta`（解码由调用方完成）。
 *   - `format`：覆盖 `meta.format`（默认按分隔符判定 csv/tsv）。
 * @returns {import('./index.js').ParsedTable} 解析结果。
 * @throws {TypeError} text 不是字符串时抛出。
 */
export function readCsvText(text, options = {}) {
  if (typeof text !== 'string') throw new TypeError('readCsvText 需要字符串文本');
  const maxRows = normalizeMaxRows(options.maxRows);
  const rowOffset = normalizeRowOffset(options.rowOffset);
  const source = normalizeSource(text);
  const delimiter = normalizeDelimiter(options.delimiter) ?? sniffDelimiter(source);

  const scanned = scanRecords(source, delimiter, rowOffset);
  const issueLog = scanned.issueLog;
  const header = scanned.records.length > 0 ? scanned.records[0] : null;
  const columns = buildColumnNames(header === null ? [] : header.cells);

  const rows = [];
  const rowNumbers = [];
  let truncated = false;
  let widthIssues = 0;

  for (let index = header === null ? 0 : 1; index < scanned.records.length; index += 1) {
    if (rows.length >= maxRows) {
      truncated = true;
      break;
    }
    const record = scanned.records[index];
    const row = {};
    for (let column = 0; column < columns.length; column += 1) {
      setOwn(row, columns[column], column < record.cells.length ? record.cells[column] : null);
    }
    if (record.cells.length > columns.length && widthIssues < MAX_WIDTH_ISSUES) {
      widthIssues += 1;
      issueLog.push({
        row: record.line,
        message: `该行有 ${record.cells.length} 个字段，超过表头的 ${columns.length} 个；多出的字段已忽略`,
      });
    }
    rows.push(row);
    rowNumbers.push(record.line);
  }

  return {
    columns,
    fields: buildFields(columns, rows),
    rows,
    rowNumbers,
    issues: issueLog.finish(),
    meta: {
      format: normalizeFormat(options.format, delimiter),
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
 * 规范化 `maxRows`：非法值退回默认上限，而不是让整份文件读不出来。
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
 * 规范化行号偏移量（文本之前已读取的物理行数）。
 *
 * @param {unknown} value 调用方传入的偏移。
 * @returns {number} 非负整数偏移。
 */
function normalizeRowOffset(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

/**
 * 规范化显式分隔符；允许配置里把制表符写成字面量 `\t`。
 *
 * @param {unknown} value 调用方传入的分隔符。
 * @returns {string|null} 分隔符，或 null 表示需要嗅探。
 */
function normalizeDelimiter(value) {
  if (typeof value !== 'string' || value === '') return null;
  if (value === '\\t') return '\t';
  return value;
}

/**
 * 根据分隔符推断 `meta.format`。
 *
 * @param {unknown} explicit 调用方显式指定的格式。
 * @param {string} delimiter 实际使用的分隔符。
 * @returns {string} `csv` 或 `tsv`。
 */
function normalizeFormat(explicit, delimiter) {
  if (typeof explicit === 'string' && explicit !== '') return explicit;
  return delimiter === '\t' ? 'tsv' : 'csv';
}

/**
 * 创建有上限的 issue 收集器；超限时只记一条汇总，不丢「发生过问题」这个事实。
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
 * 写一个自有属性，避免表头里的 `__proto__` 改写对象原型。
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
 * 扫描文本为记录序列，记录每条记录的起始物理行号。
 *
 * 引号字段内允许分隔符与换行；`""` 表示一个字面引号；未闭合引号在文件结尾
 * 记一条 issue 并保留已读内容，而不是让整份文件解析失败。
 *
 * @param {string} source 已归一换行的文本。
 * @param {string} delimiter 分隔符。
 * @param {number} rowOffset 行号偏移。
 * @returns {{records: {cells: string[], line: number}[], issueLog: ReturnType<typeof createIssueLog>}} 扫描结果。
 */
function scanRecords(source, delimiter, rowOffset) {
  const issueLog = createIssueLog();
  const records = [];
  const delimiterLength = delimiter.length;
  const delimiterHead = delimiter[0];
  let index = 0;
  let line = 1;
  let recordLine = 1;
  let recordCells = [];
  let cell = '';
  let inQuotes = false;
  let cellWasQuoted = false;
  let closedQuote = false;
  let quoteTailIssued = false;
  let hasContent = false;

  const endRecord = () => {
    recordCells.push(cell);
    cell = '';
    // 只有整行空才跳过；`a,,` 这类空字段的行必须保留。
    if (hasContent || recordCells.length > 1) records.push({cells: recordCells, line: recordLine + rowOffset});
    recordCells = [];
    hasContent = false;
    cellWasQuoted = false;
    closedQuote = false;
    quoteTailIssued = false;
  };

  while (index < source.length) {
    const character = source[index];

    if (inQuotes) {
      if (character === '"') {
        if (source[index + 1] === '"') {
          cell += '"';
          index += 2;
          continue;
        }
        inQuotes = false;
        closedQuote = true;
        index += 1;
        continue;
      }
      if (character === '\n') line += 1;
      cell += character;
      index += 1;
      continue;
    }

    if (character === '"' && cell === '' && !cellWasQuoted) {
      inQuotes = true;
      cellWasQuoted = true;
      closedQuote = false;
      hasContent = true;
      index += 1;
      continue;
    }

    if (character === delimiterHead && source.startsWith(delimiter, index)) {
      recordCells.push(cell);
      cell = '';
      cellWasQuoted = false;
      closedQuote = false;
      hasContent = true;
      index += delimiterLength;
      continue;
    }

    if (character === '\n') {
      endRecord();
      index += 1;
      line += 1;
      recordLine = line;
      continue;
    }

    // RFC 4180 不允许引号闭合后再出现字符；这里按字面拼接，但要留下证据。
    if (closedQuote && !quoteTailIssued && character.trim() !== '') {
      quoteTailIssued = true;
      issueLog.push({
        row: recordLine + rowOffset,
        message: '引号字段闭合后又出现字符，已按字面拼接到该字段',
      });
    }
    cell += character;
    hasContent = true;
    index += 1;
  }

  if (inQuotes) {
    // 契约要求「在该行记 issue 并继续」：把已经读到的内容交出去，同时留下证据。
    issueLog.push({
      row: recordLine + rowOffset,
      message: `引号未闭合：从第 ${recordLine + rowOffset} 行开始的引号字段直到文件结尾都没有闭合`,
    });
  }
  if (cell !== '' || recordCells.length > 0 || hasContent) endRecord();

  return {records, issueLog};
}

/**
 * 统计一行里某个候选分隔符切出的字段数。
 *
 * @param {string} line 单行文本。
 * @param {string} delimiter 候选分隔符。
 * @returns {number} 字段数；引号未闭合时返回 -1 表示该行不参与统计。
 */
function countFields(line, delimiter) {
  let count = 1;
  let inQuotes = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (inQuotes) {
      if (character === '"') {
        if (line[index + 1] === '"') index += 1;
        else inQuotes = false;
      }
      continue;
    }
    if (character === '"') {
      inQuotes = true;
      continue;
    }
    if (character === delimiter[0] && line.startsWith(delimiter, index)) {
      count += 1;
      index += delimiter.length - 1;
    }
  }
  return inQuotes ? -1 : count;
}

/**
 * 取中位数（偶数个时取偏下的那个）。
 *
 * @param {number[]} values 已排序或未排序的数值。
 * @returns {number} 中位数。
 */
function medianOf(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor((sorted.length - 1) / 2)];
}

/**
 * 嗅探分隔符：选「字段数中位数最常出现」的候选；平局时字段更多者优先。
 *
 * @param {string} source 已归一换行的文本。
 * @returns {string} 分隔符。
 */
function sniffDelimiter(source) {
  const sampleLines = source
    .split('\n')
    .filter((line) => line.trim() !== '')
    .slice(0, SNIFF_LINE_LIMIT);
  if (sampleLines.length === 0) return ',';

  let bestDelimiter = ',';
  let bestScore = -1;
  for (const delimiter of CANDIDATE_DELIMITERS) {
    const counts = [];
    for (const line of sampleLines) {
      const count = countFields(line, delimiter);
      if (count > 0) counts.push(count);
    }
    if (counts.length === 0) continue;
    const median = medianOf(counts);
    if (median <= 1) continue;
    const frequency = counts.filter((count) => count === median).length;
    const score = frequency * 1000 + Math.min(median, 999);
    if (score > bestScore) {
      bestScore = score;
      bestDelimiter = delimiter;
    }
  }
  return bestDelimiter;
}

/**
 * 由表头字段生成去重后的列名：空名 → `column_N`，重名 → `name_2`、`name_3`。
 *
 * @param {string[]} rawNames 表头原始字段。
 * @returns {string[]} 唯一列名。
 */
function buildColumnNames(rawNames) {
  const used = new Set();
  return rawNames.map((rawName, index) => {
    const trimmed = String(rawName).trim();
    const base = trimmed === '' ? `column_${index + 1}` : trimmed;
    let candidate = base;
    let suffix = 2;
    while (used.has(candidate)) {
      candidate = `${base}_${suffix}`;
      suffix += 1;
    }
    used.add(candidate);
    return candidate;
  });
}

/**
 * 用 `inferKind` 推断每列的值类型；只采样前若干个数据行，避免大文件重复扫描。
 *
 * @param {string[]} columns 列名。
 * @param {Record<string, string|null>[]} rows 数据行。
 * @returns {{name: string, kind: string}[]} 字段描述。
 */
function buildFields(columns, rows) {
  const sample = rows.slice(0, KIND_SAMPLE_LIMIT);
  return columns.map((name) => ({name, kind: inferKind(sample.map((row) => row[name]))}));
}
