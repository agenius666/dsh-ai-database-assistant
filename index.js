/**
 * Host half of the AI database assistant plugin.
 *
 * Responsibilities (and nothing else):
 *   1. own the storage root under `$DSH_HOME/ai-database-assistant/`;
 *   2. build the analysis service and publish the service as `aiDatabaseAssistant`;
 *   3. hand the subprocess-backed read-only runner to that service;
 *   4. tear everything down cleanly on unload (aborting running tasks).
 *
 * Tools live in `tools.js` (mounted by the `ai-database-assistant` preset) and HTTP routes in
 * `routes.js`, so this row also activates in a headless profile.
 *
 * @module @agenius/dsh-ai-database-assistant
 */
import {homedir} from 'node:os';
import {join} from 'node:path';

import {createRunner} from './src/db/read.js';
import {createAssistantService} from './src/services/index.js';
import {defaultStorageRoot, JsonStore} from './src/store.js';

/** Cordis function-plugin name. */
export const name = 'ai-database-assistant';

/** Plugin version; must match package.json. */
export const PLUGIN_VERSION = '1.0.4';

/** Default limits, all overridable through the bundle patch `config`. */
export const DEFAULTS = Object.freeze({
  storageRoot: '',
  evidenceRoot: '',
  reportRoot: '',
  queryTimeoutMs: 30_000,
  maxResultBytes: 8 * 1024 * 1024,
  maxExceptions: 20_000,
  maxRowsPerSource: 200_000,
  maxRowsPerTool: 200,
});

/**
 * A runner proxy that tolerates the subprocess service arriving later.
 *
 * The Host row must not depend on activation order: `subprocess` may be mounted
 * after this plugin. Every call fails with an actionable message until the real
 * runner is attached.
 */
class LazyRunner {
  /** @type {object|null} */
  #inner = null;
  /** @type {object} */
  #logger;

  constructor(logger) {
    this.#logger = logger;
  }

  /**
   * Attach the real runner.
   *
   * @param {object} runner runner instance.
   * @returns {void}
   */
  attach(runner) {
    this.#inner = runner;
  }

  /** @returns {object} the attached runner. */
  #require() {
    if (this.#inner === null) {
      throw new Error('数据库执行器尚未就绪：宿主 subprocess 服务未挂载。文件数据源仍可使用，数据库数据源暂不可用。');
    }
    return this.#inner;
  }

  /**
   * Stream one MySQL statement through the real runner.
   *
   * The dataset loader probes for this method to decide between the consistent
   * single-statement path and paged reads; without this forwarder the proxy
   * hides the forwarder and every MySQL read silently degrades to page-offset.
   *
   * @param {object} connection connection.
   * @param {object} request stream request.
   * @returns {Promise<object>} streamed result.
   */
  streamRead(connection, request) {
    const inner = this.#require();
    if (typeof inner.streamRead !== 'function') {
      throw new Error('数据库执行器不支持流式读取：请升级分析插件 Host 模块。');
    }
    return inner.streamRead(connection, request);
  }

  /**
   * Probe a connection.
   *
   * @param {object} connection connection.
   * @param {AbortSignal} [signal] cancellation.
   * @returns {Promise<object>} probe result.
   */
  async probe(connection, signal) {
    return this.#require().probe(connection, signal);
  }

  /**
   * Run one read-only statement.
   *
   * @param {object} connection connection.
   * @param {object} request request.
   * @returns {Promise<object>} result.
   */
  async run(connection, request) {
    return this.#require().run(connection, request);
  }

  /**
   * List schemas.
   *
   * @param {object} connection connection.
   * @param {object} request request.
   * @returns {Promise<string[]>} schemas.
   */
  async listSchemas(connection, request) {
    return this.#require().listSchemas(connection, request);
  }

  /**
   * List tables.
   *
   * @param {object} connection connection.
   * @param {object} request request.
   * @returns {Promise<object[]>} tables.
   */
  async listTables(connection, request) {
    return this.#require().listTables(connection, request);
  }

  /**
   * Describe a table.
   *
   * @param {object} connection connection.
   * @param {object} request request.
   * @returns {Promise<object[]>} columns.
   */
  async describeTable(connection, request) {
    return this.#require().describeTable(connection, request);
  }
}

/**
 * Resolve the DSH home directory.
 *
 * @returns {string} absolute path.
 */
function resolveDshHome() {
  const configured = process.env.DSH_HOME;
  return typeof configured === 'string' && configured !== '' ? configured : join(homedir(), '.dsh');
}

/**
 * Mount the host side.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx plugin context.
 * @param {object} [config] patch config.
 */
export function apply(ctx, config = {}) {
  const settings = {...DEFAULTS, ...(config ?? {})};
  const storageRoot = settings.storageRoot !== '' ? settings.storageRoot : defaultStorageRoot(resolveDshHome());
  const store = new JsonStore(storageRoot, {logger: ctx.logger});
  const lazyRunner = new LazyRunner(ctx.logger);
  const service = createAssistantService({
    store,
    runner: lazyRunner,
    logger: ctx.logger,
    config: {
      evidenceRoot: settings.evidenceRoot !== '' ? settings.evidenceRoot : join(storageRoot, 'evidence'),
      reportRoot: settings.reportRoot !== '' ? settings.reportRoot : join(storageRoot, 'reports'),
      maxExceptions: settings.maxExceptions,
      maxRowsPerSource: settings.maxRowsPerSource,
      queryTimeoutMs: settings.queryTimeoutMs,
      maxResultBytes: settings.maxResultBytes,
      maxRowsPerTool: settings.maxRowsPerTool,
    },
  });

  ctx.provide('aiDatabaseAssistant', service);
  ctx.effect(() => () => service.dispose(), 'ai-database-assistant: stop running tasks on unload');

  // Attach the real runner as soon as the subprocess service exists.
  ctx.inject(['subprocess'], (scope) => {
    lazyRunner.attach(
      createRunner({
        subprocess: scope.subprocess,
        logger: ctx.logger,
        defaults: {
          timeoutMs: settings.queryTimeoutMs,
          maxBytes: settings.maxResultBytes,
          maxRows: settings.maxRowsPerTool,
        },
      }),
    );
  });

  ctx.logger.info(`ai-database-assistant ${PLUGIN_VERSION}: storage root ${storageRoot}`);
}

export {AssistantError} from './src/core/errors.js';
