/**
 * Lexical SQL guards for the read-only execution path.
 *
 * These guards are *defense in depth*, not the security boundary. The real
 * boundary is the database account's own read-only privilege plus the
 * connection-level read-only settings applied by `src/db/read.js`. A lexical
 * scanner cannot know that `SELECT my_volatile_function()` writes rows.
 *
 * Everything here works on a masked copy of the statement: string literals,
 * quoted identifiers, comments, and dollar-quoted bodies are replaced by
 * spaces first, so a keyword inside a literal can never be mistaken for syntax.
 *
 * @module src/core/sql-safety
 */

/** Statements that are read-only for every supported dialect. */
const READ_LEADING = new Set(['SELECT', 'WITH', 'SHOW', 'DESCRIBE', 'DESC', 'EXPLAIN', 'PRAGMA', 'VALUES']);
/** Statements that are never allowed on an analysis connection. */
const WRITE_LEADING = new Set([
  'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'UPSERT', 'REPLACE', 'TRUNCATE', 'DROP', 'CREATE', 'ALTER',
  'RENAME', 'GRANT', 'REVOKE', 'COMMENT', 'CALL', 'EXEC', 'EXECUTE', 'BEGIN', 'COMMIT', 'ROLLBACK',
  'SAVEPOINT', 'LOCK', 'UNLOCK', 'SET', 'USE', 'COPY', 'LOAD', 'ATTACH', 'DETACH', 'PRAGMA_WRITE',
  'VACUUM', 'ANALYZE', 'REINDEX', 'CLUSTER', 'REFRESH', 'IMPORT', 'EXPORT', 'KILL', 'SHUTDOWN',
]);
/** Leading tokens for which a read judgement is deliberately refused. */
const AMBIGUOUS_LEADING = new Set(['(', 'VALUES']);
/**
 * Side effects that can hide inside an otherwise read-only statement.
 * Documented as advisory: MySQL's `INTO OUTFILE`, PostgreSQL's `FOR UPDATE`
 * lock escalation, and server-side file readers are all rejected here.
 */
const DANGEROUS_PATTERNS = [
  /\bINTO\s+(OUTFILE|DUMPFILE)\b/,
  // PostgreSQL / SQL Server `SELECT ... INTO new_table` creates a table; MySQL
  // user variables (`INTO @v`) are the only harmless form and stay allowed.
  /\bINTO\s+(?!(OUTFILE|DUMPFILE)\b|@)[A-Za-z_#\[]/,
  /\bFOR\s+(UPDATE|SHARE|NO\s+KEY\s+UPDATE|KEY\s+SHARE)\b/,
  /\bLOCK\s+IN\s+SHARE\s+MODE\b/,
  /\bPG_READ_FILE\s*\(/,
  /\bPG_READ_BINARY_FILE\s*\(/,
  /\bPG_WRITE_FILE\s*\(/,
  /\bPG_LS_DIR\s*\(/,
  /\bPG_STAT_FILE\s*\(/,
  // Backend control functions mutate server state even inside a read-only
  // transaction; a quoted identifier must not hide them (identifier view below).
  /\bPG_(TERMINATE_BACKEND|CANCEL_BACKEND|RELOAD_CONF|PROMOTE|CREATE_RESTORE_POINT|SWITCH_WAL|CREATE_PHYSICAL_REPLICATION_SLOT|DROP_REPLICATION_SLOT|LOGICAL_EMIT_MESSAGE)\s*\(/,
  /\bLOAD_FILE\s*\(/,
  /\bOPENROWSET\s*\(/,
  /\bOPENQUERY\s*\(/,
  /\bOPENDATASOURCE\s*\(/,
  /\b(XP_CMDSHELL|XP_DIRTREE|SP_OACREATE|SP_OAMETHOD)\b/,
  /\b(UTL_FILE|UTL_HTTP|UTL_TCP|UTL_SMTP|UTL_INADDR)\b/,
  /\bDBMS_(SCHEDULER|LOCK|PIPE)\b/,
  /\bWAITFOR\s+(DELAY|TIME)\b/,
  /\bLO_IMPORT\s*\(/,
  /\bLO_EXPORT\s*\(/,
  // `dblink_exec`/`dblink_connect` are the write-capable members: a word
  // boundary after DBLINK does not match them (`_` is a word character).
  /\bDBLINK\w*\s*\(/,
  /\bNEXTVAL\s*\(/,
  /\bSETVAL\s*\(/,
  // PostgreSQL's sleep family (`pg_sleep_for` / `pg_sleep_until`) was missed by
  // the `\bSLEEP` pattern because `_` is a word character.
  /\b(PG_SLEEP|PG_SLEEP_FOR|PG_SLEEP_UNTIL|SLEEP)\s*\(/,
  /\bBENCHMARK\s*\(/,
  // sqlite3's CLI-only functions reach the host filesystem even with `-readonly`
  // (the flag only protects the database file): writefile/readfile/fsdir/zipfile
  // read or write arbitrary host paths and load_extension loads native code.
  /\b(WRITEFILE|READFILE|FSDIR|ZIPFILE|LOAD_EXTENSION)\s*\(/,
];

/**
 * Dialect-specific side effects.
 *
 * `NEXT VALUE FOR` advances a sequence durably and the locking table hints take
 * write locks, both without a leading write keyword; SQL Server has no session
 * read-only mode, so the lexical guard is the only layer that can stop them.
 */
const DIALECT_DANGEROUS_PATTERNS = {
  sqlserver: [
    /\bNEXT\s+VALUE\s+FOR\b/,
    /\bWITH\s*\(\s*(TABLOCK|TABLOCKX|XLOCK|UPDLOCK|HOLDLOCK|PAGLOCK)\b/,
    // The same write-locking hints are valid without the WITH wrapper
    // (`FROM t (TABLOCKX)`), which the pattern above missed.
    /\b(TABLOCKX?|XLOCK|UPDLOCK|HOLDLOCK|PAGLOCK)\b/,
  ],
  oracle: [
    /\bEXPLAIN\s+PLAN\b/,
    // `seq.NEXTVAL` is the Oracle spelling: it has no parentheses, so the
    // shared NEXTVAL( pattern never matched it and a read-only query could
    // advance a sequence durably.
    /\bNEXTVAL\b/,
  ],
};

/**
 * Replace literals, quoted identifiers, and comments with spaces.
 *
 * The result has exactly the same length and newline positions as the input, so
 * offsets remain valid for diagnostics. Indices are UTF-16 code units (the same
 * units as `String#length`), so an astral character such as an emoji inside a
 * literal cannot shift the masking by one position and swallow a following
 * semicolon.
 *
 * @param {string} sql statement text.
 * @param {string} [dialect] database dialect (MySQL needs its own comment rule).
 * @param {{keepQuotedIdentifiers?: boolean}} [options] when true, the *content*
 *   of `"..."`, `` `...` `` and `[...]` identifiers is preserved while string
 *   literals and comments stay blanked. The deny-list scans that view as well,
 *   so `SELECT "pg_terminate_backend"(1)` cannot hide behind its quotes.
 * @returns {string} masked statement.
 */
export function maskSql(sql, dialect = 'postgres', options = {}) {
  const text = String(sql);
  const keepQuoted = options.keepQuotedIdentifiers === true;
  // `split('')` splits into UTF-16 code units, not code points: a surrogate
  // pair occupies two entries, exactly like the indexes below compute.
  const out = text.split('');
  const blank = (index) => {
    if (out[index] !== '\n' && out[index] !== '\r') out[index] = ' ';
  };
  const keep = (index) => {
    if (out[index] === '\n' || out[index] === '\r') out[index] = ' ';
  };
  let index = 0;
  while (index < text.length) {
    const character = text[index];
    const next = text[index + 1];
    if (character === '-' && next === '-') {
      // MySQL requires whitespace (or end of input) after `--`; `--1` is two
      // unary minus signs there. Treating the sequence as a comment would hide a
      // following `;DELETE ...` from the statement splitter.
      if (dialect === 'mysql' && !/[\u0000-\u0020]/.test(text[index + 2] ?? '')) {
        index += 1;
        continue;
      }
      while (index < text.length && text[index] !== '\n') {
        blank(index);
        index += 1;
      }
      continue;
    }
    if (dialect === 'mysql' && character === '#') {
      while (index < text.length && text[index] !== '\n') {
        blank(index);
        index += 1;
      }
      continue;
    }
    if (character === '/' && next === '*') {
      // Only PostgreSQL and SQL Server treat block comments as nestable.
      const nested = dialect === 'postgres' || dialect === 'sqlserver';
      let depth = 1;
      blank(index);
      blank(index + 1);
      index += 2;
      while (index < text.length && depth > 0) {
        if (nested && text[index] === '/' && text[index + 1] === '*') {
          depth += 1;
          blank(index);
          blank(index + 1);
          index += 2;
          continue;
        }
        if (text[index] === '*' && text[index + 1] === '/') {
          depth -= 1;
          blank(index);
          blank(index + 1);
          index += 2;
          continue;
        }
        blank(index);
        index += 1;
      }
      continue;
    }
    if ((dialect === 'sqlserver' || dialect === 'sqlite') && character === '[') {
      // T-SQL and SQLite bracket-delimited identifiers. Without this rule a
      // `--` inside `[--]` looked like the start of a comment and the rest of
      // the batch (`; DELETE ...`) vanished from the masked statement.
      blank(index);
      keep(index);
      index += 1;
      while (index < text.length) {
        if (text[index] === ']') {
          if (text[index + 1] === ']') {
            if (!keepQuoted) blank(index);
            else keep(index);
            if (!keepQuoted) blank(index + 1);
            else keep(index + 1);
            index += 2;
            continue;
          }
          blank(index);
          index += 1;
          break;
        }
        if (keepQuoted) keep(index); else blank(index);
        index += 1;
      }
      continue;
    }
    if (character === "'" || character === '"' || character === '`') {
      const quote = character;
      const preserve = keepQuoted && quote !== "'";
      // Backslashes are not string escapes in SQLite/Oracle/SQL Server, and
      // MySQL runs with NO_BACKSLASH_ESCAPES forced by its stdin prologue.
      // PostgreSQL only honors them in E'...' strings.
      const escapesE = dialect === 'postgres' && quote === "'"
        && (text[index - 1] === 'E' || text[index - 1] === 'e')
        && !/[A-Za-z0-9_$]/.test(text[index - 2] ?? '');
      const backslashEscapes = escapesE;
      blank(index);
      index += 1;
      while (index < text.length) {
        if (text[index] === '\\' && backslashEscapes) {
          blank(index);
          blank(index + 1);
          index += 2;
          continue;
        }
        if (text[index] === quote) {
          if (text[index + 1] === quote) {
            if (preserve) {
              // Keep one literal quote of a doubled identifier quote.
              blank(index);
              keep(index + 1);
            } else {
              blank(index);
              blank(index + 1);
            }
            index += 2;
            continue;
          }
          blank(index);
          index += 1;
          break;
        }
        if (preserve) keep(index); else blank(index);
        index += 1;
      }
      continue;
    }
    if (dialect === 'postgres' && character === '$') {
      // A dollar-quote tag may only start at a token boundary: PostgreSQL
      // allows `$` inside an unquoted identifier, so `a$$; SET ...` used to be
      // mistaken for the opening of a `$$` block and the tail was blanked.
      const before = text[index - 1];
      if (before !== undefined && /[A-Za-z0-9_$\u0080-\uFFFF]/.test(before)) {
        index += 1;
        continue;
      }
      const match = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(text.slice(index));
      if (match !== null) {
        const tag = match[0];
        const end = text.indexOf(tag, index + tag.length);
        const stop = end === -1 ? text.length : end + tag.length;
        while (index < stop) {
          blank(index);
          index += 1;
        }
        continue;
      }
    }
    if (dialect === 'oracle' && (character === 'q' || character === 'Q') && next === "'") {
      const open = text[index + 2];
      const close = open === '[' ? ']' : open === '{' ? '}' : open === '(' ? ')' : open === '<' ? '>' : open;
      blank(index);
      blank(index + 1);
      index += 3;
      while (index < text.length) {
        if (text[index] === close && text[index + 1] === "'") {
          blank(index);
          blank(index + 1);
          index += 2;
          break;
        }
        blank(index);
        index += 1;
      }
      continue;
    }
    index += 1;
  }
  return out.join('');
}

/**
 * Split a script into top-level statements.
 *
 * @param {string} sql script text.
 * @param {string} [dialect] database dialect.
 * @returns {string[]} non-empty statements, without their trailing semicolon.
 */
export function splitStatements(sql, dialect = 'postgres') {
  const masked = maskSql(sql, dialect);
  const statements = [];
  let start = 0;
  for (let index = 0; index < masked.length; index += 1) {
    if (masked[index] !== ';') continue;
    const piece = sql.slice(start, index).trim();
    if (maskSql(piece, dialect).trim() !== '') statements.push(piece);
    start = index + 1;
  }
  const tail = sql.slice(start).trim();
  if (maskSql(tail, dialect).trim() !== '') statements.push(tail);
  return statements;
}

/**
 * Statement-leading words that cannot appear inside a T-SQL SELECT expression as
 * an unquoted identifier. T-SQL does not require `;` between statements, so a
 * whole second statement can hide after a newline in text the semicolon splitter
 * sees as one statement.
 *
 * `ENABLE`/`DISABLE` are deliberately qualified with `TRIGGER`: both are legal
 * column names (a config table with `enable`/`disable` columns is common), and
 * only `ENABLE TRIGGER` / `DISABLE TRIGGER` are statements. `USE` is reserved.
 */
const SQLSERVER_SECOND_STATEMENT_WORDS = /\b(INSERT|UPDATE|DELETE|MERGE|DROP|ALTER|CREATE|TRUNCATE|EXEC|EXECUTE|GRANT|REVOKE|DENY|BACKUP|RESTORE|DBCC|BULK|KILL|SHUTDOWN|RECONFIGURE|USE|ENABLE\s+TRIGGER|DISABLE\s+TRIGGER|SET)\b/gi;

/**
 * Reject an extra T-SQL statement hidden in one batch.
 *
 * The SQL Server path sends the text verbatim as a single TDS batch, so a second
 * statement after a newline would execute even though the semicolon splitter saw
 * one statement. A depth-0 occurrence of a reserved statement keyword (outside
 * strings, comments and identifiers, which maskSql blanks) is a second statement
 * because that word cannot be a column name or alias unquoted.
 *
 * @param {string} sql raw SQL text.
 * @param {string} label label used in the error message.
 * @throws {Error} when a second statement-leading keyword is present.
 */
function assertNoSecondSqlServerStatement(sql, label) {
  const masked = maskSql(sql, 'sqlserver');
  const pattern = new RegExp(SQLSERVER_SECOND_STATEMENT_WORDS.source, 'gi');
  let match;
  while ((match = pattern.exec(masked)) !== null) {
    if (match.index === 0) continue;
    let depth = 0;
    for (let index = 0; index < match.index; index += 1) {
      if (masked[index] === '(') depth += 1;
      else if (masked[index] === ')') depth = Math.max(0, depth - 1);
    }
    if (depth !== 0) continue;
    throw new Error(`${label}: 一次调用只允许一条语句；检测到 T-SQL 批量中的额外语句（${match[1].toUpperCase()}）。`);
  }
}

/**
 * Assert that a script holds exactly one statement.
 *
 * @param {string} sql script text.
 * @param {string} [label] label used in the error message.
 * @param {string} [dialect] database dialect.
 * @throws {Error} when the script is empty or holds more than one statement.
 */
export function assertSingleStatement(sql, label = 'SQL', dialect = 'postgres') {
  const text = String(sql ?? '');
  if (text.trim() === '') throw new Error(`${label}: 语句不能为空。`);
  const statements = splitStatements(text, dialect);
  if (statements.length > 1) {
    throw new Error(`${label}: 一次调用只允许一条语句，检测到 ${statements.length} 条（第 2 条起被拒绝）。`);
  }
  if (dialect === 'sqlserver') assertNoSecondSqlServerStatement(text, label);
}

/**
 * Read the first significant keyword of the masked statement.
 *
 * @param {string} masked masked statement.
 * @returns {string} upper-case keyword, or '' when none.
 */
function leadingKeyword(masked) {
  const match = /^\s*([A-Za-z_]+)/.exec(masked);
  return match === null ? '' : match[1].toUpperCase();
}

/**
 * Classify a statement as `read` or `write`.
 *
 * `WITH` is resolved by scanning its depth-0 tokens: a CTE body sits inside
 * parentheses, so the first depth-0 verb after the CTE list decides the kind.
 *
 * @param {string} sql statement text.
 * @param {string} [dialect] database dialect.
 * @returns {'read' | 'write'} classification.
 */
export function classifyStatement(sql, dialect = 'postgres') {
  const masked = maskSql(sql, dialect);
  const keyword = leadingKeyword(masked);
  if (keyword === '') return 'write';
  if (AMBIGUOUS_LEADING.has(keyword)) return 'write';
  if (WRITE_LEADING.has(keyword)) return 'write';
  if (keyword === 'PRAGMA') {
    if (dialect === 'sqlite' && /=\s*\S/.test(masked)) return 'write';
    // SQLite also accepts the function-call form: `PRAGMA writable_schema(ON)`
    // changes the database, so only an explicit read-only allow-list passes.
    if (dialect === 'sqlite') {
      const call = /^\s*PRAGMA\s+([A-Za-z_]+)\s*\(/.exec(masked);
      if (call !== null && !SQLITE_READ_PRAGMAS.has(call[1].toLowerCase())) return 'write';
    }
    return 'read';
  }
  if (keyword === 'WITH') return classifyWith(masked);
  if (keyword === 'EXPLAIN') {
    // Oracle `EXPLAIN PLAN FOR ...` writes PLAN_TABLE rows; the Oracle path has
    // only account-level read-only, so the lexical guard must reject it.
    if (dialect === 'oracle') return 'write';
    return classifyExplain(masked);
  }
  if (dialect === 'oracle' && (keyword === 'SHOW' || keyword === 'DESCRIBE' || keyword === 'DESC')) {
    // These are SQL*Plus client commands on Oracle, not read-only statements.
    return 'write';
  }
  if (READ_LEADING.has(keyword)) return 'read';
  return 'write';
}

/** SQLite PRAGMAs that only read metadata in their function-call form. */
const SQLITE_READ_PRAGMAS = new Set([
  'table_info', 'table_xinfo', 'table_list', 'index_info', 'index_list', 'index_xinfo',
  'foreign_key_list', 'database_list', 'function_list', 'module_list', 'pragma_list',
  'collation_list', 'compile_options', 'freelist_count', 'page_count', 'integrity_check',
  'quick_check', 'schema_version', 'user_version',
]);

/** Option tokens that may appear between EXPLAIN and the explained statement. */
const EXPLAIN_OPTIONS = new Set([
  'ANALYZE', 'ANALYSE', 'VERBOSE', 'PLAN', 'FOR', 'BUFFERS', 'COSTS', 'TIMING',
  'SETTINGS', 'WAL', 'SUMMARY', 'FORMAT', 'TEXT', 'JSON', 'XML', 'YAML', 'TRUE',
  'FALSE', 'ON', 'OFF', 'QUERY', 'GENERIC_PLAN', 'MEMORY', 'SERIALIZE', 'DIST',
]);

/**
 * Classify an `EXPLAIN` statement.
 *
 * Plain EXPLAIN only plans; `EXPLAIN ANALYZE` (PostgreSQL/MySQL) actually runs
 * the explained statement, so `EXPLAIN ANALYZE INSERT ...` must not pass as a
 * read. The explained statement is extracted conservatively: anything this
 * scanner cannot recognise as SELECT/WITH/VALUES is a write.
 *
 * @param {string} masked masked statement.
 * @returns {'read' | 'write'} classification.
 */
function classifyExplain(masked) {
  if (!/\bANALY[ZS]E\b/.test(masked)) return 'read';
  let rest = masked.replace(/^\s*EXPLAIN\b/, '');
  for (;;) {
    rest = rest.replace(/^\s+/, '');
    if (!rest.startsWith('(')) break;
    let depth = 0;
    let index = 0;
    for (; index < rest.length; index += 1) {
      if (rest[index] === '(') depth += 1;
      else if (rest[index] === ')') {
        depth -= 1;
        if (depth === 0) { index += 1; break; }
      }
    }
    rest = rest.slice(index);
  }
  for (;;) {
    rest = rest.replace(/^\s+/, '');
    const match = /^([A-Za-z_]+)/.exec(rest);
    if (match === null) return 'write';
    const token = match[1].toUpperCase();
    if (!EXPLAIN_OPTIONS.has(token)) break;
    rest = rest.slice(match[0].length);
    // `FORMAT = JSON`, `COSTS = true` style option assignments.
    rest = rest.replace(/^\s*=\s*[A-Za-z_]+/, '');
  }
  const inner = /^\s*([A-Za-z_]+)/.exec(rest);
  if (inner === null) return 'write';
  const keyword = inner[1].toUpperCase();
  if (keyword === 'WITH') return classifyWith(rest);
  return keyword === 'SELECT' || keyword === 'VALUES' ? 'read' : 'write';
}

/**
 * Resolve the statement kind of a `WITH ...` query.
 *
 * Write-capable CTEs are valid PostgreSQL (`WITH d AS (DELETE ... RETURNING *)
 * SELECT * FROM d`), so a write keyword at ANY depth makes the statement a
 * write; only a depth-0 SELECT may classify the statement as a read.
 *
 * @param {string} masked masked statement.
 * @returns {'read' | 'write'} classification.
 */
function classifyWith(masked) {
  let depth = 0;
  let topLevelRead = false;
  const token = /[A-Za-z_]+|[()]/g;
  let match;
  while ((match = token.exec(masked)) !== null) {
    const value = match[0];
    if (value === '(') {
      depth += 1;
      continue;
    }
    if (value === ')') {
      depth = Math.max(0, depth - 1);
      continue;
    }
    // Only a token in statement position can be a statement: scanning every
    // identifier made a column named `comment`/`set` look like a write and
    // rejected valid CTE queries. A CTE body starts right after `(`; the main
    // statement starts after the last `)` of the CTE list (depth 0).
    let before = match.index - 1;
    while (before >= 0 && /\s/.test(masked[before])) before -= 1;
    const previous = before >= 0 ? masked[before] : '';
    let statementPosition;
    if (before < 0 || previous === ';') statementPosition = true;
    else if (previous === ')') statementPosition = depth === 0;
    else if (previous === '(') {
      // `WITH c(comment) AS (...)` has a column list: the token after `(` is a
      // column name, not a statement. Only a CTE body (`AS (`) starts a
      // statement. PostgreSQL also allows `AS [NOT] MATERIALIZED (`.
      statementPosition = /\bAS\s+(?:NOT\s+MATERIALIZED\s+|MATERIALIZED\s+)?$/i.test(masked.slice(0, before));
    } else statementPosition = false;
    const upper = value.toUpperCase();
    if (WRITE_LEADING.has(upper) && statementPosition) {
      // `REPLACE(...)` / `TRUNCATE(...)` in a CTE are scalar functions, not
      // statements; a write keyword followed by `(` is treated as a function.
      let lookahead = token.lastIndex;
      while (lookahead < masked.length && /\s/.test(masked[lookahead])) lookahead += 1;
      if (masked[lookahead] !== '(') return 'write';
    }
    if (depth === 0 && statementPosition && (upper === 'SELECT' || upper === 'VALUES')) topLevelRead = true;
  }
  return topLevelRead ? 'read' : 'write';
}

/**
 * Reject a statement whose masked text contains a known side-effect pattern.
 *
 * @param {string} sql statement text.
 * @param {string} [label] label used in the error message.
 * @throws {Error} when a dangerous pattern is present.
 */
export function assertNoDangerousClause(sql, label = 'SQL', dialect = 'postgres') {
  const raw = String(sql);
  const masked = maskSql(raw, dialect).toUpperCase();
  // The same statement with quoted-identifier *content* kept: a deny-listed
  // function written as "pg_terminate_backend" must not hide behind quotes.
  const identifiers = maskSql(raw, dialect, {keepQuotedIdentifiers: true}).toUpperCase();
  // MySQL executes the body of a `/*! ... */` comment, so a masked statement
  // could be read-only while the real one is not.
  if (/\/\*!/.test(raw)) {
    throw new Error(`${label}: 不允许 MySQL 可执行注释（/*! ... */）。`);
  }
  // A quoted identifier is blanked by maskSql; recover its position from the
  // raw text so `SELECT ... INTO "new_table"` cannot slip past the INTO rule.
  for (const match of masked.matchAll(/\bINTO\b/g)) {
    let cursor = match.index + 4;
    while (cursor < masked.length && /\s/.test(masked[cursor])) cursor += 1;
    const nextCharacter = raw[cursor];
    if (nextCharacter === '"' || nextCharacter === '`' || nextCharacter === '[') {
      throw new Error(`${label}: 语句包含不允许的子句（INTO 引号标识符）。只读连接不允许建表或写文件。`);
    }
  }
  const patterns = [...DANGEROUS_PATTERNS, ...(DIALECT_DANGEROUS_PATTERNS[dialect] ?? [])];
  for (const pattern of patterns) {
    if (pattern.test(masked) || pattern.test(identifiers)) {
      throw new Error(`${label}: 语句包含不允许的子句（${pattern.source.replace(/\\b/g, '')}）。只读分析连接不允许写文件、加锁或调用服务端副作用函数。`);
    }
  }
}

/**
 * Reject client meta-commands that the CLI would execute itself.
 *
 * The SQL always reaches the client through stdin, and the clients interpret
 * line-leading meta-commands before/while sending SQL:
 *   * psql: `\!` runs a shell, `\o` writes files, `\lo_import` reads files;
 *   * SQL*Plus: `/` executes the buffer, `@` includes a script (a URL is
 *     fetched), `!`/`HOST` run a shell, `&name` prompts for substitution;
 *   * sqlcmd: `:r`, `:setvar`, `!!`, `$(var)`, and `GO`.
 * A crafted value could otherwise turn a valid SELECT into host command
 * execution, which is exactly the boundary this plugin promises not to cross.
 *
 * @param {string} sql statement text.
 * @param {string} [dialect] database dialect.
 * @param {string} [label] label used in the error message.
 * @throws {Error} when a client directive is present.
 */
export function assertNoClientDirectives(sql, dialect = 'sqlserver', label = 'SQL') {
  const text = String(sql ?? '');
  if (dialect === 'sqlite') {
    if (/^[^\S\r\n]*\.[A-Za-z]/m.test(text)) {
      throw new Error(`${label}: 不允许 sqlite3 点命令（行首 .）。`);
    }
    return;
  }
  if (dialect === 'mysql') {
    if (/^[^\S\r\n]*[\\!]/m.test(text)) {
      throw new Error(`${label}: 不允许 mysql 客户端的行首反斜杠/感叹号命令。`);
    }
    return;
  }
  if (dialect === 'postgres') {
    // Any line beginning with a backslash is a psql meta-command, even while a
    // statement is still being buffered (`SELECT 1\n\! id`).
    if (/^[^\S\r\n]*\\/m.test(text)) {
      throw new Error(`${label}: 不允许 psql 元命令（行首反斜杠），例如 \\! / \\o / \\lo_import。`);
    }
    return;
  }
  if (dialect === 'oracle') {
    // SQL*Plus treats form feed (0x0C) and vertical tab (0x0B) as blanks, so a
    // line starting with them is still a client command line. `[ \t]*` let
    // `\fHOST id` through and executed it on the host (reproduced). Every
    // line-leading rule now skips any non-newline whitespace.
    if (/^[^\S\r\n]*\/[^\S\r\n]*$/m.test(text)) {
      throw new Error(`${label}: 不允许 SQL*Plus 的「/」执行命令（可提前清空缓冲区并执行后续客户端命令）。`);
    }
    if (/^[^\S\r\n]*@@?/m.test(text)) {
      throw new Error(`${label}: 不允许 SQL*Plus 的 @/@@ 脚本命令（可读取本地或远程脚本）。`);
    }
    if (/^[^\S\r\n]*!/m.test(text)) {
      throw new Error(`${label}: 不允许 SQL*Plus 的「!」外壳命令。`);
    }
    // SQL*Plus executes line-leading client commands from a piped script. HOST/$
    // run a shell and SPOOL/STORE/SAVE/GET/START write or read host files; SET /
    // WHENEVER / DEFINE change the client's behaviour mid-script, CONNECT can
    // switch identity, EXIT/QUIT end the script early. The argument must be on
    // the same line so a multi-line SELECT whose column happens to be named
    // `host` (a legal Oracle identifier) is not misread as a command.
    // The argument test is `\S`: an argument that starts with `.`
    // (`HOST ./x.sh`) or `)` is still a host command, and excluding those
    // characters let a crafted read-only SELECT run local commands.
    if (/^[^\S\r\n]*(?:HOST|SPOOL|SET|DEFINE|UNDEFINE|WHENEVER|STORE|SAVE|GET|START|EDIT|ACCEPT|PAUSE|PROMPT|CLEAR|CONNECT|CONN|PASSWORD|EXIT|QUIT)\b[^\S\r\n]+\S/im.test(text)
      || /^[^\S\r\n]*\$[^\S\r\n]*\S/m.test(text)) {
      throw new Error(`${label}: 不允许 SQL*Plus 客户端命令（HOST/$/SPOOL/SET/STORE 等行首命令）。`);
    }
    return;
  }
  if (dialect !== 'sqlserver') return;
  // The native TDS path never uses sqlcmd, but these checks stay as defense in
  // depth. They must run on the masked statement: `SELECT '$(x)'` and a string
  // containing `GO` are ordinary T-SQL and were rejected as client directives.
  const directiveText = maskSql(text, 'sqlserver');
  const trimmed = directiveText.trimStart();
  if (/^:/.test(trimmed) || /(^|\n)\s*:(r|R|setvar|connect|ed|!!)\b/.test(directiveText)) {
    throw new Error(`${label}: 不允许 sqlcmd 客户端指令（:r / :setvar / :connect / !!）。`);
  }
  if (/(^|\n)\s*GO\s*($|\n)/i.test(directiveText)) throw new Error(`${label}: 不允许 GO 批处理分隔符。`);
  if (/\$\([A-Za-z_]/.test(directiveText)) throw new Error(`${label}: 不允许 sqlcmd 变量（$(name)）。`);
  if (/(^|\n)\s*!!/.test(directiveText)) throw new Error(`${label}: 不允许 !! 外壳转义。`);
}

/**
 * Assert that a statement is executable on the read-only path.
 *
 * @param {string} sql statement text.
 * @param {string} [dialect] database dialect.
 * @param {string} [label] label used in the error message.
 * @returns {'read' | 'write'} the accepted classification (always `read`).
 * @throws {Error} when the statement is not a single read-only statement.
 */
export function assertReadOnly(sql, dialect = 'postgres', label = 'SQL') {
  assertSingleStatement(sql, label, dialect);
  assertNoClientDirectives(sql, dialect, label);
  const kind = classifyStatement(sql, dialect);
  if (kind !== 'read') {
    throw new Error(`${label}: 只允许只读查询。检测到非只读语句；分析连接不提供写入、DDL、存储过程或客户端命令能力。`);
  }
  assertNoDangerousClause(sql, label, dialect);
  return kind;
}

/**
 * Append or rewrite a top-level row limit so the database does less work.
 *
 * This is a resource guard only; the parser truncates again and flags truncation.
 *
 * @param {string} sql statement text.
 * @param {string} dialect database dialect.
 * @param {number} maxRows row ceiling.
 * @returns {{sql: string, limited: boolean}} rewritten statement.
 */
export function enforceRowLimit(sql, dialect, maxRows) {
  const limit = Number.isInteger(maxRows) && maxRows > 0 ? maxRows : 100;
  // `SELECT 1;;` is one statement for the splitter but appending `LIMIT` after
  // the remaining `;` would be invalid SQL.
  const trimmed = String(sql).trim().replace(/;+(\s*--[^\n]*)?\s*$/, '');
  const masked = maskSql(trimmed, dialect);
  const keyword = leadingKeyword(masked);
  if (!['SELECT', 'WITH', 'VALUES'].includes(keyword)) return {sql: trimmed, limited: false};
  if (dialect === 'sqlserver') return enforceSqlServerLimit(trimmed, masked, limit);
  if (dialect === 'oracle') {
    // A CTE cannot be wrapped in an inline view on every Oracle version; the
    // 12c+ row-limiting clause appends cleanly after the final SELECT.
    if (keyword === 'WITH') {
      const fetch = /FETCH\s+(?:FIRST|NEXT)\s+(\d+)\s+ROWS?\s+(?:ONLY|WITH\s+TIES)\s*$/i.exec(trimmed);
      if (fetch !== null && Number(fetch[1]) <= limit) return {sql: trimmed, limited: false};
      // Newline before the clause: a trailing `-- comment` would otherwise
      // swallow it. Replacing an oversized row count keeps the query valid.
      if (fetch !== null) {
        return {sql: `${trimmed.slice(0, fetch.index)}FETCH FIRST ${limit} ROWS ONLY`, limited: true};
      }
      return {sql: `${trimmed}\nFETCH FIRST ${limit} ROWS ONLY`, limited: true};
    }
    // Newlines around the subquery keep a trailing `-- comment` from swallowing
    // the closing parenthesis.
    return {sql: `SELECT * FROM (\n${trimmed}\n) WHERE ROWNUM <= ${limit}`, limited: true};
  }
  return enforceLimitClause(trimmed, masked, limit, dialect);
}

/**
 * Rewrite a statement with a `LIMIT n` clause.
 *
 * @param {string} sql statement text.
 * @param {string} masked masked statement.
 * @param {number} limit row ceiling.
 * @returns {{sql: string, limited: boolean}} rewritten statement.
 */
function enforceLimitClause(sql, masked, limit, dialect = 'postgres') {
  const depth = topLevelLimit(masked);
  if (depth === -1) {
    // PostgreSQL's standard row limiter (`FETCH FIRST/NEXT n ROWS ONLY`) already
    // bounds the result; appending `LIMIT` after it is a syntax error and made
    // the whole statement fail. A bare `OFFSET` (no limiter) cannot take a
    // LIMIT after it either, because PostgreSQL requires LIMIT before OFFSET.
    if ((dialect === 'postgres' || dialect === 'oracle') && hasTopLevelOffsetFetch(masked)) {
      return {sql, limited: false};
    }
    // The limiter goes on its own line: appending it to the last line would put
    // it inside a trailing `-- comment` and silently drop the limit.
    return {sql: `${sql}\nLIMIT ${limit}`, limited: true};
  }
  const tail = masked.slice(depth);
  // `LIMIT n`, `LIMIT offset, n` (MySQL) and `LIMIT n OFFSET m` are all capped;
  // other shapes (expressions, `LIMIT ALL`) are left alone rather than guessed.
  const match = /^\s*LIMIT\s+(?:(\d+)\s*,\s*)?(\d+|ALL)(\s+OFFSET\s+\d+)?\s*$/i.exec(tail);
  if (match === null) return {sql, limited: false};
  const count = match[2].toUpperCase() === 'ALL' ? Number.POSITIVE_INFINITY : Number(match[2]);
  if (count <= limit) return {sql, limited: false};
  const offset = match[1] === undefined ? '' : `${match[1]}, `;
  const rest = match[3] ?? '';
  return {sql: `${sql.slice(0, depth)}LIMIT ${offset}${limit}${rest}`, limited: true};
}

/**
 * Locate a depth-0 `LIMIT` clause.
 *
 * @param {string} masked masked statement.
 * @returns {number} index of the clause, or -1.
 */
function topLevelLimit(masked) {
  let depth = 0;
  for (let index = 0; index < masked.length; index += 1) {
    const character = masked[index];
    if (character === '(') depth += 1;
    else if (character === ')') depth = Math.max(0, depth - 1);
    else if (depth === 0 && (character === 'L' || character === 'l')) {
      const slice = masked.slice(index, index + 5).toUpperCase();
      // An identifier such as `credit_limit` is not a LIMIT clause: require a
      // token boundary on both sides, otherwise the clause is never found and
      // the row cap silently is not applied.
      const before = index === 0 ? '' : masked[index - 1];
      if (slice === 'LIMIT' && !/[A-Za-z0-9_$]/.test(before) && /\s/.test(masked[index + 5] ?? ' ')) return index;
    }
  }
  return -1;
}

/**
 * Rewrite a statement for SQL Server's `TOP` / `OFFSET … FETCH` syntax.
 *
 * @param {string} sql statement text.
 * @param {string} masked masked statement.
 * @param {number} limit row ceiling.
 * @returns {{sql: string, limited: boolean}} rewritten statement.
 */
function enforceSqlServerLimit(sql, masked, limit) {
  if (/^\s*SELECT\s+(DISTINCT\s+)?TOP\b/i.test(masked)) return {sql, limited: false};
  // Shapes where injecting TOP or OFFSET produces invalid T-SQL:
  // `SELECT ALL` (TOP goes after ALL), `OPTION (...)`/`FOR XML|JSON` (they must
  // stay last). These stay unlimited in SQL; the client-side row/byte caps still
  // bound the result.
  if (/^\s*SELECT\s+ALL\b/i.test(masked)) return {sql, limited: false};
  if (/\bOPTION\s*\(/i.test(masked) || /\bFOR\s+(XML|JSON|BROWSE)\b/i.test(masked)) return {sql, limited: false};
  // A window function's `OVER (ORDER BY ...)` is not a statement-level ORDER
  // BY; appending OFFSET/FETCH there would be a syntax error, so only a
  // depth-0 ORDER BY accepts the paging rewrite.
  if (hasTopLevelOrderBy(masked)) {
    if (hasTopLevelOffsetFetch(masked)) return {sql, limited: false};
    return {sql: `${sql}\nOFFSET 0 ROWS FETCH NEXT ${limit} ROWS ONLY`, limited: true};
  }
  // Locate the token in the masked copy: block comments before SELECT are
  // blanks there, so `/* c */ SELECT ...` still gets a TOP instead of silently
  // running without any row limit. `sql` and `masked` have identical lengths.
  const head = /^(\s*SELECT\s+(?:DISTINCT\s+|ALL\s+)?)/i.exec(masked);
  if (head === null) return {sql, limited: false};
  const at = head[1].length;
  return {sql: `${sql.slice(0, at)}TOP (${limit}) ${sql.slice(at)}`, limited: true};
}

/**
 * Whether a statement has a depth-0 ORDER BY.
 *
 * @param {string} masked masked statement.
 * @returns {boolean} true when the statement itself is ordered.
 */
function hasTopLevelOrderBy(masked) {
  let depth = 0;
  for (let index = 0; index < masked.length; index += 1) {
    const character = masked[index];
    if (character === '(') depth += 1;
    else if (character === ')') depth = Math.max(0, depth - 1);
    else if (depth === 0 && (character === 'O' || character === 'o')) {
      if (/^ORDER\s+BY\b/i.test(masked.slice(index))) return true;
    }
  }
  return false;
}

/**
 * Whether a statement already has a depth-0 OFFSET/FETCH clause.
 *
 * @param {string} masked masked statement.
 * @returns {boolean} true when paging is already present.
 */
function hasTopLevelOffsetFetch(masked) {
  let depth = 0;
  for (let index = 0; index < masked.length; index += 1) {
    const character = masked[index];
    if (character === '(') depth += 1;
    else if (character === ')') depth = Math.max(0, depth - 1);
    else if (depth === 0) {
      if (/^(OFFSET|FETCH)\b/i.test(masked.slice(index))) return true;
    }
  }
  return false;
}

/**
 * Validate and quote one identifier for use in metadata SQL.
 *
 * Whitespace, quotes, control characters, and punctuation are rejected at the
 * boundary rather than escaped: an identifier that needs escaping is a signal
 * the caller did not get the name from the catalog.
 *
 * @param {string} dialect database dialect.
 * @param {string} identifier raw identifier.
 * @returns {string} quoted identifier.
 * @throws {Error} when the identifier is not a plain name.
 */
export function quoteIdentifier(dialect, identifier) {
  const text = String(identifier ?? '');
  if (text === '') throw new Error('标识符不能为空。');
  if (!/^[\p{L}\p{M}\p{N}_$]+$/u.test(text)) {
    throw new Error(`非法标识符：${JSON.stringify(text)}。只允许字母、数字、下划线、$。`);
  }
  if (dialect === 'mysql' || dialect === 'doris' || dialect === 'hive' || dialect === 'impala') return `\`${text}\``;
  if (dialect === 'sqlserver') return `[${text}]`;
  return `"${text}"`;
}

/**
 * Scan free text for a credential-looking fragment.
 *
 * @param {string} text text to scan.
 * @returns {string} a short description of the first hit, or ''.
 */
export function looksLikeCredential(text) {
  const patterns = [
    /password\s*[=:]\s*\S+/i,
    /pwd\s*[=:]\s*\S+/i,
    // URL DSN userinfo (`mysql://user:pw@host`) and space-separated password
    // variables: the previous patterns matched only a bare keyword, so a pasted
    // DSN was stored verbatim in a result label.
    /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@/i,
    /(?:MYSQL_PWD|PGPASSWORD|SQLCMDPASSWORD)\s*[=:]?\s*\S+/i,
    /mysql_pwd/i,
    /pgpassword/i,
    /sqlcmdpassword/i,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(String(text ?? ''));
    if (match !== null) return match[0];
  }
  return '';
}
