/**
 * Streaming MySQL reader.
 *
 * Why this exists: the previous loader issued one `mysql` process per page, so
 * every page ran in its own session/transaction. Deleting rows between pages
 * shifted `OFFSET` and silently dropped records. A single statement, read as a
 * stream, gives InnoDB's statement-level consistent read view for the whole
 * result: concurrent INSERT/UPDATE/DELETE cannot change what the statement sees.
 *
 * The child process is spawned directly (not through the Cordis subprocess
 * service) because that service captures output only after exit; this reader
 * must consume `<row>` elements as they arrive. The SQL is still validated by
 * the same read-only guards and the password still travels only through the
 * environment.
 *
 * @module src/db/stream
 */
import {spawn as nodeSpawn} from 'node:child_process';

import {assertReadOnly, enforceRowLimit} from '../core/sql-safety.js';
import {redactText} from '../core/redact.js';
import {DIALECTS, buildEnv, buildStdin, buildTemplate, explainClientFailure, parseMysqlXml} from './dialects.js';

/** Byte ceiling for one streamed result. */
export const DEFAULT_MAX_BYTES = 256 * 1024 * 1024;
/** Row ceiling used when the caller does not pass one. */
export const DEFAULT_STREAM_ROWS = 200_000;

/**
 * Read one MySQL result set as a stream.
 *
 * Returns the same shape the paged path produced plus an explicit consistency
 * record. The caller must treat `truncated` as "result incomplete".
 */
export class MysqlStreamReader {
  /** @type {(command: string, args: string[], options: object) => import('node:child_process').ChildProcess} */
  #spawnProcess;
  /** @type {(command: string) => Promise<string>} */
  #resolveExecutable;
  /** @type {object} */
  #logger;
  /** @type {object} */
  #defaults;

  /**
   * @param {{
   *   spawnProcess?: Function,
   *   resolveExecutable: (command: string, env?: object, signal?: AbortSignal) => Promise<string>,
   *   logger?: object,
   *   defaults?: {timeoutMs?: number, maxBytes?: number, maxRows?: number},
   * }} options injected primitives.
   */
  constructor(options) {
    this.#spawnProcess = options.spawnProcess ?? nodeSpawn;
    this.#resolveExecutable = options.resolveExecutable;
    this.#logger = options.logger ?? {};
    this.#defaults = {timeoutMs: 60_000, maxBytes: DEFAULT_MAX_BYTES, maxRows: DEFAULT_STREAM_ROWS, ...(options.defaults ?? {})};
  }

  /**
   * Stream one validated read-only statement.
   *
   * @param {object} connection analysis source.
   * @param {{
   *   sql: string, password?: string, signal?: AbortSignal, label?: string,
   *   maxRows?: number, maxBytes?: number, timeoutMs?: number,
   *   limitInSql?: boolean,
   *   onRow?: (row: Record<string, string|null>, index: number) => void,
   *   onProgress?: (loaded: number) => void,
   * }} request read request.
   * @returns {Promise<{
   *   columns: string[], rows: Record<string, string|null>[],
   *   truncated: boolean, capReached: boolean, bytesReached: boolean,
   *   elapsedMs: number, executedSql: string, enforcement: string,
   *   consistency: {level: string, note: string, startedAt: string, finishedAt: string},
   *   warnings: string[],
   * }>} streamed result.
   */
  async read(connection, request) {
    const label = request.label ?? 'dataset-load';
    const maxRows = request.maxRows ?? this.#defaults.maxRows;
    const maxBytes = request.maxBytes ?? this.#defaults.maxBytes;
    const timeoutMs = request.timeoutMs ?? this.#defaults.timeoutMs;
    const rawSql = String(request.sql ?? '');
    assertReadOnly(rawSql, connection.dialect, label);
    // By default the resource ceiling is also pushed into SQL so the server
    // stops early. Final-result queries disable the limit: the exported SQL must be the
    // exact statement the user relied on, and truncation is detected by the
    // stream row count instead of a LIMIT clause.
    const limitInSql = request.limitInSql !== false;
    const limited = limitInSql
      ? enforceRowLimit(rawSql, connection.dialect, maxRows + 1)
      : {sql: rawSql};
    const startedAt = new Date().toISOString();
    const started = Date.now();
    const warnings = [];
    const template = buildTemplate(connection, {maxRows, structured: true});
    const command = connection.command ?? DIALECTS[connection.dialect]?.client ?? 'mysql';
    const executable = await this.#resolveExecutable(command, template.env, request.signal);
    const env = streamEnv(connection, request.password);
    const stdinText = buildStdin(connection, template, limited.sql, request.password);

    const rows = [];
    const columnOrder = [];
    let buffer = '';
    let bytes = 0;
    let stderr = '';
    let capReached = false;
    let bytesReached = false;
    let timedOut = false;
    let aborted = false;
    let settled = false;

    const child = this.#spawnProcess(executable, template.argv, {env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true});

    return await new Promise((resolve, reject) => {
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        request.signal?.removeEventListener('abort', onAbort);
        fn(value);
      };
      const kill = () => {
        try {
          if (process.platform === 'win32' && typeof child.pid === 'number') {
            // Kill the whole client tree: a plain SIGKILL only terminates the
            // direct child on Windows and can leave the mysql client running.
            nodeSpawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {stdio: 'ignore', windowsHide: true});
            return;
          }
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      };
      const consume = (chunk) => {
        if (capReached || bytesReached || timedOut) return;
        buffer += chunk;
        for (;;) {
          const start = buffer.indexOf('<row>');
          if (start === -1) break;
          const end = buffer.indexOf('</row>', start);
          if (end === -1) break;
          const fragment = buffer.slice(start, end + '</row>'.length);
          buffer = buffer.slice(end + '</row>'.length);
          const parsed = parseMysqlXml(fragment, 1);
          if (parsed.rows.length === 0) continue;
          const row = parsed.rows[0];
          if (rows.length >= maxRows) {
            capReached = true;
            kill();
            return;
          }
          for (const name of Object.keys(row)) if (!columnOrder.includes(name)) columnOrder.push(name);
          rows.push(row);
          try {
            request.onRow?.(row, rows.length);
            if (rows.length % 5000 === 0) request.onProgress?.(rows.length);
          } catch (error) {
            kill();
            finish(reject, error instanceof Error ? error : new Error(String(error)));
            return;
          }
          // `truncated` is set by the *next* row (see the guard above): a result
          // with exactly `maxRows` rows is complete, one extra row means the
          // caller's ceiling was hit.
        }
      };
      const timer = setTimeout(() => {
        timedOut = true;
        kill();
      }, timeoutMs);
      const onAbort = () => {
        aborted = true;
        kill();
      };
      if (request.signal?.aborted) {
        aborted = true;
        kill();
      } else {
        request.signal?.addEventListener('abort', onAbort, {once: true});
      }
      /**
       * Drain a readable stream without using its event name, which is part of
       * legacy vocabulary this repository avoids.
       *
       * @param {import('node:stream').Readable} stream stream.
       * @param {(chunk: string) => void} onChunk chunk callback.
       */
      const drain = (stream, onChunk) => {
        stream.on('readable', () => {
          let chunk = stream.read();
          while (chunk !== null) {
            onChunk(chunk);
            chunk = stream.read();
          }
        });
      };
      child.stdout.setEncoding('utf8');
      drain(child.stdout, (chunk) => {
        if (capReached || bytesReached || timedOut) return;
        bytes += Buffer.byteLength(chunk);
        if (bytes > maxBytes) {
          bytesReached = true;
          kill();
          return;
        }
        consume(chunk);
      });
      child.stderr.setEncoding('utf8');
      drain(child.stderr, (chunk) => {
        if (stderr.length < 8000) stderr += chunk;
      });
      child.on('error', (error) => finish(reject, new Error(`${label}: 无法启动 mysql 客户端：${error.message}`)));
      child.on('close', (code) => {
        if (aborted) {
          finish(reject, new Error(`${label}: 已取消。`));
          return;
        }
        if (timedOut) {
          finish(reject, new Error(`${label}: 查询超时（${timeoutMs}ms），结果不完整。`));
          return;
        }
        if (code !== 0 && !capReached && !bytesReached) {
          const password = request.password;
          const shortSecret = typeof password === 'string' && password !== '' && password.length < 3;
          const reason = shortSecret
            ? '客户端报错中包含无法安全脱敏的短密码，原始错误已隐藏。'
            : explainClientFailure(redactText(stderr.trim(), [password]));
          const readOnlyBlocked = /READ ONLY transaction|1792/i.test(stderr);
          const hint = readOnlyBlocked
            ? '（数据库以只读会话拒绝了该语句，这是预期保护；请只提交 SELECT。）'
            : /READ ONLY|1846|SET TRANSACTION/i.test(stderr)
              ? '（会话级只读设置被数据库拒绝，按 fail-closed 策略未继续；请使用支持 SET SESSION TRANSACTION READ ONLY 的数据库或只读账号。）'
              : '';
          finish(reject, new Error(`${label}: 查询失败（exit ${code}）：${reason || '未知错误'}${hint}`));
          return;
        }
        try { request.onProgress?.(rows.length); } catch { /* progress is advisory */ }
        finish(resolve, {
          columns: columnOrder,
          rows,
          truncated: capReached || bytesReached,
          capReached,
          bytesReached,
          elapsedMs: Date.now() - started,
          executedSql: limited.sql,
          enforcement: DIALECTS[connection.dialect]?.readOnly ?? 'account',
          consistency: {
            level: 'statement-snapshot',
            note: capReached || bytesReached
              ? '单条 SELECT 读取期间使用 InnoDB 语句级读视图；因触及行数/字节上限提前终止，结果不完整。'
              : '单条 SELECT 在 InnoDB 中基于语句级读视图读取，读取期间的数据变更不影响本次结果。',
            startedAt,
            finishedAt: new Date().toISOString(),
          },
          warnings,
        });
      });
      child.stdin.on('error', () => {});
      child.stdin.end(stdinText);
    });
  }
}

/**
 * Minimal environment for the directly spawned MySQL client.
 *
 * Passing the full host environment would hand DSH variables and any
 * unrelated credentials to the database client. Keep only the variables a
 * client needs to locate itself, its libraries and its configuration.
 *
 * @param {object} connection connection.
 * @param {string|undefined} password resolved password.
 * @returns {Record<string, string>} scrubbed environment.
 */
function streamEnv(connection, password) {
  const allow = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'USER', 'LOGNAME', 'SHELL', 'LD_LIBRARY_PATH', 'DYLD_LIBRARY_PATH', 'SSL_CERT_FILE', 'SSL_CERT_DIR'];
  const env = {};
  for (const key of allow) {
    if (typeof process.env[key] === 'string') env[key] = process.env[key];
  }
  return {...env, ...buildEnv(connection, password)};
}

/**
 * Build a streaming reader from host primitives.
 *
 * @param {{subprocess: object, logger?: object, defaults?: object}} context host context.
 * @returns {MysqlStreamReader} reader.
 */
export function createMysqlStreamReader(context) {
  return new MysqlStreamReader({
    resolveExecutable: (command, env, signal) => context.subprocess.resolveExecutable(command, env, signal),
    logger: context.logger,
    defaults: context.defaults,
  });
}
