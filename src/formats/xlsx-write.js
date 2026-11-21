/**
 * XLSX 写入：手写 ZIP（deflate）+ inlineStr 文本 + 冻结首行/自动筛选。
 *
 * 设计取舍：文本一律写 `inlineStr`，跳过 sharedStrings 的索引维护；
 * 数字写 `<v>` 原始文本，日期写 ISO 文本——分析底稿里「可读、可复核」
 * 比「Excel 内部最优」重要。中文与长文本都按 UTF-8 原样落盘。
 *
 * @module src/formats/xlsx-write
 */

import {mkdir, rename, rm, writeFile} from 'node:fs/promises';
import {dirname} from 'node:path';
import * as zlib from 'node:zlib';

/** ZIP 本地文件头签名。 */
const LOCAL_SIGNATURE = 0x04034b50;
/** ZIP 中央目录条目签名。 */
const CENTRAL_SIGNATURE = 0x02014b50;
/** ZIP 中央目录结尾签名。 */
const EOCD_SIGNATURE = 0x06054b50;

/** deflate 压缩方法编号。 */
const METHOD_DEFLATE = 8;

/** ZIP 通用标志位：文件名使用 UTF-8。 */
const FLAG_UTF8 = 0x0800;

/** DOS 日期 1980-01-01（位：年-1980 << 9 | 月 << 5 | 日）。 */
const DOS_DATE = (1 << 5) | 1;

/** Excel 单工作表行数上限（含表头）。 */
const MAX_SHEET_ROWS = 1048576;

/** Excel 单工作表列数上限。 */
const MAX_SHEET_COLUMNS = 16384;

/** Excel 单个单元格文本上限（字符）。 */
const MAX_CELL_TEXT_LENGTH = 32_767;

/** 表头样式在 `cellXfs` 里的下标。 */
const HEADER_STYLE_INDEX = 1;

/** 可以判定为数字文本、需要写 `<v>` 的形态。 */
const NUMERIC_TEXT = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

/** 工作表名非法字符。 */
const INVALID_SHEET_NAME = /[[\]\\/?*:]/;

/**
 * 把工作簿写入 xlsx 文件。
 *
 * @param {string} filePath 目标绝对路径。
 * @param {{sheets: {name: string, columns: {name: string, width?: number, type?: 'text'|'number'|'date'},
 *          rows: (string|number|null)[][]}[]}} workbook 工作簿内容。
 * @returns {Promise<void>} 写入完成。
 * @throws {TypeError} 工作簿结构不合法时抛出。
 * @throws {Error} 工作表名非法、行/列数超过 Excel 上限或数字无效时抛出。
 */
export async function writeXlsx(filePath, workbook) {
  if (typeof filePath !== 'string' || filePath === '') throw new TypeError('writeXlsx 需要目标文件路径');
  const sheets = normalizeWorkbook(workbook);
  const archive = buildArchive(sheets);

  // 先写临时文件再 rename：中途失败不会留下半个 xlsx 让下游读到。
  const directory = dirname(filePath);
  await mkdir(directory, {recursive: true});
  const temporaryPath = `${filePath}.tmp`;
  try {
    await writeFile(temporaryPath, archive);
    await rename(temporaryPath, filePath);
  } catch (error) {
    await rm(temporaryPath, {force: true});
    throw error;
  }
}

/**
 * 校验并归一工作簿结构。
 *
 * @param {{sheets: {name: string, columns: object[], rows: object[]}[]}} workbook 原始工作簿。
 * @returns {{name: string, columns: {name: string, width: number|null, type: string}[], rows: (string|number|null)[][]}[]} 归一后的工作表。
 * @throws {TypeError} 结构不合法时抛出。
 * @throws {Error} 工作表名或行列数不合法时抛出。
 */
function normalizeWorkbook(workbook) {
  if (workbook === null || typeof workbook !== 'object' || !Array.isArray(workbook.sheets)) {
    throw new TypeError('writeXlsx 需要 {sheets: [...]} 形式的工作簿');
  }
  if (workbook.sheets.length === 0) throw new TypeError('writeXlsx 至少需要一张工作表');

  const usedNames = new Set();
  return workbook.sheets.map((sheet, sheetIndex) => {
    if (sheet === null || typeof sheet !== 'object') throw new TypeError(`第 ${sheetIndex + 1} 张工作表不是对象`);
    const name = normalizeSheetName(sheet.name, sheetIndex);
    if (usedNames.has(name.toLowerCase())) throw new Error(`工作表名重复：${name}`);
    usedNames.add(name.toLowerCase());

    const rawColumns = Array.isArray(sheet.columns) ? sheet.columns : [];
    if (rawColumns.length > MAX_SHEET_COLUMNS) {
      throw new Error(`工作表「${name}」的列数 ${rawColumns.length} 超过 Excel 上限 ${MAX_SHEET_COLUMNS}`);
    }
    const columns = rawColumns.map((column, columnIndex) => normalizeColumn(column, name, columnIndex));

    const rawRows = Array.isArray(sheet.rows) ? sheet.rows : [];
    if (rawRows.length + 1 > MAX_SHEET_ROWS) {
      throw new Error(`工作表「${name}」的数据行数 ${rawRows.length} 超过 Excel 上限（含表头 ${MAX_SHEET_ROWS} 行）`);
    }
    const rows = rawRows.map((row, rowIndex) => normalizeRow(row, columns.length, name, rowIndex));

    return {name, columns, rows};
  });
}

/**
 * 校验工作表名。
 *
 * @param {unknown} rawName 原始名称。
 * @param {number} index 工作表下标。
 * @returns {string} 合法名称。
 * @throws {Error} 名称为空、超长或含非法字符时抛出。
 */
function normalizeSheetName(rawName, index) {
  const name = typeof rawName === 'string' ? rawName.trim() : '';
  if (name === '') throw new Error(`第 ${index + 1} 张工作表缺少名称`);
  if (name.length > 31) throw new Error(`工作表名「${name}」超过 31 个字符，Excel 无法打开`);
  if (INVALID_SHEET_NAME.test(name)) throw new Error(`工作表名「${name}」含有 Excel 不允许的字符`);
  return name;
}

/**
 * 校验并归一列定义。
 *
 * @param {unknown} column 原始列定义。
 * @param {string} sheetName 所属工作表名（用于报错）。
 * @param {number} index 列下标。
 * @returns {{name: string, width: number|null, type: string}} 归一后的列。
 * @throws {Error} 列类型或宽度非法时抛出。
 */
function normalizeColumn(column, sheetName, index) {
  const source = column !== null && typeof column === 'object' ? column : {};
  const rawName = typeof source.name === 'string' ? source.name.trim() : '';
  const name = rawName === '' ? `column_${index + 1}` : rawName;
  const type = source.type === undefined ? 'text' : source.type;
  if (type !== 'text' && type !== 'number' && type !== 'date') {
    throw new Error(`工作表「${sheetName}」的列「${name}」类型非法：${String(type)}`);
  }
  let width = null;
  if (source.width !== undefined && source.width !== null) {
    const parsed = Number(source.width);
    if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 255) {
      throw new Error(`工作表「${sheetName}」的列「${name}」宽度非法：${String(source.width)}`);
    }
    width = parsed;
  }
  return {name, width, type};
}

/**
 * 校验一行数据。
 *
 * @param {unknown} row 原始行。
 * @param {number} columnCount 列数。
 * @param {string} sheetName 所属工作表名。
 * @param {number} rowIndex 行下标。
 * @returns {(string|number|null)[]} 归一后的行。
 * @throws {TypeError} 行不是数组或单元格过多时抛出。
 */
function normalizeRow(row, columnCount, sheetName, rowIndex) {
  if (!Array.isArray(row)) throw new TypeError(`工作表「${sheetName}」第 ${rowIndex + 1} 行不是数组`);
  if (row.length > columnCount) {
    throw new TypeError(`工作表「${sheetName}」第 ${rowIndex + 1} 行有 ${row.length} 个单元格，超过列数 ${columnCount}`);
  }
  return row.map((value) => (value === undefined ? null : value));
}

/**
 * 生成整个 xlsx 的 ZIP 内容。
 *
 * @param {{name: string, columns: object[], rows: object[]}[]} sheets 归一后的工作表。
 * @returns {Buffer} ZIP 字节。
 */
function buildArchive(sheets) {
  const parts = [];
  const stylesId = `rId${sheets.length + 1}`;

  parts.push({name: '[Content_Types].xml', bytes: Buffer.from(buildContentTypes(sheets), 'utf8')});
  parts.push({name: '_rels/.rels', bytes: Buffer.from(buildRootRelationships(), 'utf8')});
  parts.push({name: 'xl/workbook.xml', bytes: Buffer.from(buildWorkbook(sheets), 'utf8')});
  parts.push({name: 'xl/_rels/workbook.xml.rels', bytes: Buffer.from(buildWorkbookRelationships(sheets, stylesId), 'utf8')});
  parts.push({name: 'xl/styles.xml', bytes: Buffer.from(buildStyles(), 'utf8')});
  sheets.forEach((sheet, index) => {
    parts.push({name: `xl/worksheets/sheet${index + 1}.xml`, bytes: Buffer.from(buildWorksheet(sheet), 'utf8')});
  });
  return buildZip(parts);
}

/**
 * 生成 `[Content_Types].xml`。
 *
 * @param {{name: string}[]} sheets 工作表清单。
 * @returns {string} XML 文本。
 */
function buildContentTypes(sheets) {
  const overrides = sheets
    .map((_, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`)
    .join('');
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
    '<Default Extension="xml" ContentType="application/xml"/>',
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>',
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>',
    overrides,
    '</Types>',
  ].join('');
}

/**
 * 生成包级关系 `_rels/.rels`。
 *
 * @returns {string} XML 文本。
 */
function buildRootRelationships() {
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>',
    '</Relationships>',
  ].join('');
}

/**
 * 生成 `xl/workbook.xml`。
 *
 * @param {{name: string}[]} sheets 工作表清单。
 * @returns {string} XML 文本。
 */
function buildWorkbook(sheets) {
  const entries = sheets
    .map((sheet, index) => `<sheet name="${escapeXmlText(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`)
    .join('');
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"',
    ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">',
    '<workbookPr/>',
    `<sheets>${entries}</sheets>`,
    '</workbook>',
  ].join('');
}

/**
 * 生成 `xl/_rels/workbook.xml.rels`。
 *
 * @param {{name: string}[]} sheets 工作表清单。
 * @param {string} stylesId 样式关系 id。
 * @returns {string} XML 文本。
 */
function buildWorkbookRelationships(sheets, stylesId) {
  const entries = sheets
    .map((_, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`)
    .join('');
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
    entries,
    `<Relationship Id="${stylesId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`,
    '</Relationships>',
  ].join('');
}

/**
 * 生成 `xl/styles.xml`：0 号普通样式、1 号加粗表头样式。
 *
 * @returns {string} XML 文本。
 */
function buildStyles() {
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
    '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>',
    '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>',
    '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>',
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>',
    '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>',
    '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>',
    '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>',
    '</styleSheet>',
  ].join('');
}

/**
 * 生成单张工作表的 XML：表头加粗、冻结首行、自动筛选、可选列宽。
 *
 * @param {{name: string, columns: {name: string, width: number|null, type: string}[], rows: (string|number|null)[][]}} sheet 工作表。
 * @returns {string} XML 文本。
 */
function buildWorksheet(sheet) {
  const {columns, rows} = sheet;
  const lastColumn = columnNameOf(Math.max(columns.length, 1) - 1);
  const lastRow = rows.length + 1;

  const chunks = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"',
    ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">',
    `<dimension ref="A1:${lastColumn}${Math.max(lastRow, 1)}"/>`,
    '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>',
    '<selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView></sheetViews>',
    '<sheetFormatPr defaultRowHeight="15"/>',
  ];

  const widths = columns.filter((column) => column.width !== null);
  if (widths.length > 0) {
    chunks.push('<cols>');
    columns.forEach((column, index) => {
      if (column.width === null) return;
      chunks.push(`<col min="${index + 1}" max="${index + 1}" width="${column.width}" customWidth="1"/>`);
    });
    chunks.push('</cols>');
  }

  chunks.push('<sheetData>');
  if (columns.length > 0) {
    chunks.push(`<row r="1" spans="1:${columns.length}">`);
    columns.forEach((column, index) => {
      chunks.push(cellXml(`${columnNameOf(index)}1`, column.name, 'text', true));
    });
    chunks.push('</row>');
  }
  rows.forEach((row, rowIndex) => {
    const rowNumber = rowIndex + 2;
    const cells = [];
    row.forEach((value, columnIndex) => {
      if (value === null) return;
      const cell = cellXml(
        `${columnNameOf(columnIndex)}${rowNumber}`,
        value,
        columns[columnIndex]?.type ?? 'text',
        false,
      );
      if (cell !== '') cells.push(cell);
    });
    if (cells.length === 0) return;
    chunks.push(`<row r="${rowNumber}" spans="1:${columns.length}">${cells.join('')}</row>`);
  });
  chunks.push('</sheetData>');

  if (columns.length > 0 && rows.length > 0) {
    chunks.push(`<autoFilter ref="A1:${lastColumn}${lastRow}"/>`);
  }
  chunks.push('</worksheet>');
  return chunks.join('');
}

/**
 * 生成一个单元格的 XML。
 *
 * 文本写 `inlineStr`；数字写 `<v>`（字符串形态的数字按原样写入，保持 `1.10`）；
 * 日期按契约写 ISO 文本，因此走文本分支。
 *
 * @param {string} ref 单元格引用（如 `B2`）。
 * @param {string|number} value 单元格值。
 * @param {string} type 列类型。
 * @param {boolean} isHeader 是否表头单元格（加粗）。
 * @returns {string} 单元格 XML；空值返回空串。
 * @throws {Error} 数字不是有限数时抛出。
 */
function cellXml(ref, value, type, isHeader) {
  if (value === null || value === undefined) return '';
  if (isHeader) {
    if (String(value).length > MAX_CELL_TEXT_LENGTH) {
      throw new Error(`表头 ${ref} 超过 Excel 单元格文本上限 ${MAX_CELL_TEXT_LENGTH}。`);
    }
    return `<c r="${ref}" s="${HEADER_STYLE_INDEX}" t="inlineStr"><is><t xml:space="preserve">${escapeXmlText(value)}</t></is></c>`;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`单元格 ${ref} 的数字无效：${String(value)}`);
    return `<c r="${ref}"><v>${String(value)}</v></c>`;
  }
  const text = String(value);
  if (text.length > MAX_CELL_TEXT_LENGTH) {
    throw new Error(`单元格 ${ref} 文本长度 ${text.length} 超过 Excel 上限 ${MAX_CELL_TEXT_LENGTH}；请缩短或拆分该列。`);
  }
  if (type === 'number' && NUMERIC_TEXT.test(text)) return `<c r="${ref}"><v>${text}</v></c>`;
  return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escapeXmlText(text)}</t></is></c>`;
}

/**
 * 0 基列号 → 列字母。
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

/**
 * XML 文本转义，并把 XML 1.0 不允许的控制字符转成 Excel 的 `_xHHHH_` 形态。
 *
 * 换行/制表用字符引用保留；回车用 `_x000D_`，否则解析端会把 CRLF 归一掉。
 *
 * @param {unknown} value 原始值。
 * @returns {string} 转义后的文本。
 */
export function escapeXmlText(value) {
  return String(value)
    // XML 1.0 forbids U+FFFE/U+FFFF (and lone surrogates). A value with either
    // noncharacter otherwise produced an unreadable workbook while the export
    // reported success; encode them with Excel's `_xHHHH_` escape.
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '\uFFFD')
    .replace(/[\uFFFE\uFFFF]/g, (character) => (
      `_x${character.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}_`
    ))
    // A literal `_xHHHH_` must be encoded as `_x005F_xHHHH_`, otherwise Excel
    // (and our own reader) decodes the sequence as a character escape on round-trip.
    .replace(/_x([0-9A-Fa-f]{4})_/g, '_x005F_x$1_')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    .replace(/\r/g, '_x000D_')
    .replace(/\n/g, '&#10;')
    .replace(/\t/g, '&#9;')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, (character) => (
      `_x${character.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}_`
    ));
}

/**
 * 生成 ZIP 归档（全部条目用 deflate，大小写在本地头与中央目录里）。
 *
 * @param {{name: string, bytes: Buffer}[]} files 条目列表。
 * @returns {Buffer} ZIP 字节。
 */
function buildZip(files) {
  const localChunks = [];
  const centralChunks = [];
  let offset = 0;

  for (const file of files) {
    const nameBytes = Buffer.from(file.name, 'utf8');
    const content = file.bytes;
    const compressed = zlib.deflateRawSync(content, {level: 6});
    const checksum = crc32Of(content);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(LOCAL_SIGNATURE, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(FLAG_UTF8, 6);
    localHeader.writeUInt16LE(METHOD_DEFLATE, 8);
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(DOS_DATE, 12);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(content.length, 22);
    localHeader.writeUInt16LE(nameBytes.length, 26);
    localHeader.writeUInt16LE(0, 28);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(CENTRAL_SIGNATURE, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(FLAG_UTF8, 8);
    centralHeader.writeUInt16LE(METHOD_DEFLATE, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(DOS_DATE, 14);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(content.length, 24);
    centralHeader.writeUInt16LE(nameBytes.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);

    localChunks.push(localHeader, nameBytes, compressed);
    centralChunks.push(centralHeader, nameBytes);
    offset += localHeader.length + nameBytes.length + compressed.length;
  }

  const centralDirectory = Buffer.concat(centralChunks);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(EOCD_SIGNATURE, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...localChunks, centralDirectory, end]);
}

/** CRC-32 查表（仅在运行环境没有 `zlib.crc32` 时使用）。 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

/**
 * 计算 CRC-32：优先用 Node 内置实现，缺失时退回本地查表。
 *
 * @param {Buffer} buffer 内容。
 * @returns {number} 无符号 CRC-32。
 */
function crc32Of(buffer) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buffer) >>> 0;
  let crc = 0xffffffff;
  for (let index = 0; index < buffer.length; index += 1) {
    crc = CRC_TABLE[(crc ^ buffer[index]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
