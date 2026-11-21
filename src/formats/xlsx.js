/**
 * XLSX 读取：零依赖 ZIP（中央目录 + inflateRaw）与最小 XML 解析。
 *
 * 实现边界（契约第 4 节）：
 * - ZIP 只支持 store / deflate，遇到 ZIP64 或加密条目抛明确错误；
 *   条目大小一律以中央目录为准，因此「本地头写 0 + 数据描述符」的文件也能读；
 * - 单元格值保持 `<v>` 里的原始文本，绝不 `Number()` 之后再 `String()`，
 *   否则 `1.10` 会变成 `1.1`、`1e21` 会变成 `1e+21`；
 * - 日期序列按 1900 系统转换，并处理 1900-02-29 的历史 bug；
 * - 公式取缓存值；只有 `<f>` 没有 `<v>` 时值为 null 并计入 `uncomputableCells`。
 *
 * @module src/formats/xlsx
 */

import * as zlib from 'node:zlib';

import {inferKind} from '../core/value.js';

/** ZIP 本地文件头签名。 */
const LOCAL_SIGNATURE = 0x04034b50;
/** ZIP 中央目录条目签名。 */
const CENTRAL_SIGNATURE = 0x02014b50;
/** ZIP 中央目录结尾签名。 */
const EOCD_SIGNATURE = 0x06054b50;

/** ZIP 中表示「值在 ZIP64 扩展字段里」的哨兵。 */
const ZIP64_SENTINEL = 0xffffffff;
/** ZIP 中表示「条目数在 ZIP64 扩展字段里」的哨兵。 */
const ZIP64_COUNT_SENTINEL = 0xffff;

/** 默认行数上限，与契约第 2 节一致。 */
export const DEFAULT_MAX_ROWS = 200000;
/** Hard cap for one decompressed ZIP part (a "zip bomb" guard). */
export const MAX_ENTRY_BYTES = 64 * 1024 * 1024;
/** Hard cap for the decompressed total of one workbook. */
export const MAX_TOTAL_BYTES = 256 * 1024 * 1024;

/** 单表合并单元格 issue 上限（契约第 4 节）。 */
const MAX_MERGE_ISSUES = 50;

/** 单个文件最多记录的 issue 条数。 */
const MAX_ISSUES = 5000;

/** 每列最多参与 kind 推断的样本行数。 */
const KIND_SAMPLE_LIMIT = 500;

/** 内置的日期/日期时间数字格式 id（14–17，以及 22 = m/d/yy h:mm）。 */
const BUILTIN_DATE_FORMAT_IDS = new Set([14, 15, 16, 17, 22]);

/** 内置的时间数字格式 id（18–21、45–47）。 */
const BUILTIN_TIME_FORMAT_IDS = new Set([18, 19, 20, 21, 45, 46, 47]);

/** 毫秒/天。 */
const MS_PER_DAY = 86400000;

/** 1900 系统的序列号上限（9999-12-31）。 */
const MAX_EXCEL_SERIAL_1900 = 2958465;

/** 1904 系统的序列号上限（9999-12-31；两套系统相差 1462 天）。 */
const MAX_EXCEL_SERIAL_1904 = 2957003;

/**
 * 读取 XLSX 工作簿中的一张工作表。
 *
 * @param {Buffer|Uint8Array} buffer 整个 xlsx 文件的字节。
 * @param {{sheet?: string, maxRows?: number}} [options] 读取选项。
 *   - `sheet`：工作表名；缺省取第一张，指定但不存在时抛错并列出可用表名。
 *   - `maxRows`：数据行上限，超出置 `meta.truncated`。
 * @returns {import('./index.js').ParsedTable} 解析结果。
 * @throws {Error} 文件不是合法 ZIP / XLSX、工作表不存在或结构损坏时抛出。
 */
export function readXlsx(buffer, options = {}) {
  const bytes = toBuffer(buffer);
  const maxRows = normalizeMaxRows(options.maxRows);
  const zip = readZipEntries(bytes);
  const partCache = new Map();

  const readPart = (name) => {
    const entry = findEntry(zip.entries, name);
    if (entry === null) return null;
    return readEntry(bytes, entry, partCache).toString('utf8');
  };

  const workbookXml = readPart('xl/workbook.xml');
  if (workbookXml === null) throw new Error('不是有效的 XLSX：缺少 xl/workbook.xml');
  const workbook = parseWorkbook(workbookXml);
  if (workbook.sheets.length === 0) throw new Error('XLSX 工作簿里没有任何工作表');

  const relsXml = readPart('xl/_rels/workbook.xml.rels');
  const relationships = relsXml === null ? new Map() : parseRelationships(relsXml);

  const requested = typeof options.sheet === 'string' && options.sheet !== '' ? options.sheet : null;
  let sheetIndex = 0;
  if (requested !== null) {
    sheetIndex = workbook.sheets.findIndex((sheet) => sheet.name === requested);
    if (sheetIndex === -1) {
      const available = workbook.sheets.map((sheet) => `「${sheet.name}」`).join('、');
      throw new Error(`XLSX 中不存在工作表「${requested}」，可用工作表：${available}`);
    }
  }
  const sheet = workbook.sheets[sheetIndex];
  const target = resolveSheetTarget(sheet, sheetIndex, relationships);
  const sheetXml = readPart(target);
  if (sheetXml === null) throw new Error(`XLSX 中找不到工作表「${sheet.name}」的数据部件：${target}`);

  const sharedStrings = readPart('xl/sharedStrings.xml');
  const stylesXml = readPart('xl/styles.xml');
  const styleTable = stylesXml === null ? [] : parseStyles(stylesXml);

  const issueLog = createIssueLog();
  const metrics = {formulaCells: 0, uncomputableCells: 0};
  const context = {
    sharedStrings: sharedStrings === null ? [] : parseSharedStrings(sharedStrings),
    styles: styleTable,
    date1904: workbook.date1904,
    issueLog,
    metrics,
  };

  const scanned = scanSheet(sheetXml);
  const grid = buildGrid(scanned.cells, context, issueLog);
  applyMerges(scanned.merges, grid, issueLog);

  const table = buildTable(grid, {maxRows, sheetName: sheet.name, metrics, issueLog});
  return table;
}

/**
 * 把入参归一为 Buffer。
 *
 * @param {Buffer|Uint8Array|ArrayBuffer} buffer 原始字节。
 * @returns {Buffer} Buffer 视图。
 * @throws {TypeError} 入参不是字节序列时抛出。
 */
function toBuffer(buffer) {
  if (Buffer.isBuffer(buffer)) return buffer;
  if (buffer instanceof Uint8Array) return Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  if (buffer instanceof ArrayBuffer) return Buffer.from(buffer);
  throw new TypeError('readXlsx 需要 xlsx 文件的字节内容');
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

/* ------------------------------------------------------------------ *
 * ZIP
 * ------------------------------------------------------------------ */

/**
 * 解析 ZIP 的中央目录（不支持 ZIP64）。
 *
 * @param {Buffer} buffer 整个文件的字节。
 * @returns {{entries: Map<string, object>}} 条目表，键为归一后的条目名。
 * @throws {Error} 结构不合法、分卷、加密或 ZIP64 时抛出明确错误。
 */
function readZipEntries(buffer) {
  if (buffer.length < 22) throw new Error('不是有效的 XLSX：文件过小，缺少 ZIP 结构');
  const eocd = findEndOfCentralDirectory(buffer);
  const diskNumber = buffer.readUInt16LE(eocd + 4);
  const centralDisk = buffer.readUInt16LE(eocd + 6);
  const diskEntryCount = buffer.readUInt16LE(eocd + 8);
  const entryCount = buffer.readUInt16LE(eocd + 10);
  const centralSize = buffer.readUInt32LE(eocd + 12);
  const centralOffset = buffer.readUInt32LE(eocd + 16);

  // ZIP64 判定要排在其他一致性检查之前：0xffff 的条目数既可能是 ZIP64，
  // 也可能被误判成分卷，直接报 ZIP64 更贴近真实原因。
  if (entryCount === ZIP64_COUNT_SENTINEL || centralSize === ZIP64_SENTINEL || centralOffset === ZIP64_SENTINEL) {
    throw new Error('不支持 ZIP64 格式的 XLSX（ZIP64 扩展字段未实现），请另存为普通 xlsx 后重试');
  }
  if (diskNumber !== 0 || centralDisk !== 0 || diskEntryCount !== entryCount) {
    throw new Error('不支持分卷 ZIP：XLSX 必须是单个 ZIP 包');
  }
  if (centralOffset + centralSize > buffer.length) {
    throw new Error('XLSX 结构损坏：ZIP 中央目录越界');
  }

  const entries = new Map();
  let cursor = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) {
      throw new Error('XLSX 结构损坏：ZIP 中央目录条目签名错误');
    }
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const checksum = buffer.readUInt32LE(cursor + 16);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const size = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);

    if ((flags & 0x0001) !== 0) throw new Error('不支持加密的 ZIP 条目，无法读取 XLSX');
    if (compressedSize === ZIP64_SENTINEL || size === ZIP64_SENTINEL || localOffset === ZIP64_SENTINEL) {
      throw new Error('不支持 ZIP64 格式的 XLSX（条目大小或偏移使用了 ZIP64 扩展字段）');
    }

    const rawName = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength);
    const name = rawName.replace(/\\/g, '/');
    entries.set(name, {name, method, flags, checksum, compressedSize, size, localOffset});
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return {entries};
}

/**
 * 从文件尾部向前查找 EOCD（考虑最大 65535 字节的注释）。
 *
 * @param {Buffer} buffer 整个文件的字节。
 * @returns {number} EOCD 的偏移。
 * @throws {Error} 找不到 EOCD 时抛出。
 */
function findEndOfCentralDirectory(buffer) {
  const minimum = Math.max(0, buffer.length - 22 - 0xffff);
  for (let offset = buffer.length - 22; offset >= minimum; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) return offset;
  }
  throw new Error('不是有效的 XLSX/ZIP：找不到中央目录结尾（EOCD）');
}

/**
 * 按名称查条目，找不到时退化为大小写不敏感查找。
 *
 * @param {Map<string, object>} entries 条目表。
 * @param {string} name 期望的条目名。
 * @returns {object|null} 条目，或 null。
 */
function findEntry(entries, name) {
  if (entries.has(name)) return entries.get(name);
  const wanted = name.toLowerCase();
  for (const [key, entry] of entries) {
    if (key.toLowerCase() === wanted) return entry;
  }
  return null;
}

/**
 * 读取并解压一个 ZIP 条目。
 *
 * 大小以中央目录为准（数据描述符场景下本地头可能写 0），并做长度与 CRC 校验。
 *
 * @param {Buffer} buffer 整个文件的字节。
 * @param {object} entry 中央目录条目。
 * @param {Map<string, Buffer>} cache 解压结果缓存。
 * @returns {Buffer} 解压后的内容。
 * @throws {Error} 压缩方法不支持、越界、长度或 CRC 不一致时抛出。
 */
function readEntry(buffer, entry, cache) {
  if (cache.has(entry.name)) return cache.get(entry.name);
  if (entry.localOffset + 30 > buffer.length || buffer.readUInt32LE(entry.localOffset) !== LOCAL_SIGNATURE) {
    throw new Error(`XLSX 结构损坏：条目 ${entry.name} 的本地文件头无效`);
  }
  const nameLength = buffer.readUInt16LE(entry.localOffset + 26);
  const extraLength = buffer.readUInt16LE(entry.localOffset + 28);
  const start = entry.localOffset + 30 + nameLength + extraLength;
  const end = start + entry.compressedSize;
  if (end > buffer.length) throw new Error(`XLSX 结构损坏：条目 ${entry.name} 的数据越界`);

  // A tiny workbook can declare (or inflate to) an enormous part: without a cap
  // one crafted file would exhaust the Host heap and take every plugin request
  // down with it. Bound both one part and the whole decompression budget.
  if (entry.size > MAX_ENTRY_BYTES) {
    throw new Error(`XLSX 部件过大：${entry.name} 声明 ${Math.round(entry.size / 1024 / 1024)} MB，超过单部件上限 ${MAX_ENTRY_BYTES / 1024 / 1024} MB`);
  }
  const raw = buffer.subarray(start, end);
  let content;
  if (entry.method === 0) content = Buffer.from(raw);
  else if (entry.method === 8) {
    try {
      content = zlib.inflateRawSync(raw, {maxOutputLength: MAX_ENTRY_BYTES});
    } catch (error) {
      throw new Error(`XLSX 部件解压失败或超过 ${MAX_ENTRY_BYTES / 1024 / 1024} MB 上限：${entry.name}`);
    }
  } else {
    throw new Error(`不支持 ZIP 压缩方法 ${entry.method}（仅支持 store 与 deflate）：${entry.name}`);
  }

  if (entry.size !== 0 && content.length !== entry.size) {
    throw new Error(`XLSX 结构损坏：条目 ${entry.name} 解压后长度与中央目录不一致`);
  }
  let totalBytes = content.length;
  for (const cached of cache.values()) totalBytes += cached.length;
  if (totalBytes > MAX_TOTAL_BYTES) {
    throw new Error(`XLSX 解压总量过大：超过 ${MAX_TOTAL_BYTES / 1024 / 1024} MB 上限，已停止读取`);
  }
  if (entry.checksum !== 0 && typeof zlib.crc32 === 'function' && (zlib.crc32(content) >>> 0) !== entry.checksum) {
    throw new Error(`XLSX 结构损坏：条目 ${entry.name} 的 CRC 校验失败`);
  }
  cache.set(entry.name, content);
  return content;
}

/* ------------------------------------------------------------------ *
 * 最小 XML 解析
 * ------------------------------------------------------------------ */

/**
 * 解析 XML 为极简节点树。
 *
 * 只需要工作簿、关系、样式这类结构固定的小文件，因此不追求通用性：
 * 支持注释、CDATA、处理指令、自闭合标签、单双引号属性与实体解码。
 *
 * @param {string} xml XML 文本。
 * @returns {{name: string, attrs: Record<string, string>, children: object[], text: string}} 文档根节点。
 */
function parseXml(xml) {
  const root = {name: '#document', attrs: {}, children: [], text: ''};
  const stack = [root];
  const length = xml.length;
  let index = 0;

  while (index < length) {
    const open = xml.indexOf('<', index);
    if (open === -1) {
      stack[stack.length - 1].text += decodeXmlText(xml.slice(index));
      break;
    }
    if (open > index) stack[stack.length - 1].text += decodeXmlText(xml.slice(index, open));

    if (xml.startsWith('<!--', open)) {
      const close = xml.indexOf('-->', open + 4);
      index = close === -1 ? length : close + 3;
      continue;
    }
    if (xml.startsWith('<![CDATA[', open)) {
      const close = xml.indexOf(']]>', open + 9);
      stack[stack.length - 1].text += xml.slice(open + 9, close === -1 ? length : close);
      index = close === -1 ? length : close + 3;
      continue;
    }
    if (xml.startsWith('<?', open)) {
      const close = xml.indexOf('?>', open + 2);
      index = close === -1 ? length : close + 2;
      continue;
    }
    if (xml.startsWith('<!', open)) {
      const close = xml.indexOf('>', open + 2);
      index = close === -1 ? length : close + 1;
      continue;
    }
    if (xml.startsWith('</', open)) {
      const close = xml.indexOf('>', open + 2);
      if (close === -1) break;
      if (stack.length > 1) stack.pop();
      index = close + 1;
      continue;
    }

    let cursor = open + 1;
    let quote = '';
    while (cursor < length) {
      const character = xml[cursor];
      if (quote !== '') {
        if (character === quote) quote = '';
        cursor += 1;
        continue;
      }
      if (character === '"' || character === "'") {
        quote = character;
        cursor += 1;
        continue;
      }
      if (character === '>') break;
      cursor += 1;
    }
    if (cursor >= length) break;

    const rawTag = xml.slice(open + 1, cursor);
    const selfClosing = rawTag.endsWith('/');
    const tagText = selfClosing ? rawTag.slice(0, -1) : rawTag;
    const nameMatch = /^[^\s/>]+/.exec(tagText);
    if (nameMatch === null) {
      index = cursor + 1;
      continue;
    }
    const name = nameMatch[0];
    const node = {name, attrs: parseAttributes(tagText.slice(name.length)), children: [], text: ''};
    stack[stack.length - 1].children.push(node);
    if (!selfClosing) stack.push(node);
    index = cursor + 1;
  }
  return root;
}

/**
 * 解析标签属性。
 *
 * @param {string} text 标签名之后的部分。
 * @returns {Record<string, string>} 属性表，值已做实体解码。
 */
function parseAttributes(text) {
  const attrs = {};
  const regexp = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let match;
  while ((match = regexp.exec(text)) !== null) {
    attrs[match[1]] = decodeXmlText(match[2] ?? match[3] ?? '');
  }
  return attrs;
}

/**
 * 解码 XML 实体与 Excel 的 `_xHHHH_` 控制字符转义。
 *
 * @param {string} text 原始文本。
 * @returns {string} 解码后的文本。
 */
function decodeXmlText(text) {
  // XML end-of-line normalization (XML 1.0 §2.11): a literal CRLF/CR in character
  // data becomes LF. Without it an XLSX cell keeps `\r\n` while the same logical
  // value from a DB/CSV source has `\n`, so reconciliation reports a difference.
  // Character references such as `&#13;` are decoded afterwards and survive.
  const normalized = text.replace(/\r\n?/g, '\n');
  if (normalized.indexOf('&') === -1 && normalized.indexOf('_x') === -1) return normalized;
  let decoded = normalized.replace(/&(#x[0-9A-Fa-f]+|#\d+|amp|lt|gt|quot|apos);/g, (match, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return match;
      try {
        return String.fromCodePoint(code);
      } catch {
        return match;
      }
    }
    const named = {amp: '&', lt: '<', gt: '>', quot: '"', apos: "'"};
    return named[body] ?? match;
  });
  if (decoded.indexOf('_x') !== -1) {
    decoded = decoded.replace(/_x([0-9A-Fa-f]{4})_/g, (match, hex) => {
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) ? String.fromCharCode(code) : match;
    });
  }
  return decoded;
}

/**
 * 去掉命名空间前缀后的本地名。
 *
 * @param {string} name 标签或属性名。
 * @returns {string} 本地名。
 */
function localNameOf(name) {
  const colon = name.indexOf(':');
  return colon === -1 ? name : name.slice(colon + 1);
}

/**
 * 取第一个元素子节点。
 *
 * @param {object} node 父节点。
 * @returns {object} 第一个元素子节点；没有时返回父节点本身。
 */
function firstElement(node) {
  return node.children.length > 0 ? node.children[0] : node;
}

/**
 * 按本地名查找一个子元素。
 *
 * @param {object} node 父节点。
 * @param {string} name 本地名。
 * @returns {object|null} 子节点或 null。
 */
function childByName(node, name) {
  return node.children.find((child) => localNameOf(child.name) === name) ?? null;
}

/**
 * 按本地名查找所有子元素。
 *
 * @param {object} node 父节点。
 * @param {string} name 本地名。
 * @returns {object[]} 子节点数组。
 */
function childrenByName(node, name) {
  return node.children.filter((child) => localNameOf(child.name) === name);
}

/**
 * 读取属性值；先精确匹配，再按本地名匹配（兼容 `r:id`）。
 *
 * @param {object} node 元素节点。
 * @param {string} name 属性名。
 * @returns {string|undefined} 属性值。
 */
function attrOf(node, name) {
  if (Object.prototype.hasOwnProperty.call(node.attrs, name)) return node.attrs[name];
  for (const [key, value] of Object.entries(node.attrs)) {
    if (localNameOf(key) === name) return value;
  }
  return undefined;
}

/* ------------------------------------------------------------------ *
 * 工作簿 / 关系 / 共享字符串 / 样式
 * ------------------------------------------------------------------ */

/**
 * 解析 `xl/workbook.xml`：工作表清单与 1900/1904 日期系统。
 *
 * @param {string} xml 工作簿 XML。
 * @returns {{sheets: {name: string, rId: string}[], date1904: boolean}} 工作簿信息。
 */
function parseWorkbook(xml) {
  const document = parseXml(xml);
  const workbook = firstElement(document);
  const properties = childByName(workbook, 'workbookPr');
  const date1904Flag = properties === null ? undefined : attrOf(properties, 'date1904');
  const date1904 = date1904Flag === '1' || date1904Flag === 'true';
  const sheetsNode = childByName(workbook, 'sheets');
  const sheets = sheetsNode === null
    ? []
    : childrenByName(sheetsNode, 'sheet').map((node) => ({
      name: attrOf(node, 'name') ?? '',
      rId: attrOf(node, 'id') ?? '',
    }));
  return {sheets, date1904};
}

/**
 * 解析 `xl/_rels/workbook.xml.rels`。
 *
 * @param {string} xml 关系 XML。
 * @returns {Map<string, {target: string, type: string, mode: string}>} rId → 关系。
 */
function parseRelationships(xml) {
  const document = parseXml(xml);
  const root = firstElement(document);
  const relationships = new Map();
  for (const node of childrenByName(root, 'Relationship')) {
    const id = attrOf(node, 'Id');
    const target = attrOf(node, 'Target');
    if (id === undefined || target === undefined) continue;
    relationships.set(id, {
      target,
      type: attrOf(node, 'Type') ?? '',
      mode: attrOf(node, 'TargetMode') ?? 'Internal',
    });
  }
  return relationships;
}

/**
 * 计算工作表 XML 在 ZIP 里的路径。
 *
 * @param {{name: string, rId: string}} sheet 工作表条目。
 * @param {number} index 工作表在清单里的位置（用于兜底命名）。
 * @param {Map<string, {target: string, type: string, mode: string}>} relationships 关系表。
 * @returns {string} ZIP 内路径。
 */
function resolveSheetTarget(sheet, index, relationships) {
  const relationship = sheet.rId === '' ? undefined : relationships.get(sheet.rId);
  if (relationship !== undefined && relationship.mode !== 'External' && (relationship.type === '' || relationship.type.endsWith('/worksheet'))) {
    return resolveZipPath('xl/', relationship.target);
  }
  // 少数生成器不写关系文件，退回 OOXML 的常规命名。
  return `xl/worksheets/sheet${index + 1}.xml`;
}

/**
 * 把相对路径解析为 ZIP 内路径（以 `/` 开头的视为包内绝对路径）。
 *
 * @param {string} base 基础目录（以 `/` 结尾）。
 * @param {string} target 关系目标。
 * @returns {string} 归一后的 ZIP 内路径。
 */
function resolveZipPath(base, target) {
  if (target.startsWith('/')) return target.slice(1);
  const segments = `${base}${target}`.split('/');
  const output = [];
  for (const segment of segments) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') output.pop();
    else output.push(segment);
  }
  return output.join('/');
}

/**
 * 解析 `xl/sharedStrings.xml`（含富文本 `<r>` 拼接）。
 *
 * @param {string} xml 共享字符串 XML。
 * @returns {string[]} 按 `t="s"` 索引的字符串数组。
 */
function parseSharedStrings(xml) {
  const values = [];
  const regexp = /<si\b[^>]*?(?:\/>|>([\s\S]*?)<\/si>)/g;
  let match;
  while ((match = regexp.exec(xml)) !== null) {
    values.push(collectTextRuns(match[1] ?? ''));
  }
  return values;
}

/**
 * 拼接一段富文本里的所有 `<t>`，忽略拼音注音 `<rPh>`。
 *
 * @param {string} xml 富文本片段。
 * @returns {string} 纯文本。
 */
function collectTextRuns(xml) {
  const withoutPhonetic = xml.replace(/<rPh\b[^>]*>[\s\S]*?<\/rPh>/g, '');
  let text = '';
  const regexp = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
  let match;
  while ((match = regexp.exec(withoutPhonetic)) !== null) text += decodeXmlText(match[1]);
  return text;
}

/**
 * 解析 `xl/styles.xml` 的 `cellXfs`，给出每个样式下标是否为日期/时间。
 *
 * @param {string} xml 样式 XML。
 * @returns {{date: boolean, timeOnly: boolean}[]} 样式表。
 */
function parseStyles(xml) {
  const document = parseXml(xml);
  const root = firstElement(document);
  const customFormats = new Map();

  const numFmtsNode = childByName(root, 'numFmts');
  if (numFmtsNode !== null) {
    for (const node of childrenByName(numFmtsNode, 'numFmt')) {
      const id = Number.parseInt(attrOf(node, 'numFmtId') ?? '', 10);
      const code = attrOf(node, 'formatCode');
      if (Number.isFinite(id) && code !== undefined) customFormats.set(id, code);
    }
  }

  const styles = [];
  const cellXfsNode = childByName(root, 'cellXfs');
  if (cellXfsNode !== null) {
    for (const node of childrenByName(cellXfsNode, 'xf')) {
      const numFmtId = Number.parseInt(attrOf(node, 'numFmtId') ?? '0', 10);
      styles.push(classifyNumberFormat(Number.isFinite(numFmtId) ? numFmtId : 0, customFormats.get(numFmtId) ?? null));
    }
  }
  return styles;
}

/**
 * 判断一个数字格式是否表示日期/时间。
 *
 * 内置 id 直接按 ECMA-376 判定；自定义格式先剥掉引号字面量、方括号条件/颜色、
 * 反斜杠转义与填充字符，再看是否残留 `y/m/d/h/s` 记号。
 *
 * @param {number} numFmtId 数字格式 id。
 * @param {string|null} formatCode 自定义格式代码。
 * @returns {{date: boolean, timeOnly: boolean}} 判定结果。
 */
function classifyNumberFormat(numFmtId, formatCode) {
  if (BUILTIN_DATE_FORMAT_IDS.has(numFmtId)) return {date: true, timeOnly: false};
  if (BUILTIN_TIME_FORMAT_IDS.has(numFmtId)) return {date: true, timeOnly: true};
  if (typeof formatCode !== 'string' || formatCode.trim() === '') return {date: false, timeOnly: false};

  const cleaned = stripFormatLiterals(formatCode);
  if (!/[ymdhs]/i.test(cleaned)) return {date: false, timeOnly: false};

  const hasDay = /[yd]/i.test(cleaned);
  const hasClock = /[hs]/i.test(cleaned);
  const hasMonth = /m/i.test(cleaned);
  if (!hasDay && !hasMonth && !hasClock) return {date: false, timeOnly: false};
  // 只有时/秒标记、没有年/日标记的格式按时分秒处理，避免给纯时间值套上 1899 年。
  return {date: true, timeOnly: hasClock && !hasDay};
}

/**
 * 剥掉数字格式里的非语义片段，只留下格式记号。
 *
 * @param {string} formatCode 原始格式代码。
 * @returns {string} 清理后的格式代码。
 */
function stripFormatLiterals(formatCode) {
  return formatCode
    .replace(/"[^"]*"/g, '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/\\./g, '')
    .replace(/[_*]./g, '')
    .toLowerCase();
}

/* ------------------------------------------------------------------ *
 * 工作表扫描
 * ------------------------------------------------------------------ */

/**
 * 扫描工作表 XML，取出单元格与合并单元格范围。
 *
 * 用逐行/逐格的块扫描而不是完整建树，避免几十万行的工作表把内存吃光。
 *
 * @param {string} xml 工作表 XML。
 * @returns {{cells: {row: number, column: number, attrs: Record<string, string>, body: string}[], merges: string[]}} 扫描结果。
 */
function scanSheet(xml) {
  const cells = [];
  const merges = [];

  const mergeBlock = /<mergeCells\b[^>]*>([\s\S]*?)<\/mergeCells>/.exec(xml);
  if (mergeBlock !== null) {
    const regexp = /<mergeCell\b[^>]*?\bref\s*=\s*"([^"]+)"/g;
    let match;
    while ((match = regexp.exec(mergeBlock[1])) !== null) merges.push(match[1]);
  }

  const rowRegexp = /<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g;
  let rowMatch;
  let implicitRow = 0;
  while ((rowMatch = rowRegexp.exec(xml)) !== null) {
    const rowAttrs = parseAttributes(rowMatch[1]);
    const explicitRow = Number.parseInt(rowAttrs.r ?? '', 10);
    const rowIndex = Number.isFinite(explicitRow) ? explicitRow : implicitRow + 1;
    implicitRow = rowIndex;

    const body = rowMatch[2] ?? '';
    const cellRegexp = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let cellMatch;
    let implicitColumn = 0;
    while ((cellMatch = cellRegexp.exec(body)) !== null) {
      const attrs = parseAttributes(cellMatch[1]);
      const ref = typeof attrs.r === 'string' ? parseCellRef(attrs.r) : null;
      const column = ref === null ? implicitColumn : ref.column;
      implicitColumn = column + 1;
      cells.push({row: rowIndex, column, attrs, body: cellMatch[2] ?? ''});
    }
  }
  return {cells, merges};
}

/**
 * 解析单元格引用（如 `B5`、`$B$5`）。
 *
 * @param {string} ref 单元格引用。
 * @returns {{column: number, row: number}|null} 0 基列号 + 1 基行号，非法时为 null。
 */
function parseCellRef(ref) {
  const match = /^\$?([A-Za-z]{1,3})\$?(\d+)$/.exec(ref.trim());
  if (match === null) return null;
  return {column: columnIndexOf(match[1]), row: Number.parseInt(match[2], 10)};
}

/**
 * 把列字母转成 0 基列号。
 *
 * @param {string} letters 列字母（如 `AB`）。
 * @returns {number} 0 基列号。
 */
function columnIndexOf(letters) {
  let value = 0;
  for (const character of letters.toUpperCase()) {
    value = value * 26 + (character.charCodeAt(0) - 64);
  }
  return value - 1;
}

/**
 * 把 0 基列号转成列字母。
 *
 * @param {number} index 0 基列号。
 * @returns {string} 列字母。
 */
function columnNameOf(index) {
  let value = index + 1;
  let name = '';
  while (value > 0) {
    const remainder = (value - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    value = Math.floor((value - 1) / 26);
  }
  return name;
}

/* ------------------------------------------------------------------ *
 * 单元格取值
 * ------------------------------------------------------------------ */

/**
 * 拆出单元格正文里的公式、缓存值与内联字符串。
 *
 * @param {string} body `<c>` 标签内的 XML。
 * @returns {{formula: object|null, rawValue: string|null, inlineText: string|null}} 正文结构。
 */
function parseCellContent(body) {
  if (body === '') return {formula: null, rawValue: null, inlineText: null};
  const formulaMatch = /<f\b([^>]*?)(?:\/>|>([\s\S]*?)<\/f>)/.exec(body);
  const valueMatch = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(body);
  const inlineMatch = /<is\b[^>]*>([\s\S]*?)<\/is>/.exec(body);
  return {
    formula: formulaMatch === null ? null : {attrs: parseAttributes(formulaMatch[1])},
    rawValue: valueMatch === null ? null : decodeXmlText(valueMatch[1]),
    inlineText: inlineMatch === null ? null : collectTextRuns(inlineMatch[1]),
  };
}

/**
 * 把单元格解析为字符串或 null。
 *
 * 数值一律返回 `<v>` 的原始文本，只有日期样式才做序列号转换。
 *
 * @param {{row: number, column: number, attrs: Record<string, string>, body: string}} cell 单元格。
 * @param {{sharedStrings: string[], styles: {date: boolean, timeOnly: boolean}[], date1904: boolean,
 *          issueLog: ReturnType<typeof createIssueLog>, metrics: {formulaCells: number, uncomputableCells: number}}} context 解析上下文。
 * @returns {string|null} 单元格文本。
 */
function resolveCell(cell, context) {
  const {sharedStrings, styles, date1904, issueLog, metrics} = context;
  const attrs = cell.attrs;
  const type = attrs.t;
  const label = columnNameOf(cell.column);
  const styleIndex = Number.parseInt(attrs.s ?? '', 10);
  const style = Number.isFinite(styleIndex) ? styles[styleIndex] ?? null : null;
  const content = parseCellContent(cell.body);

  if (content.formula !== null) {
    metrics.formulaCells += 1;
    if (content.rawValue === null || content.rawValue === '') {
      metrics.uncomputableCells += 1;
      issueLog.push({
        row: cell.row,
        column: label,
        message: '公式单元格没有缓存值（有 <f> 无 <v>），按契约记为 null',
      });
      return null;
    }
  }

  switch (type) {
    case 's': {
      if (content.rawValue === null) return null;
      const sharedIndex = Number.parseInt(content.rawValue, 10);
      if (!Number.isFinite(sharedIndex) || sharedIndex < 0 || sharedIndex >= sharedStrings.length) {
        issueLog.push({
          row: cell.row,
          column: label,
          message: `共享字符串索引 ${content.rawValue} 越界（共 ${sharedStrings.length} 条），值记为 null`,
        });
        return null;
      }
      return sharedStrings[sharedIndex];
    }
    case 'inlineStr':
      return content.inlineText ?? content.rawValue ?? null;
    case 'str':
      return content.rawValue ?? null;
    case 'b': {
      if (content.rawValue === '1') return 'TRUE';
      if (content.rawValue === '0') return 'FALSE';
      issueLog.push({row: cell.row, column: label, message: `布尔单元格的原始值不是 0/1：${content.rawValue ?? '空'}`});
      return content.rawValue === null || content.rawValue === '' ? null : 'FALSE';
    }
    case 'e': {
      const raw = content.rawValue ?? '';
      issueLog.push({row: cell.row, column: label, message: `单元格是错误值 ${raw || '(空)'}，按原样保留`});
      return raw;
    }
    case 'd': {
      const raw = content.rawValue ?? '';
      const normalized = normalizeIsoDate(raw);
      if (normalized === null) {
        issueLog.push({row: cell.row, column: label, message: `无法识别的 ISO 日期单元格：${raw}`});
        return raw;
      }
      return normalized;
    }
    case 'n':
    case undefined:
      return resolveNumericCell(content.rawValue, style, cell, date1904, issueLog, label);
    default: {
      const raw = content.inlineText ?? content.rawValue ?? null;
      issueLog.push({row: cell.row, column: label, message: `未知的单元格类型 t="${type}"，按原始文本保留`});
      return raw;
    }
  }
}

/**
 * 处理数值单元格：日期样式转 ISO，其余保留原始文本。
 *
 * @param {string|null} raw `<v>` 里的原始文本。
 * @param {{date: boolean, timeOnly: boolean}|null} style 单元格样式。
 * @param {{row: number}} cell 单元格位置。
 * @param {boolean} date1904 是否 1904 日期系统。
 * @param {ReturnType<typeof createIssueLog>} issueLog issue 收集器。
 * @param {string} label 列字母。
 * @returns {string|null} 单元格文本。
 */
function resolveNumericCell(raw, style, cell, date1904, issueLog, label) {
  if (raw === null) return null;
  if (style === null || !style.date) return raw;
  const serial = Number(raw);
  if (!Number.isFinite(serial)) {
    issueLog.push({row: cell.row, column: label, message: `日期单元格的值不是数字：${raw}`});
    return raw;
  }
  const parts = serialToParts(serial, date1904);
  if (parts === null) {
    issueLog.push({row: cell.row, column: label, message: `日期序列号超出可表示范围：${raw}`});
    return raw;
  }
  if (parts.fakeLeap) {
    issueLog.push({
      row: cell.row,
      column: label,
      message: '日期序列号 60 对应 Excel 1900 闰年 bug 的虚构日期 1900-02-29，按原样输出',
    });
    return '1900-02-29';
  }
  if (style.timeOnly && parts.days === 0) return parts.timeText;
  if (parts.secondsOfDay === 0) return parts.dateText;
  return `${parts.dateText} ${parts.timeText}`;
}

/**
 * 把 Excel 日期序列号拆成日期文本与时间文本。
 *
 * 1900 系统：序列号 1 是 1900-01-01；序列号 60 是虚构的 1900-02-29，
 * 因此 61 及以后按 1899-12-30 起算，59 及以前按 1899-12-31 起算。
 * 1904 系统：序列号 0 是 1904-01-01。
 *
 * @param {number} serial 日期序列号。
 * @param {boolean} date1904 是否 1904 日期系统。
 * @returns {{dateText: string, timeText: string, days: number, secondsOfDay: number, fakeLeap: boolean}|null} 拆分结果。
 */
function serialToParts(serial, date1904) {
  const limit = date1904 ? MAX_EXCEL_SERIAL_1904 : MAX_EXCEL_SERIAL_1900;
  if (!Number.isFinite(serial) || serial < 0 || serial > limit) return null;
  const totalSeconds = Math.round(serial * 86400);
  const days = Math.floor(totalSeconds / 86400);
  const secondsOfDay = totalSeconds - days * 86400;

  if (!date1904 && days === 60) {
    return {dateText: '1900-02-29', timeText: formatTime(secondsOfDay), days, secondsOfDay, fakeLeap: true};
  }

  let epochMs;
  if (date1904) epochMs = Date.UTC(1904, 0, 1) + days * MS_PER_DAY;
  else epochMs = (days >= 61 ? Date.UTC(1899, 11, 30) : Date.UTC(1899, 11, 31)) + days * MS_PER_DAY;

  return {
    dateText: formatDate(epochMs),
    timeText: formatTime(secondsOfDay),
    days,
    secondsOfDay,
    fakeLeap: false,
  };
}

/**
 * 用 UTC 字段格式化日期，避免受机器时区影响。
 *
 * @param {number} epochMs UTC 毫秒时间戳。
 * @returns {string} `YYYY-MM-DD`。
 */
function formatDate(epochMs) {
  const date = new Date(epochMs);
  const year = String(date.getUTCFullYear()).padStart(4, '0');
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * 把一天内的秒数格式化为 `HH:mm:ss`。
 *
 * @param {number} secondsOfDay 0–86399 的秒数。
 * @returns {string} `HH:mm:ss`。
 */
function formatTime(secondsOfDay) {
  const hours = Math.floor(secondsOfDay / 3600);
  const minutes = Math.floor((secondsOfDay % 3600) / 60);
  const seconds = secondsOfDay % 60;
  return [hours, minutes, seconds].map((value) => String(value).padStart(2, '0')).join(':');
}

/**
 * 归一化 `t="d"` 的 ISO 日期文本。
 *
 * @param {string} raw 原始文本，如 `2023-01-01T00:00:00`。
 * @returns {string|null} `YYYY-MM-DD` 或 `YYYY-MM-DD HH:mm:ss`；无法识别时 null。
 */
function normalizeIsoDate(raw) {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(raw.trim());
  if (match === null) return null;
  const [, year, month, day, hour, minute, second] = match;
  if (hour === undefined) return `${year}-${month}-${day}`;
  return `${year}-${month}-${day} ${hour}:${minute}:${second ?? '00'}`;
}

/* ------------------------------------------------------------------ *
 * 表格组装
 * ------------------------------------------------------------------ */

/**
 * 把单元格列表组装成 行号 → 列号 → 值 的稀疏网格。
 *
 * @param {{row: number, column: number, attrs: Record<string, string>, body: string}[]} cells 单元格列表。
 * @param {object} context 解析上下文。
 * @param {ReturnType<typeof createIssueLog>} issueLog issue 收集器。
 * @returns {Map<number, Map<number, string|null>>} 稀疏网格。
 */
function buildGrid(cells, context, issueLog) {
  const grid = new Map();
  for (const cell of cells) {
    let row = grid.get(cell.row);
    if (row === undefined) {
      row = new Map();
      grid.set(cell.row, row);
    }
    if (row.has(cell.column)) {
      issueLog.push({
        row: cell.row,
        column: columnNameOf(cell.column),
        message: '同一坐标出现多个单元格，后出现的覆盖先出现的',
      });
    }
    row.set(cell.column, resolveCell(cell, context));
  }
  return grid;
}

/**
 * 应用合并单元格：只保留左上角值，其余置 null 并记 issue（每表最多 50 条）。
 *
 * @param {string[]} merges 合并范围（如 `A1:C3`）。
 * @param {Map<number, Map<number, string|null>>} grid 稀疏网格。
 * @param {ReturnType<typeof createIssueLog>} issueLog issue 收集器。
 * @returns {void}
 */
function applyMerges(merges, grid, issueLog) {
  let recorded = 0;
  for (const ref of merges) {
    const range = parseMergeRange(ref);
    if (range === null) {
      issueLog.push({row: 0, message: `无法识别的合并单元格范围：${ref}`});
      continue;
    }
    const area = (range.bottom - range.top + 1) * (range.right - range.left + 1);
    if (area > 5000) {
      if (recorded < MAX_MERGE_ISSUES) {
        recorded += 1;
        issueLog.push({
          row: range.top,
          column: columnNameOf(range.left),
          message: `合并单元格 ${ref} 范围过大，仅保留左上角值`,
        });
      }
      continue;
    }
    for (let row = range.top; row <= range.bottom; row += 1) {
      for (let column = range.left; column <= range.right; column += 1) {
        if (row === range.top && column === range.left) continue;
        const target = grid.get(row);
        if (target !== undefined && target.has(column)) target.set(column, null);
        if (recorded < MAX_MERGE_ISSUES) {
          recorded += 1;
          issueLog.push({
            row,
            column: columnNameOf(column),
            message: `合并单元格 ${ref} 的从属单元格已置为 null`,
          });
        }
      }
    }
  }
}

/**
 * 解析合并范围引用。
 *
 * @param {string} ref 形如 `A1:C3` 或 `A1`。
 * @returns {{top: number, left: number, bottom: number, right: number}|null} 范围；非法时 null。
 */
function parseMergeRange(ref) {
  const [start, end] = ref.split(':');
  const first = parseCellRef(start);
  if (first === null) return null;
  const second = end === undefined ? first : parseCellRef(end);
  if (second === null) return null;
  return {
    top: Math.min(first.row, second.row),
    bottom: Math.max(first.row, second.row),
    left: Math.min(first.column, second.column),
    right: Math.max(first.column, second.column),
  };
}

/**
 * 从稀疏网格生成统一表格：表头行决定列名，后续非空行是数据。
 *
 * @param {Map<number, Map<number, string|null>>} grid 稀疏网格。
 * @param {{maxRows: number, sheetName: string, metrics: {formulaCells: number, uncomputableCells: number},
 *          issueLog: ReturnType<typeof createIssueLog>}} options 组装选项。
 * @returns {import('./index.js').ParsedTable} 解析结果。
 */
function buildTable(grid, options) {
  const {maxRows, sheetName, metrics, issueLog} = options;
  const rowIndexes = [...grid.keys()].sort((left, right) => left - right);
  const headerRowIndex = rowIndexes.find((index) => hasValue(grid.get(index)));

  if (headerRowIndex === undefined) {
    return {
      columns: [],
      fields: [],
      rows: [],
      rowNumbers: [],
      issues: issueLog.finish(),
      meta: {
        format: 'xlsx',
        sheet: sheetName,
        encoding: null,
        delimiter: null,
        rowCount: 0,
        truncated: false,
        formulaCells: metrics.formulaCells,
        uncomputableCells: metrics.uncomputableCells,
      },
    };
  }

  // 列范围只由「确实有值」的单元格决定：表头右侧的空白列或只有无缓存公式的列
  // 不应该凭空多出 column_N。
  let maxColumn = -1;
  for (const row of grid.values()) {
    for (const [column, value] of row) {
      if (value !== null && value !== '' && column > maxColumn) maxColumn = column;
    }
  }

  const headerRow = grid.get(headerRowIndex);
  const columns = [];
  const usedNames = new Set();
  for (let column = 0; column <= maxColumn; column += 1) {
    const raw = headerRow.get(column) ?? null;
    const trimmed = raw === null ? '' : String(raw).trim();
    const base = trimmed === '' ? `column_${column + 1}` : trimmed;
    let candidate = base;
    let suffix = 2;
    while (usedNames.has(candidate)) {
      candidate = `${base}_${suffix}`;
      suffix += 1;
    }
    usedNames.add(candidate);
    columns.push(candidate);
  }

  const rows = [];
  const rowNumbers = [];
  let truncated = false;
  for (const rowIndex of rowIndexes) {
    if (rowIndex <= headerRowIndex) continue;
    const row = grid.get(rowIndex);
    if (!hasValue(row)) continue;
    if (rows.length >= maxRows) {
      truncated = true;
      break;
    }
    const output = {};
    for (let column = 0; column < columns.length; column += 1) {
      setOwn(output, columns[column], row.get(column) ?? null);
    }
    rows.push(output);
    rowNumbers.push(rowIndex);
  }

  return {
    columns,
    fields: buildFields(columns, rows),
    rows,
    rowNumbers,
    issues: issueLog.finish(),
    meta: {
      format: 'xlsx',
      sheet: sheetName,
      encoding: null,
      delimiter: null,
      rowCount: rows.length,
      truncated,
      formulaCells: metrics.formulaCells,
      uncomputableCells: metrics.uncomputableCells,
    },
  };
}

/**
 * 判断一行里是否至少有一个非空值。
 *
 * @param {Map<number, string|null>|undefined} row 行数据。
 * @returns {boolean} 是否有值。
 */
function hasValue(row) {
  if (row === undefined) return false;
  for (const value of row.values()) {
    if (value !== null && value !== '') return true;
  }
  return false;
}

/**
 * 写一个自有属性，避免表头 `__proto__` 改写对象原型。
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
