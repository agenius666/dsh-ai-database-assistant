/**
 * 文件数据源统一入口：按扩展名分派到具体解析器，并统一再导出。
 *
 * 契约见 `docs/CONTRACT-FORMATS.md`。所有解析器返回同一个 `ParsedTable`，
 * 上层（服务、工具、导出）只依赖这个结构，不关心文件实际是什么格式。
 *
 * @module src/formats
 */

import {readFile} from 'node:fs/promises';
import {extname} from 'node:path';

import {DEFAULT_MAX_ROWS, decodeText, readCsvText} from './csv.js';
import {parseJsonRecords} from './jsonl.js';
import {parseTextLog} from './textlog.js';
import {readXlsx} from './xlsx.js';
import {writeXlsx} from './xlsx-write.js';

export {DEFAULT_MAX_ROWS, decodeText, parseJsonRecords, parseTextLog, readCsvText, readXlsx, writeXlsx};

/**
 * 统一解析结果。
 *
 * @typedef {Object} ParsedTable
 * @property {string[]} columns 列名，按文件顺序，已去重（重名 → `name_2`）。
 * @property {{name: string, kind: string}[]} fields 列名 + `inferKind` 推断结果。
 * @property {Record<string, string|null>[]} rows 数据行；值一律字符串或 null。
 * @property {number[]} rowNumbers 与 `rows` 等长的原始行号（1 基；XLSX 为 Excel 行号）。
 * @property {{row: number, column?: string, message: string}[]} issues 解析异常。
 * @property {ParsedMeta} meta 解析元信息。
 */

/**
 * 解析元信息。
 *
 * @typedef {Object} ParsedMeta
 * @property {string} format `csv` | `tsv` | `xlsx` | `json` | `jsonl` | `text`
 * @property {string|null} sheet 工作表名（仅 XLSX）
 * @property {string|null} encoding 实际使用的编码
 * @property {string|null} delimiter 实际使用的分隔符
 * @property {number} rowCount 数据行数
 * @property {boolean} truncated 是否因 `maxRows` 被截断
 * @property {number} formulaCells XLSX 公式单元格总数
 * @property {number} uncomputableCells XLSX 公式但无缓存值的单元格数
 */

/**
 * 读取任意受支持的文件为统一表格。
 *
 * 分派规则（契约第 2 节）：
 * - `.xlsx`：XLSX 解析器（字节级，不解码文本）；
 * - `.csv` / `.tsv`：CSV 解析器（自动编码探测、分隔符嗅探）；
 * - `.json` / `.jsonl` / `.ndjson`：JSON 解析器；
 * - `.txt` / `.log`：文本日志解析器；
 * - 其他扩展名：JSON 形态优先按 JSON 解析，否则依次尝试 csv → jsonl → text，
 *   并在 `meta.format` 写明实际使用的格式。
 *
 * @param {string} filePath 绝对路径（也接受相对当前工作目录的路径）。
 * @param {{maxRows?: number, sheet?: string, encoding?: string, delimiter?: string,
 *          textPattern?: {regex: string, flags?: string}, textDelimiter?: string}} [options] 读取选项。
 *   - `maxRows`：数据行上限，默认 200000；超出时截断并置 `meta.truncated`。
 *   - `sheet`：XLSX 工作表名；缺省取第一张。
 *   - `encoding`：强制文本编码（缺省按 BOM/严格 UTF-8/GB18030 探测）。
 *   - `delimiter`：CSV/TSV 显式分隔符。
 *   - `textPattern`：文本日志的命名组正则。
 *   - `textDelimiter`：文本日志的切分符。
 * @returns {Promise<ParsedTable>} 解析结果。
 * @throws {TypeError} 路径为空时抛出。
 * @throws {Error} 文件不存在、编码不支持、XLSX 结构损坏或工作表不存在时抛出。
 */
export async function readTableFile(filePath, options = {}) {
  if (typeof filePath !== 'string' || filePath.trim() === '') {
    throw new TypeError('readTableFile 需要一个文件路径');
  }
  const maxRows = normalizeMaxRows(options.maxRows);
  const buffer = await readFile(filePath);
  const extension = extname(filePath).toLowerCase();

  if (extension === '.xlsx') {
    return readXlsx(buffer, {sheet: options.sheet, maxRows});
  }

  const decoded = decodeWith(buffer, options.encoding);
  const text = decoded.text;
  const encoding = decoded.encoding;

  switch (extension) {
    case '.csv':
      return readCsvText(text, {delimiter: options.delimiter, maxRows, encoding});
    case '.tsv':
      return readCsvText(text, {delimiter: options.delimiter ?? '\t', maxRows, encoding});
    case '.json':
      return parseJsonRecords(text, {format: 'json', maxRows, encoding});
    case '.jsonl':
    case '.ndjson':
      return parseJsonRecords(text, {format: 'jsonl', maxRows, encoding});
    case '.txt':
    case '.log':
      return parseTextLog(text, {
        pattern: options.textPattern,
        delimiter: options.textDelimiter,
        maxRows,
        encoding,
      });
    default:
      return readUnknownExtension(text, {maxRows, encoding, options});
  }
}

/**
 * 未知扩展名的兜底分派。
 *
 * 契约要求「依次尝试 csv → jsonl → text」。这里额外加一条保护：
 * 文本明显以 `{` / `[` 开头时先试 JSON，否则 `[`、`,` 这些 JSON 语法会被
 * CSV 嗅探误判成多列数据，反而把结构化文件读成噪声。
 *
 * @param {string} text 已解码文本。
 * @param {{maxRows: number, encoding: string, options: object}} context 上下文。
 * @returns {ParsedTable} 解析结果。
 */
function readUnknownExtension(text, context) {
  const {maxRows, encoding, options} = context;

  if (/^\s*[[{]/.test(text)) {
    const json = parseJsonRecords(text, {maxRows, encoding});
    if (json.columns.length > 0) return json;
  }

  const csv = readCsvText(text, {delimiter: options.delimiter, maxRows, encoding});
  if (csv.columns.length > 1) return csv;

  const jsonl = parseJsonRecords(text, {format: 'jsonl', maxRows, encoding});
  if (jsonl.columns.length > 0) return jsonl;

  return parseTextLog(text, {
    pattern: options.textPattern,
    delimiter: options.textDelimiter,
    maxRows,
    encoding,
  });
}

/**
 * 按调用方指定的编码解码；未指定时走 BOM/UTF-8/GB18030 探测。
 *
 * @param {Buffer} buffer 文件字节。
 * @param {unknown} encoding 调用方指定的编码标签。
 * @returns {{text: string, encoding: string}} 解码文本与实际编码。
 * @throws {Error} 编码标签不受支持时抛出。
 */
function decodeWith(buffer, encoding) {
  if (typeof encoding !== 'string' || encoding.trim() === '') return decodeText(buffer);
  const label = encoding.trim();
  let decoder;
  try {
    decoder = new TextDecoder(label);
  } catch {
    throw new Error(`不支持的文本编码：${label}`);
  }
  return {text: decoder.decode(buffer), encoding: label.toLowerCase()};
}

/**
 * 规范化 `maxRows`：非法值退回默认上限。
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
