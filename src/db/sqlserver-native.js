/**
 * Native SQL Server result reader.
 *
 * `sqlcmd` is a text protocol: the client cannot distinguish NULL from the literal
 * string "NULL", and an embedded newline becomes another physical line. This
 * module uses the TDS driver (tedious) so the server supplies typed columns and
 * values directly; no delimiter/NULL guessing is involved.
 *
 * Only the SQL Server path changes. The other four dialects keep their CLI
 * adapters unchanged.
 *
 * @module src/db/sqlserver-native
 */
import {createRequire} from 'node:module';
/**
 * Install an exact TDS DECIMAL/NUMERIC reader.
 *
 * tedious itself reads the 16-byte integer through JS Number before dividing
 * by 10^scale, which loses precision above 2^53. Its row parser resolves
 * `readValue` from the `value-parser` module at call time, so a narrow
 * runtime shim can return the exact unscaled BigInt rendered as a decimal
 * string. This is the only patched code in the dependency; all other TDS
 * types use tedious unchanged.
 */
let exactDecimalInstalled = false;
/** The only tedious version whose private value-parser shape was verified. */
export const VERIFIED_TEDIOUS_VERSION = '20.3.9';
function installExactDecimalReader() {
  if (exactDecimalInstalled) return;
  const require = createRequire(import.meta.url);
  let tediousPackage;
  try {
    tediousPackage = require('tedious/package.json');
  } catch {
    throw new Error('无法确认 SQL Server 原生驱动 tedious 的版本，拒绝安装精度补丁。');
  }
  if (tediousPackage.version !== VERIFIED_TEDIOUS_VERSION) {
    throw new Error(`SQL Server 原生驱动版本为 ${tediousPackage.version}，本插件只验证过 ${VERIFIED_TEDIOUS_VERSION}；依赖固定在 package.json，请勿单独升级 tedious。`);
  }
  let parser;
  try {
    parser = require('tedious/lib/value-parser');
  } catch {
    throw new Error('SQL Server 原生驱动 tedious 的 value-parser 不可用，拒绝使用有精度歧义的解析。');
  }
  const original = parser.readValue;
  parser.readValue = (buf, offset, metadata, options) => {
    const typeName = metadata?.type?.name;
    if (typeName === 'DecimalN' || typeName === 'NumericN') {
      return readExactDecimal(buf, offset, metadata?.scale);
    }
    // MONEY values are integers scaled by 10000; tedious divides them as JS
    // doubles, which rounds values above 2^53/10000 and made the exactness check
    // reject perfectly valid money amounts. Reconstruct them exactly like DECIMAL.
    if (typeName === 'MoneyN' || typeName === 'Money' || typeName === 'SmallMoney') {
      return readExactMoney(buf, offset, typeName);
    }
    return original(buf, offset, metadata, options);
  };
  exactDecimalInstalled = true;
}

/**
 * Read one TDS MONEY/SMALLMONEY payload as an exact decimal string.
 *
 * Wire format mirrors tedious: Money is a signed 64-bit value split into a
 * little-endian high int32 followed by a little-endian low uint32, scaled by
 * 10000; SmallMoney is a little-endian int32 scaled by 10000; MoneyN prefixes a
 * one-byte length (0 = NULL, 4 = smallmoney, 8 = money).
 *
 * @param {Buffer} buf token buffer.
 * @param {number} offset value start.
 * @param {string} typeName TDS type name.
 * @returns {{value: string|null, offset: number}} exact value and next offset.
 */
export function readExactMoney(buf, offset, typeName) {
  if (typeName === 'MoneyN') {
    const dataLength = buf.readUInt8(offset);
    if (dataLength === 0) return {value: null, offset: offset + 1};
    if (dataLength === 4) return readExactMoney(buf, offset + 1, 'SmallMoney');
    if (dataLength === 8) return readExactMoney(buf, offset + 1, 'Money');
    throw new Error(`不支持 TDS MONEYN 长度 ${dataLength}。`);
  }
  let scaled;
  let position = offset;
  if (typeName === 'SmallMoney') {
    scaled = BigInt(buf.readInt32LE(position));
    position += 4;
  } else {
    const high = BigInt(buf.readInt32LE(position));
    const low = BigInt(buf.readUInt32LE(position + 4));
    scaled = (high << 32n) + low;
    position += 8;
  }
  const negative = scaled < 0n;
  const digits = (negative ? -scaled : scaled).toString().padStart(5, '0');
  const text = `${negative ? '-' : ''}${digits.slice(0, digits.length - 4)}.${digits.slice(-4)}`;
  return {value: text, offset: position};
}

/**
 * Read one TDS DECIMAL/NUMERIC payload as an exact decimal string.
 *
 * Wire format: uint8 byte length, uint8 sign (1 positive / 0 negative), then
 * the little-endian unsigned integer of byteLength-1 bytes.
 *
 * @param {Buffer} buf token buffer.
 * @param {number} offset value start.
 * @param {number|undefined} scale decimal scale.
 * @returns {{value: string|null, offset: number}} exact value and next offset.
 */
export function readExactDecimal(buf, offset, scale) {
  let position = offset;
  const byteLength = buf.readUInt8(position);
  position += 1;
  if (byteLength === 0) return {value: null, offset: position};
  if (![5, 9, 13, 17].includes(byteLength)) throw new Error(`不支持 TDS DECIMAL 长度 ${byteLength}。`);
  const positive = buf.readUInt8(position) === 1;
  position += 1;
  const digits = byteLength - 1;
  let unscaled = 0n;
  for (let index = 0; index < digits; index += 1) {
    unscaled |= BigInt(buf[position + index]) << BigInt(index * 8);
  }
  position += digits;
  const actualScale = Number.isInteger(scale) && scale >= 0 ? scale : 0;
  let text = unscaled.toString().padStart(actualScale + 1, '0');
  const integer = text.slice(0, text.length - actualScale) || '0';
  const fraction = actualScale === 0 ? '' : `.${text.slice(text.length - actualScale)}`;
  text = `${positive || unscaled === 0n ? '' : '-'}${integer}${fraction}`;
  return {value: text, offset: position};
}

/** Types for which tedious returns a Date object. */
const DATE_TYPES = new Set(['DateTime', 'DateTime2', 'SmallDateTime', 'Date', 'Time', 'DateTimeOffset']);
/** Numeric types with a scale that must be rendered exactly. */
const DECIMAL_TYPES = new Set(['DecimalN', 'NumericN', 'MoneyN', 'Money', 'SmallMoney']);

/**
 * Render a SQL Server date/time value without applying a timezone shift.
 *
 * datetime/datetime2/smalldatetime have no offset; tedious produces a Date that
 * represents the database wall-clock in the process timezone. Formatting its
 * local components preserves the value the server returned. datetimeoffset is
 * normalized to ISO (the instant is preserved; the original offset is not part
 * of the current result contract).
 *
 * @param {Date} value date.
 * @param {string} typeName SQL Server type name.
 * @param {number|undefined} scale fractional seconds scale.
 * @returns {string} serialized value.
 */
export function formatSqlServerTemporal(value, typeName, scale) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) return String(value);
  if (typeName === 'DateTimeOffset') return value.toISOString();
  const pad = (number, width = 2) => String(number).padStart(width, '0');
  if (typeName === 'Date') return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
  if (typeName === 'Time') {
    const digits = Number.isInteger(scale) ? Math.min(scale, 3) : 3;
    const fraction = digits <= 0 ? '' : `.${pad(value.getMilliseconds(), 3).slice(0, digits)}`;
    return `${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}${fraction}`;
  }
  const digits = Number.isInteger(scale) ? Math.min(scale, 3) : 3;
  const fraction = digits <= 0 ? '' : `.${pad(value.getMilliseconds(), 3).slice(0, digits)}`;
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())} ${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}${fraction}`;
}

/**
 * Render a DECIMAL/NUMERIC value exactly, or refuse instead of silently losing
 * precision. Tedious parses TDS decimal into a JS number; when the scaled
 * integer fits in a safe integer we can reconstruct the exact value. Larger
 * precision is refused because the driver has already rounded the value.
 *
 * @param {number} value parsed value.
 * @param {number|undefined} scale decimal scale.
 * @returns {string} exact decimal text.
 */
export function formatSqlServerDecimal(value, scale) {
  if (!Number.isFinite(value)) throw new Error('SQL Server DECIMAL 返回了非有限数值，拒绝导出。');
  const actualScale = Number.isInteger(scale) && scale >= 0 ? scale : 0;
  const factor = 10 ** actualScale;
  const scaled = value * factor;
  const rounded = Math.round(scaled);
  if (!Number.isSafeInteger(rounded) || Math.abs(scaled - rounded) > 1e-7) {
    throw new Error('SQL Server DECIMAL 超出安全精度，当前驱动无法可靠保真；请将该列 CAST 为 VARCHAR 后重试，插件不会静默四舍五入。');
  }
  const negative = rounded < 0;
  const digits = String(Math.abs(rounded)).padStart(actualScale + 1, '0');
  const integer = digits.slice(0, digits.length - actualScale) || '0';
  const fraction = actualScale === 0 ? '' : `.${digits.slice(digits.length - actualScale)}`;
  return `${negative ? '-' : ''}${integer}${fraction}`;
}

/**
 * Convert one TDS cell to the plugin's string/null row model.
 *
 * @param {unknown} value driver value.
 * @param {{name?: string, scale?: number}} metadata column metadata.
 * @returns {string|null} serialized value.
 */
export function sqlServerValue(value, metadata) {
  if (value === null || value === undefined) return null;
  const typeName = metadata?.name ?? '';
  if (value instanceof Date || DATE_TYPES.has(typeName)) {
    return formatSqlServerTemporal(value, typeName, metadata?.scale);
  }
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number') {
    if (DECIMAL_TYPES.has(typeName)) {
      // Money/SmallMoney always carry four decimal places; tedious leaves their
      // metadata scale undefined, which previously made every money value look
      // like a precision error.
      const money = typeName === 'Money' || typeName === 'MoneyN' || typeName === 'SmallMoney';
      return formatSqlServerDecimal(value, money ? 4 : metadata?.scale);
    }
    if (!Number.isFinite(value)) throw new Error('SQL Server 返回了非有限数值，拒绝导出。');
    return String(value);
  }
  if (Buffer.isBuffer(value)) return value.toString('hex');
  if (value instanceof Uint8Array) return Buffer.from(value).toString('hex');
  return String(value);
}

/**
 * Execute one read-only statement through the native TDS driver.
 *
 * @param {object} connection source connection.
 * @param {{sql: string, password?: string, maxRows: number, timeoutMs?: number, signal?: AbortSignal}} request request.
 * @returns {Promise<object>} run-shaped result.
 */
export async function runSqlServerNative(connection, request) {
  installExactDecimalReader();
  let tedious;
  try {
    tedious = await import('tedious');
  } catch {
    throw new Error('SQL Server 原生驱动 tedious 不可用；请安装依赖后重试（不会退回有 NULL/换行歧义的 sqlcmd 文本解析）。');
  }
  const {Connection, Request} = tedious;
  const started = Date.now();
  const maxRows = Math.max(1, request.maxRows ?? 1000);
  const maxBytes = Math.max(1024 * 1024, request.maxBytes ?? 8 * 1024 * 1024);
  const config = {
    server: connection.host ?? '127.0.0.1',
    authentication: {
      type: 'default',
      options: {userName: connection.user ?? 'sa', password: request.password ?? ''},
    },
    options: {
      port: connection.port ?? 1433,
      database: connection.database,
      encrypt: true,
      trustServerCertificate: connection.trustServerCertificate === true,
      rowCollectionOnRequestCompletion: false,
      useColumnNames: false,
      useUTC: false,
      connectionTimeout: request.timeoutMs ?? 30_000,
      requestTimeout: request.timeoutMs ?? 30_000,
      cancelTimeout: 5_000,
    },
  };
  const conn = new Connection(config);
  const columns = [];
  const rows = [];
  let resultSetCount = 0;
  let rowLimitExceeded = false;
  let byteLimitExceeded = false;
  let storedBytes = 0;
  let settled = false;
  let stopped = false;
  let timer = null;
  let abortHandler = null;
  const warnings = [];

  const cleanup = () => {
    if (timer !== null) clearTimeout(timer);
    if (abortHandler !== null && request.signal !== undefined) request.signal.removeEventListener('abort', abortHandler);
    try { conn.close(); } catch { /* already closed */ }
  };

  return new Promise((resolve, reject) => {
    const fail = (error) => {
      if (settled) return;
      // After a deliberate row/byte cap the driver reports a cancellation
      // error; that is not a failure, the partial prefix is the result.
      if (stopped) { succeed(); return; }
      settled = true;
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const succeed = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({
        columns,
        rows,
        rowLimitExceeded,
        truncated: byteLimitExceeded,
        exitCode: 0,
        elapsedMs: Date.now() - started,
        executedSql: request.sql,
        enforcement: 'account',
        warnings,
      });
    };

    conn.on('error', fail);
    conn.on('connect', (error) => {
      if (error) { fail(error); return; }
      const req = new Request(request.sql, (error) => {
        if (error) { fail(error); return; }
        succeed();
      });
      req.on('columnMetadata', (metadata) => {
        resultSetCount += 1;
        if (resultSetCount > 1) {
          req.cancel();
          fail(new Error('SQL Server 返回了多个结果集，当前读取器只支持单个结果集；已拒绝作为完整结果导出。'));
          return;
        }
        const names = metadata.map((column) => column.colName);
        const normalized = names.map((name) => String(name).toLowerCase());
        if (new Set(normalized).size !== normalized.length) {
          req.cancel();
          fail(new Error('SQL Server 结果包含重复列名，无法无损映射为一行；请为重复列设置不同别名。'));
          return;
        }
        for (const column of metadata) {
          const typeName = column.type?.name;
          // A JS Date keeps milliseconds only; TDStime/datetime2 can carry up to
          // seven fractional digits, so be explicit about the lost precision.
          if ((typeName === 'DateTime2' || typeName === 'Time' || typeName === 'DateTimeOffset') && Number(column.scale) > 3) {
            warnings.push(`列「${column.colName}」为 ${typeName}(${column.scale})：驱动只保留毫秒，亚毫秒位不会进入结果；需要逐位精确请在 SQL 中 CAST 为 VARCHAR。`);
          }
        }
        columns.push(...names);
      });
      req.on('row', (row) => {
        if (stopped) return;
        if (rows.length >= maxRows) {
          rowLimitExceeded = true;
          stopped = true;
          try { req.cancel(); } catch { /* already finished */ }
          return;
        }
        const output = {};
        let rowBytes = 0;
        row.forEach((cell, index) => {
          const name = columns[index] ?? cell.metadata?.colName ?? `column_${index + 1}`;
          const metadata = {...cell.metadata, name: cell.metadata?.type?.name ?? cell.metadata?.name};
          const value = sqlServerValue(cell.value, metadata);
          output[name] = value;
          rowBytes += Buffer.byteLength(name, 'utf8') + (value === null ? 0 : Buffer.byteLength(value, 'utf8'));
        });
        if (storedBytes + rowBytes > maxBytes) {
          // Keep rows a strict prefix of the server result: refusing this row
          // and all later rows is what "truncated" means.
          byteLimitExceeded = true;
          stopped = true;
          try { req.cancel(); } catch { /* already finished */ }
          return;
        }
        storedBytes += rowBytes;
        rows.push(output);
      });
      if (request.signal !== undefined) {
        if (request.signal.aborted) { req.cancel(); fail(new Error('SQL Server 查询已取消。')); return; }
        abortHandler = () => { try { req.cancel(); } catch { /* closing */ } fail(new Error('SQL Server 查询已取消。')); };
        request.signal.addEventListener('abort', abortHandler, {once: true});
      }
      timer = setTimeout(() => {
        try { req.cancel(); } catch { /* closing */ }
        fail(new Error(`SQL Server 查询超时（${request.timeoutMs ?? 30_000}ms），结果不完整。`));
      }, request.timeoutMs ?? 30_000);
      try { conn.execSql(req); } catch (error) { fail(error); }
    });
    try { conn.connect(); } catch (error) { fail(error); }
  });
}
