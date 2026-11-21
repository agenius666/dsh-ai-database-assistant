/**
 * Dataset loading.
 *
 * A dataset is the only way the engine touches records: the dataset is fully loaded (or
 * explicitly truncated) before a rule runs, so a rule implementation never
 * issues I/O of its own and every result can point at the exact query and row
 * numbers the dataset came from.
 *
 * @module src/engine/dataset
 */
import {AssistantError, ERROR_CODES} from '../core/errors.js';
import {quoteIdentifier} from '../core/sql-safety.js';
import {compareDecimal} from '../core/value.js';

/** Default cap on rows loaded per source. */
export const DEFAULT_MAX_ROWS_PER_SOURCE = 200_000;
/** Rows requested per page when paging a database source. */
export const PAGE_SIZE = 20_000;

/**
 * @typedef {Object} Dataset
 * @property {'left'|'right'} side side label.
 * @property {string} sourceId analysis source id.
 * @property {string} sourceName display name.
 * @property {string[]} columns column names.
 * @property {Record<string, string|null>[]} rows rows.
 * @property {number[]} rowNumbers original row numbers (1-based) used for traceability.
 * @property {number} rowCount loaded row count.
 * @property {boolean} truncated whether a row cap stopped the load.
 * @property {string} observedAt ISO time the load started.
 * @property {string[]} statements executed SQL statements (no credentials).
 * @property {string[]} warnings non-fatal observations.
 * @property {boolean} orderStable whether paging used a stable order.
 */

/**
 * Load one side of a rule.
 *
 * @param {{
 *   side: 'left'|'right',
 *   source: object,
 *   dataset: object,
 *   runner: import('../db/read.js').ReadOnlyRunner,
 *   password?: string,
 *   signal?: AbortSignal,
 *   onProgress?: (progress: {loaded: number, phase: string}) => void,
 *   maxRows?: number,
 * }} request load request.
 * @returns {Promise<Dataset>} loaded dataset.
 */
export async function loadDataset(request) {
  const {side, source, dataset, runner, signal, onProgress} = request;
  const maxRows = request.maxRows ?? source.maxRowsPerSource ?? DEFAULT_MAX_ROWS_PER_SOURCE;
  const observedAt = new Date().toISOString();
  if (source === undefined || source === null) throw new AssistantError(ERROR_CODES.notFound, `${side} 数据源不存在。`);
  if (source.kind === 'file') return loadFileDataset({side, source, dataset, maxRows, observedAt, signal, onProgress});
  return loadDatabaseDataset({side, source, dataset, runner, password: request.password, maxRows, observedAt, signal, onProgress});
}

/**
 * Load a file dataset.
 *
 * @param {{side: 'left'|'right', source: object, dataset: object, maxRows: number, observedAt: string,
 *   signal?: AbortSignal, onProgress?: Function}} request load request.
 * @returns {Promise<Dataset>} dataset.
 */
async function loadFileDataset(request) {
  const {side, source, dataset, maxRows, observedAt, signal, onProgress} = request;
  if (typeof source.storedPath !== 'string' || source.storedPath === '') {
    throw new AssistantError(ERROR_CODES.sourceUnavailable, `${side} 文件数据源「${source.name}」缺少已导入文件。`);
  }
  signal?.throwIfAborted();
  onProgress?.({loaded: 0, phase: 'reading-file'});
  // Loaded lazily so the engine core stays importable without the file
  // readers (and so a profile without the formats module still boots).
  const {readTableFile} = await import('../formats/index.js');
  const parsed = await readTableFile(source.storedPath, {
    maxRows,
    sheet: dataset.sheet ?? source.sheet,
  });
  const columns = dataset.columns === undefined || dataset.columns.length === 0 ? parsed.columns : dataset.columns;
  const missing = columns.filter((column) => !parsed.columns.includes(column));
  if (missing.length > 0) {
    throw new AssistantError(ERROR_CODES.invalidInput, `${side} 数据源「${source.name}」缺少列：${missing.join('、')}`, {
      details: {availableColumns: parsed.columns},
    });
  }
  // Unknown filter columns used to filter everything out silently; make them
  // an explicit input error, matching the database path (where the SQL fails).
  for (const filter of Array.isArray(dataset.filters) ? dataset.filters : []) {
    if (!parsed.columns.includes(filter.column)) {
      throw new AssistantError(ERROR_CODES.invalidInput, `${side} 文件数据源「${source.name}」的过滤列不存在：${filter.column}`);
    }
  }
  const filtered = applyFilters(parsed.rows, dataset.filters, columns, parsed.rowNumbers);
  const warnings = [];
  if (parsed.meta.truncated) warnings.push('文件读取达到行数上限，结果被截断。');
  if (parsed.meta.uncomputableCells > 0) {
    warnings.push(`文件中有 ${parsed.meta.uncomputableCells} 个公式单元格没有缓存值，按空值处理。`);
  }
  if (parsed.issues.length > 0) warnings.push(`文件解析发现 ${parsed.issues.length} 条异常，详见导入记录。`);
  onProgress?.({loaded: filtered.rows.length, phase: 'loaded'});
  return {
    side,
    sourceId: source.id,
    sourceName: source.name,
    columns,
    columnsKnown: columns.length > 0,
    rows: filtered.rows.map((row) => pick(row, columns)),
    rowNumbers: filtered.rowNumbers,
    rowCount: filtered.rows.length,
    truncated: parsed.meta.truncated,
    observedAt,
    statements: [],
    warnings,
    orderStable: true,
    fileMeta: parsed.meta,
    parseIssues: parsed.issues.slice(0, 200),
  };
}

/**
 * Load a database dataset with paging.
 *
 * @param {{side: 'left'|'right', source: object, dataset: object, runner: object, password?: string,
 *   maxRows: number, observedAt: string, signal?: AbortSignal, onProgress?: Function}} request load request.
 * @returns {Promise<Dataset>} dataset.
 */
async function loadDatabaseDataset(request) {
  const {side, source, dataset, runner, password, maxRows, observedAt, signal, onProgress} = request;
  const dialect = source.dialect;
  const statements = [];
  const warnings = [];
  const rows = [];
  let truncated = false;
  let columns = [];
  let consistency = null;
  const orderColumns = dataset.orderBy ?? [];

  // MySQL: one statement, streamed. This is the only path that gives a
  // consistent read view across the whole result (see src/db/stream.js).
  if (dialect === 'mysql' && typeof runner.streamRead === 'function' && runner.streamRead !== undefined) {
    const sql = dataset.kind === 'sql' ? dataset.sql : streamTableSql(dialect, dataset, orderColumns);
    const streamed = await runner.streamRead(source, {
      sql,
      password,
      signal,
      maxRows,
      label: `dataset-load:${side}`,
      onProgress: (loaded) => onProgress?.({loaded, phase: 'streaming'}),
    });
    statements.push(streamed.executedSql);
    columns = streamed.columns;
    // Never spread a whole result set into push(): 200k arguments overflow the
    // stack. The streamed array is already the dataset rows.
    for (const row of streamed.rows) rows.push(row);
    truncated = streamed.truncated;
    consistency = streamed.consistency;
    warnings.push(...streamed.warnings);
    if (streamed.capReached) warnings.push(`读取达到每侧 ${maxRows} 行上限，结果被截断。`);
    if (streamed.bytesReached) warnings.push('读取达到输出字节上限，结果被截断。');
    if (columns.length === 0) {
      if (dataset.kind === 'table') {
        try {
          const described = await runner.describeTable(source, {table: dataset.table, schema: dataset.schema, password, signal});
          columns = described.map((column) => column.name);
          warnings.push('该侧查询返回 0 行，列结构已从数据字典补齐。');
        } catch (error) {
          warnings.push(`该侧查询返回 0 行且无法取得列结构：${error instanceof Error ? error.message : String(error)}`);
        }
      } else {
        warnings.push('只读查询返回 0 行且无法取得列结构；按空数据集处理，未校验列名。');
      }
    }
    if (orderColumns.length === 0 && rows.length > 1) {
      warnings.push('未指定排序列，已在内存按整行内容排序，以保证结果可重复。');
      const sorted = sortDeterministically(rows);
      rows.length = 0;
      for (const row of sorted) rows.push(row);
    }
    return {
      side,
      sourceId: source.id,
      sourceName: source.name,
      columns,
      columnsKnown: columns.length > 0,
      rows,
      rowNumbers: rows.map((_, index) => index + 1),
      rowCount: rows.length,
      truncated,
      observedAt,
      statements,
      warnings,
      orderStable: orderColumns.length > 0,
      readEngine: 'mysql-stream',
      consistency,
    };
  }

  if (dataset.kind === 'sql') {
    const result = await runner.run(source, {
      sql: dataset.sql,
      password,
      signal,
      maxRows,
      label: `dataset-load:${side}`,
    });
    if (result.exitCode !== 0) throw new AssistantError(ERROR_CODES.sourceUnavailable, `${side} 数据源查询失败：${result.stderr ?? '未知错误'}`);
    statements.push(result.executedSql ?? dataset.sql);
    columns = result.columns;
    // Spread would hit the argument-count ceiling on large result sets
    // (V8 throws RangeError around 125k rows); push one by one instead.
    for (const row of result.rows) rows.push(row);
    truncated = result.truncated === true || result.rowLimitExceeded === true || result.rows.length >= maxRows;
    warnings.push(...result.warnings);
    onProgress?.({loaded: rows.length, phase: 'loaded'});
    if (columns.length === 0) {
      warnings.push('只读查询返回 0 行且无法取得列结构；按空数据集处理，未校验列名。');
    }
    return {
      side, sourceId: source.id, sourceName: source.name, columns,
      columnsKnown: columns.length > 0, rows,
      rowNumbers: rows.map((_, index) => index + 1), rowCount: rows.length,
      truncated, observedAt, statements, warnings, orderStable: false,
    };
  }

  if (typeof dataset.table !== 'string' || dataset.table === '') {
    throw new AssistantError(ERROR_CODES.invalidInput, `${side} 数据集缺少表名。`);
  }
  const orderStable = orderColumns.length > 0;
  if (!orderStable) warnings.push('未指定排序列，分页顺序由数据库决定，可能影响重复行定位。');
  let offset = 0;
  while (rows.length < maxRows) {
    signal?.throwIfAborted();
    const pageLimit = Math.min(PAGE_SIZE, maxRows - rows.length);
    const sql = pageSql(dialect, dataset, orderColumns, pageLimit, offset);
    statements.push(sql);
    const result = await runner.run(source, {sql, password, signal, maxRows: pageLimit, label: `dataset-load:${side}`});
    if (result.exitCode !== 0) throw new AssistantError(ERROR_CODES.sourceUnavailable, `${side} 数据源查询失败：${result.stderr ?? '未知错误'}`);
    if (columns.length === 0) columns = result.columns;
    // Spread would hit the argument-count ceiling on large result sets
    // (V8 throws RangeError around 125k rows); push one by one instead.
    for (const row of result.rows) rows.push(row);
    warnings.push(...result.warnings);
    onProgress?.({loaded: rows.length, phase: 'loading'});
    // A page whose captured output hit the byte cap was parsed partially; the
    // dataset is incomplete even though the row count looks normal.
    if (result.truncated === true || result.rowLimitExceeded === true) {
      truncated = true;
      break;
    }
    if (result.rows.length < pageLimit) break;
    offset += result.rows.length;
    if (rows.length >= maxRows) {
      truncated = true;
      break;
    }
  }
  if (columns.length === 0) {
    // An empty result set carries no column names: the mysql client prints no
    // header for zero rows even in XML mode. Resolve the schema from the rows
    // dictionary so a legitimately empty side still reconciles as "no rows"
    // instead of failing column validation.
    if (dataset.kind === 'table') {
      try {
        const described = await runner.describeTable(source, {table: dataset.table, schema: dataset.schema, password, signal});
        columns = described.map((column) => column.name);
        warnings.push('该侧查询返回 0 行，列结构已从数据字典补齐。');
      } catch (error) {
        warnings.push(`该侧查询返回 0 行且无法取得列结构：${error instanceof Error ? error.message : String(error)}`);
      }
    } else {
      warnings.push('只读查询返回 0 行且无法取得列结构；按空数据集处理，未校验列名。');
    }
  }
  return {
    side,
    sourceId: source.id,
    sourceName: source.name,
    columns,
    columnsKnown: columns.length > 0,
    rows,
    rowNumbers: rows.map((_, index) => index + 1),
    rowCount: rows.length,
    truncated,
    observedAt,
    statements,
    warnings,
    orderStable,
  };
}

/**
 * Build the single SELECT used by the streaming MySQL path.
 *
 * No OFFSET: one statement keeps InnoDB's statement-level read view, so a
 * concurrent delete cannot shift a later page. The reader still caps rows.
 *
 * @param {string} dialect dialect.
 * @param {object} dataset dataset spec.
 * @param {string[]} orderColumns ordering columns.
 * @returns {string} SQL statement.
 */
export function streamTableSql(dialect, dataset, orderColumns) {
  const table = qualifiedTable(dialect, dataset);
  const where = whereClause(dialect, dataset.filters);
  const order = orderColumns.length === 0 ? '' : ` ORDER BY ${orderColumns.map((column) => quoteIdentifier(dialect, column)).join(', ')}`;
  return `SELECT * FROM ${table}${where}${order}`;
}

/**
 * Sort rows by their canonical content so row numbers and exception ids stay
 * reproducible when the database gives no stable order.
 *
 * @param {Record<string, string|null>[]} rows rows.
 * @returns {Record<string, string|null>[]} sorted rows.
 */
function sortDeterministically(rows) {
  // Pre-compute the canonical key once per row: stringifying inside the
  // comparator is both slow and unnecessary for large result sets.
  return rows
    .map((row) => ({row, key: JSON.stringify(row)}))
    .sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0))
    .map((entry) => entry.row);
}

/**
 * Build one paged SELECT for the dialect.
 *
 * @param {string} dialect dialect.
 * @param {object} dataset dataset spec.
 * @param {string[]} orderColumns stable ordering columns.
 * @param {number} limit page size.
 * @param {number} offset rows to skip.
 * @returns {string} SQL statement.
 */
export function pageSql(dialect, dataset, orderColumns, limit, offset) {
  const table = qualifiedTable(dialect, dataset);
  const where = whereClause(dialect, dataset.filters);
  const order = orderColumns.length === 0 ? '' : ` ORDER BY ${orderColumns.map((column) => quoteIdentifier(dialect, column)).join(', ')}`;
  const base = `SELECT * FROM ${table}${where}${order}`;
  if (dialect === 'sqlserver') {
    const stable = order === '' ? ' ORDER BY (SELECT NULL)' : order;
    return `SELECT * FROM ${table}${where}${stable} OFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY`;
  }
  if (dialect === 'oracle') {
    // Oracle 12c+ OFFSET/FETCH avoids the helper ROWNUM column that used to
    // leak into the dataset's columns (and clash with a business column).
    return `${base} OFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY`;
  }
  return `${base} LIMIT ${limit} OFFSET ${offset}`;
}

/**
 * Render a table reference.
 *
 * @param {string} dialect dialect.
 * @param {object} dataset dataset spec.
 * @returns {string} quoted table name.
 */
function qualifiedTable(dialect, dataset) {
  const table = quoteIdentifier(dialect, dataset.table);
  if (typeof dataset.schema === 'string' && dataset.schema !== '') return `${quoteIdentifier(dialect, dataset.schema)}.${table}`;
  return table;
}

/**
 * Render a WHERE clause from rule filters.
 *
 * @param {string} dialect dialect.
 * @param {object[]|undefined} filters filters.
 * @returns {string} clause text, including a leading space, or ''.
 */
export function whereClause(dialect, filters) {
  if (!Array.isArray(filters) || filters.length === 0) return '';
  const parts = filters.map((filter) => {
    const column = quoteIdentifier(dialect, filter.column);
    switch (filter.op) {
      case 'isnull':
        return `${column} IS NULL`;
      case 'notnull':
        return `${column} IS NOT NULL`;
      case 'in':
        return `${column} IN (${filter.value.map((value) => literal(value, dialect)).join(', ')})`;
      case 'between':
        return `${column} BETWEEN ${literal(filter.value[0], dialect)} AND ${literal(filter.value[1], dialect)}`;
      case 'like':
        return `${column} LIKE ${literal(filter.value, dialect)}`;
      case 'ne':
        return `${column} <> ${literal(filter.value, dialect)}`;
      case 'gt':
        return `${column} > ${literal(filter.value, dialect)}`;
      case 'gte':
        return `${column} >= ${literal(filter.value, dialect)}`;
      case 'lt':
        return `${column} < ${literal(filter.value, dialect)}`;
      case 'lte':
        return `${column} <= ${literal(filter.value, dialect)}`;
      default:
        return `${column} = ${literal(filter.value, dialect)}`;
    }
  });
  return ` WHERE ${parts.join(' AND ')}`;
}

/**
 * Render a SQL literal for a filter value.
 *
 * Filter values come from an user-authored rule, never from the model, and
 * are still escaped rather than interpolated raw.
 *
 * @param {unknown} value value.
 * @returns {string} literal.
 */
function literal(value, dialect) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return value ? '1' : '0';
  let text = String(value).replace(/'/g, "''");
  // MySQL's default sql_mode treats backslash as an escape inside literals;
  // a filter value such as `a\' OR 1=1 --` would otherwise break out.
  if (dialect === 'mysql') text = text.replace(/\\/g, '\\\\');
  return `'${text}'`;
}

/**
 * Apply in-memory filters to file rows.
 *
 * @param {Record<string, string|null>[]} rows rows.
 * @param {object[]|undefined} filters filters.
 * @param {string[]} columns selected columns.
 * @returns {{rows: Record<string, string|null>[], rowNumbers: number[]}} filtered rows.
 */
export function applyFilters(rows, filters, columns, sourceRowNumbers) {
  // Keep the parity between a row and its ORIGINAL line: an empty CSV line or
  // a multi-line quoted value shifts positional numbering, so reuse the
  // parser's row numbers when the parser provides them.
  const original = Array.isArray(sourceRowNumbers) && sourceRowNumbers.length === rows.length
    ? sourceRowNumbers
    : rows.map((_, index) => index + 1);
  if (!Array.isArray(filters) || filters.length === 0) {
    return {rows, rowNumbers: original};
  }
  const kept = [];
  const rowNumbers = [];
  rows.forEach((row, index) => {
    if (filters.every((filter) => matches(row[filter.column], filter))) {
      kept.push(row);
      rowNumbers.push(original[index]);
    }
  });
  return {rows: kept, rowNumbers};
}

/**
 * Evaluate one filter against one value.
 *
 * @param {string|null|undefined} raw cell value.
 * @param {object} filter filter.
 * @returns {boolean} whether the row matches.
 */
function matches(raw, filter) {
  const value = raw ?? null;
  switch (filter.op) {
    case 'isnull':
      return value === null || value === '';
    case 'notnull':
      return value !== null && value !== '';
    case 'in':
      return filter.value.some((candidate) => equalish(value, candidate));
    case 'between':
      return compareOrder(value, filter.value[0]) >= 0 && compareOrder(value, filter.value[1]) <= 0;
    case 'ne':
      return !equalish(value, filter.value);
    case 'gt':
      return compareOrder(value, filter.value) > 0;
    case 'gte':
      return compareOrder(value, filter.value) >= 0;
    case 'lt':
      return compareOrder(value, filter.value) < 0;
    case 'lte':
      return compareOrder(value, filter.value) <= 0;
    case 'like':
      return like(value, filter.value);
    default:
      return equalish(value, filter.value);
  }
}

/**
 * Text/loose equality used by filters.
 *
 * @param {unknown} left value.
 * @param {unknown} right value.
 * @returns {boolean} equality.
 */
function equalish(left, right) {
  if (left === null || left === undefined) return right === null || right === undefined;
  return String(left) === String(right);
}

/**
 * Order comparison that prefers exact decimal comparison when possible.
 *
 * @param {unknown} left value.
 * @param {unknown} right value.
 * @returns {number} negative, zero, or positive.
 */
function compareOrder(left, right) {
  if (left === null || left === undefined) return -1;
  const numeric = compareDecimal(left, right);
  if (numeric !== null) {
    if (numeric.left === numeric.right) return 0;
    const leftValue = Number(numeric.left);
    const rightValue = Number(numeric.right);
    if (Number.isFinite(leftValue) && Number.isFinite(rightValue)) return leftValue < rightValue ? -1 : 1;
  }
  return String(left) < String(right) ? -1 : String(left) > String(right) ? 1 : 0;
}

/**
 * Translate a SQL LIKE pattern to a regular expression.
 *
 * @param {unknown} value cell value.
 * @param {unknown} pattern LIKE pattern.
 * @returns {boolean} whether the value matches.
 */
function like(value, pattern) {
  const text = String(value ?? '');
  const source = String(pattern).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.');
  return new RegExp(`^${source}$`).test(text);
}

/**
 * Keep only the selected columns of a row.
 *
 * @param {Record<string, string|null>} row row.
 * @param {string[]} columns selected columns.
 * @returns {Record<string, string|null>} projected row.
 */
function pick(row, columns) {
  const out = {};
  for (const column of columns) out[column] = row[column] === undefined ? null : row[column];
  return out;
}
