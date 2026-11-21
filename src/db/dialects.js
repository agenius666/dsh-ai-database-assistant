import {existsSync} from 'node:fs';

/**
 * Database dialect descriptors for the read-only analysis path.
 *
 * Each descriptor answers three questions the runner cannot guess:
 *   1. How is the client invoked (argv only; SQL always goes through stdin)?
 *   2. How does the client's machine output parse back into `{columns, rows}`?
 *   3. What read-only hardening can be applied at the session level?
 *
 * Matching the upstream project's rule: the password never enters `argv` and
 * travels only through an environment variable or a stdin prologue.
 *
 * @module src/db/dialects
 */

/** NULL marker used across dialects so a literal 'NULL' string stays distinct. */
export const NULL_TOKEN = '\u241f';
/**
 * PostgreSQL NULL marker.
 *
 * The psql client converts a non-ASCII `-P null=` argument through the Windows
 * ANSI code page before it is used, so U+241F arrives as `?` on a Chinese
 * Windows host and every SQL NULL became the literal string "?". The token must
 * therefore be pure ASCII; the C0 control characters make an accidental data
 * collision practically impossible and survive the argv round trip.
 */
export const PG_NULL_TOKEN = '\u001fDSH_NULL\u001f';
/** SQL Server field separator (a control character unlikely to appear in values). */
export const SQLSERVER_SEPARATOR = '\u001f';

/**
 * @typedef {Object} Connection
 * @property {string} id analysis source id.
 * @property {string} name display name.
 * @property {string} dialect one of the keys of `DIALECTS`.
 * @property {string} [host] host name.
 * @property {number} [port] TCP port.
 * @property {string} [user] login name.
 * @property {string} [database] database or service name.
 * @property {string} [file] SQLite file path.
 * @property {string} [schema] default schema.
 * @property {string} [passwordRef] credential reference (never a password).
 * @property {string} [command] client executable override.
 */

/**
 * Dialect registry.
 *
 * `tier` follows the requirement's priority list. `supported: false` dialects
 * are listed so the workbench can explain *why* they are unavailable instead of
 * silently hiding them.
 */
export const DIALECTS = Object.freeze({
  sqlite: {
    label: 'SQLite',
    tier: 1,
    supported: true,
    file: true,
    defaultPort: 0,
    defaultUser: '',
    client: 'sqlite3',
    readOnly: 'session',
    readOnlyNote: '客户端 -readonly 以只读方式打开数据库文件',
  },
  mysql: {
    label: 'MySQL',
    tier: 1,
    supported: true,
    file: false,
    defaultPort: 3306,
    defaultUser: 'root',
    client: 'mysql',
    readOnly: 'session',
    readOnlyNote: '查询前强制 SET SESSION TRANSACTION READ ONLY；数据库拒绝时本次查询失败（不降级重试）',
  },
  postgres: {
    label: 'PostgreSQL',
    tier: 1,
    supported: true,
    file: false,
    defaultPort: 5432,
    defaultUser: 'postgres',
    client: 'psql',
    readOnly: 'session',
    readOnlyNote: 'PGOPTIONS 始终设置 default_transaction_read_only=on（与是否提供密码无关）',
  },
  sqlserver: {
    label: 'SQL Server',
    tier: 1,
    supported: true,
    file: false,
    defaultPort: 1433,
    defaultUser: 'sa',
    client: 'sqlcmd',
    readOnly: 'account',
    readOnlyNote: '客户端无会话级只读开关，仅账号级只读 + 语句级拦截',
  },
  oracle: {
    label: 'Oracle',
    tier: 1,
    supported: true,
    file: false,
    defaultPort: 1521,
    defaultUser: '',
    client: 'sqlplus',
    readOnly: 'account',
    readOnlyNote: '客户端无会话级只读开关，仅账号级只读 + 语句级拦截',
  },
  doris: {
    label: 'Apache Doris',
    tier: 2,
    supported: false,
    file: false,
    defaultPort: 9030,
    defaultUser: 'root',
    client: 'mysql',
    readOnly: 'account',
    readOnlyNote: '本版未实现',
  },
  hive: {
    label: 'Hive',
    tier: 2,
    supported: false,
    file: false,
    defaultPort: 10000,
    defaultUser: '',
    client: 'beeline',
    readOnly: 'account',
    readOnlyNote: '本版未实现',
  },
  impala: {
    label: 'Impala',
    tier: 2,
    supported: false,
    file: false,
    defaultPort: 21050,
    defaultUser: '',
    client: 'impala-shell',
    readOnly: 'account',
    readOnlyNote: '本版未实现',
  },
  clickhouse: {
    label: 'ClickHouse',
    tier: 2,
    supported: false,
    file: false,
    defaultPort: 8123,
    defaultUser: 'default',
    client: 'clickhouse-client',
    readOnly: 'account',
    readOnlyNote: '本版未实现（需要内置 HTTP 客户端）',
  },
});

/**
 * Ordered dialect list for the workbench menu.
 *
 * @returns {{type: string, label: string, tier: number, supported: boolean, reason?: string}[]} menu entries.
 */
export function dialectMenu() {
  return Object.entries(DIALECTS).map(([type, descriptor]) => ({
    type,
    label: descriptor.label,
    tier: descriptor.tier,
    supported: descriptor.supported,
    ...(descriptor.supported ? {} : {reason: `${descriptor.label} 本版未实现，连接不会被启用。`}),
  }));
}

/**
 * Effective port for a connection.
 *
 * @param {Connection} connection connection.
 * @returns {number} port.
 */
function portOf(connection) {
  if (Number.isInteger(connection.port) && connection.port > 0) return connection.port;
  return DIALECTS[connection.dialect]?.defaultPort ?? 0;
}

/**
 * Build the argv, environment, and stdin prologue for one query.
 *
 * @param {Connection} connection connection.
 * @param {{maxRows: number, structured: boolean}} options call options.
 * @returns {{argv: string[], env: Record<string, string>, stdinPrefix: string, passwordChannel: string}} template.
 */
export function buildTemplate(connection, options) {
  const dialect = connection.dialect;
  const user = connection.user ?? DIALECTS[dialect]?.defaultUser ?? '';
  switch (dialect) {
    case 'sqlite': {
      if (typeof connection.file !== 'string' || connection.file.trim() === '') {
        throw new Error('SQLite 数据源必须指定数据库文件路径。');
      }
      return {
        // `-csv` resets header state in the sqlite3 CLI, so `-header` must come
        // after the CSV flag; the opposite order silently drops the header row.
        argv: ['-readonly', '-csv', '-header', connection.file],
        env: {},
        stdinPrefix: `.nullvalue ${NULL_TOKEN}\n`,
        passwordChannel: 'none',
      };
    }
    case 'mysql': {
      return {
        argv: [
          // Do not let ~/.my.cnf inject init-command / init-file statements
          // before the read-only prologue; the analysis connection must be fully
          // specified by this plugin.
          '--no-defaults',
          // Without --quick the client buffers the whole result before printing
          // the first row, so the row/byte caps in the streaming reader cannot
          // stop a huge result from exhausting Host memory.
          '--quick',
          // XML output is the only mysql client mode that distinguishes SQL
          // NULL (`xsi:nil="true"`) from the literal text "NULL"; a batch read
          // would silently turn both into the same string.
          '--xml',
          '--default-character-set=utf8mb4',
          '--connect-timeout=10',
          ...(connection.host ? ['--host', String(connection.host)] : []),
          ...(portOf(connection) > 0 ? ['--port', String(portOf(connection))] : []),
          ...(user ? ['--user', user] : []),
          ...(connection.database ? ['--database', String(connection.database)] : []),
        ],
        env: {},
        stdinPrefix: '',
        passwordChannel: 'MYSQL_PWD',
      };
    }
    case 'postgres': {
      return {
        argv: [
          '--csv',
          '--no-psqlrc',
          '--quiet',
          '-v',
          'ON_ERROR_STOP=1',
          '-P',
          `null=${PG_NULL_TOKEN}`,
          ...(connection.host ? ['-h', String(connection.host)] : []),
          ...(portOf(connection) > 0 ? ['-p', String(portOf(connection))] : []),
          ...(user ? ['-U', user] : []),
          ...(connection.database ? ['-d', String(connection.database)] : []),
        ],
        env: {},
        stdinPrefix: '',
        passwordChannel: 'PGPASSWORD',
      };
    }
    case 'sqlserver': {
      const env = {};
      // Homebrew's ODBC Driver 18 loads OpenSSL dynamically; a Finder-launched
      // DSH does not inherit the shell's DYLD_LIBRARY_PATH. Add the keg-only
      // OpenSSL 3 directory when the directory exists, without overriding an explicit one.
      if (process.platform === 'darwin' && existsSync('/opt/homebrew/opt/openssl@3/lib')) {
        env.DYLD_LIBRARY_PATH = process.env.DYLD_LIBRARY_PATH
          ? `${process.env.DYLD_LIBRARY_PATH}:/opt/homebrew/opt/openssl@3/lib`
          : '/opt/homebrew/opt/openssl@3/lib';
      }
      return {
        argv: [
          '-b',
          '-r',
          '1',
          '-W',
          '-w',
          '65535',
          '-s',
          SQLSERVER_SEPARATOR,
          ...(connection.trustServerCertificate === true ? ['-C'] : []),
          '-S',
          `${connection.host ?? '127.0.0.1'}${portOf(connection) > 0 ? `,${portOf(connection)}` : ''}`,
          ...(user ? ['-U', user] : []),
          ...(connection.database ? ['-d', String(connection.database)] : []),
        ],
        env,
        stdinPrefix: 'SET NOCOUNT ON;\n',
        passwordChannel: 'SQLCMDPASSWORD',
      };
    }
    case 'oracle': {
      const service = connection.serviceName ?? connection.database ?? '';
      const target = `${connection.host ?? '127.0.0.1'}:${portOf(connection)}/${service}`;
      return {
        argv: ['-S', '/nolog'],
        env: {},
        // SQL*Plus CSV markup preserves headers, quoting and NULL-vs-empty
        // (NULL is an unquoted empty field; '' is quoted). The older
        // PAGESIZE/COLSEP text mode truncates expression headers to one char.
        stdinPrefix:
          'SET MARKUP CSV ON DELIMITER \'|\' QUOTE ON\n' +
          'SET FEEDBACK OFF\nSET NULL \'\'\nSET NUMWIDTH 50\n' +
          // &name would be substituted by SQL*Plus (possibly consuming the
          // next input line); force literal ampersands.
          'SET DEFINE OFF\n' +
          'WHENEVER SQLERROR EXIT FAILURE\n',
        env: {
          NLS_LANG: 'AMERICAN_AMERICA.AL32UTF8',
          NLS_DATE_FORMAT: 'YYYY-MM-DD HH24:MI:SS',
          NLS_TIMESTAMP_FORMAT: 'YYYY-MM-DD HH24:MI:SS.FF6',
        },
        passwordChannel: 'stdin',
        connectTarget: target,
        connectUser: user,
      };
    }
    default:
      throw new Error(`数据库类型 ${dialect} 本版未实现。`);
  }
}

/**
 * Remove blank lines from a script while respecting string literals and comments.
 *
 * SQL*Plus runs the buffered statement when it meets a blank line, so a read-only
 * SQL text containing a blank line can execute a second statement that the
 * single-statement guard (which only counts `;`) never saw. Collapsing blank
 * lines keeps normal multi-line queries intact and turns a hidden second
 * statement into a syntax error (fail closed) instead of an executed write.
 *
 * @param {string} text script text.
 * @returns {string} text without blank lines.
 */
function collapseBlankLines(text) {
  let out = '';
  let index = 0;
  let state = null;
  while (index < text.length) {
    const character = text[index];
    const next = text[index + 1];
    if (state === 'line') {
      out += character;
      if (character === '\n') state = null;
      index += 1;
      continue;
    }
    if (state === 'block') {
      out += character;
      if (character === '*' && next === '/') {
        out += next;
        index += 2;
        state = null;
        continue;
      }
      index += 1;
      continue;
    }
    if (state === 'single') {
      out += character;
      if (character === "'") {
        if (next === "'") {
          out += next;
          index += 2;
          continue;
        }
        state = null;
      }
      index += 1;
      continue;
    }
    if (state === 'double') {
      out += character;
      if (character === '"') state = null;
      index += 1;
      continue;
    }
    if (character === '-' && next === '-') {
      state = 'line';
      out += character;
      index += 1;
      continue;
    }
    if (character === '/' && next === '*') {
      state = 'block';
      out += character;
      index += 1;
      continue;
    }
    if (character === "'") {
      state = 'single';
      out += character;
      index += 1;
      continue;
    }
    if (character === '"') {
      state = 'double';
      out += character;
      index += 1;
      continue;
    }
    if (character === '\n' || character === '\r') {
      out += character;
      index += 1;
      let look = index;
      // SQL*Plus treats form feed / vertical tab (and any other non-newline
      // whitespace) as a blank line and executes the buffered statement there.
      // Skipping only space/tab/CR let a `\f`-only line execute a hidden
      // statement (reproduced against a real 19c server).
      while (look < text.length && /[^\S\n]/.test(text[look])) look += 1;
      if (look < text.length && text[look] === '\n') {
        // The line between the two newlines is empty: drop it entirely.
        index = look + 1;
      }
      continue;
    }
    out += character;
    index += 1;
  }
  return out;
}

/**
 * Compose the full stdin payload for one query.
 *
 * @param {Connection} connection connection.
 * @param {{argv: string[], env: Record<string, string>, stdinPrefix: string, connectTarget?: string, connectUser?: string}} template template.
 * @param {string} sql statement.
 * @param {string | undefined} password resolved password, if any.
 * @returns {string} stdin text.
 */
export function buildStdin(connection, template, sql, password) {
  let prefix = template.stdinPrefix;
  if (connection.dialect === 'oracle') {
    // SQL*Plus parses the connect line itself: an unquoted password containing
    // `@`, `/`, a quote or whitespace silently changes the connect target and
    // the driver reports a misleading network error (reproduced on macOS:
    // ORA-12537). Always quote it as a SQL*Plus identifier and double any
    // embedded quote, which is valid for every password.
    const quoted = `"${String(password ?? '').replace(/"/g, '""')}"`;
    const credential = template.connectUser ? `${template.connectUser}/${quoted}` : `/${quoted}`;
    prefix += `connect ${credential}@${template.connectTarget}\n`;
  }
  if (connection.dialect === 'mysql') {
    // Always request a read-only session: whether the account happens to have
    // a password is unrelated to whether the session can be read-only. A server
    // that rejects this statement fails the run (fail closed) instead of
    // silently running with guards only.
    prefix += 'SET SESSION TRANSACTION READ ONLY;\n';
    // The lexical guard assumes backslash is a literal. Force the same rule on
    // the server so a crafted `\'` cannot escape a quote on one side only.
    prefix += "SET SESSION sql_mode = TRIM(BOTH ',' FROM CONCAT(@@SESSION.sql_mode, IF(FIND_IN_SET('NO_BACKSLASH_ESCAPES', @@SESSION.sql_mode) > 0, '', ',NO_BACKSLASH_ESCAPES')));\n";
  }
  if (connection.dialect === 'oracle') {
    return `${prefix}${collapseBlankLines(sql.trim()).replace(/;+\s*$/, '')};\nEXIT\n`;
  }
  if (connection.dialect === 'sqlite') {
    return `${prefix}${sql.trim().replace(/;+\s*$/, '')};\n`;
  }
  if (connection.dialect === 'sqlserver') {
    // sqlcmd is interactive by default: without GO the client only echoes prompts.
    return `${prefix}${sql.trim().replace(/;+\s*$/, '')};\nGO\nQUIT\n`;
  }
  return `${prefix}${sql.trim().replace(/;+\s*$/, '')};\n`;
}

/**
 * Compose the environment for a client invocation.
 *
 * @param {Connection} connection connection.
 * @param {string | undefined} password resolved password.
 * @returns {Record<string, string>} environment additions.
 */
export function buildEnv(connection, password) {
  const env = {};
  if (connection.dialect === 'postgres') {
    // Session-level read-only is the strongest guarantee available without
    // changing the account; PGOPTIONS survives the client's own startup. The variable
    // must be set even when no password is supplied (.pgpass / peer auth).
    env.PGOPTIONS = '-c default_transaction_read_only=on -c standard_conforming_strings=on';
    // The Host decodes client output as UTF-8. psql defaults client_encoding to
    // the database encoding, so a legacy GBK/SJIS database would otherwise
    // deliver mojibake; pin the client to UTF-8 like the other dialects do.
    env.PGCLIENTENCODING = 'UTF8';
  }
  if (typeof password !== 'string') return env;
  if (connection.dialect === 'mysql') env.MYSQL_PWD = password;
  else if (connection.dialect === 'postgres') env.PGPASSWORD = password;
  else if (connection.dialect === 'sqlserver') env.SQLCMDPASSWORD = password;
  return env;
}

/**
 * Turn a known client-compatibility failure into actionable guidance.
 *
 * MySQL 9+/26 clients no longer ship `mysql_native_password`; connecting to an
 * 8.0 server whose account uses that plugin fails with error 2059 before any
 * query runs. The raw driver text names a `.so` path, which is not something a
 * user can act on, so it is prefixed with the actual fix and the override field.
 *
 * @param {string} text client stderr or error text (already redacted).
 * @returns {string} original text, or text with guidance prefixed.
 */
export function explainClientFailure(text) {
  const raw = String(text ?? '');
  if (/Authentication plugin ['`]?mysql_native_password['`]? cannot be loaded|mysql_native_password\.so/i.test(raw)) {
    return '当前 MySQL 客户端已移除 mysql_native_password 认证（MySQL 9+ 客户端常见），无法连接仍使用该认证的服务器。'
      + '请安装仍支持该认证的 MySQL 8.4（或更早）客户端，并在「编辑连接 → 客户端可执行文件」中填写该客户端在本机的绝对路径。'
      + `原始错误：${raw}`;
  }
  return raw;
}

/**
 * Split delimited text into records, honouring quoting for CSV-like output.
 *
 * @param {string} text raw client output.
 * @param {{delimiter: string, quote: string, nullToken: string, foldCrlfInFields?: boolean}} options parsing options.
 * @returns {string[][]} records.
 */
export function parseDelimitedRecords(text, options) {
  const {delimiter, quote, nullToken} = options;
  const foldCrlf = options.foldCrlfInFields === true;
  const records = [];
  let record = [];
  let field = '';
  let fieldQuoted = false;
  let inQuotes = false;
  let index = 0;
  const pushField = () => {
    // Windows CLI clients (psql, SQL*Plus) write stdout in text mode, so an LF
    // stored inside a value is emitted as CRLF. Fold only on that platform and
    // only inside a quoted field: a record terminator is already consumed by
    // the loop below and a genuine CRLF cannot be distinguished from the
    // translation by the client, so it is disclosed in docs/PLATFORM.md.
    if (foldCrlf && fieldQuoted && field.includes('\r\n')) field = field.replace(/\r\n/g, '\n');
    record.push(fieldQuoted ? field : field === nullToken ? null : field);
    field = '';
    fieldQuoted = false;
  };
  while (index < text.length) {
    const character = text[index];
    if (inQuotes) {
      if (character === quote) {
        if (text[index + 1] === quote) {
          field += quote;
          index += 2;
          continue;
        }
        inQuotes = false;
        index += 1;
        continue;
      }
      field += character;
      index += 1;
      continue;
    }
    if (character === quote && field === '') {
      inQuotes = true;
      fieldQuoted = true;
      index += 1;
      continue;
    }
    if (character === delimiter) {
      pushField();
      index += 1;
      continue;
    }
    if (character === '\n' || character === '\r') {
      pushField();
      records.push(record);
      record = [];
      if (character === '\r' && text[index + 1] === '\n') index += 1;
      index += 1;
      continue;
    }
    field += character;
    index += 1;
  }
  if (field !== '' || record.length > 0) {
    pushField();
    records.push(record);
  }
  return records;
}

/**
 * Decode the character entities the mysql client writes in XML mode.
 *
 * @param {string} text entity-encoded text.
 * @returns {string} decoded text.
 */
export function unescapeXml(text) {
  return String(text).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, entity) => {
    if (entity[0] === '#') {
      const code = entity[1] === 'x' || entity[1] === 'X'
        ? Number.parseInt(entity.slice(2), 16)
        : Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    switch (entity) {
      case 'lt': return '<';
      case 'gt': return '>';
      case 'amp': return '&';
      case 'quot': return '"';
      case 'apos': return "'";
      default: return whole;
    }
  });
}

/**
 * Parse the mysql client's `--xml` output.
 *
 * XML is used because XML is the only mode where a SQL NULL is structurally
 * distinguishable (`xsi:nil="true"`) from the text "NULL". Whitespace inside a
 * field is preserved exactly (tabs and newlines are legal XML text), and
 * entities are decoded. An empty result carries no column names, so `columns`
 * stays empty and the caller must resolve the schema another way.
 *
 * @param {string} stdout raw XML.
 * @param {number} maxRows row ceiling.
 * @param {{platform?: string}} [options] parsing options; `platform` fixes the
 *   text-mode newline translation the Windows mysql client applies.
 * @returns {{columns: string[], rows: Record<string, string|null>[], rowLimitExceeded: boolean}} parsed result.
 */
export function parseMysqlXml(stdout, maxRows, options = {}) {
  const text = String(stdout ?? '');
  const platform = options.platform ?? process.platform;
  const rows = [];
  /** @type {string[]|null} */
  let columns = null;
  let exceeded = false;
  const rowPattern = /<row>([\s\S]*?)<\/row>/g;
  const fieldPattern = /<field\s+([^>]*?)(\/>|>([\s\S]*?)<\/field>)/g;
  let rowMatch;
  while ((rowMatch = rowPattern.exec(text)) !== null) {
    if (rows.length >= maxRows) {
      exceeded = true;
      break;
    }
    /** @type {{name: string, value: string|null}[]} */
    const fields = [];
    let fieldMatch;
    fieldPattern.lastIndex = 0;
    while ((fieldMatch = fieldPattern.exec(rowMatch[1])) !== null) {
      const attributes = fieldMatch[1];
      const nameMatch = /name="((?:[^"\\]|\\.)*)"/.exec(attributes);
      const name = nameMatch === null ? '' : unescapeXml(nameMatch[1]);
      const isNull = /\bxsi:nil="true"/.test(attributes);
      let value = isNull ? null : unescapeXml(fieldMatch[3] ?? '');
      // The Windows mysql client writes stdout in text mode, so a newline
      // inside a field is emitted as CRLF. The same value on macOS/Linux keeps
      // its LF, and the client offers no way to distinguish a stored CRLF from
      // that translation, so normalize only on win32 to keep one cross-platform
      // result contract. (A genuine CRLF inside a value is folded to LF and
      // disclosed in docs/PLATFORM.md.)
      if (value !== null && platform === 'win32') value = value.replace(/\r\n/g, '\n');
      fields.push({name, value});
    }
    // A row with no fields is a parse artefact, not a record.
    if (fields.length === 0) continue;
    if (columns === null) {
      // MySQL repeats the alias for a duplicated column (`SELECT a.id, b.id`).
      // Map by field POSITION and dedupe the names, otherwise the later value
      // silently overwrites the earlier one and the export loses a column.
      columns = dedupeColumns(fields.map((field, index) => field.name === '' ? `column_${index + 1}` : field.name));
    }
    const row = {};
    for (let index = 0; index < columns.length; index += 1) {
      row[columns[index]] = index < fields.length ? fields[index].value : null;
    }
    rows.push(row);
  }
  if (rows.length >= maxRows) exceeded = true;
  return {columns: columns ?? [], rows, rowLimitExceeded: exceeded};
}

/**
 * Parse client output into columns, rows, and a truncation flag.
 *
 * @param {Connection} connection connection.
 * @param {string} stdout raw output.
 * @param {{maxRows: number}} options parse options.
 * @returns {{columns: string[], rows: Record<string, string|null>[], rowLimitExceeded: boolean}} parsed result.
 */
export function parseStructuredOutput(connection, stdout, options) {
  const dialect = connection.dialect;
  // Do not rewrite CR/CRLF here: values legitimately contain them, and the
  // quote-aware parser below already treats an unquoted CR/LF as a record
  // terminator. (The old global fold silently changed cell values.)
  const text = String(stdout ?? '');
  const platform = options.platform ?? process.platform;
  const foldCrlfInFields = platform === 'win32';
  let records;
  if (dialect === 'sqlserver') {
    // sqlcmd prints a literal NULL as "NULL"; a quoted literal 'NULL' is
    // indistinguishable. The run receipt records this limitation.
    const cleaned = text.replace(/^\(\d+ rows? affected\)\n?/gim, '').trim();
    records = parseDelimitedRecords(cleaned, {delimiter: SQLSERVER_SEPARATOR, quote: '\u0000', nullToken: 'NULL'});
    // sqlcmd prints a dashed underline under the header row.
    if (records.length > 1 && records[1].every((value) => /^-+$/.test(value ?? ''))) records.splice(1, 1);
    // sqlcmd has no quoting: an embedded newline becomes an extra physical row.
    // Refuse to misalign the result instead of silently shifting columns.
    if (records.length > 1 && records.slice(1).some((record) => record.length !== records[0].length)) {
      throw new Error('SQL Server sqlcmd 输出包含换行或分隔符，无法安全解析；请避免在结果值中使用换行，或改用支持引用的客户端。');
    }
  } else if (dialect === 'oracle') {
    records = parseDelimitedRecords(text, {delimiter: '|', quote: '"', nullToken: '', foldCrlfInFields});
  } else if (dialect === 'postgres') {
    // PostgreSQL CSV prints SQL NULL as the configured ASCII token and an empty
    // string as an empty field, so the two stay distinguishable on Windows.
    // (psql silently rewrites a non-ASCII token through the ANSI code page;
    // that used to turn every NULL into "?".)
    records = parseDelimitedRecords(text, {delimiter: ',', quote: '"', nullToken: PG_NULL_TOKEN, foldCrlfInFields});
  } else if (dialect === 'mysql') {
    const parsed = parseMysqlXml(text, options.maxRows, {platform});
    return parsed;
  } else if (dialect === 'doris') {
    // Doris is not a supported dialect yet; keep the legacy batch split so an
    // accidental use stays explicit rather than silently mis-parsing.
    records = parseDelimitedRecords(text, {delimiter: '\t', quote: '\u0000', nullToken: '\\N'});
  } else {
    records = parseDelimitedRecords(text, {delimiter: ',', quote: '"', nullToken: NULL_TOKEN});
  }
  // Skip only leading blank lines (some clients emit one before the header).
  // Never drop rows: a one-column result may legitimately be NULL/empty.
  while (records.length > 0 && records[0].every((value) => value === null || String(value).trim() === '')) {
    records.shift();
  }
  if (records.length === 0) return {columns: [], rows: [], rowLimitExceeded: false};
  const header = records[0].map((value, index) => {
    const text = value === null || value === '' ? '' : String(value).trim();
    return text === '' ? `column_${index + 1}` : text;
  });
  const uniqueColumns = dedupeColumns(header);
  const rows = [];
  let exceeded = false;
  for (const record of records.slice(1)) {
    if (rows.length >= options.maxRows) {
      exceeded = true;
      break;
    }
    const row = {};
    uniqueColumns.forEach((column, index) => {
      const raw = index < record.length ? record[index] : null;
      row[column] = typeof raw === 'string' && (dialect === 'mysql' || dialect === 'doris') ? unescapeMysqlBatch(raw) : raw;
    });
    rows.push(row);
  }
  // A result that fills the limit exactly may or may not be complete; treat the result
  // as truncated so a caller never presents a possibly cut result as complete.
  if (rows.length >= options.maxRows) exceeded = true;
  return {columns: uniqueColumns, rows, rowLimitExceeded: exceeded};
}

/**
 * Reverse MySQL's `--batch` escaping of value-internal control characters.
 *
 * @param {string} value escaped field text.
 * @returns {string} literal value.
 */
export function unescapeMysqlBatch(value) {
  return String(value).replace(/\\(.)/g, (whole, character) => {
    switch (character) {
      case 't':
        return '\t';
      case 'n':
        return '\n';
      case 'r':
        return '\r';
      case '0':
        return '\u0000';
      case '\\':
        return '\\';
      default:
        return whole;
    }
  });
}

/**
 * Make duplicate column names unique in a stable way.
 *
 * @param {string[]} columns raw column names.
 * @returns {string[]} unique names.
 */
export function dedupeColumns(columns) {
  const used = new Set();
  return columns.map((column) => {
    if (!used.has(column)) {
      used.add(column);
      return column;
    }
    let suffix = 2;
    while (used.has(`${column}_${suffix}`)) suffix += 1;
    const unique = `${column}_${suffix}`;
    used.add(unique);
    return unique;
  });
}

/**
 * Metadata statement for listing schemas.
 *
 * @param {string} dialect dialect.
 * @returns {string} SQL.
 */
export function listSchemasSql(dialect) {
  switch (dialect) {
    case 'sqlite':
      return 'SELECT name FROM pragma_database_list';
    case 'mysql':
      return 'SELECT schema_name FROM information_schema.schemata ORDER BY schema_name';
    case 'postgres':
      return 'SELECT schema_name FROM information_schema.schemata ORDER BY schema_name';
    case 'sqlserver':
      return 'SELECT name FROM sys.schemas ORDER BY name';
    case 'oracle':
      return 'SELECT username FROM all_users ORDER BY username';
    default:
      throw new Error(`数据库类型 ${dialect} 本版未实现。`);
  }
}

/**
 * Metadata statement for listing tables and views.
 *
 * @param {string} dialect dialect.
 * @param {string} [schema] schema filter (already validated by the caller).
 * @returns {string} SQL.
 */
export function listTablesSql(dialect, schema) {
  const escaped = schema === undefined ? '' : escapeSqlLiteral(schema, dialect);
  switch (dialect) {
    case 'sqlite':
      return "SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name";
    case 'mysql':
      return `SELECT table_schema, table_name, table_type FROM information_schema.tables ${schema === undefined ? '' : `WHERE table_schema = ${escaped} `}ORDER BY table_schema, table_name`;
    case 'postgres':
      return `SELECT table_schema, table_name, table_type FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema')${schema === undefined ? '' : ` AND table_schema = ${escaped}`} ORDER BY table_schema, table_name`;
    case 'sqlserver':
      return `SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE FROM INFORMATION_SCHEMA.TABLES${schema === undefined ? '' : ` WHERE TABLE_SCHEMA = ${escaped}`} ORDER BY TABLE_SCHEMA, TABLE_NAME`;
    case 'oracle':
      return `SELECT owner, table_name, 'TABLE' AS table_type FROM all_tables${schema === undefined ? '' : ` WHERE owner = ${escaped}`} ORDER BY owner, table_name`;
    default:
      throw new Error(`数据库类型 ${dialect} 本版未实现。`);
  }
}

/**
 * Quote one metadata value as a SQL string literal.
 *
 * MySQL treats backslash as an escape character by default, so doubling only
 * the quote would let a schema name like `x\' OR 1=1 -- ` break out of the
 * literal. Other dialects use the standard doubled-quote form.
 *
 * @param {string} value raw value.
 * @param {string} [dialect] database dialect.
 * @returns {string} quoted literal.
 */
export function escapeSqlLiteral(value) {
  // Doubling the quote is the portable rule and is correct for every supported
  // dialect. MySQL runs with NO_BACKSLASH_ESCAPES forced by the stdin prologue
  // (see buildStdin), so a backslash is already literal there; doubling it as
  // well would change the value (`a\b` would look for `a\\b`).
  return `'${String(value).replace(/'/g, "''")}'`;
}
