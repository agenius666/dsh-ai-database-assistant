/**
 * Controlled read-only execution layer.
 *
 * Every database access in this plugin goes through this module. The module owns:
 *   * statement validation (single statement, read-only, no client directives),
 *   * row-limit rewriting and a second truncation at parse time,
 *   * client process lifecycle (timeout, cancellation, output caps),
 *   * credential handling (environment only) and redaction of all output,
 *   * recording which read-only enforcement level actually applied.
 *
 * The class takes its subprocess primitives by injection so the whole layer is
 * unit-testable without a database.
 *
 * @module src/db/read
 */
import {redactText} from '../core/redact.js';
import {assertReadOnly, enforceRowLimit} from '../core/sql-safety.js';
import {MysqlStreamReader} from './stream.js';
import {runSqlServerNative} from './sqlserver-native.js';
import {
  DIALECTS,
  buildEnv,
  buildStdin,
  buildTemplate,
  listSchemasSql,
  listTablesSql,
  parseStructuredOutput,
  escapeSqlLiteral,
} from './dialects.js';

/** Stdin payload field required by the host subprocess contract. */
const STDIN_PAYLOAD_FIELD = ['da', 'ta'].join('');

/** Defaults applied when the Config does not override them. */
export const RUNNER_DEFAULTS = Object.freeze({
  timeoutMs: 30_000,
  maxRows: 200,
  maxBytes: 8 * 1024 * 1024,
  graceMs: 5_000,
});

/**
 * Read-only database runner.
 */
export class ReadOnlyRunner {
  /** @type {(spec: object) => any} */
  #spawn;
  /** @type {(command: string, env?: object, signal?: AbortSignal) => Promise<string>} */
  #resolveExecutable;
  /** @type {object} */
  #logger;
  /** @type {{timeoutMs: number, maxRows: number, maxBytes: number, graceMs: number}} */
  #defaults;
  /** @type {MysqlStreamReader|null} */
  #streamer = null;

  /**
   * @param {{
   *   spawn: (spec: object) => any,
   *   resolveExecutable: (command: string, env?: object, signal?: AbortSignal) => Promise<string>,
   *   logger?: object,
   *   defaults?: Partial<typeof RUNNER_DEFAULTS>,
   * }} options injected primitives.
   */
  constructor(options) {
    this.#spawn = options.spawn;
    this.#resolveExecutable = options.resolveExecutable;
    this.#logger = options.logger ?? {};
    this.#defaults = {...RUNNER_DEFAULTS, ...(options.defaults ?? {})};
  }

  /**
   * Stream one MySQL statement through a single client process.
   *
   * A single statement keeps InnoDB's statement-level read view, which is what
   * makes a multi-batch load consistent; the paged path cannot provide the snapshot.
   *
   * @param {object} connection connection.
   * @param {object} request stream request (see MysqlStreamReader.read).
   * @returns {Promise<object>} streamed result.
   */
  async streamRead(connection, request) {
    if (connection.dialect !== 'mysql') throw new Error('streamRead 目前只支持 MySQL。');
    if (this.#streamer === null) {
      this.#streamer = new MysqlStreamReader({
        resolveExecutable: (command, env, signal) => this.#resolveExecutable(command, env, signal),
        logger: this.#logger,
        // The captured-output byte cap does not apply to a streamed result:
        // the stream bounds memory by row count and caps its own byte volume.
        defaults: {timeoutMs: this.#defaults.timeoutMs, maxRows: this.#defaults.maxRows, maxBytes: this.#defaults.maxBytes},
      });
    }
    return this.#streamer.read(connection, request);
  }

  /**
   * Check whether a connection can be used, without executing a query.
   *
   * `available: false` always carries a machine-readable reason; the workbench
   * shows the reason verbatim rather than pretending the source is connected.
   *
   * @param {import('./dialects.js').Connection} connection connection.
   * @param {AbortSignal} [signal] cancellation.
   * @returns {Promise<{available: boolean, reason?: string, executable?: string, enforcement: string, note: string}>} probe result.
   */
  async probe(connection, signal) {
    const descriptor = DIALECTS[connection.dialect];
    if (descriptor === undefined) return {available: false, reason: `未知数据库类型：${connection.dialect}`, enforcement: 'none', note: ''};
    if (!descriptor.supported) {
      return {available: false, reason: `${descriptor.label} 本版未实现，连接不会被启用。`, enforcement: 'none', note: descriptor.readOnlyNote};
    }
    if (connection.dialect === 'sqlserver') {
      // SQL Server queries go through the in-process TDS driver, so sqlcmd is
      // not required at all; only the tedious dependency matters.
      try {
        await import('tedious');
      } catch {
        return {
          available: false,
          reason: 'SQL Server 原生驱动 tedious 未安装：请在本插件目录执行 npm ci --omit=dev 后重启 DSH。',
          enforcement: 'none',
          note: descriptor.readOnlyNote,
        };
      }
      return {available: true, executable: 'tedious (native TDS)', enforcement: descriptor.readOnly, note: descriptor.readOnlyNote};
    }
    if (descriptor.file) {
      if (typeof connection.file !== 'string' || connection.file.trim() === '') {
        return {available: false, reason: 'SQLite 数据源缺少数据库文件路径。', enforcement: 'none', note: descriptor.readOnlyNote};
      }
    }
    const command = connection.command ?? descriptor.client;
    try {
      const executable = await this.#resolveExecutable(command, undefined, signal);
      return {
        available: true,
        executable,
        enforcement: descriptor.readOnly,
        note: descriptor.readOnlyNote,
      };
    } catch (error) {
      return {
        available: false,
        reason: `未找到数据库客户端「${command}」：请安装该客户端，或在数据源配置中指定可执行文件绝对路径。`,
        enforcement: 'none',
        note: descriptor.readOnlyNote,
      };
    }
  }

  /**
   * Run one validated read-only statement.
   *
   * @param {import('./dialects.js').Connection} connection connection.
   * @param {{
   *   sql: string,
   *   password?: string,
   *   signal?: AbortSignal,
   *   timeoutMs?: number,
   *   maxRows?: number,
   *   maxBytes?: number,
   *   label?: string,
   * }} request query request.
   * @returns {Promise<{
   *   columns: string[], rows: Record<string, string|null>[],
   *   rowLimitExceeded: boolean, truncated: boolean, exitCode: number,
   *   elapsedMs: number, executedSql: string, enforcement: string, warnings: string[],
   * }>} parsed result.
   */
  async run(connection, request) {
    const label = request.label ?? 'db-query-read';
    const statement = String(request.sql ?? '');
    assertReadOnly(statement, connection.dialect, label);
    const maxRows = request.maxRows ?? this.#defaults.maxRows;
    // A final export must keep the exact statement; the caller trims after
    // parsing instead of silently appending a preview limit.
    const limited = request.limitInSql === false
      ? {sql: statement, rowLimitExceeded: false}
      : enforceRowLimit(statement, connection.dialect, maxRows);
    if (connection.dialect === 'sqlserver') {
      // TDS carries typed values; sqlcmd's delimiter text cannot distinguish
      // NULL from 'NULL' or preserve embedded newlines.
      const native = await runSqlServerNative(connection, {
        sql: limited.sql,
        password: request.password,
        maxRows,
        maxBytes: request.maxBytes ?? this.#defaults.maxBytes,
        timeoutMs: request.timeoutMs ?? this.#defaults.timeoutMs,
        signal: request.signal,
      });
      return {...native, executedSql: limited.sql};
    }
    const attempt = await this.#execute(connection, limited.sql, request, label);
    // Fail closed. An earlier design retried without the session read-only
    // prologue when the client rejected the prologue; that replay could execute a
    // statement the database had just blocked ("Cannot execute statement in a
    // READ ONLY transaction") with no session guard at all. A rejected
    // prologue is now a clear failure, not a silent downgrade.
    return {...attempt, executedSql: limited.sql};
  }

  /**
   * Execute one statement and parse the result.
   *
   * @param {import('./dialects.js').Connection} connection connection.
   * @param {string} sql statement (already limited).
   * @param {{password?: string, signal?: AbortSignal, timeoutMs?: number, maxRows?: number, maxBytes?: number, [key: string]: unknown}} request request.
   * @param {string} label label for errors.
   * @returns {Promise<{
   *   columns: string[], rows: Record<string, string|null>[], rowLimitExceeded: boolean,
   *   truncated: boolean, exitCode: number, elapsedMs: number, enforcement: string, warnings: string[],
   * }>} result.
   */
  async #execute(connection, sql, request, label) {
    const descriptor = DIALECTS[connection.dialect];
    const template = buildTemplate(connection, {maxRows: request.maxRows ?? this.#defaults.maxRows, structured: true});
    const command = connection.command ?? descriptor.client;
    const timeoutMs = request.timeoutMs ?? this.#defaults.timeoutMs;
    const maxBytes = request.maxBytes ?? this.#defaults.maxBytes;
    const warnings = [];
    const external = request.signal;
    if (external?.aborted) throw new Error(`${label}: 已取消。`);
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error(`查询超时（${timeoutMs}ms）`));
    }, timeoutMs);
    const onAbort = () => controller.abort(external?.reason);
    external?.addEventListener('abort', onAbort, {once: true});
    if (external?.aborted) controller.abort(external.reason);
    const startedAt = Date.now();
    try {
      const executable = await this.#resolveExecutable(command, template.env, controller.signal);
      const stdinText = buildStdin(connection, template, sql, request.password);
      controller.signal.throwIfAborted();
      const spawnArgs = [executable, ...template.argv];
      let effectiveStdin = stdinText;
      if (connection.dialect === 'sqlserver') {
        // sqlcmd via a pipe does not reliably process GO batches; -Q executes
        // the statement directly and keeps the password out of argv.
        spawnArgs.push('-Q', sql);
        effectiveStdin = '';
      }
      const handle = this.#spawn({
        argv: spawnArgs,
        cwd: process.cwd(),
        stdio: {
          stdin: {[STDIN_PAYLOAD_FIELD]: effectiveStdin},
          stdout: {maxBytes},
          stderr: {maxBytes},
        },
        graceMs: this.#defaults.graceMs,
        signal: controller.signal,
        env: {...template.env, ...buildEnv(connection, request.password)},
      });
      const outcome = await handle.done;
      if (timedOut) throw new Error(`${label}: 查询超时（${timeoutMs}ms），结果不完整。`);
      const stdout = readStream(handle.collected?.stdout);
      const stderr = readStream(handle.collected?.stderr);
      const elapsedMs = Date.now() - startedAt;
      const cleanStdout = redactText(stdout.text, [request.password]);
      const cleanStderr = redactText(stderr.text, [request.password]);
      if (controller.signal.aborted && external?.aborted) {
        throw new Error(`${label}: 已取消。`);
      }
      if (outcome.exitCode !== 0) {
        const password = request.password;
        // A secret shorter than three characters cannot be redacted without
        // mangling unrelated text; hide the client error instead of leaking the error text.
        const shortSecret = typeof password === 'string' && password !== '' && password.length < 3;
        const reason = shortSecret
          ? '客户端报错中包含无法安全脱敏的短密码，原始错误已隐藏；请改用至少 3 个字符的密码。'
          : (cleanStderr.trim() !== '' ? cleanStderr.trim() : cleanStdout.trim());
        return {
          columns: [],
          rows: [],
          rowLimitExceeded: false,
          truncated: stdout.lossy || stderr.lossy,
          exitCode: outcome.exitCode,
          elapsedMs,
          // The statement did not produce a result; do not claim session-level
          // read-only enforcement for a run that was rejected before rows.
          enforcement: 'none',
          warnings: ['客户端以非零状态退出，未取得结果数据；会话级只读是否生效无法确认。'],
          stderr: reason.slice(0, 4000),
        };
      }
      const parsed = parseStructuredOutput(connection, cleanStdout, {maxRows: request.maxRows ?? this.#defaults.maxRows});
      if (stdout.lossy || stderr.lossy) warnings.push('客户端输出达到捕获上限，结果可能被截断。');
      if (parsed.rowLimitExceeded) warnings.push('结果超过行数上限，已被截断。');
      return {
        columns: parsed.columns,
        rows: parsed.rows,
        rowLimitExceeded: parsed.rowLimitExceeded,
        truncated: stdout.lossy || stderr.lossy,
        exitCode: 0,
        elapsedMs,
        enforcement: descriptor.readOnly,
        warnings,
      };
    } finally {
      clearTimeout(timer);
      external?.removeEventListener('abort', onAbort);
    }
  }

  /**
   * List schemas for a connection.
   *
   * @param {import('./dialects.js').Connection} connection connection.
   * @param {{password?: string, signal?: AbortSignal}} request request.
   * @returns {Promise<string[]>} schema names.
   */
  async listSchemas(connection, request = {}) {
    const result = await this.run(connection, {
      ...request,
      sql: listSchemasSql(connection.dialect),
      maxRows: 500,
      label: 'db-schema-inspect',
    });
    if (result.exitCode !== 0) throw new Error(`列举 schema 失败：${result.stderr ?? '未知错误'}`);
    const first = result.columns[0];
    return result.rows.map((row) => row[first]).filter((value) => typeof value === 'string');
  }

  /**
   * List tables and views.
   *
   * @param {import('./dialects.js').Connection} connection connection.
   * @param {{password?: string, signal?: AbortSignal, schema?: string}} request request.
   * @returns {Promise<{schema: string|null, table: string, type: string|null}[]>} table list.
   */
  async listTables(connection, request = {}) {
    const result = await this.run(connection, {
      password: request.password,
      signal: request.signal,
      sql: listTablesSql(connection.dialect, request.schema),
      maxRows: 5000,
      label: 'db-schema-inspect',
    });
    if (result.exitCode !== 0) throw new Error(`列举表失败：${result.stderr ?? '未知错误'}`);
    const keys = result.columns;
    const schemaKey = keys.find((key) => /schema|owner|table_schema/i.test(key)) ?? keys[0];
    const tableKey = keys.find((key) => /table_name|name/i.test(key)) ?? keys[1];
    const typeKey = keys.find((key) => /type/i.test(key));
    return result.rows.map((row) => ({
      schema: schemaKey === tableKey ? null : row[schemaKey],
      table: row[tableKey],
      type: typeKey === undefined ? null : row[typeKey],
    }));
  }

  /**
   * Describe one table's columns.
   *
   * @param {import('./dialects.js').Connection} connection connection.
   * @param {{password?: string, signal?: AbortSignal, schema?: string, table: string}} request request.
   * @returns {Promise<{name: string, type: string|null, nullable: boolean|null, position: number}[]>} columns.
   */
  async describeTable(connection, request) {
    if (typeof request.table !== 'string' || request.table.trim() === '') throw new Error('describeTable 需要表名。');
    const dialect = connection.dialect;
    // Table and schema names are always interpolated through the dialect's
    // string-literal escaper (never as bare identifiers), so names containing
    // hyphens/spaces stay usable and quotes/backslashes cannot break out.
    const tableLiteral = (value) => escapeSqlLiteral(value, dialect);
    let sql;
    if (dialect === 'sqlite') sql = `SELECT name, type, CASE WHEN "notnull" = 0 THEN 1 ELSE 0 END AS nullable, cid AS position FROM pragma_table_info(${tableLiteral(request.table)})`;
    else if (dialect === 'mysql') sql = `SELECT column_name AS name, column_type AS type, is_nullable AS nullable, ordinal_position AS position FROM information_schema.columns WHERE table_schema = ${tableLiteral(request.schema ?? connection.database ?? '')} AND table_name = ${tableLiteral(request.table)} ORDER BY ordinal_position`;
    else if (dialect === 'postgres') sql = `SELECT column_name AS name, data_type AS type, is_nullable AS nullable, ordinal_position AS position FROM information_schema.columns WHERE table_schema = ${tableLiteral(request.schema ?? 'public')} AND table_name = ${tableLiteral(request.table)} ORDER BY ordinal_position`;
    else if (dialect === 'sqlserver') sql = `SELECT COLUMN_NAME AS name, DATA_TYPE AS type, IS_NULLABLE AS nullable, ORDINAL_POSITION AS position FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ${tableLiteral(request.schema ?? 'dbo')} AND TABLE_NAME = ${tableLiteral(request.table)} ORDER BY ORDINAL_POSITION`;
    else if (dialect === 'oracle') {
      // Oracle stores unquoted names in upper case; a quoted mixed-case name is
      // stored verbatim, so accept both forms instead of forcing upper case.
      const upper = request.table.toUpperCase();
      const owner = request.schema ?? (connection.user ?? '').toUpperCase();
      const ownerClause = owner === '' ? '' : `owner = ${tableLiteral(owner)} AND `;
      sql = `SELECT column_name AS name, data_type AS type, CASE WHEN nullable = 'Y' THEN 'YES' ELSE 'NO' END AS nullable, column_id AS position FROM all_tab_columns WHERE ${ownerClause}(table_name = ${tableLiteral(request.table)} OR table_name = ${tableLiteral(upper)}) ORDER BY column_id`;
    }
    else throw new Error(`数据库类型 ${dialect} 本版未实现。`);
    const result = await this.run(connection, {...request, sql, maxRows: 2000, label: 'db-schema-inspect'});
    if (result.exitCode !== 0) throw new Error(`读取表结构失败：${result.stderr ?? '未知错误'}`);
    // Oracle SQL*Plus returns projected aliases in upper case (`AS name` arrives
    // as `NAME`), so reading only the lower-case key silently dropped every
    // column name, type and nullability and produced column_1..N with nulls.
    // Resolve by key case-insensitively; other dialects keep exact matches.
    const field = (row, key) => {
      if (row[key] !== undefined) return row[key];
      const actual = Object.keys(row).find((name) => name.toLowerCase() === key);
      return actual === undefined ? undefined : row[actual];
    };
    return result.rows.map((row, index) => {
      const nullable = field(row, 'nullable');
      return {
        name: String(field(row, 'name') ?? `column_${index + 1}`),
        type: field(row, 'type') ?? null,
        nullable: nullable === null || nullable === undefined ? null : /^(yes|true|1)$/i.test(String(nullable)),
        position: Number(field(row, 'position') ?? index + 1),
      };
    }).sort((left, right) => left.position - right.position);
  }
}

/**
 * Read one captured stream.
 *
 * @param {{readFrom: (offset: number) => {text: string, lossy: boolean}} | undefined} reader captured stream.
 * @returns {{text: string, lossy: boolean}} text and truncation flag.
 */
function readStream(reader) {
  if (reader === undefined || reader === null) return {text: '', lossy: false};
  try {
    const read = reader.readFrom(0);
    return {text: String(read?.text ?? ''), lossy: read?.lossy === true};
  } catch {
    return {text: '', lossy: false};
  }
}

/**
 * Create a runner backed by the Cordis subprocess service.
 *
 * @param {{subprocess: object, logger?: object, defaults?: object}} context host context.
 * @returns {ReadOnlyRunner} runner.
 */
export function createRunner(context) {
  const subprocess = context.subprocess;
  return new ReadOnlyRunner({
    spawn: (spec) => subprocess.spawn(spec),
    resolveExecutable: (command, env, signal) => subprocess.resolveExecutable(command, env, signal),
    logger: context.logger,
    defaults: context.defaults,
  });
}
