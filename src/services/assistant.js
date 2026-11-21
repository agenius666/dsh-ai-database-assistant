/**
 * Natural-language database assistant service.
 *
 * This is the assistant core: a project owns one or more MySQL connections; the
 * agent explores schema, writes read-only SQL, executes the SQL, and exports the
 * *same* stored result as XLSX + CSV + SQL. There are no rules, no rule
 * confirmations and no analysis evidence packs in this flow.
 *
 * Result snapshots live under `projects/<id>/results/<resultId>/`:
 *   meta.json   public metadata (SQL, columns, counts, consistency)
 *   rows.jsonl  one JSON row per line (exact values, strings + null)
 *   preview.json first rows for the UI/model (never the full result)
 *
 * @module src/services/assistant
 */
import {createHash, randomBytes} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {chmod, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, stat, writeFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {createInterface} from 'node:readline';
import {dirname, join} from 'node:path';

import {AssistantError, ERROR_CODES} from '../core/errors.js';
import {assertReadOnly, looksLikeCredential} from '../core/sql-safety.js';
import {analyzeSql} from '../core/sql-review.js';
import {explainClientFailure} from '../db/dialects.js';
import {
  canonicalizeRealPath,
  describeFsError,
  hostPlatform,
  sameUserPath,
  sanitizeFileBaseName,
  validateUserPath,
} from '../core/user-path.js';
import {writeXlsx} from '../formats/xlsx-write.js';

/** Preview row ceiling returned to the model. */
export const PREVIEW_ROWS = 50;
/** Explore queries are deliberately small. */
export const EXPLORE_ROWS = 200;
/** Final result ceiling (per query). */
export const FINAL_ROWS = 200_000;
/** Hard bounds for the model-facing preview. */
export const PREVIEW_LIMITS = Object.freeze({min: 5, max: 100, defaultValue: 50});
/** A single result snapshot above this size is refused for export. */
export const MAX_EXPORT_BYTES = 256 * 1024 * 1024;
/** Result ids are package-generated; anything else is a path attempt. */
const RESULT_ID_PATTERN = /^RES-[0-9A-Za-z-]+$/;
/** Ownership marker written inside an export staging directory. */
const STAGE_MARKER = '.ita-owner';
/** Prefix of an overwrite backup kept inside a staging directory. */
const BACKUP_PREFIX = 'backup-';
/** Functions whose value changes between executions. */
const NONDETERMINISTIC = /\b(NOW|CURDATE|CURRENT_DATE|CURRENT_TIMESTAMP|SYSDATE|RAND|UUID|UNIX_TIMESTAMP|CURTIME)\s*\(/i;

/**
 * New result id.
 *
 * @returns {string} id.
 */
function newResultId() {
  return `RES-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${randomBytes(3).toString('hex')}`;
}

/**
 * Public SQL text: strip a trailing semicolon, keep exactly one at export.
 *
 * @param {string} sql SQL.
 * @returns {string} trimmed SQL.
 */
function bareSql(sql) {
  return String(sql).trim().replace(/;+\s*$/, '');
}

/**
 * Mask a credential-shaped fragment in a display label.
 *
 * Purpose/base name are free-text labels persisted in the result index and
 * shown in the UI/model; a pasted connection string must not be stored there.
 * Query SQL itself is deliberately left untouched: `WHERE password = 'x'` is a
 * legitimate predicate, and rewriting executed SQL would break provenance.
 *
 * @param {string} text label text.
 * @returns {string} label with credential-shaped fragments masked.
 */
function scrubCredentialLabel(text) {
  const hit = looksLikeCredential(text);
  if (hit === '') return text;
  return text.replaceAll(hit, '***').slice(0, 500);
}

/** Assistant service. */
export class AssistantService {
  /** @type {object} */
  #store;
  /** @type {object} */
  #projects;
  /** @type {object|null} */
  #runner;
  /** @type {object} */
  #logger;
  /** @type {object} */
  #config;
  /** @type {number} */
  #previewLimit;
  /** @type {number} captured-result byte ceiling for the buffered dialects. */
  #maxBytes;
  /** @type {Promise<void>} serializes exports to bound peak memory. */
  #exportQueue = Promise.resolve();
  /** @type {Map<string, Promise<void>>} per-project read/modify/write locks. */
  #projectLocks = new Map();
  /** @type {Set<AbortController>} in-flight query cancellations. */
  #activeQueries = new Set();
  /** @type {boolean} set by dispose so late calls fail instead of writing. */
  #disposed = false;

  /**
   * @param {{store: object, projects: object, runner?: object, logger?: object, config?: object}} options composition.
   */
  constructor(options) {
    this.#store = options.store;
    this.#projects = options.projects;
    this.#runner = options.runner ?? null;
    this.#logger = options.logger ?? {};
    this.#config = options.config ?? {};
    const requested = Number(this.#config.previewRows ?? PREVIEW_LIMITS.defaultValue);
    this.#previewLimit = Number.isFinite(requested)
      ? Math.min(Math.max(Math.trunc(requested), PREVIEW_LIMITS.min), PREVIEW_LIMITS.max)
      : PREVIEW_LIMITS.defaultValue;
    const configuredBytes = Number(this.#config.maxResultBytes);
    this.#maxBytes = Number.isFinite(configuredBytes) && configuredBytes >= 1024 * 1024
      ? Math.min(Math.trunc(configuredBytes), 1024 * 1024 * 1024)
      : 256 * 1024 * 1024;
  }

  /**
   * Serialize one read/modify/write sequence per project.
   *
   * The result index and the per-session final state are whole-file read /
   * modify / write sequences; two concurrent final queries used to read the
   * same index and the later write silently dropped the earlier entry.
   *
   * @template T
   * @param {string} projectId project id.
   * @param {() => Promise<T>} operation critical section.
   * @returns {Promise<T>} operation result.
   */
  async #withProjectLock(projectId, operation) {
    const previous = this.#projectLocks.get(projectId) ?? Promise.resolve();
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    const queued = previous.then(() => current);
    this.#projectLocks.set(projectId, queued);
    await previous.catch(() => {});
    try {
      return await operation();
    } finally {
      release();
      if (this.#projectLocks.get(projectId) === queued) this.#projectLocks.delete(projectId);
    }
  }

  /**
   * Cancel in-flight queries and refuse new ones.
   *
   * @returns {void}
   */
  dispose() {
    this.#disposed = true;
    for (const controller of this.#activeQueries) {
      try { controller.abort(new Error('插件已卸载，查询已取消。')); } catch { /* already settled */ }
    }
    this.#activeQueries.clear();
  }

  /** @returns {number} model-facing preview row limit. */
  get previewLimit() {
    return this.#previewLimit;
  }

  /** @returns {number} final result ceiling. */
  get finalRows() {
    return Number(this.#config.maxRowsPerSource ?? FINAL_ROWS);
  }

  /**
   * Pick the database source for a project.
   *
   * @param {string} projectId project id.
   * @param {string|undefined} sourceId explicit source.
   * @returns {Promise<object>} source.
   */
  async #sourceOf(projectId, sourceId) {
    const sources = await this.#projects.listSources(projectId);
    const databases = sources.filter((entry) => entry.kind === 'database');
    if (databases.length === 0) {
      throw new AssistantError(ERROR_CODES.invalidInput, '当前项目还没有数据库连接。请先在项目顶部添加 MySQL 连接并测试通过。');
    }
    if (sourceId === undefined || sourceId === '') {
      // The documented default is the first *available* connection, not the first
      // created one: an untested older connection must not block a query.
      return databases.find((entry) => entry.status?.available === true) ?? databases[0];
    }
    const selected = databases.find((entry) => entry.id === sourceId);
    if (selected === undefined) throw new AssistantError(ERROR_CODES.notFound, `数据源不存在或不属于当前项目：${sourceId}`);
    return selected;
  }

  /**
   * Execute one read-only query and store its complete result snapshot.
   *
   * @param {string} projectId project id.
   * @param {{sql: string, mode?: 'explore'|'final', sourceId?: string, purpose?: string, baseName?: string}} request query.
   * @param {{credentials?: object, sessionId?: string}} context host context.
   * @returns {Promise<object>} result metadata with a bounded preview.
   */
  async query(projectId, request, context = {}) {
    if (this.#disposed) throw new AssistantError(ERROR_CODES.internal, '插件已卸载，不能继续查询。');
    // Validate the project before writing per-session state: a traversal-shaped
    // project id must not create files under another project.
    await this.#projects.requireProject(projectId);
    const mode = request.mode === 'explore' ? 'explore' : 'final';
    const sessionId = typeof context.sessionId === 'string' && context.sessionId !== '' ? context.sessionId : null;
    const controller = new AbortController();
    this.#activeQueries.add(controller);
    try {
      if (mode === 'final' && sessionId !== null) await this.#recordFinal(projectId, sessionId, {status: 'running'});
      try {
        const result = await this.#queryUnsafe(projectId, request, {...context, signal: controller.signal});
        if (mode === 'final' && sessionId !== null) {
          await this.#recordFinal(projectId, sessionId, {
            status: result.complete === true ? 'complete' : 'incomplete',
            resultId: result.resultId,
          });
        }
        return result;
      } catch (error) {
        if (mode === 'final' && sessionId !== null) {
          await this.#recordFinal(projectId, sessionId, {status: 'failed', reason: error instanceof Error ? error.message : String(error)});
        }
        throw error;
      }
    } finally {
      this.#activeQueries.delete(controller);
    }
  }

  async #queryUnsafe(projectId, request, context = {}) {
    await this.#projects.requireProject(projectId);
    if (typeof request.sql !== 'string' || request.sql.trim() === '') {
      throw new AssistantError(ERROR_CODES.invalidInput, 'SQL 不能为空。');
    }
    if (request.sql.length > 20_000) {
      throw new AssistantError(ERROR_CODES.invalidInput, 'SQL 不能超过 20,000 个字符。');
    }
    const source = await this.#sourceOf(projectId, request.sourceId);
    // Reject unsafe SQL before any availability/credential check so a write
    // attempt is always reported as a read-only violation. Guard errors are
    // policy decisions, not internal failures: wrap them so the HTTP/tool layer
    // reports the declared read-only-violation code instead of a 500.
    try {
      assertReadOnly(bareSql(request.sql), source.dialect, 'db-query');
    } catch (error) {
      if (error instanceof AssistantError) throw error;
      throw new AssistantError(ERROR_CODES.sourceReadOnly, error instanceof Error ? error.message : String(error));
    }
    if (this.#runner === null || typeof this.#runner.streamRead !== 'function') {
      throw new AssistantError(ERROR_CODES.internal, '数据库执行器未就绪，暂时无法查询。');
    }
    if (source.status?.available !== true) {
      throw new AssistantError(ERROR_CODES.sourceUnavailable, `数据库「${source.name}」尚未连接成功。请先测试连接。`);
    }
    const mode = request.mode === 'explore' ? 'explore' : 'final';
    const maxRows = mode === 'explore' ? EXPLORE_ROWS : this.finalRows;
    const password = await this.#projects.resolvePassword(source, context);
    const started = Date.now();
    const streamed = source.dialect === 'mysql'
      ? await this.#runner.streamRead(source, {
          sql: bareSql(request.sql),
          password,
          maxRows,
          maxBytes: this.#maxBytes,
          limitInSql: false,
          signal: context.signal,
          label: `assistant:${mode}`,
        })
      : await this.#runBuffered(source, bareSql(request.sql), {maxRows, password, mode, signal: context.signal});
    const resultId = newResultId();
    const directory = `projects/${projectId}/results/${resultId}`;
    const complete = !streamed.truncated;
    const valueKinds = scanValueKinds(streamed.rows);
    const nondeterministic = NONDETERMINISTIC.test(bareSql(request.sql));
    const review = analyzeSql(bareSql(request.sql));
    const columnTypes = await this.#columnTypes(source, bareSql(request.sql), password, context.signal);
    // An empty result set carries no column metadata from the MySQL XML stream
    // (and none from the sqlite3 CSV output), so the snapshot used to record
    // `columns: []`: exporting it produced a headerless CSV/XLSX and the model
    // could not describe the projection. For the simple single-table SELECTs
    // `#columnTypes` covers, its ordered projection aliases are the exact column
    // list; anything it cannot resolve stays empty and export refuses instead of
    // silently delivering a file without headers.
    const columns = streamed.columns.length > 0 ? streamed.columns : Object.keys(columnTypes);
    const purpose = scrubCredentialLabel(typeof request.purpose === 'string' ? request.purpose.slice(0, 500) : '');
    const baseName = scrubCredentialLabel(typeof request.baseName === 'string' ? request.baseName.slice(0, 120) : '');
    const meta = {
      resultId,
      projectId,
      sessionId: context.sessionId ?? null,
      sourceId: source.id,
      sourceName: source.name,
      database: source.database ?? source.file ?? null,
      schema: source.schema ?? null,
      dialect: source.dialect,
      mode,
      purpose,
      baseName,
      sql: bareSql(request.sql),
      executedSql: streamed.executedSql,
      columns,
      rowCount: streamed.rows.length,
      complete,
      truncated: streamed.truncated,
      elapsedMs: Date.now() - started,
      consistency: streamed.consistency,
      nondeterministic,
      review,
      columnTypes,
      valueKinds,
      csvPolicy: 'CSV 中 SQL NULL 与空字符串都输出为空；以 = + - @ 开头的文本加单引号防公式注入（合法负数不加）。',
      previewRows: Math.min(streamed.rows.length, this.#previewLimit),
      createdAt: new Date().toISOString(),
    };
    const resultDir = this.#store.path(directory);
    await mkdir(resultDir, {recursive: true, mode: 0o700});
    // Stream the snapshot to disk: joining 200k rows into one string would
    // roughly double the peak memory for no benefit.
    const handle = await open(join(resultDir, 'rows.jsonl'), 'w', 0o600);
    try {
      let chunk = [];
      for (const row of streamed.rows) {
        chunk.push(JSON.stringify(row));
        if (chunk.length >= 2000) {
          await handle.write(`${chunk.join('\n')}\n`);
          chunk = [];
        }
      }
      if (chunk.length > 0) await handle.write(`${chunk.join('\n')}\n`);
    } finally {
      await handle.close();
    }
    await writeFile(join(resultDir, 'preview.json'), `${JSON.stringify(streamed.rows.slice(0, this.#previewLimit))}\n`, {encoding: 'utf8', mode: 0o600});
    await this.#store.writeJson(`${directory}/meta.json`, meta);
    await this.#index(projectId, meta);
    return this.#publicResult(meta, streamed.rows.slice(0, this.#previewLimit));
  }

  /**
   * List recent results of a project (metadata only).
   *
   * @param {string} projectId project id.
   * @param {{limit?: number}} [options] options.
   * @returns {Promise<object[]>} results.
   */
  async listResults(projectId, options = {}) {
    await this.#projects.requireProject(projectId);
    const state = await this.#store.readJson(`projects/${projectId}/results.json`, {results: []});
    return (state.results ?? [])
      .filter((entry) => entry.cleared !== true)
      .slice()
      .sort((left, right) => (left.createdAt < right.createdAt ? 1 : -1))
      .slice(0, Math.min(Math.max(Math.trunc(Number(options.limit ?? 20)), 1), 50))
      .map((entry) => ({
        resultId: entry.resultId,
        purpose: entry.purpose,
        baseName: entry.baseName,
        sourceId: entry.sourceId ?? null,
        sourceName: entry.sourceName ?? null,
        database: entry.database ?? null,
        dialect: entry.dialect ?? null,
        columns: entry.columns,
        rowCount: entry.rowCount,
        complete: entry.complete,
        truncated: entry.truncated,
        elapsedMs: entry.elapsedMs,
        consistency: entry.consistency?.level ?? null,
        createdAt: entry.createdAt,
        mode: entry.mode,
        exported: entry.exported ?? null,
      }));
  }

  /**
   * Page through all results of a project (metadata only).
   *
   * @param {string} projectId project id.
   * @param {{page?: number, pageSize?: number}} [options] paging.
   * @returns {Promise<{items: object[], total: number, page: number, pageSize: number, pageCount: number}>} page.
   */
  async listResultsPage(projectId, options = {}) {
    await this.#projects.requireProject(projectId);
    const pageSize = Math.min(Math.max(Math.trunc(Number(options.pageSize ?? 10)), 1), 50);
    const state = await this.#store.readJson(`projects/${projectId}/results.json`, {results: []});
    const sorted = (state.results ?? [])
      .filter((entry) => entry.cleared !== true)
      .slice()
      .sort((left, right) => (left.createdAt < right.createdAt ? 1 : -1));
    const total = sorted.length;
    const pageCount = Math.max(Math.ceil(total / pageSize), 1);
    const page = Math.min(Math.max(Math.trunc(Number(options.page ?? 1)), 1), pageCount);
    const items = sorted.slice((page - 1) * pageSize, page * pageSize).map((entry) => ({
      resultId: entry.resultId,
      purpose: entry.purpose,
      baseName: entry.baseName,
      columns: entry.columns,
      rowCount: entry.rowCount,
      complete: entry.complete,
      truncated: entry.truncated,
      elapsedMs: entry.elapsedMs,
      consistency: entry.consistency?.level ?? null,
      createdAt: entry.createdAt,
      mode: entry.mode,
      exported: entry.exported ?? null,
    }));
    return {items, total, page, pageSize, pageCount};
  }

  /**
   * Read one result: metadata plus a bounded preview, never all rows.
   *
   * @param {string} projectId project id.
   * @param {string} resultId result id.
   * @param {{previewRows?: number}} [options] options.
   * @returns {Promise<object>} result.
   */
  async getResult(projectId, resultId, options = {}) {
    await this.#projects.requireProject(projectId);
    const meta = await this.#readMeta(projectId, resultId);
    if (meta.cleared === true) {
      // The snapshot was cleaned; SQL/purpose stay readable, the rows are gone.
      return this.#publicResult(meta, []);
    }
    const requested = Number(options.previewRows ?? this.#previewLimit);
    const limit = Number.isFinite(requested)
      ? Math.min(Math.max(Math.trunc(requested), 1), this.#previewLimit)
      : this.#previewLimit;
    // Read only the preview lines: a 200k-row snapshot must not be loaded just
    // to show 50 rows to the model or the UI.
    const preview = await this.#readPreview(projectId, resultId, limit);
    return this.#publicResult(meta, preview);
  }

  /**
   * Set the project's delivery directory (the only directory export may write).
   *
   * The path is checked against the Host platform (the machine that will write
   * the files), then proven against the real filesystem: it must be (or become)
   * a directory, accept a probe file, and resolve to a canonical real path.
   * Every failure is reported for what it actually is — "not absolute" is only
   * one of the possible reasons.
   *
   * @param {string} projectId project id.
   * @param {string} directory absolute directory chosen by the user.
   * @returns {Promise<object>} normalized directory info.
   */
  async setOutputDir(projectId, directory) {
    await this.#projects.requireProject(projectId);
    const absolute = validateUserPath(directory, {
      platform: hostPlatform(),
      label: '保存目录',
      maxLength: 1000,
    });
    const existing = await stat(absolute).catch(() => null);
    if (existing !== null) {
      if (!existing.isDirectory()) throw new AssistantError(ERROR_CODES.invalidInput, '指定路径不是文件夹。');
    } else {
      try {
        // The user may type a new sub-directory; creating it is the documented
        // behavior, but a failure (missing drive, unreachable UNC share, no
        // permission) must say why.
        await mkdir(absolute, {recursive: true});
      } catch (error) {
        throw describeFsError(error, {label: '保存目录'})
          ?? new AssistantError(ERROR_CODES.invalidInput, `无法创建保存目录：${absolute}`);
      }
    }
    const probe = join(absolute, `.ita-write-test-${randomBytes(3).toString('hex')}`);
    try {
      await writeFile(probe, 'ok', 'utf8');
    } catch (error) {
      throw describeFsError(error, {label: '保存目录'})
        ?? new AssistantError(ERROR_CODES.forbidden, `无法写入指定目录：${absolute}`);
    } finally {
      await rm(probe, {force: true}).catch((error) => {
        this.#logger.warn?.(`ai-database-assistant: 无法删除写入检查文件 ${probe}：${error instanceof Error ? error.message : String(error)}`);
      });
    }
    let real;
    try {
      // A native Windows realpath may answer `\\?\C:\...`; store the canonical
      // form instead so the saved value stays a normal absolute path.
      real = canonicalizeRealPath(await realpath(absolute), {platform: hostPlatform()});
    } catch (error) {
      throw describeFsError(error, {label: '保存目录'})
        ?? new AssistantError(ERROR_CODES.invalidInput, `无法解析保存目录的真实路径：${absolute}`);
    }
    const project = await this.#projects.requireProject(projectId);
    await this.#projects.updateProject(projectId, {outputDir: real});
    return {projectId: project.id, outputDir: real};
  }

  /**
   * Suggest a delivery directory for this Host, without creating or saving it.
   *
   * Only directories that already exist are used, so the suggestion is legal on
   * the machine that would write the files. Nothing is created, nothing is
   * persisted, and the user's existing choice is never overwritten: the caller
   * may show this as a hint only.
   *
   * @returns {Promise<string|null>} suggested directory, or null when no
   *   existing directory is usable (the UI then asks for a manual path).
   */
  async suggestOutputDir() {
    const home = homedir();
    for (const candidate of [join(home, 'Documents'), home]) {
      if (typeof candidate !== 'string' || candidate === '') continue;
      const info = await stat(candidate).catch(() => null);
      if (info !== null && info.isDirectory()) return join(candidate, 'DSH 数据库分析结果');
    }
    return null;
  }

  /**
   * Read the project's delivery directory.
   *
   * @param {string} projectId project id.
   * @returns {Promise<string|null>} directory or null.
   */
  async outputDirOf(projectId) {
    const project = await this.#projects.requireProject(projectId);
    return typeof project.outputDir === 'string' && project.outputDir !== '' ? project.outputDir : null;
  }

  /**
   * Export one stored result as XLSX + CSV + SQL.
   *
   * @param {string} projectId project id.
   * @param {string} resultId result id.
   * @param {{baseName?: string, formats?: string[], directory?: string, overwrite?: boolean}} [request] export request.
   * @returns {Promise<object>} delivered files.
   */
  async exportResult(projectId, resultId, request = {}) {
    // Only one export may build an XLSX at a time; two 200k-row exports would
    // otherwise double peak memory in the same process.
    const previous = this.#exportQueue;
    let release;
    this.#exportQueue = new Promise((resolve) => { release = resolve; });
    await previous.catch(() => {});
    try {
      return await this.#exportUnlocked(projectId, resultId, request);
    } finally {
      release();
    }
  }

  async #exportUnlocked(projectId, resultId, request = {}) {
    // Serialize against query results, clearResults and the result index; a
    // concurrent clear must not turn into a resurrected or half-cleared export.
    return this.#withProjectLock(projectId, async () => {
    await this.#projects.requireProject(projectId);
    const meta = await this.#readMeta(projectId, resultId);
    if (meta.cleared === true) throw new AssistantError(ERROR_CODES.conflict, '该结果的数据快照已被清理，不能再导出；SQL 仍可在「查询说明」中查看。');
    if (typeof request.sessionId === 'string' && request.sessionId !== ''
      && typeof meta.sessionId === 'string' && meta.sessionId !== '' && meta.sessionId !== request.sessionId) {
      throw new AssistantError(ERROR_CODES.forbidden, '该结果属于其他会话，已拒绝导出；请在当前会话重新查询，或使用当前会话的最新结果。');
    }
    if (meta.complete !== true || meta.truncated === true) {
      throw new AssistantError(ERROR_CODES.conflict, `结果不完整（已加载 ${meta.rowCount} 行，达到上限）。请缩小查询范围或提高上限后重新查询，不能导出被截断的结果。`);
    }
    const projectDir = await this.outputDirOf(projectId);
    if (projectDir === null) {
      throw new AssistantError(ERROR_CODES.invalidInput, '尚未设置保存目录。请先在项目顶部选择保存文件夹。');
    }
    const supplied = request.directory === undefined || request.directory === '' ? null : String(request.directory);
    // The stored directory was validated when it was saved; validate *input*, not
    // the already-authorized configuration. Otherwise a directory name that is
    // legal on the current filesystem but rejected by today's input rules (for
    // example a legacy macOS name with a control character) would break export
    // without the user changing anything.
    const targetPath = supplied === null || supplied === projectDir
      ? projectDir
      : validateUserPath(supplied, {
        platform: hostPlatform(),
        label: '导出目录',
        maxLength: 1000,
      });
    let realProject;
    try {
      realProject = canonicalizeRealPath(await realpath(projectDir), {platform: hostPlatform()});
    } catch (error) {
      throw describeFsError(error, {label: '保存目录'})
        ?? new AssistantError(ERROR_CODES.invalidInput, `保存目录不可用：${projectDir}`);
    }
    // A symlink/junction at the authorized directory itself means the path now
    // points somewhere else than the directory the user authorized. Reject a
    // pre-existing replacement instead of writing through it. (A rename race
    // during one export is still possible; see the residual-risk register.)
    const projectDirInfo = await lstat(projectDir).catch(() => null);
    if (projectDirInfo !== null && projectDirInfo.isSymbolicLink()) {
      throw new AssistantError(ERROR_CODES.forbidden, '保存目录已被符号链接/联接替换，已拒绝导出；请重新保存目录后再试。');
    }
    let realTarget;
    try {
      realTarget = canonicalizeRealPath(await realpath(targetPath), {platform: hostPlatform()});
    } catch (error) {
      // A path outside the authorized directory is rejected even when the path does
      // not exist: existence must not be the authorization check.
      if (!sameUserPath(targetPath, projectDir, {platform: hostPlatform()})) {
        throw new AssistantError(ERROR_CODES.forbidden, '导出只能写入项目设置里授权的保存目录。');
      }
      throw describeFsError(error, {label: '保存目录'})
        ?? new AssistantError(ERROR_CODES.invalidInput, `保存目录不存在：${targetPath}`);
    }
    if (!sameUserPath(realTarget, realProject, {platform: hostPlatform()})) {
      throw new AssistantError(ERROR_CODES.forbidden, '导出只能写入项目设置里授权的保存目录。');
    }
    const formats = Array.isArray(request.formats) && request.formats.length > 0
      ? [...new Set(request.formats.map((entry) => String(entry)))]
      : ['xlsx', 'csv', 'sql'];
    const allowed = new Set(['xlsx', 'csv', 'sql']);
    for (const format of formats) {
      if (!allowed.has(format)) throw new AssistantError(ERROR_CODES.invalidInput, `不支持的导出格式：${format}`);
    }
    const baseName = sanitizeBaseName(scrubCredentialLabel(request.baseName || meta.baseName || meta.purpose || `查询结果-${resultId}`));
    const rowsPath = this.#store.path(`projects/${projectId}/results/${resultId}/rows.jsonl`);
    const rowsInfo = await stat(rowsPath).catch(() => null);
    if (rowsInfo === null) {
      throw new AssistantError(ERROR_CODES.conflict, '结果快照数据缺失（可能已被清理），不能导出。');
    }
    if (rowsInfo.size > MAX_EXPORT_BYTES) {
      throw new AssistantError(ERROR_CODES.conflict, `结果快照体积 ${Math.round(rowsInfo.size / 1024 / 1024)} MB 超过单次导出上限 ${MAX_EXPORT_BYTES / 1024 / 1024} MB；请缩小范围或聚合后再查询。`);
    }
    if (!Array.isArray(meta.columns) || meta.columns.length === 0) {
      // A headerless CSV/XLSX looks like a successful delivery while losing the
      // projection entirely. Refuse and tell the user how to get a real file.
      throw new AssistantError(ERROR_CODES.invalidInput, '该结果没有列信息（空结果集且查询不是简单的单表列投影），导出的文件会缺少表头；请显式列出列名后重新查询，或先确认表中有数据。');
    }
    const rows = await this.#readRows(projectId, resultId);
    if (Number.isInteger(meta.rowCount) && rows.length !== meta.rowCount) {
      // A truncated/corrupt rows.jsonl would otherwise be delivered as if it were
      // the whole result: the receipt says N rows, the files hold fewer.
      throw new AssistantError(ERROR_CODES.conflict, `结果快照不完整：元数据记录 ${meta.rowCount} 行，实际读取 ${rows.length} 行；已拒绝导出，请重新执行查询。`);
    }
    // One base name for the whole delivery: xlsx/csv/sql must share the base name even when
    // an older file with the same name already exists.
    const deliveryBase = await this.#uniqueBase(realTarget, baseName, formats, request.overwrite === true);
    const delivered = [];
    const planned = [];
    const stageDir = join(realTarget, `.ita-stage-${resultId}-${randomBytes(4).toString('hex')}`);
    const created = [];
    await this.#cleanStaleStages(realTarget);
    const recovered = await this.#recoverDeliveries(projectId);
    let journalPath = null;
    let journalRelative = null;
    /** @type {{files: string[], backups: {target: string, backup: string}[]}} */
    const journalEntry = {files: [], backups: []};
    try {
      await mkdir(stageDir, {recursive: true, mode: 0o700});
      // Ownership marker: stale-stage cleanup may only remove directories this
      // plugin created, never a user directory that happens to use the prefix.
      await writeFile(join(stageDir, STAGE_MARKER), `${resultId}\n`, {encoding: 'utf8', mode: 0o600});
      for (const format of formats) {
        const finalName = `${deliveryBase}.${format}`;
        const staged = join(stageDir, finalName);
        if (format === 'csv') await writeCsvFile(staged, meta.columns, rows);
        else if (format === 'sql') await writeFile(staged, buildSqlFile(meta), {encoding: 'utf8', mode: 0o600});
        else await writeXlsx(staged, buildWorkbook(meta, rows));
        const info = await stat(staged);
        if (!info.isFile() || info.size === 0) throw new Error(`${format.toUpperCase()} 生成结果为空或不是文件`);
        planned.push({format, name: finalName, staged, target: join(realTarget, finalName), bytes: info.size});
      }
      // Journal the planned commit so an interrupted delivery can be identified
      // on the next export. The journal lives in the plugin store, never in the
      // user's directory.
      journalEntry.files = planned.map((item) => item.name);
      const journalId = `${Date.now()}-${randomBytes(4).toString('hex')}`;
      journalRelative = `exports/${journalId}.json`;
      await this.#store.writeJson(journalRelative, {id: journalId, projectId, resultId, directory: realTarget, ...journalEntry, createdAt: new Date().toISOString()});
      journalPath = this.#store.path(journalRelative);
      // Commit only after every file is generated; roll back this run's files if
      // a later rename fails. User files that existed before are never touched.
      for (const item of planned) {
        const existing = await lstat(item.target).catch(() => null);
        if (existing !== null && !existing.isFile()) {
          throw new Error(`目标已存在且不是普通文件，拒绝覆盖：${item.name}`);
        }
        let backup = null;
        if (existing !== null) {
          if (request.overwrite !== true) throw new Error(`目标文件已存在，拒绝覆盖：${item.name}`);
          backup = join(stageDir, `backup-${randomBytes(4).toString('hex')}-${item.name}`);
          await rename(item.target, backup);
          // Register the backup for rollback BEFORE the journal write: if that
          // write fails, the catch block restores it. Previously the backup was
          // pushed only after the journal write, so a journal failure deleted the
          // user's previous file together with the stage directory.
          created.push({target: item.target, backup});
          journalEntry.backups.push({target: item.target, backup});
          try {
            await this.#store.writeJson(journalRelative, {id: journalId, projectId, resultId, directory: realTarget, ...journalEntry, createdAt: new Date().toISOString()});
          } catch (error) {
            throw new AssistantError(ERROR_CODES.internal, `导出记录（journal）写入失败，已回滚本次导出：${error instanceof Error ? error.message : String(error)}`);
          }
        } else {
          created.push({target: item.target, backup: null});
        }
        try {
          await rename(item.staged, item.target);
        } catch (error) {
          if (backup !== null) await rename(backup, item.target).catch(() => {});
          throw error;
        }
      }
      await rm(journalPath, {force: true}).catch(() => {});
    } catch (error) {
      // Restore every pre-existing file before removing files created by this
      // run; a partial overwrite must never destroy the user's old delivery.
      for (const entry of created.reverse()) {
        if (entry.backup !== null) await rename(entry.backup, entry.target).catch(() => {});
        else await rm(entry.target, {force: true}).catch(() => {});
      }
      await rm(stageDir, {recursive: true, force: true}).catch(() => {});
      if (journalPath !== null) await rm(journalPath, {force: true}).catch(() => {});
      // Report the real cause (missing directory, permission, disk full, name too
      // long) instead of one generic "导出失败"; the raw fs text may be localized
      // and different per platform.
      if (error instanceof AssistantError) throw error;
      const mapped = describeFsError(error, {label: '保存目录'});
      if (mapped !== null) {
        this.#logger.warn?.(`ai-database-assistant: 导出失败（${mapped.code}）：${error instanceof Error ? error.stack ?? error.message : String(error)}`);
        throw mapped;
      }
      // The raw message may contain Host paths or localized OS text; keep it in
      // the Host log and give the UI/model a stable reason.
      this.#logger.warn?.(`ai-database-assistant: 导出失败（未分类）：${error instanceof Error ? error.stack ?? error.message : String(error)}`);
      const message = error instanceof Error ? error.message : String(error);
      // Data-shape failures are actionable for the user; do not collapse them
      // into "internal" (they were reproduced: a cell longer than Excel's
      // 32,767-character limit aborted the whole delivery).
      if (/超过 Excel|单元格|32767/u.test(message)) {
        throw new AssistantError(ERROR_CODES.invalidInput, message);
      }
      if (/目标已存在且不是普通文件/u.test(message)) {
        throw new AssistantError(ERROR_CODES.conflict, message);
      }
      throw new AssistantError(ERROR_CODES.internal, '导出失败，已清理本次未完成的文件；详细原因已写入宿主日志。');
    }
    await rm(stageDir, {recursive: true, force: true}).catch(() => {});
    for (const item of planned) delivered.push({format: item.format, name: item.name, path: item.target, bytes: item.bytes});
    const stamp = new Date().toISOString().replace(/[-:TZ]/g, '').slice(0, 14);
    meta.exported = {at: new Date().toISOString(), directory: realTarget, baseName, files: delivered.map((entry) => entry.name), stamp};
    await this.#store.writeJson(`projects/${projectId}/results/${resultId}/meta.json`, meta);
    await this.#indexLocked(projectId, meta);
    return {resultId, directory: realTarget, baseName, rowCount: meta.rowCount, files: delivered, warnings: [], recovered};
    });
  }

  /**
   * Persist an export receipt in the project's result index.
   *
   * @param {string} projectId project id.
   * @param {object} meta result meta.
   * @returns {Promise<void>} resolves after write.
   */
  async #index(projectId, meta) {
    await this.#withProjectLock(projectId, () => this.#indexLocked(projectId, meta));
  }

  /**
   * Index a result while the caller already holds the project lock.
   *
   * @param {string} projectId project id.
   * @param {object} meta result meta.
   * @returns {Promise<void>} resolves after write.
   */
  async #indexLocked(projectId, meta) {
    const path = `projects/${projectId}/results.json`;
    const state = await this.#store.readJson(path, {results: []});
    const results = Array.isArray(state.results) ? state.results : [];
    const index = results.findIndex((entry) => entry.resultId === meta.resultId);
    const entry = {...meta, preview: undefined, previewRows: undefined};
    if (index === -1) results.push(entry); else results[index] = entry;
    // Keep every result; retention is the user's choice, not a hard cap.
    await this.#store.writeJson(path, {results});
  }

  /**
   * Buffered read-only query for non-MySQL dialects.
   *
   * The CLI clients cannot stream a single statement the way mysql --xml does,
   * so this path captures the bounded output, trims to the caller's row ceiling
   * and marks the result incomplete when the client/limit cut the result. The path is marked
   * experimental in the result receipt.
   *
   * @param {object} source database source.
   * @param {string} sql statement.
   * @param {{maxRows: number, password?: string, mode: string}} options options.
   * @returns {Promise<object>} stream-shaped result.
   */
  async #runBuffered(source, sql, options) {
    if (this.#runner === null || typeof this.#runner.run !== 'function') {
      throw new AssistantError(ERROR_CODES.internal, `${source.dialect} 执行器未就绪。`);
    }
    const outcome = await this.#runner.run(source, {
      sql,
      password: options.password,
      maxRows: options.maxRows + 1,
      maxBytes: this.#maxBytes,
      limitInSql: false,
      signal: options.signal,
      label: `assistant:${options.mode}`,
    });
    if (outcome.exitCode !== 0) {
      throw new AssistantError(ERROR_CODES.sourceUnavailable, explainClientFailure(outcome.stderr) || `${source.dialect} 查询失败。`);
    }
    const truncated = outcome.truncated === true || outcome.rows.length > options.maxRows;
    return {
      columns: outcome.columns,
      rows: outcome.rows.slice(0, options.maxRows),
      truncated,
      consistency: {
        level: 'single-statement-buffered',
        note: `${source.dialect} 客户端单条只读语句缓冲读取；结果按行数上限裁剪。`,
      },
      executedSql: outcome.executedSql ?? sql,
      warnings: outcome.warnings ?? [],
      elapsedMs: outcome.elapsedMs,
    };
  }

  /**
   * Resolve declared column types for a trivial single-table projection.
   *
   * MySQL's XML stream does not carry result-set types. For a plain
   * `SELECT col[, col] FROM table [WHERE/ORDER/LIMIT]` we can read the table
   * definition; for expressions, aggregates and joins we return `{}` and the
   * exporter keeps everything as text rather than guessing.
   *
   * @param {object} source database source.
   * @param {string} sql normalized SQL.
   * @param {string|undefined} password reader password.
   * @returns {Promise<Record<string, string>>} output column → mysql type.
   */
  async #columnTypes(source, sql, password, signal) {
    if (this.#runner === null || typeof this.#runner.describeTable !== 'function') return {};
    if (/\b(join|union|distinct|group\s+by|having|with|over\s*\(|select\s+\*)\b/i.test(sql)) return {};
    const match = /^\s*select\s+([\s\S]+?)\s+from\s+([`\w.]+)\s*(?:where|order\s+by|limit|$)/i.exec(sql);
    if (match === null) return {};
    const selectList = match[1];
    if (selectList.includes('(')) return {};
    const rawTable = match[2].replace(/`/g, '');
    const parts = rawTable.split('.');
    const table = parts.pop();
    const schema = parts.length > 0 ? parts.pop() : undefined;
    const expressions = [];
    for (const item of selectList.split(',')) {
      const columnMatch = /^\s*(?:`?([A-Za-z_][\w$]*)`?|([A-Za-z_][\w$]*))\s*(?:as\s+`?([A-Za-z_][\w$]*)`?)?\s*$/i.exec(item);
      if (columnMatch === null) return {};
      const column = columnMatch[1] ?? columnMatch[2];
      expressions.push({column, alias: columnMatch[3] ?? column});
    }
    if (expressions.length === 0) return {};
    try {
      const described = await this.#runner.describeTable(source, {table, schema: schema ?? source.schema, password, signal});
      const byName = new Map(described.map((entry) => [String(entry.name), String(entry.type ?? '').toLowerCase()]));
      const types = {};
      for (const {column, alias} of expressions) {
        const type = byName.get(column);
        if (type === undefined) return {};
        types[alias] = type;
      }
      return types;
    } catch {
      return {};
    }
  }

  /**
   * Load and validate result metadata.
   *
   * @param {string} projectId project id.
   * @param {string} resultId result id.
   * @returns {Promise<object>} meta.
   */
  async #readMeta(projectId, resultId) {
    if (typeof resultId !== 'string' || !RESULT_ID_PATTERN.test(resultId)) {
      throw new AssistantError(ERROR_CODES.invalidInput, '结果 ID 不合法。');
    }
    const meta = await this.#store.readJson(`projects/${projectId}/results/${resultId}/meta.json`, null);
    if (meta === null) throw new AssistantError(ERROR_CODES.notFound, `查询结果不存在：${resultId}`);
    if (meta.projectId !== projectId) throw new AssistantError(ERROR_CODES.forbidden, '结果不属于当前项目。');
    return meta;
  }

  /**
   * Tighten permissions on internal result snapshots (historical included).
   *
   * Never follows symlinks and never touches exported files outside the store.
   *
   * @param {string|null} projectId project id, or null for every project.
   * @returns {Promise<{directories: number, files: number, skippedSymlinks: number}>} counts.
   */
  async hardenPermissions(projectId = null) {
    const counts = {directories: 0, files: 0, skippedSymlinks: 0};
    const roots = [];
    if (projectId !== null) {
      await this.#projects.requireProject(projectId);
      roots.push(this.#store.path(`projects/${projectId}/results`));
    } else {
      const projects = await this.#projects.listProjects();
      for (const project of projects) roots.push(this.#store.path(`projects/${project.id}/results`));
    }
    for (const root of roots) {
      let entries;
      try {
        entries = await readdir(root, {withFileTypes: true});
      } catch {
        continue;
      }
      for (const entry of entries) {
        const target = join(root, entry.name);
        if (entry.isSymbolicLink()) {
          counts.skippedSymlinks += 1;
          continue;
        }
        if (!entry.isDirectory()) continue;
        await chmod(target, 0o700).catch(() => {});
        counts.directories += 1;
        const files = await readdir(target, {withFileTypes: true}).catch(() => []);
        for (const file of files) {
          if (file.isSymbolicLink()) {
            counts.skippedSymlinks += 1;
            continue;
          }
          if (!file.isFile()) continue;
          await chmod(join(target, file.name), 0o600).catch(() => {});
          counts.files += 1;
        }
      }
    }
    return counts;
  }

  /**
   * Read only the first N snapshot rows.
   *
   * @param {string} projectId project id.
   * @param {string} resultId result id.
   * @param {number} limit rows to read.
   * @returns {Promise<object[]>} preview rows.
   */
  async #readPreview(projectId, resultId, limit) {
    const path = this.#store.path(`projects/${projectId}/results/${resultId}/rows.jsonl`);
    const stream = createReadStream(path, {encoding: 'utf8'});
    const reader = createInterface({input: stream, crlfDelay: Infinity});
    const rows = [];
    try {
      for await (const line of reader) {
        if (line.trim() === '') continue;
        rows.push(JSON.parse(line));
        if (rows.length >= limit) break;
      }
    } finally {
      // readline.close() detaches the interface but does not close the file
      // descriptor of the stream it wrapped; destroy it so previews cannot leak
      // handles across a long Host uptime.
      reader.close();
      stream.destroy();
    }
    return rows;
  }

  /**
   * Read all rows of a result.
   *
   * @param {string} projectId project id.
   * @param {string} resultId result id.
   * @returns {Promise<object[]>} rows.
   */
  async #readRows(projectId, resultId) {
    const text = await readFile(this.#store.path(`projects/${projectId}/results/${resultId}/rows.jsonl`), 'utf8');
    return text.split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line));
  }

  /**
   * Persist the final-query state for a session.
   *
   * A failed/incomplete final query must block default export even when older
   * complete results exist.
   *
   * @param {string} projectId project id.
   * @param {string} sessionId session id.
   * @param {{status: string, resultId?: string, reason?: string}} patch state patch.
   * @returns {Promise<void>} resolves after write.
   */
  async #recordFinal(projectId, sessionId, patch) {
    await this.#withProjectLock(projectId, async () => {
      const path = this.#sessionStatePath(projectId, sessionId);
      const state = await this.#store.readJson(path, {sessionId, latestFinal: null});
      state.sessionId = sessionId;
      state.latestFinal = {...state.latestFinal, ...patch, at: new Date().toISOString()};
      // A recovered success must not keep the previous failure reason around.
      if (state.latestFinal.status !== 'failed') delete state.latestFinal.reason;
      await this.#store.writeJson(path, state);
    });
  }

  /**
   * Stable state file path for a session (no raw ids in file names).
   *
   * @param {string} projectId project id.
   * @param {string} sessionId session id.
   * @returns {string} relative path.
   */
  #sessionStatePath(projectId, sessionId) {
    const key = createHash('sha256').update(sessionId).digest('hex').slice(0, 32);
    return `projects/${projectId}/assistant-sessions/${key}.json`;
  }

  /**
   * Latest final-query state for one session.
   *
   * @param {string} projectId project id.
   * @param {string} sessionId session id.
   * @returns {Promise<object|null>} state summary.
   */
  async latestFinalSummary(projectId, sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') return null;
    const state = await this.#store.readJson(this.#sessionStatePath(projectId, sessionId), null);
    if (state === null || state.latestFinal === null || state.latestFinal === undefined) return null;
    return {...state.latestFinal, sessionId};
  }

  /**
   * Latest result that may be exported by default.
   *
   * Returns null when the session never ran a final query. Throws when the most
   * recent final query did not produce a complete result, so callers cannot
   * silently fall back to an older success.
   *
   * @param {string} projectId project id.
   * @param {string} sessionId session id.
   * @returns {Promise<string|null>} result id.
   */
  async latestResultId(projectId, sessionId) {
    const summary = await this.latestFinalSummary(projectId, sessionId);
    if (summary === null) return null;
    if (summary.status === 'failed') {
      throw new AssistantError(ERROR_CODES.conflict, `最近一次最终查询失败（${summary.reason ?? '未知原因'}），不能默认导出历史结果。请修正查询后重试，或明确指定要导出的历史 resultId。`);
    }
    if (summary.status === 'incomplete') {
      throw new AssistantError(ERROR_CODES.conflict, '最近一次最终查询数据不完整（达到行数上限），不能默认导出历史结果。请缩小范围后重试，或明确指定历史 resultId。');
    }
    if (summary.status === 'running') {
      const startedAt = Date.parse(summary.at ?? '');
      const stale = Number.isFinite(startedAt) && Date.now() - startedAt > 10 * 60 * 1000;
      if (stale) {
        throw new AssistantError(ERROR_CODES.conflict, '最近一次最终查询未正常结束（宿主可能中断），状态仍为“执行中”；请重新执行一次最终查询以清除该状态，或明确指定历史 resultId。');
      }
      throw new AssistantError(ERROR_CODES.conflict, '最近一次最终查询还在执行，暂时不能默认导出；请等待完成或明确指定历史结果。');
    }
    if (typeof summary.resultId !== 'string' || summary.resultId === '') {
      throw new AssistantError(ERROR_CODES.conflict, '最近一次最终查询没有可导出的结果，请重新查询。');
    }
    const cleared = await this.#store.readJson(`projects/${projectId}/results/${summary.resultId}/meta.json`, null).catch(() => null);
    if (cleared === null || cleared.cleared === true) {
      // The session pointer can outlive its snapshot (clearResults keeps the
      // pointer). Report the real cause instead of letting export fail later.
      throw new AssistantError(ERROR_CODES.conflict, '最近一次最终查询的数据快照已被清理，不能默认导出；请重新执行一次最终查询，或明确指定历史 resultId。');
    }
    return summary.resultId;
  }

  /**
   * Clear old internal snapshots, never the user's exported files.
   *
   * @param {string} projectId project id.
   * @param {{keep?: number}} [options] how many newest snapshots to keep.
   * @returns {Promise<{removed: number, kept: number, keptIds: string[]}>} cleanup result.
   */
  async clearResults(projectId, options = {}) {
    await this.#projects.requireProject(projectId);
    return this.#withProjectLock(projectId, async () => {
    const keep = Math.min(Math.max(Math.trunc(Number(options.keep ?? 10)), 1), 200);
    const state = await this.#store.readJson(`projects/${projectId}/results.json`, {results: []});
    const sorted = [...(state.results ?? [])].sort((left, right) => (left.createdAt < right.createdAt ? 1 : -1));
    const kept = sorted.slice(0, keep);
    const removed = sorted.slice(keep);
    const tombstoned = [];
    for (const entry of removed) {
      const directory = this.#store.path(`projects/${projectId}/results/${entry.resultId}`);
      const metaPath = join(directory, 'meta.json');
      let meta = null;
      try {
        meta = JSON.parse(await readFile(metaPath, 'utf8'));
      } catch {
        meta = null;
      }
      await rm(join(directory, 'rows.jsonl'), {force: true}).catch(() => {});
      await rm(join(directory, 'preview.json'), {force: true}).catch(() => {});
      if (meta !== null) {
        meta.cleared = true;
        meta.clearedAt = new Date().toISOString();
        meta.rowCount = meta.rowCount ?? 0;
        await this.#store.writeJson(`projects/${projectId}/results/${entry.resultId}/meta.json`, meta);
        tombstoned.push({...entry, cleared: true, clearedAt: meta.clearedAt});
      }
    }
    // Cleared results keep a tombstone (SQL/purpose/time) so history can explain
    // the missing rows instead of pretending the result never existed.
    await this.#store.writeJson(`projects/${projectId}/results.json`, {results: [...kept, ...tombstoned]});
    return {removed: removed.length, kept: kept.length, keptIds: kept.map((entry) => entry.resultId), clearedIds: removed.map((entry) => entry.resultId)};
    });
  }

  /**
   * Public result shape.
   *
   * @param {object} meta meta.
   * @param {object[]} preview preview rows.
   * @returns {object} public result.
   */
  #publicResult(meta, preview) {
    const result = {
      resultId: meta.resultId,
      mode: meta.mode,
      purpose: meta.purpose,
      baseName: meta.baseName,
      // Which connection produced this result must stay visible: the default
      // source can silently switch to another available connection.
      sourceId: meta.sourceId ?? null,
      sourceName: meta.sourceName ?? null,
      database: meta.database ?? null,
      dialect: meta.dialect ?? null,
      sql: meta.sql,
      executedSql: meta.executedSql,
      columns: meta.columns,
      rowCount: meta.rowCount,
      complete: meta.complete,
      truncated: meta.truncated,
      elapsedMs: meta.elapsedMs,
      consistency: meta.consistency,
      nondeterministic: meta.nondeterministic === true,
      review: meta.review ?? null,
      columnTypes: meta.columnTypes ?? {},
      cleared: meta.cleared === true,
      notice: meta.cleared === true
        ? '该结果的数据快照已清理：只能说明 SQL、目的与时间，不能导出，也不应自动重新执行；只有用户明确要求重新查询时才可再执行 SQL。'
        : null,
      valueKinds: meta.valueKinds ?? {hasNull: false, hasEmptyString: false},
      csvPolicy: meta.csvPolicy ?? '',
      createdAt: meta.createdAt,
      preview,
      previewRows: preview.length,
      exported: meta.exported ?? null,
    };
    // Tool output schemas declare these as strings; omit them when absent
    // instead of returning null (which fails output validation).
    if (result.notice === null || result.notice === undefined) delete result.notice;
    if (result.review === null || result.review === undefined) delete result.review;
    return result;
  }

  /**
   * Write one delivery journal (plugin store, never the user directory).
   *
   * @param {{projectId: string, resultId: string, directory: string, files: string[]}} entry delivery.
   * @returns {Promise<string>} absolute journal path.
   */
  async #writeJournal(entry) {
    const id = `${Date.now()}-${randomBytes(4).toString('hex')}`;
    const relative = `exports/${id}.json`;
    await this.#store.writeJson(relative, {...entry, id, createdAt: new Date().toISOString()});
    return this.#store.path(relative);
  }

  /**
   * Identify interrupted deliveries older than one hour.
   *
   * Never deletes final files: they may have been modified by the user. The cleanup only
   * reports whether the planned set was complete and removes the journal.
   *
   * @returns {Promise<object[]>} recovery reports.
   */
  async #recoverDeliveries(projectId) {
    const directory = this.#store.path('exports');
    const entries = await readdir(directory).catch(() => []);
    const staleAfterMs = 60 * 60 * 1000;
    const recovered = [];
    for (const name of entries) {
      if (!name.endsWith('.json')) continue;
      const path = join(directory, name);
      let entry;
      try {
        entry = JSON.parse(await readFile(path, 'utf8'));
      } catch {
        continue;
      }
      // Journals describe one project's delivery; another project's failed
      // export must never be reported to (or deleted on behalf of) this one.
      if (entry.projectId !== projectId) continue;
      if (Date.now() - Date.parse(entry.createdAt ?? 0) < staleAfterMs) continue;
      const restored = [];
      const restoreErrors = [];
      for (const backup of entry.backups ?? []) {
        const targetExists = await stat(backup.target).then(() => true, () => false);
        const backupExists = await stat(backup.backup).then(() => true, () => false);
        if (!targetExists && backupExists) {
          try {
            await mkdir(dirname(backup.target), {recursive: true});
            await rename(backup.backup, backup.target);
            restored.push(backup.target);
          } catch (error) {
            restoreErrors.push({target: backup.target, error: error instanceof Error ? error.message : String(error)});
            this.#logger.warn?.(`ai-database-assistant: 恢复被覆盖的交付失败：${backup.target}: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      }
      const present = [];
      const missing = [];
      for (const file of entry.files ?? []) {
        const exists = await stat(join(entry.directory, file)).then(() => true, () => false);
        (exists ? present : missing).push(file);
      }
      recovered.push({id: entry.id, resultId: entry.resultId, directory: entry.directory, present, missing, restored, restoreErrors, complete: missing.length === 0});
      await rm(path, {force: true}).catch(() => {});
    }
    return recovered;
  }

  /**
   * Remove staging directories left by a crashed export (older than one hour).
   *
   * Only directories this plugin created are removed: the ownership marker is
   * required, and a directory that still holds an overwrite backup is preserved
   * so recovery can restore the user's previous delivery.
   *
   * @param {string} directory authorized export directory.
   * @returns {Promise<void>} resolves after best-effort cleanup.
   */
  async #cleanStaleStages(directory) {
    const entries = await readdir(directory, {withFileTypes: true}).catch(() => []);
    const staleAfterMs = 60 * 60 * 1000;
    const cutoff = Date.now() - staleAfterMs;
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith('.ita-stage-')) continue;
      const target = join(directory, entry.name);
      try {
        const info = await lstat(target);
        if (info.isSymbolicLink()) continue;
        if (info.mtimeMs >= cutoff) continue;
        const owned = await stat(join(target, STAGE_MARKER)).then(() => true, () => false);
        if (!owned) continue;
        const children = await readdir(target).catch(() => []);
        if (children.some((name) => name.startsWith(BACKUP_PREFIX))) continue;
        await rm(target, {recursive: true, force: true});
      } catch (error) {
        // A concurrent export may finish first; anything else is worth a log.
        if (error?.code !== 'ENOENT') this.#logger.warn?.(`ai-database-assistant: 清理导出暂存目录失败：${target}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  /**
   * Choose one non-clashing base name shared by every requested format.
   *
   * @param {string} directory authorized directory.
   * @param {string} base requested base name.
   * @param {string[]} formats requested formats.
   * @param {boolean} overwrite allowed to overwrite.
   * @returns {Promise<string>} base name without extension.
   */
  async #uniqueBase(directory, base, formats, overwrite) {
    const exists = async (candidate) => stat(join(directory, candidate)).then(() => true, () => false);
    if (overwrite) return base;
    const free = async (candidate) => {
      for (const format of formats) {
        if (await exists(`${candidate}.${format}`)) return false;
      }
      return true;
    };
    if (await free(base)) return base;
    const stamp = new Date().toISOString().replace(/[-:TZ]/g, '').slice(0, 14);
    let candidate = `${base}-${stamp}`;
    let counter = 2;
    while (!(await free(candidate))) {
      candidate = `${base}-${stamp}-${counter}`;
      counter += 1;
    }
    return candidate;
  }
}

/**
 * Keep only characters that are safe in a delivered file name.
 *
 * The rule is the portable one (Windows is stricter than POSIX): illegal
 * characters, trailing dots/spaces and reserved device names (`CON`, `NUL`,
 * `COM1`…) are removed or suffixed, so the same delivery can be opened, moved
 * and copied on both platforms.
 *
 * @param {string} name raw name.
 * @returns {string} safe base name.
 */
export function sanitizeBaseName(name) {
  return sanitizeFileBaseName(name, {maxLength: 80});
}

/**
 * Build the CSV payload for a stored result.
 *
 * @param {string[]} columns columns.
 * @param {object[]} rows rows.
 * @returns {string} BOM + CSV text.
 */
export function buildCsv(columns, rows) {
  const header = columns.map(csvCell).join(',');
  const body = rows.map((row) => columns.map((name) => csvCell(row[name])).join(','));
  return `\uFEFF${[header, ...body].join('\r\n')}\r\n`;
}

/**
 * Escape one CSV cell. Text starting with a formula trigger is prefixed with a
 * single quote so spreadsheet applications treat the value as text; this is the only
 * transformation and is disclosed in the export workbook.
 *
 * @param {unknown} value value.
 * @returns {string} escaped cell.
 */
function csvCell(value) {
  if (value === null || value === undefined) return '';
  let text = String(value);
  // Formula triggers must be neutralised, but a negative number is a value, not a
  // formula. Only prefix text that is not a plain number.
  const numeric = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text);
  // Neutralise a formula trigger even when the cell starts with whitespace or a
  // BOM/NBSP: spreadsheet apps trim those before deciding the cell is a formula.
  if (!numeric && /^[\s\uFEFF\u00A0]*[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

/**
 * Build the SQL delivery file: a header comment block plus the exact statement.
 *
 * @param {object} meta result meta.
 * @returns {string} SQL text.
 */
export function buildSqlFile(meta) {
  const dialect = meta.dialect ?? 'mysql';
  // Metadata is stored text, not a trusted SQL fragment: a newline in a
  // database/schema name must never become an executable line in the delivered
  // file, and a PostgreSQL identifier must be quoted as an identifier.
  const comment = (value) => String(value ?? '').replace(/[\r\n\u0000-\u001f]/g, ' ');
  const quoteIdent = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;
  const header = [
    '-- 由 DSH AI 数据库助手导出',
    `-- 项目结果 ID：${comment(meta.resultId)}`,
    `-- 数据库类型：${comment(dialect)}`,
    `-- 数据库：${comment(meta.database)}${meta.schema ? `（schema: ${comment(meta.schema)}）` : ''}`,
    `-- 查询完成时间：${comment(meta.createdAt)}`,
    `-- 结果行数：${comment(meta.rowCount)}`,
    `-- 完整性：${meta.complete === true ? '完整' : '不完整（请勿作为全量结果）'}`,
    `-- 一致性：${comment(meta.consistency?.level ?? '未知')}；${comment(meta.consistency?.note ?? '')}`,
    '-- 说明：本文件中的 SELECT 即生成上述结果时实际执行的语句。',
    dialect === 'mysql' && meta.database
      ? `-- 执行前会切到该数据库（USE ${'`'}${String(meta.database).replace(/`/g, '``')}${'`'}）。`
      : dialect === 'sqlserver' && meta.database
        ? `-- 执行前会切到该数据库（USE [${String(meta.database).replace(/\]/g, ']]')}]）。`
        : dialect === 'postgres'
          ? `-- PostgreSQL：请以相同数据库连接执行${meta.schema ? `，并先 SET search_path TO ${quoteIdent(meta.schema)}` : ''}。`
          : dialect === 'oracle'
            ? '-- Oracle：请以相同 service/schema 连接执行。'
            : '-- SQLite：直接对数据库文件执行本文件。',
    '-- 若原语句包含 NOW()/CURDATE() 等动态值，重新执行会按执行时点计算。',
    `-- 动态函数：${meta.nondeterministic === true ? '包含（重跑时点不同可能产生不同结果）' : '无'}`,
    `-- NULL/空字符串：CSV 中均输出为空；XLSX 中 NULL 为空单元格、空字符串为空文本。`,
    '',
  ].join('\n');
  let use = '';
  if (dialect === 'mysql' && meta.database) use = `USE ${'`'}${String(meta.database).replace(/`/g, '``')}${'`'};\n\n`;
  else if (dialect === 'sqlserver' && meta.database) use = `USE [${String(meta.database).replace(/\]/g, ']]')}];\n\n`;
  else if (dialect === 'postgres' && meta.schema) use = `SET search_path TO ${quoteIdent(meta.schema)};\n\n`;
  if (dialect === 'oracle') {
    // SQL*Plus needs these client-side settings to preserve headers, NULL vs
    // empty string and values containing the column separator.
    use = "SET MARKUP CSV ON DELIMITER '|' QUOTE ON\nSET FEEDBACK OFF\nSET NULL ''\nSET NUMWIDTH 50\n" +
      "ALTER SESSION SET NLS_DATE_FORMAT='YYYY-MM-DD HH24:MI:SS';\n" +
      "ALTER SESSION SET NLS_TIMESTAMP_FORMAT='YYYY-MM-DD HH24:MI:SS.FF6';\n\n";
  }
  // The terminator goes on its own line so a trailing `-- comment` in the
  // recorded statement cannot swallow it.
  return `${header}${use}${meta.sql}\n;\n`;
}

/**
 * Build the XLSX workbook: result sheet + a separate "查询说明" sheet.
 *
 * @param {object} meta meta.
 * @param {object[]} rows rows.
 * @returns {object} workbook.
 */
export function buildWorkbook(meta, rows) {
  const columns = meta.columns.map((name) => ({name, width: Math.min(Math.max(String(name).length + 4, 10), 40), type: 'text'}));
  // Numbers that Excel can represent without changing the original text become
  // numeric cells (summable). Everything else stays text, preserving precision.
  const columnTypes = meta.columnTypes ?? {};
  const dataRows = rows.map((row) => meta.columns.map((name) => excelValue(row[name], columnTypes[name])));
  return {
    sheets: [
      {name: '查询结果', columns, rows: dataRows},
      {
        name: '查询说明',
        columns: [{name: '项目', width: 28}, {name: '内容', width: 80}],
        rows: [
          ['结果 ID', meta.resultId],
          ['数据库', `${meta.database ?? ''}（${meta.dialect}）`],
          ['执行时间', meta.createdAt],
          ['结果行数', String(meta.rowCount)],
          ['完整性', meta.complete === true ? '完整' : '不完整'],
          ['一致性', meta.consistency?.level ?? ''],
          ['说明', meta.consistency?.note ?? ''],
          ['最终 SQL', meta.sql],
          ['动态函数', meta.nondeterministic === true ? 'SQL 含动态函数，重跑时点不同可能产生不同结果' : '无'],
          ['NULL 与空字符串', 'CSV 中两者都输出为空；XLSX 中 NULL 为空单元格、空字符串为空文本，Excel 内不可区分，原始值以快照为准'],
          ['CSV 安全转换', '以 = + - @ 开头的文本在 CSV 中以单引号前缀防止公式注入；合法负数不加前缀'],
          ['Excel 数值类型', '只有能从 information_schema 确认列类型、且可精确表示的整数/小数写为数值；VARCHAR/表达式/聚合/超长整数/前导零等一律文本'],
          ['结果快照', `项目内已保存（${meta.resultId}），导出只使用该快照`],
        ],
      },
    ],
  };
}

/**
 * Detect whether a result contains SQL NULL and/or empty strings.
 *
 * @param {object[]} rows snapshot rows.
 * @returns {{hasNull: boolean, hasEmptyString: boolean}} flags.
 */
export function scanValueKinds(rows) {
  let hasNull = false;
  let hasEmptyString = false;
  for (const row of rows) {
    for (const value of Object.values(row)) {
      if (value === null) hasNull = true;
      else if (value === '') hasEmptyString = true;
      if (hasNull && hasEmptyString) return {hasNull, hasEmptyString};
    }
  }
  return {hasNull, hasEmptyString};
}

/**
 * Stream a CSV file from snapshot rows using the same escaping as `buildCsv`.
 *
 * @param {string} filePath target path.
 * @param {string[]} columns columns.
 * @param {object[]} rows rows.
 * @returns {Promise<void>} resolves after close.
 */
export async function writeCsvFile(filePath, columns, rows) {
  const handle = await open(filePath, 'w', 0o600);
  try {
    await handle.write('\uFEFF' + columns.map(csvCell).join(',') + '\r\n');
    const chunk = [];
    for (const row of rows) {
      chunk.push(columns.map((name) => csvCell(row[name])).join(','));
      if (chunk.length >= 2000) {
        await handle.write(chunk.join('\r\n') + '\r\n');
        chunk.length = 0;
      }
    }
    if (chunk.length > 0) await handle.write(chunk.join('\r\n') + '\r\n');
  } finally {
    await handle.close();
  }
}

/**
 * Convert one result value for XLSX: safe numbers stay numeric, everything
 * else remains text so precision and leading zeros are preserved.
 *
 * @param {unknown} value snapshot value.
 * @returns {string|number|null} Excel cell value.
 */
export function excelValue(value, columnType) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value !== 'string') return String(value);
  const type = typeof columnType === 'string' ? columnType.toLowerCase() : '';
  // Without a confirmed numeric type, keep text: a VARCHAR that happens to look
  // like a number must not change its business meaning in Excel.
  if (!/^(tinyint|smallint|mediumint|int|integer|bigint|decimal|numeric|number|float|double|real|year|bit)\b/.test(type)) return value;
  if (/^-?(?:0|[1-9]\d{0,14})$/.test(value)) {
    const number = Number(value);
    if (Number.isSafeInteger(number)) return number;
    return value;
  }
  if (/^-?(?:0|[1-9]\d{0,9})\.\d{1,6}$/.test(value)) {
    const digits = value.replace(/[-.]/g, '').length;
    if (digits <= 12) {
      const number = Number(value);
      // Only use a numeric cell when the text round-trips exactly; `1.10`
      // stays text so the stored scale is not silently changed.
      if (Number.isFinite(number) && String(number) === value) return number;
    }
  }
  return value;
}
