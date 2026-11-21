/**
 * Project, session binding, source, and catalog services.
 *
 * Isolation model: every call takes a project id, and tool calls additionally
 * take the calling session id which must be bound to that project. There is no
 * "current project" global, so one session can never reach another project's
 * sources by changing an argument.
 *
 * @module src/services/projects
 */
import {createHash} from 'node:crypto';
import {promises as fs} from 'node:fs';
import {basename, extname} from 'node:path';

import {AssistantError, ERROR_CODES} from '../core/errors.js';
import {isCredentialRef} from '../core/credential-ref.js';
import {newId} from '../core/ids.js';
import {redactText} from '../core/redact.js';
import {hostPlatform, validateUserPath} from '../core/user-path.js';
import {DIALECTS, dialectMenu, explainClientFailure} from '../db/dialects.js';
import {StoreCorruptError} from '../store.js';

/** Maximum bytes accepted for one imported file. */
export const MAX_IMPORT_BYTES = 512 * 1024 * 1024;
/** Hard ceiling for a per-source row override. */
export const MAX_ROWS_PER_SOURCE = 1_000_000;
/** Largest valid TCP port. */
export const MAX_PORT = 65_535;
/** Supported file extensions. */
export const SUPPORTED_FILE_EXTENSIONS = Object.freeze(['.xlsx', '.csv', '.tsv', '.json', '.jsonl', '.ndjson', '.txt']);

/**
 * Resolve the connection schema.
 *
 * PostgreSQL databases contain schemas, SQL Server uses dbo by default, Oracle
 * is owned by the connecting user and SQLite is always `main`. Treating the
 * database name as a schema (the previous behavior) hides every PostgreSQL
 * table because the database name is not a schema.
 *
 * @param {object} source database source.
 * @returns {string|undefined} schema to inspect.
 */
export function connectionSchemaOf(source) {
  if (typeof source.schema === 'string' && source.schema !== '') return source.schema;
  if (source.dialect === 'postgres') return 'public';
  if (source.dialect === 'sqlserver') return 'dbo';
  if (source.dialect === 'sqlite') return 'main';
  if (source.dialect === 'oracle') return source.user ? String(source.user).toUpperCase() : undefined;
  return source.database;
}

/**
 * Project registry and per-project resources.
 */
export class ProjectService {
  /** @type {import('../store.js').JsonStore} */
  #store;
  /** @type {object} */
  #logger;
  /** @type {object|null} */
  #runner;
  /** @type {Map<string, Promise<void>>} per-file read/modify/write locks. */
  #locks = new Map();

  /**
   * @param {{store: object, runner?: object, logger?: object}} options services.
   */
  constructor(options) {
    this.#store = options.store;
    this.#runner = options.runner ?? null;
    this.#logger = options.logger ?? {};
  }

  /**
   * Serialize one read/modify/write sequence.
   *
   * `JsonStore.writeText` serializes writes, but two callers that each read,
   * change and write the same JSON file still lose one update. Every registry
   * mutation goes through this lock.
   *
   * @template T
   * @param {string} key lock key (normally the relative file path).
   * @param {() => Promise<T>} operation critical section.
   * @returns {Promise<T>} operation result.
   */
  async #withLock(key, operation) {
    const previous = this.#locks.get(key) ?? Promise.resolve();
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    const queued = previous.then(() => current);
    this.#locks.set(key, queued);
    await previous.catch(() => {});
    try {
      return await operation();
    } finally {
      release();
      if (this.#locks.get(key) === queued) this.#locks.delete(key);
    }
  }

  /**
   * Read / mutate / write one JSON registry under its file lock.
   *
   * @template T
   * @param {string} relative relative file path.
   * @param {object} fallback value used when the file is missing.
   * @param {(state: object) => Promise<{state?: object, result?: T}|void>} mutation mutation.
   * @returns {Promise<T|undefined>} mutation result.
   */
  async #mutateJson(relative, fallback, mutation) {
    return this.#withLock(relative, async () => {
      const state = await this.#store.readJson(relative, fallback);
      const outcome = await mutation(state);
      if (outcome !== undefined && outcome !== null) {
        await this.#store.writeJson(relative, outcome.state ?? state);
        return outcome.result;
      }
      await this.#store.writeJson(relative, state);
      return undefined;
    });
  }

  /**
   * Read the project registry, refusing to treat a corrupt file as empty.
   *
   * The registry is the only index of the user's projects. A corrupt JSON file
   * used to be quarantined and then replaced by `{projects: []}` on the next
   * write, which made every existing project disappear from the workbench while
   * its data directory stayed on disk. A missing file is still the legitimate
   * first-start state; a corrupt/invalid file is not, and every read and write
   * fails with an actionable error until the user repairs it.
   *
   * @returns {Promise<{projects: object[]}>} validated registry.
   * @throws {AssistantError} when the registry exists but cannot be used.
   */
  async #readRegistry() {
    let state;
    try {
      state = await this.#store.readJson('projects.json', {projects: []}, {corrupt: 'throw'});
    } catch (error) {
      if (error instanceof StoreCorruptError) {
        this.#logger.warn?.(`ai-database-assistant: 项目索引损坏，拒绝读取/写入：${error.filePath}`);
        throw new AssistantError(
          ERROR_CODES.storageCorrupt,
          '项目索引 projects.json 无法解析（JSON 损坏）。为避免用空配置覆盖现有项目，已拒绝读取和写入；原文件未被修改或删除。请修复或恢复插件数据目录下的 projects.json 后重试（项目数据目录未被删除）。',
          {status: 500},
        );
      }
      throw error;
    }
    const validEntry = (entry) => entry !== null && typeof entry === 'object' && !Array.isArray(entry)
      && typeof entry.id === 'string' && entry.id !== ''
      && typeof entry.name === 'string'
      // listProjects sorts on createdAt; a missing/non-string value would throw
      // a TypeError instead of the actionable storage-corrupt error.
      && typeof entry.createdAt === 'string';
    const uniqueIds = Array.isArray(state?.projects)
      && new Set(state.projects.map((entry) => entry?.id)).size === state.projects.length;
    if (state === null || typeof state !== 'object' || Array.isArray(state)
      || !Array.isArray(state.projects) || !state.projects.every(validEntry) || !uniqueIds) {
      this.#logger.warn?.('ai-database-assistant: 项目索引结构不合法，拒绝读取/写入');
      throw new AssistantError(
        ERROR_CODES.storageCorrupt,
        '项目索引 projects.json 格式不正确（projects 必须为项目对象数组）。为避免覆盖现有项目，已拒绝读取和写入；原文件未被修改。请修复或恢复该文件后重试。',
        {status: 500},
      );
    }
    return state;
  }

  /**
   * Mutate the project registry under its lock, using the strict reader.
   *
   * @template T
   * @param {(state: {projects: object[]}) => Promise<{state?: object, result?: T}|void>} mutation mutation.
   * @returns {Promise<T|undefined>} mutation result.
   */
  async #mutateRegistry(mutation) {
    return this.#withLock('projects.json', async () => {
      const state = await this.#readRegistry();
      const outcome = await mutation(state);
      if (outcome !== undefined && outcome !== null) {
        await this.#store.writeJson('projects.json', outcome.state ?? state);
        return outcome.result;
      }
      await this.#store.writeJson('projects.json', state);
      return undefined;
    });
  }

  /**
   * Database dialect menu for the workbench; unsupported dialects carry a reason.
   *
   * @returns {object[]} menu entries.
   */
  dialectMenu() {
    return dialectMenu();
  }

  /**
   * List projects.
   *
   * @returns {Promise<object[]>} projects sorted by creation time.
   */
  async listProjects() {
    const registry = await this.#readRegistry();
    return [...registry.projects].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  /**
   * Read one project or fail.
   *
   * @param {string} projectId project id.
   * @returns {Promise<object>} project.
   */
  async requireProject(projectId) {
    if (typeof projectId !== 'string' || projectId.trim() === '') {
      throw new AssistantError(ERROR_CODES.invalidInput, '缺少分析项目 ID。');
    }
    const projects = await this.listProjects();
    const project = projects.find((entry) => entry.id === projectId);
    if (project === undefined) throw new AssistantError(ERROR_CODES.notFound, `分析项目不存在：${projectId}`);
    return project;
  }

  /**
   * Create a project.
   *
   * @param {{name: string, description?: string}} input project input.
   * @returns {Promise<object>} created project.
   */
  async createProject(input) {
    const name = String(input.name ?? '').trim();
    if (name === '') throw new AssistantError(ERROR_CODES.invalidInput, '项目名称不能为空。');
    if (name.length > 120) throw new AssistantError(ERROR_CODES.invalidInput, '项目名称不能超过 120 个字符。');
    const now = new Date().toISOString();
    const project = {
      id: newId('P'),
      name,
      description: String(input.description ?? '').slice(0, 2000),
      createdAt: now,
      updatedAt: now,
      archived: false,
    };
    await this.#mutateRegistry((state) => {
      const projects = state.projects;
      if (projects.some((entry) => entry.name === name)) {
        throw new AssistantError(ERROR_CODES.conflict, `项目名称已存在：${name}`);
      }
      state.projects = [...projects, project];
      return {result: project};
    });
    await this.#store.ensureDir('projects', project.id);
    return project;
  }

  /**
   * Rename or re-describe a project.
   *
   * @param {string} projectId project id.
   * @param {{name?: string, description?: string}} patch changes.
   * @returns {Promise<object>} updated project.
   */
  async updateProject(projectId, patch) {
    return this.#mutateRegistry((state) => {
      const projects = state.projects;
      const index = projects.findIndex((project) => project.id === projectId);
      if (index === -1) throw new AssistantError(ERROR_CODES.notFound, `分析项目不存在：${projectId}`);
      const next = {...projects[index]};
      if (patch.name !== undefined) {
        const name = String(patch.name).trim();
        if (name === '') throw new AssistantError(ERROR_CODES.invalidInput, '项目名称不能为空。');
        if (projects.some((project, position) => position !== index && project.name === name)) {
          throw new AssistantError(ERROR_CODES.conflict, `项目名称已存在：${name}`);
        }
        next.name = name;
      }
      if (patch.description !== undefined) next.description = String(patch.description).slice(0, 2000);
      if (patch.outputDir !== undefined) {
        // The delivery directory belongs to the Host machine; accept the rule of
        // the platform that will actually write there (Windows drive/UNC paths
        // included) instead of a POSIX "starts with /" test.
        next.outputDir = requireUserPath(patch.outputDir, '保存目录');
      }
      next.updatedAt = new Date().toISOString();
      projects[index] = next;
      return {result: next};
    });
  }

  /**
   * Delete a project record and its session bindings.
   *
   * Analysis artifacts on disk are retained: a deleted project must not silently
   * remove evidence that may already be referenced by a working paper.
   *
   * @param {string} projectId project id.
   * @returns {Promise<{deleted: boolean, retainedData: string}>} result.
   */
  async deleteProject(projectId) {
    // Read the credential references before the project disappears so the route
    // can release the ones no other project still uses.
    const {sources} = await this.#store.readJson(`projects/${projectId}/sources.json`, {sources: []});
    const passwordRefs = [...new Set(sources.map((source) => source.passwordRef).filter((ref) => typeof ref === 'string' && ref !== ''))];
    const removed = await this.#mutateRegistry((state) => {
      const projects = state.projects;
      const remaining = projects.filter((project) => project.id !== projectId);
      if (remaining.length === projects.length) throw new AssistantError(ERROR_CODES.notFound, `分析项目不存在：${projectId}`);
      state.projects = remaining;
      return {result: true};
    });
    if (removed !== true) throw new AssistantError(ERROR_CODES.notFound, `分析项目不存在：${projectId}`);
    await this.#mutateJson('sessions.json', {bindings: {}}, (state) => {
      const bindings = state.bindings ?? {};
      for (const [sessionId, binding] of Object.entries(bindings)) {
        if (binding.projectId === projectId) delete bindings[sessionId];
      }
      state.bindings = bindings;
      return {};
    });
    return {deleted: true, retainedData: this.#store.projectPath(projectId), passwordRefs};
  }

  /**
   * Collect every credential reference still used by any project.
   *
   * @returns {Promise<Set<string>>} references in use.
   */
  async credentialRefsInUse() {
    const projects = await this.listProjects();
    const used = new Set();
    for (const project of projects) {
      const {sources} = await this.#store.readJson(`projects/${project.id}/sources.json`, {sources: []});
      for (const source of sources) {
        if (typeof source.passwordRef === 'string' && source.passwordRef !== '') used.add(source.passwordRef);
      }
    }
    return used;
  }

  /**
   * Bind a session to a project.
   *
   * @param {string} sessionId DSH session id.
   * @param {string} projectId project id.
   * @returns {Promise<object>} binding.
   */
  async bindSession(sessionId, projectId) {
    if (typeof sessionId !== 'string' || sessionId.trim() === '') {
      throw new AssistantError(ERROR_CODES.invalidInput, '缺少会话 ID。');
    }
    await this.requireProject(projectId);
    const binding = {projectId, boundAt: new Date().toISOString()};
    return this.#mutateJson('sessions.json', {bindings: {}}, (state) => {
      const bindings = state.bindings ?? {};
      bindings[sessionId] = binding;
      state.bindings = bindings;
      return {result: {sessionId, ...binding}};
    });
  }

  /**
   * Remove one session binding.
   *
   * @param {string} sessionId DSH session id.
   * @returns {Promise<{unbound: boolean}>} result.
   */
  async unbindSession(sessionId) {
    return this.#mutateJson('sessions.json', {bindings: {}}, (state) => {
      const bindings = state.bindings ?? {};
      if (bindings[sessionId] === undefined) return {skipWrite: true, result: {unbound: false}};
      delete bindings[sessionId];
      state.bindings = bindings;
      return {result: {unbound: true}};
    });
  }

  /**
   * Read the project bound to a session.
   *
   * @param {string} sessionId DSH session id.
   * @returns {Promise<object|null>} binding plus project, or null.
   */
  async bindingOf(sessionId) {
    const {bindings} = await this.#store.readJson('sessions.json', {bindings: {}});
    const binding = bindings[sessionId];
    if (binding === undefined) return null;
    const projects = await this.listProjects();
    const project = projects.find((entry) => entry.id === binding.projectId);
    if (project === undefined) return null;
    return {...binding, sessionId, project};
  }

  /**
   * Resolve the project bound to a tool call's session, or explain the remedy.
   *
   * @param {string|undefined} sessionId calling session.
   * @returns {Promise<object>} project.
   */
  async requireBoundProject(sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') {
      throw new AssistantError(ERROR_CODES.notBound, '当前调用没有会话标识，无法确定分析项目。');
    }
    const binding = await this.bindingOf(sessionId);
    if (binding === null) {
      throw new AssistantError(
        ERROR_CODES.notBound,
        '当前会话尚未绑定分析项目。请在「AI 数据库助手」选中项目（会自动绑定当前会话），或在工作台底部发送一次提问；若刚操作过，请刷新页面后重试。',
      );
    }
    return binding.project;
  }

  /**
   * List sources of a project.
   *
   * @param {string} projectId project id.
   * @returns {Promise<object[]>} sources without secrets.
   */
  async listSources(projectId) {
    await this.requireProject(projectId);
    const state = await this.#store.readJson(`projects/${projectId}/sources.json`, {sources: []});
    return state.sources.map(publicSource);
  }

  /**
   * Database connections from other projects that can be copied.
   *
   * @param {string} excludeProjectId current project id.
   * @returns {Promise<object[]>} [{project, sources}] with safe config only.
   */
  async listCopyCandidates(excludeProjectId) {
    await this.requireProject(excludeProjectId);
    const projects = await this.listProjects();
    const result = [];
    for (const project of projects) {
      if (project.id === excludeProjectId) continue;
      const sources = (await this.listSources(project.id)).filter((source) => source.kind === 'database');
      if (sources.length === 0) continue;
      result.push({
        project: {id: project.id, name: project.name},
        sources: sources.map((source) => ({
          sourceId: source.id,
          name: source.name,
          dialect: source.dialect,
          host: source.host ?? '',
          port: source.port ?? null,
          user: source.user ?? '',
          database: source.database ?? '',
          file: source.file ?? '',
          passwordRef: source.passwordRef ?? '',
        })),
      });
    }
    return result;
  }

  /**
   * Copy one database connection's configuration into a project.
   *
   * Only connection settings are copied: no results, sessions, output directory,
   * catalog or status. The credential reference (not the password) is reused.
   *
   * @param {string} projectId target project.
   * @param {string} fromProjectId source project.
   * @param {string} sourceId source connection.
   * @returns {Promise<object>} created public source.
   */
  async copySource(projectId, fromProjectId, sourceId) {
    await this.requireProject(projectId);
    await this.requireProject(fromProjectId);
    const source = await this.requireSource(fromProjectId, sourceId);
    if (source.kind !== 'database') {
      throw new AssistantError(ERROR_CODES.invalidInput, '只能复制数据库连接；文件数据源不支持复制。');
    }
    const existing = await this.listSources(projectId);
    let name = `${source.name}（复制）`;
    let counter = 2;
    while (existing.some((entry) => entry.name === name)) {
      name = `${source.name}（复制 ${counter}）`;
      counter += 1;
    }
    return this.createDatabaseSource(projectId, {
      name,
      dialect: source.dialect,
      host: source.host,
      port: source.port,
      user: source.user,
      database: source.database,
      serviceName: source.serviceName,
      schema: source.schema,
      file: source.file,
      // The client executable override is part of the connection: without it a
      // copy whose client is not on PATH (the normal Windows case) tests as
      // "client not found" even though the original connection works.
      command: source.command,
      trustServerCertificate: source.trustServerCertificate === true,
      passwordRef: source.passwordRef,
    });
  }

  /**
   * Read one source and assert the source belongs to the project.
   *
   * @param {string} projectId project id.
   * @param {string} sourceId source id.
   * @returns {Promise<object>} source (internal shape, still no password).
   */
  async requireSource(projectId, sourceId) {
    await this.requireProject(projectId);
    if (typeof sourceId !== 'string' || sourceId.trim() === '') {
      throw new AssistantError(ERROR_CODES.invalidInput, '缺少数据源 ID。');
    }
    const state = await this.#store.readJson(`projects/${projectId}/sources.json`, {sources: []});
    const source = state.sources.find((entry) => entry.id === sourceId);
    if (source === undefined) throw new AssistantError(ERROR_CODES.notFound, `数据源不存在或不属于当前项目：${sourceId}`);
    return source;
  }

  /**
   * Add a database source. The password may be supplied as a credential
   * reference only; a literal password is rejected here so a literal password can never be
   * persisted by accident.
   *
   * @param {string} projectId project id.
   * @param {object} input source input.
   * @returns {Promise<object>} created source.
   */
  async createDatabaseSource(projectId, input) {
    await this.requireProject(projectId);
    const dialect = String(input.dialect ?? '');
    const descriptor = DIALECTS[dialect];
    if (descriptor === undefined) throw new AssistantError(ERROR_CODES.invalidInput, `未知数据库类型：${dialect}`);
    if (!descriptor.supported) {
      throw new AssistantError(ERROR_CODES.invalidInput, `${descriptor.label} 本版未实现，不能添加该数据源。`);
    }
    if (input.password !== undefined || input.passwd !== undefined) {
      throw new AssistantError(ERROR_CODES.invalidInput, '数据源配置不接受明文密码。请在 DSH 凭据中保存密码，并填写凭据引用名（passwordRef）。');
    }
    const name = String(input.name ?? '').trim();
    if (name === '') throw new AssistantError(ERROR_CODES.invalidInput, '数据源名称不能为空。');
    if (name.length > 200) throw new AssistantError(ERROR_CODES.invalidInput, '数据源名称不能超过 200 个字符。');
    if (input.passwordRef !== undefined && input.passwordRef !== '' && !isCredentialRef(input.passwordRef)) {
      throw new AssistantError(ERROR_CODES.invalidInput, '凭据引用只能包含字母、数字和下划线，且必须以字母或下划线开头（不能包含 / 或 -）。');
    }
    let sqliteFile;
    if (descriptor.file) {
      if (input.file === undefined || input.file === null || String(input.file).trim() === '') {
        throw new AssistantError(ERROR_CODES.invalidInput, 'SQLite 数据源必须填写数据库文件路径。');
      }
      sqliteFile = requireUserPath(input.file, 'SQLite 数据库文件');
      await fs.access(sqliteFile).catch(() => {
        throw new AssistantError(ERROR_CODES.sourceUnavailable, `SQLite 数据库文件不存在或不可读：${sqliteFile}`);
      });
    }
    const port = requirePort(input.port);
    const command = optionalString(input.command, 1000);
    if (command !== undefined) assertClientCommand(command);
    const now = new Date().toISOString();
    const source = {
      id: newId('S'),
      projectId,
      kind: 'database',
      name,
      dialect,
      host: connectionText(input.host, '主机'),
      port,
      user: connectionText(input.user, '用户名'),
      database: connectionText(input.database, '数据库名'),
      serviceName: connectionText(input.serviceName, '服务名'),
      schema: connectionText(input.schema, 'schema'),
      file: descriptor.file ? sqliteFile : optionalString(input.file, 1000),
      command,
      passwordRef: optionalString(input.passwordRef, 200),
      trustServerCertificate: input.trustServerCertificate === true,
      maxRowsPerSource: positiveInt(input.maxRowsPerSource, 200_000),
      status: {available: null, reason: '尚未测试连接', enforcement: descriptor.readOnly, checkedAt: null},
      catalog: null,
      createdAt: now,
      updatedAt: now,
    };
    if (descriptor.file && source.file === undefined) {
      throw new AssistantError(ERROR_CODES.invalidInput, 'SQLite 数据源必须填写数据库文件路径。');
    }
    return this.#mutateJson(`projects/${projectId}/sources.json`, {sources: []}, (state) => {
      const sources = Array.isArray(state.sources) ? state.sources : [];
      if (sources.some((entry) => entry.name === name)) {
        throw new AssistantError(ERROR_CODES.conflict, `数据源名称已存在：${name}`);
      }
      state.sources = [...sources, source];
      return {result: publicSource(source)};
    });
  }

  /**
   * Update a database source (never its password).
   *
   * @param {string} projectId project id.
   * @param {string} sourceId source id.
   * @param {object} patch changes.
   * @returns {Promise<object>} updated source.
   */
  async updateSource(projectId, sourceId, patch) {
    await this.requireProject(projectId);
    if (patch.password !== undefined) throw new AssistantError(ERROR_CODES.invalidInput, '数据源配置不接受明文密码。');
    if (patch.passwordRef !== undefined && patch.passwordRef !== '' && !isCredentialRef(patch.passwordRef)) {
      throw new AssistantError(ERROR_CODES.invalidInput, '凭据引用只能包含字母、数字和下划线，且必须以字母或下划线开头（不能包含 / 或 -）。');
    }
    return this.#mutateJson(`projects/${projectId}/sources.json`, {sources: []}, async (state) => {
      const sources = Array.isArray(state.sources) ? state.sources : [];
      const index = sources.findIndex((source) => source.id === sourceId);
      if (index === -1) throw new AssistantError(ERROR_CODES.notFound, `数据源不存在：${sourceId}`);
      if (patch.dialect !== undefined && patch.dialect !== sources[index].dialect) {
        throw new AssistantError(ERROR_CODES.invalidInput, '数据源类型创建后不可修改；请新建一个数据源。');
      }
      const current = sources[index];
      const next = {...current, updatedAt: new Date().toISOString()};
      if (patch.name !== undefined) {
        const name = String(patch.name).trim();
        if (name === '') throw new AssistantError(ERROR_CODES.invalidInput, '数据源名称不能为空。');
        if (name.length > 200) throw new AssistantError(ERROR_CODES.invalidInput, '数据源名称不能超过 200 个字符。');
        if (sources.some((entry, position) => position !== index && entry.name === name)) {
          throw new AssistantError(ERROR_CODES.conflict, `数据源名称已存在：${name}`);
        }
        next.name = name;
      }
      for (const key of ['host', 'user', 'database', 'serviceName', 'schema']) {
        if (patch[key] !== undefined) next[key] = connectionText(patch[key], key);
      }
      if (patch.passwordRef !== undefined) next.passwordRef = optionalString(patch.passwordRef, 1000);
      if (patch.file !== undefined) {
        // A SQLite database file must stay a complete absolute path for the Host
        // platform; Windows drive/UNC paths are valid, `C:Results` is not.
        const file = optionalString(patch.file, 1000);
        if (DIALECTS[next.dialect]?.file === true) {
          if (file === undefined) throw new AssistantError(ERROR_CODES.invalidInput, 'SQLite 数据源必须填写数据库文件路径。');
          next.file = requireUserPath(file, 'SQLite 数据库文件');
          await fs.access(next.file).catch(() => {
            throw new AssistantError(ERROR_CODES.sourceUnavailable, `SQLite 数据库文件不存在或不可读：${next.file}`);
          });
        } else {
          next.file = file;
        }
      }
      if (patch.command !== undefined) {
        const command = optionalString(patch.command, 1000);
        if (command !== undefined) assertClientCommand(command);
        next.command = command;
      }
      if (patch.trustServerCertificate !== undefined) next.trustServerCertificate = patch.trustServerCertificate === true;
      if (patch.port !== undefined) next.port = requirePort(patch.port);
      if (patch.maxRowsPerSource !== undefined) next.maxRowsPerSource = positiveInt(patch.maxRowsPerSource, 200_000);
      // A changed host/database/schema/credential invalidates the cached catalog
      // and the previous "available" receipt; otherwise db-schema keeps serving
      // tables from the old target.
      const connectionChanged = ['host', 'port', 'user', 'database', 'serviceName', 'schema', 'file', 'command', 'passwordRef', 'trustServerCertificate']
        .some((key) => patch[key] !== undefined && JSON.stringify(patch[key] ?? null) !== JSON.stringify(current[key] ?? null));
      if (connectionChanged) {
        next.catalog = null;
        next.status = {
          available: null,
          reason: '连接配置已变更，请重新测试连接',
          enforcement: DIALECTS[next.dialect]?.readOnly ?? 'account',
          checkedAt: null,
        };
      }
      sources[index] = next;
      state.sources = sources;
      return {result: publicSource(next)};
    });
  }

  /**
   * Remove a source. Runs that referenced the source keep their recorded coverage.
   *
   * @param {string} projectId project id.
   * @param {string} sourceId source id.
   * @returns {Promise<{deleted: boolean}>} result.
   */
  async deleteSource(projectId, sourceId) {
    await this.requireProject(projectId);
    return this.#mutateJson(`projects/${projectId}/sources.json`, {sources: []}, (state) => {
      const sources = Array.isArray(state.sources) ? state.sources : [];
      const remaining = sources.filter((source) => source.id !== sourceId);
      if (remaining.length === sources.length) throw new AssistantError(ERROR_CODES.notFound, `数据源不存在：${sourceId}`);
      state.sources = remaining;
      return {result: {deleted: true}};
    });
  }

  /**
   * Resolve a source password through DSH credentials.
   *
   * @param {object} source source.
   * @param {{credentials?: object}} context host services.
   * @returns {Promise<string|undefined>} password (never persisted).
   */
  async resolvePassword(source, context = {}) {
    if (typeof source.passwordRef !== 'string' || source.passwordRef === '') return undefined;
    const credentials = context.credentials;
    if (credentials === undefined || credentials === null) {
      throw new AssistantError(ERROR_CODES.sourceUnavailable, '宿主凭据服务不可用，无法解析数据库密码。请改用免密账号或在宿主中配置凭据。');
    }
    const resolved = await credentials.resolve(source.passwordRef);
    if (resolved === undefined || resolved === null || String(resolved.value ?? '') === '') {
      throw new AssistantError(ERROR_CODES.sourceUnavailable, `凭据引用「${source.passwordRef}」未配置密码。`);
    }
    return String(resolved.value);
  }

  /**
   * Probe a source and record the outcome in its status.
   *
   * @param {string} projectId project id.
   * @param {string} sourceId source id.
   * @param {{credentials?: object, signal?: AbortSignal}} context host services.
   * @returns {Promise<object>} probe result.
   */
  async testSource(projectId, sourceId, context = {}) {
    const source = await this.requireSource(projectId, sourceId);
    if (source.kind === 'file') {
      const status = {available: true, reason: '已导入文件', enforcement: 'read-only-copy', checkedAt: new Date().toISOString()};
      await this.#patchStatus(projectId, sourceId, status);
      return status;
    }
    if (this.#runner === null) throw new AssistantError(ERROR_CODES.internal, '数据库执行器未就绪。');
    const probe = await this.#runner.probe(source, context.signal);
    let status = {available: probe.available, reason: probe.available ? (probe.executable ?? '客户端可用') : probe.reason, enforcement: probe.enforcement, note: probe.note, checkedAt: new Date().toISOString()};
    /** @type {string|undefined} */
    let resolvedPassword;
    if (probe.available) {
      try {
        const password = typeof context.password === 'string' && context.password !== ''
          ? context.password
          : await this.resolvePassword(source, context);
        resolvedPassword = password;
        const sql = source.dialect === 'oracle' ? 'SELECT 1 AS ai_database_assistant_probe FROM dual' : 'SELECT 1 AS ai_database_assistant_probe';
        const result = await this.#runner.run(source, {sql, password, signal: context.signal, maxRows: 1, label: 'db-info'});
        if (result.exitCode !== 0) {
          status = {available: false, reason: explainClientFailure(redactDiagnostic(result.stderr || '连接失败', resolvedPassword)), enforcement: probe.enforcement, note: probe.note, checkedAt: status.checkedAt};
        }
      } catch (error) {
        status = {available: false, reason: explainClientFailure(redactDiagnostic(error instanceof Error ? error.message : String(error), resolvedPassword)), enforcement: probe.enforcement, note: probe.note, checkedAt: status.checkedAt};
      }
    }
    await this.#patchStatus(projectId, sourceId, status);
    return status;
  }

  /**
   * Persist a source status patch.
   *
   * @param {string} projectId project id.
   * @param {string} sourceId source id.
   * @param {object} status status.
   * @returns {Promise<void>} resolves after the write.
   */
  async #patchStatus(projectId, sourceId, status) {
    await this.#mutateJson(`projects/${projectId}/sources.json`, {sources: []}, (state) => {
      const sources = Array.isArray(state.sources) ? state.sources : [];
      const index = sources.findIndex((source) => source.id === sourceId);
      if (index === -1) return {};
      sources[index] = {...sources[index], status, updatedAt: new Date().toISOString()};
      state.sources = sources;
      return {};
    });
  }

  /**
   * Import a file as a source.
   *
   * @param {string} projectId project id.
   * @param {{path: string, name?: string, sheet?: string}} input import input.
   * @returns {Promise<object>} created source.
   */
  async importFileSource(projectId, input) {
    await this.requireProject(projectId);
    const sourcePath = String(input.path ?? '').trim();
    if (sourcePath === '') throw new AssistantError(ERROR_CODES.invalidInput, '缺少文件路径。');
    // An imported file is read by the Host, so its path must be a complete
    // absolute path for the Host platform. A relative value used to resolve
    // against the Host process CWD (the DSH install directory), which is never
    // what the user meant and made the file that gets imported unpredictable.
    const absoluteSourcePath = requireUserPath(sourcePath, '导入文件');
    const extension = extname(absoluteSourcePath).toLowerCase();
    if (!SUPPORTED_FILE_EXTENSIONS.includes(extension)) {
      throw new AssistantError(ERROR_CODES.invalidInput, `不支持的文件类型：${extension || '(无扩展名)'}。支持 ${SUPPORTED_FILE_EXTENSIONS.join(' / ')}。`);
    }
    const stat = await fs.stat(absoluteSourcePath).catch(() => {
      throw new AssistantError(ERROR_CODES.sourceUnavailable, `文件不存在或不可读：${absoluteSourcePath}`);
    });
    if (!stat.isFile()) throw new AssistantError(ERROR_CODES.invalidInput, '指定路径不是文件。');
    if (stat.size > MAX_IMPORT_BYTES) throw new AssistantError(ERROR_CODES.invalidInput, `文件超过导入上限 ${MAX_IMPORT_BYTES} 字节。`);
    const bytes = await fs.readFile(absoluteSourcePath);
    const hash = createHash('sha256').update(bytes).digest('hex');
    const fileId = newId('F');
    const storedName = `source${extension}`;
    await this.#store.ensureDir('projects', projectId, 'files', fileId);
    const storedPath = this.#store.path('projects', projectId, 'files', fileId, storedName);
    // Byte-identical copy: imports are evidence, so the stored file is the
    // original bytes, never a re-encoding.
    await fs.copyFile(absoluteSourcePath, storedPath);
    const {readTableFile} = await import('../formats/index.js');
    let parsed;
    try {
      parsed = await readTableFile(storedPath, {sheet: input.sheet, maxRows: 50_000});
    } catch (error) {
      throw new AssistantError(ERROR_CODES.invalidInput, `解析文件失败：${error instanceof Error ? error.message : String(error)}`);
    }
    const now = new Date().toISOString();
    const source = {
      id: newId('S'),
      projectId,
      kind: 'file',
      name: String(input.name ?? basename(absoluteSourcePath)).slice(0, 200),
      fileId,
      originalName: basename(absoluteSourcePath),
      storedPath,
      relativePath: `projects/${projectId}/files/${fileId}/${storedName}`,
      hash,
      size: stat.size,
      sheet: input.sheet ?? parsed.meta.sheet ?? null,
      encoding: parsed.meta.encoding,
      delimiter: parsed.meta.delimiter,
      columns: parsed.fields,
      rowCount: parsed.meta.rowCount,
      truncated: parsed.meta.truncated,
      parseIssues: parsed.issues.slice(0, 500),
      formulaCells: parsed.meta.formulaCells,
      uncomputableCells: parsed.meta.uncomputableCells,
      importedAt: now,
      maxRowsPerSource: 200_000,
      status: {available: true, reason: '已导入文件（只读副本）', enforcement: 'read-only-copy', checkedAt: now},
      createdAt: now,
      updatedAt: now,
    };
    return this.#mutateJson(`projects/${projectId}/sources.json`, {sources: []}, (state) => {
      const sources = Array.isArray(state.sources) ? state.sources : [];
      if (sources.some((entry) => entry.name === source.name)) {
        source.name = `${source.name} (${fileId.slice(-4)})`;
      }
      state.sources = [...sources, source];
      return {result: publicSource(source)};
    });
  }

  /**
   * Read the table/column catalog of a database source.
   *
   * @param {string} projectId project id.
   * @param {string} sourceId source id.
   * @param {{schema?: string, refresh?: boolean, credentials?: object, signal?: AbortSignal}} options options.
   * @returns {Promise<object>} catalog.
   */
  async inspectCatalog(projectId, sourceId, options = {}) {
    const source = await this.requireSource(projectId, sourceId);
    if (source.kind === 'file') {
      return {sourceId: source.id, kind: 'file', tables: [], columns: source.columns ?? [], importedAt: source.importedAt};
    }
    if (options.refresh !== true && source.catalog !== null && source.catalog !== undefined) return source.catalog;
    if (this.#runner === null) throw new AssistantError(ERROR_CODES.internal, '数据库执行器未就绪。');
    const password = await this.resolvePassword(source, options);
    const allSchemas = await this.#runner.listSchemas(source, {password, signal: options.signal});
    // A configured database/schema is the analysis scope. Listing every accessible
    // schema pulls in information_schema/performance_schema (107 tables instead
    // of the analyzed 12) and is never what the user asked for.
    const configuredSchema = optionalString(connectionSchemaOf(source), 200);
    // The configured schema is matched exactly first; a single case-insensitive
    // match is accepted because the same logical schema is spelled `HR` on
    // Oracle, `DBO` on Windows SQL Server and `Public` on some servers, while
    // users type lower case. Two schemas that differ only by case stay an error
    // (choosing one silently could scan the wrong scope).
    let scoped = configuredSchema;
    if (configuredSchema !== undefined && allSchemas.length > 0 && !allSchemas.includes(configuredSchema)) {
      const folded = allSchemas.filter((name) => name.toLowerCase() === configuredSchema.toLowerCase());
      if (folded.length === 1) scoped = folded[0];
      else {
        const sample = allSchemas.slice(0, 20).join(', ');
        throw new AssistantError(ERROR_CODES.notFound, `配置的 schema「${configuredSchema}」在该连接中不存在${folded.length > 1 ? '（存在多个仅大小写不同的同名 schema，请填写完整名称）' : ''}；可用 schema：${sample}${allSchemas.length > 20 ? ' …' : ''}。请在连接配置中更正后重试。`);
      }
    }
    const schemas = scoped === undefined ? allSchemas : allSchemas.filter((name) => name === scoped);
    const tables = [];
    for (const schema of (schemas.length === 0 ? [scoped] : schemas).slice(0, 50)) {
      const listed = await this.#runner.listTables(source, {password, schema, signal: options.signal});
      tables.push(...listed.map((entry) => ({schema: entry.schema ?? schema, table: entry.table, type: entry.type})));
      if (tables.length > 5000) break;
    }
    const catalog = {
      sourceId: source.id,
      kind: 'database',
      dialect: source.dialect,
      schemas,
      tables,
      scannedAt: new Date().toISOString(),
      complete: tables.length <= 5000,
    };
    await this.#mutateJson(`projects/${projectId}/sources.json`, {sources: []}, (state) => {
      const sources = Array.isArray(state.sources) ? state.sources : [];
      const index = sources.findIndex((entry) => entry.id === sourceId);
      if (index !== -1) {
        sources[index] = {...sources[index], catalog, updatedAt: new Date().toISOString()};
        state.sources = sources;
      }
      return {};
    });
    return catalog;
  }

  /**
   * Describe one table's columns.
   *
   * @param {string} projectId project id.
   * @param {string} sourceId source id.
   * @param {{table: string, schema?: string, credentials?: object, signal?: AbortSignal}} request request.
   * @returns {Promise<object[]>} columns.
   */
  async describeTable(projectId, sourceId, request) {
    if (typeof request.table !== 'string' || request.table.trim() === '') throw new AssistantError(ERROR_CODES.invalidInput, '缺少表名。');
    if (request.table.length > 200) throw new AssistantError(ERROR_CODES.invalidInput, '表名不能超过 200 个字符。');
    const source = await this.requireSource(projectId, sourceId);
    if (source.kind === 'file') return source.columns ?? [];
    if (this.#runner === null) throw new AssistantError(ERROR_CODES.internal, '数据库执行器未就绪。');
    const password = await this.resolvePassword(source, request);
    return this.#runner.describeTable(source, {...request, password});
  }

  /**
   * Search the cached catalog by table or column name.
   *
   * @param {string} projectId project id.
   * @param {{query: string, sourceId?: string, limit?: number}} request search request.
   * @returns {Promise<object[]>} matches.
   */
  async searchCatalog(projectId, request) {
    const query = String(request.query ?? '').trim().toLowerCase();
    if (query === '') throw new AssistantError(ERROR_CODES.invalidInput, '检索词不能为空。');
    const limit = Math.min(Math.max(Number(request.limit ?? 20), 1), 100);
    const sources = await this.listSources(projectId);
    const results = [];
    for (const source of sources) {
      if (request.sourceId !== undefined && source.id !== request.sourceId) continue;
      if (source.kind === 'file') {
        for (const column of source.columns ?? []) {
          if (String(column.name).toLowerCase().includes(query)) {
            results.push({sourceId: source.id, sourceName: source.name, kind: 'column', table: null, name: column.name, type: column.kind});
          }
        }
        continue;
      }
      for (const table of source.catalog?.tables ?? []) {
        if (String(table.table).toLowerCase().includes(query)) {
          results.push({sourceId: source.id, sourceName: source.name, kind: 'table', schema: table.schema, table: table.table, name: table.table, type: table.type});
        }
      }
    }
    return results.slice(0, limit);
  }
}

/**
 * Convert a stored source into its public shape (no filesystem internals).
 *
 * @param {object} source stored source.
 * @returns {object} public source.
 */
export function publicSource(source) {
  // `storedPath` is a Host filesystem internal: the public source shape must not
  // hand absolute Host paths to the browser or the model.
  const {passwordRef, relativePath, storedPath, ...rest} = source;
  return {
    ...rest,
    hasCredential: typeof passwordRef === 'string' && passwordRef !== '',
    ...(passwordRef === undefined ? {} : {passwordRef}),
  };
}

/**
 * Redact diagnostics before they are persisted or returned.
 *
 * The exact resolved secret is scrubbed first; credential-shaped fragments
 * (`password=...`) are masked afterwards so a driver message cannot leak a
 * secret that arrived in a different encoding.
 *
 * @param {string} text diagnostic text.
 * @param {string|undefined} secret resolved password, if any.
 * @returns {string} redacted, bounded text.
 */
function redactDiagnostic(text, secret) {
  const cleaned = redactText(String(text ?? ''), [secret]);
  // Mask only the value token: the MySQL client writes `(using password: YES)`,
  // and the old pattern consumed the closing `)`, truncating the message.
  return cleaned.replace(/(password|pwd|passwd)(\s*[=:]\s*)([^\s)]+)/gi, '$1$2***').slice(0, 2000);
}

/**
 * Return a bounded optional string.
 *
 * @param {unknown} value candidate.
 * @param {number} maxLength maximum length.
 * @returns {string|undefined} trimmed value.
 */
function optionalString(value, maxLength) {
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim();
  if (text === '') return undefined;
  return text.slice(0, maxLength);
}

/**
 * Return one connection metadata string, rejecting line breaks.
 *
 * database/schema/user/host end up in generated SQL files and client argv;
 * a newline in a stored value would otherwise be able to start another line in
 * a delivered `.sql` file. Control characters are never valid there.
 *
 * @param {unknown} value candidate.
 * @param {string} field user-facing field name.
 * @returns {string|undefined} trimmed value.
 * @throws {AssistantError} on a control character.
 */
function connectionText(value, field) {
  const text = optionalString(value, 200);
  if (text === undefined) return undefined;
  if (/[\r\n\u0000-\u001f]/.test(text)) {
    throw new AssistantError(ERROR_CODES.invalidInput, `${field}不能包含换行或控制字符。`);
  }
  return text;
}

/**
 * Return a positive integer or a default.
 *
 * @param {unknown} value candidate.
 * @param {number} fallback default.
 * @returns {number} value.
 */
function positiveInt(value, fallback) {
  const number = typeof value === 'number'
    ? value
    : (typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : Number.NaN);
  if (!Number.isInteger(number) || number < 1) return fallback;
  return Math.min(number, MAX_ROWS_PER_SOURCE);
}

/**
 * Validate an optional TCP port.
 *
 * @param {unknown} value candidate.
 * @returns {number|undefined} port, or undefined when absent.
 * @throws {AssistantError} on a non-integer or out-of-range port.
 */
function requirePort(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const number = typeof value === 'number' ? value : (typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : Number.NaN);
  if (!Number.isInteger(number) || number < 1 || number > MAX_PORT) {
    throw new AssistantError(ERROR_CODES.invalidInput, `端口必须是 1-${MAX_PORT} 之间的整数。`);
  }
  return number;
}

/**
 * Validate an optional client-executable override.
 *
 * The executable is launched by the Host, so it must be a complete absolute
 * path for the Host platform (`/opt/homebrew/bin/mysql` on macOS,
 * `C:\Program Files\MySQL\bin\mysql.exe` on Windows).
 *
 * @param {string} command absolute path.
 * @throws {AssistantError} when the path is not absolute.
 */
function assertClientCommand(command) {
  requireUserPath(command, '客户端可执行文件');
}

/**
 * Validate a user-supplied path against the Host platform rules.
 *
 * @param {unknown} value candidate.
 * @param {string} label user-facing field name.
 * @returns {string} normalized absolute path.
 * @throws {AssistantError} when the path is not a complete absolute path for the Host.
 */
function requireUserPath(value, label) {
  return validateUserPath(value, {platform: hostPlatform(), label, maxLength: 1000});
}
