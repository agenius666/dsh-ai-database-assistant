/**
 * Reconciliation tasks, exception review, and evidence export.
 *
 * A run is a durable record: the record is written as `running` before any row is
 * loaded and only leaves that state when the engine returns, throws, or is
 * cancelled. A process that dies mid-run therefore leaves a visible `running`
 * record on next boot, which the workbench reports as interrupted instead of
 * pretending the run passed.
 *
 * @module src/services/tasks
 */
import {promises as fs} from 'node:fs';
import {join} from 'node:path';

import {AssistantError, ERROR_CODES} from '../core/errors.js';
import {canonicalJson, newId, safeSegment, sha256Hex} from '../core/ids.js';
import {executeRule} from '../engine/runner.js';

/** Review states, kept separate from run states on purpose. */
export const REVIEW_STATUSES = Object.freeze(['pending', 'confirmed', 'excluded', 'insufficient']);
/** Run states. */
export const RUN_STATUSES = Object.freeze(['running', 'passed', 'exceptions', 'undetermined', 'incomplete', 'failed', 'cancelled']);

/** Human labels used by the workbench and reports. */
export const RUN_STATUS_LABELS = Object.freeze({
  running: '执行中',
  passed: '通过',
  exceptions: '发现异常',
  undetermined: '无法判断',
  incomplete: '结果不完整',
  failed: '执行失败',
  cancelled: '已取消',
});
/** Human labels for review states. */
export const REVIEW_STATUS_LABELS = Object.freeze({
  pending: '待复核',
  confirmed: '已确认',
  excluded: '已排除',
  insufficient: '证据不足',
});

/**
 * Task service.
 */
export class TaskService {
  /** @type {import('../store.js').JsonStore} */
  #store;
  /** @type {import('./rules.js').RuleService} */
  #rules;
  /** @type {import('./projects.js').ProjectService} */
  #projects;
  /** @type {object|null} */
  #runner;
  /** @type {object} */
  #logger;
  /** @type {Map<string, {controller: AbortController, promise: Promise<object>}>} */
  #active = new Map();
  /** Runs whose final record was written; progress updates must not regress them. */
  #finished = new Set();
  /** @type {Map<string, Promise<unknown>>} */
  #progressChains = new Map();
  /** @type {object} */
  #limits;
  /** @type {Map<string, Promise<void>>} per-group read/modify/write locks. */
  #groupLocks = new Map();

  /**
   * @param {{store: object, rules: object, projects: object, runner?: object, logger?: object,
   *   limits?: {maxExceptions?: number, maxRowsPerSource?: number}}} options services.
   */
  constructor(options) {
    this.#store = options.store;
    this.#rules = options.rules;
    this.#projects = options.projects;
    this.#runner = options.runner ?? null;
    this.#logger = options.logger ?? {};
    this.#limits = options.limits ?? {};
  }

  /**
   * Abort every running task (called on plugin unload).
   *
   * @returns {Promise<void>} resolves after all runs settle.
   */
  async shutdown() {
    for (const [, entry] of this.#active) entry.controller.abort(new Error('插件已卸载，任务被中断。'));
    await Promise.allSettled([...this.#active.values()].map((entry) => entry.promise));
  }

  /**
   * List run summaries.
   *
   * @param {string} projectId project id.
   * @param {{limit?: number}} [options] options.
   * @returns {Promise<object[]>} runs, newest first.
   */
  async listRuns(projectId, options = {}) {
    const index = await this.#store.readJson(`projects/${projectId}/runs.json`, {runs: []});
    const limit = Math.min(Math.max(Number(options.limit ?? 50), 1), 500);
    return [...index.runs].sort((left, right) => right.startedAt.localeCompare(left.startedAt)).slice(0, limit);
  }

  /**
   * Read one run record.
   *
   * @param {string} projectId project id.
   * @param {string} runId run id.
   * @returns {Promise<object>} run record.
   */
  async getRun(projectId, runId) {
    const run = await this.#store.readJson(`projects/${projectId}/runs/${runId}/run.json`, null);
    if (run === null) throw new AssistantError(ERROR_CODES.notFound, `核对任务不存在：${runId}`);
    return run;
  }

  /**
   * Start a reconciliation run.
   *
   * @param {string} projectId project id.
   * @param {{ruleId: string, ruleVersion?: number, allowUnconfirmed?: boolean, name?: string}} request run request.
   * @param {{sessionId?: string, credentials?: object, signal?: AbortSignal}} context host context.
   * @returns {Promise<{runId: string, done: Promise<object>}>} run handle.
   */
  async startRun(projectId, request, context = {}) {
    if (this.#runner === null) throw new AssistantError(ERROR_CODES.internal, '数据库执行器未就绪，无法执行核对。');
    const rule = await this.#rules.getRule(projectId, request.ruleId, request.ruleVersion);
    if (rule.status !== 'confirmed' && request.allowUnconfirmed !== true) {
      throw new AssistantError(
        ERROR_CODES.forbidden,
        `规则 v${rule.version} 尚未确认，不能正式执行。请在工作台确认规则，或使用「预览执行」并在结果中标注未确认。`,
        {details: {ruleVersion: rule.version, status: rule.status}},
      );
    }
    const runId = newId('RUN');
    const startedAt = new Date().toISOString();
    const run = {
      runId,
      projectId,
      name: request.name ?? `${rule.name} · v${rule.version}`,
      ruleId: rule.id,
      ruleVersion: rule.version,
      ruleName: rule.name,
      ruleKind: rule.kind,
      ruleStatus: rule.status,
      ruleFingerprint: sha256Hex(canonicalJson(rule)).slice(0, 16),
      status: 'running',
      progress: {phase: 'queued', loadedRows: 0},
      startedAt,
      finishedAt: null,
      durationMs: null,
      initiatedBy: context.sessionId ?? null,
      reviewed: {pending: 0, confirmed: 0, excluded: 0, insufficient: 0},
      exceptionCount: 0,
      stats: {},
      warnings: [],
      coverage: null,
      contentHash: null,
      complete: null,
      exceptionsTruncated: false,
      failure: null,
      outputs: {},
    };
    await this.#store.writeJson(`projects/${projectId}/runs/${runId}/run.json`, run);
    await this.#appendIndex(projectId, indexEntryOf(run));
    const controller = new AbortController();
    const onOuterAbort = () => controller.abort(context.signal?.reason);
    context.signal?.addEventListener('abort', onOuterAbort, {once: true});
    const promise = this.#execute(projectId, run, rule, controller.signal, context)
      .catch(async (error) => {
        const failed = await this.#finish(projectId, runId, {
          status: controller.signal.aborted ? 'cancelled' : 'failed',
          failure: {message: error instanceof Error ? error.message : String(error)},
        });
        return failed;
      })
      .finally(() => {
        context.signal?.removeEventListener('abort', onOuterAbort);
        this.#active.delete(runId);
      });
    this.#active.set(runId, {controller, promise});
    return {runId, done: promise};
  }

  /**
   * Run several confirmed rules in sequence as one analysis request.
   *
   * Sequential by design: each rule reads its own statement snapshot, and
   * running them one after another keeps the machine load bounded. The group
   * is not one transaction; the receipt records that each run has its own
   * consistency record.
   *
   * @param {string} projectId project id.
   * @param {{ruleIds: string[], name?: string}} request group request.
   * @param {{sessionId?: string, credentials?: object, signal?: AbortSignal}} context host context.
   * @returns {Promise<{groupId: string, runs: object[]}>} group outcome.
   */
  async startGroup(projectId, request, context = {}) {
    const ids = [...new Set(request.ruleIds ?? [])];
    if (ids.length === 0) throw new AssistantError(ERROR_CODES.invalidInput, '组合核对至少需要一条规则。');
    if (ids.length > 20) throw new AssistantError(ERROR_CODES.invalidInput, '一次组合核对最多 20 条规则。');
    await this.#projects.requireProject(projectId);
    const groupId = newId('GRP');
    const name = typeof request.name === 'string' && request.name.trim() !== '' ? request.name.trim() : `组合核对 ${groupId}`;
    const group = {
      groupId,
      projectId,
      name,
      status: 'running',
      createdAt: new Date().toISOString(),
      finishedAt: null,
      cancelRequested: false,
      rules: [],
      stats: null,
      consistency: {
        crossRule: 'separate-statements',
        note: '每条规则各自执行一条 SELECT，各自持有语句级快照；组合任务不承诺跨规则统一快照。',
      },
    };
    await this.#saveGroup(group);
    for (const ruleId of ids) {
      // Re-read the persisted flag: cancellation arrives through another call
      // and must not be overwritten by this in-memory copy.
      const latest = await this.#loadGroup(projectId, groupId);
      if (latest?.cancelRequested === true) group.cancelRequested = true;
      if (group.cancelRequested) {
        group.rules.push({ruleId, runId: null, status: 'cancelled', exceptionCount: 0, complete: null, reason: '组合任务已取消'});
        await this.#saveGroup(group);
        continue;
      }
      try {
        const rule = await this.#rules.getRule(projectId, ruleId);
        if (rule.status !== 'confirmed') {
          group.rules.push({ruleId, runId: null, status: 'failed', exceptionCount: 0, complete: null, reason: '规则尚未确认，跳过'});
          await this.#saveGroup(group);
          continue;
        }
        const handle = await this.startRun(projectId, {ruleId, name: `${name} · ${rule.name}`}, context);
        // Re-read before overwriting: a cancel that arrived between the initial
        // save and this one must not be lost by writing the stale in-memory
        // copy (that used to let the group finish as "completed").
        const latestAfterStart = await this.#loadGroup(projectId, groupId);
        if (latestAfterStart?.cancelRequested === true) {
          group.cancelRequested = true;
          await this.cancelRun(projectId, handle.runId).catch(() => {});
        }
        group.activeRunId = handle.runId;
        await this.#saveGroup(group);
        const run = await handle.done;
        const latestAfterRun = await this.#loadGroup(projectId, groupId);
        if (latestAfterRun?.cancelRequested === true) group.cancelRequested = true;
        group.rules.push({
          ruleId,
          ruleVersion: run.ruleVersion,
          runId: run.runId,
          status: run.status,
          complete: run.complete,
          exceptionCount: run.exceptionCount,
          durationMs: run.durationMs,
          readConsistency: run.readConsistency ?? null,
          reviewed: run.reviewed ?? null,
        });
      } catch (error) {
        group.rules.push({ruleId, runId: null, status: 'failed', exceptionCount: 0, complete: null, reason: error instanceof Error ? error.message : String(error)});
      }
      group.activeRunId = null;
      await this.#saveGroup(group);
    }
    group.status = groupStatus(group);
    group.finishedAt = new Date().toISOString();
    group.stats = groupStats(group);
    await this.#saveGroup(group);
    return publicGroup(group);
  }

  /**
   * List persisted combination runs.
   *
   * @param {string} projectId project id.
   * @param {{limit?: number}} [options] options.
   * @returns {Promise<object[]>} groups, newest first.
   */
  async listGroups(projectId, options = {}) {
    await this.#projects.requireProject(projectId);
    const state = await this.#store.readJson(`projects/${projectId}/groups.json`, {groups: []});
    const groups = Array.isArray(state.groups) ? state.groups : [];
    return groups
      .slice()
      .sort((left, right) => (left.createdAt < right.createdAt ? 1 : -1))
      .slice(0, options.limit ?? 50)
      .map(publicGroup);
  }

  /**
   * Read one combination run.
   *
   * @param {string} projectId project id.
   * @param {string} groupId group id.
   * @returns {Promise<object>} group.
   */
  async getGroup(projectId, groupId) {
    const state = await this.#store.readJson(`projects/${projectId}/groups.json`, {groups: []});
    const group = (state.groups ?? []).find((entry) => entry.groupId === groupId);
    if (group === undefined) throw new AssistantError(ERROR_CODES.notFound, `组合核对不存在：${groupId}`);
    return publicGroup(group);
  }

  /**
   * Request cancellation of a running combination.
   *
   * @param {string} projectId project id.
   * @param {string} groupId group id.
   * @returns {Promise<object>} updated group.
   */
  async cancelGroup(projectId, groupId) {
    await this.#projects.requireProject(projectId);
    return this.#withGroupLock(projectId, groupId, async () => {
      const state = await this.#store.readJson(`projects/${projectId}/groups.json`, {groups: []});
      const groups = Array.isArray(state.groups) ? state.groups : [];
      const index = groups.findIndex((entry) => entry.groupId === groupId);
      if (index === -1) throw new AssistantError(ERROR_CODES.notFound, `组合核对不存在：${groupId}`);
      const group = groups[index];
      group.cancelRequested = true;
      if (typeof group.activeRunId === 'string') await this.cancelRun(projectId, group.activeRunId).catch(() => {});
      if (group.status === 'running') group.status = 'cancelled';
      group.finishedAt = group.finishedAt ?? new Date().toISOString();
      groups[index] = group;
      await this.#store.writeJson(`projects/${projectId}/groups.json`, {groups: groups.slice(-200)});
      return publicGroup(group);
    });
  }

  /**
   * Serialize one group read/modify/write sequence.
   *
   * Cancellation and the executing group both rewrite the same full record; an
   * unlocked read/write pair let a stale copy clear `cancelRequested` and turn
   * a cancelled group into "completed".
   *
   * @template T
   * @param {string} projectId project id.
   * @param {string} groupId group id.
   * @param {() => Promise<T>} operation critical section.
   * @returns {Promise<T>} operation result.
   */
  async #withGroupLock(projectId, groupId, operation) {
    const key = `${projectId}/${groupId}`;
    const previous = this.#groupLocks.get(key) ?? Promise.resolve();
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    const queued = previous.then(() => current);
    this.#groupLocks.set(key, queued);
    await previous.catch(() => {});
    try {
      return await operation();
    } finally {
      release();
      if (this.#groupLocks.get(key) === queued) this.#groupLocks.delete(key);
    }
  }

  /**
   * Read one persisted group record.
   *
   * @param {string} projectId project id.
   * @param {string} groupId group id.
   * @returns {Promise<object|null>} group or null.
   */
  async #loadGroup(projectId, groupId) {
    const state = await this.#store.readJson(`projects/${projectId}/groups.json`, {groups: []});
    return (state.groups ?? []).find((entry) => entry.groupId === groupId) ?? null;
  }

  /**
   * Persist one group record inside the project index.
   *
   * @param {object} group group record.
   * @returns {Promise<void>} resolves after write.
   */
  async #saveGroup(group) {
    await this.#withGroupLock(group.projectId, group.groupId, async () => {
      const state = await this.#store.readJson(`projects/${group.projectId}/groups.json`, {groups: []});
      const groups = Array.isArray(state.groups) ? state.groups : [];
      const index = groups.findIndex((entry) => entry.groupId === group.groupId);
      if (index !== -1) {
        const existing = groups[index];
        // Never let a stale in-memory copy clear a cancellation requested
        // elsewhere, nor turn a cancelled record back into running.
        if (existing.cancelRequested === true) group.cancelRequested = true;
        if (existing.status === 'cancelled' && group.status === 'running') group.status = 'cancelled';
      }
      if (index === -1) groups.push(group); else groups[index] = group;
      await this.#store.writeJson(`projects/${group.projectId}/groups.json`, {groups: groups.slice(-200)});
    });
  }

  /**
   * Execute one run and persist its outputs.
   *
   * @param {string} projectId project id.
   * @param {object} run run record.
   * @param {object} rule rule version.
   * @param {AbortSignal} signal cancellation.
   * @param {object} context host context.
   * @returns {Promise<object>} final run record.
   */
  async #execute(projectId, run, rule, signal, context) {
    const sourceCache = new Map();
    for (const sourceId of [rule.left?.sourceId, rule.right?.sourceId]) {
      if (typeof sourceId !== 'string' || sourceId === '' || sourceCache.has(sourceId)) continue;
      sourceCache.set(sourceId, await this.#projects.requireSource(projectId, sourceId));
    }
    const passwordCache = new Map();
    const resolvePassword = async (source) => {
      if (source.kind !== 'database') return undefined;
      if (!passwordCache.has(source.id)) passwordCache.set(source.id, await this.#projects.resolvePassword(source, context));
      return passwordCache.get(source.id);
    };
    const result = await executeRule({
      rule,
      getSource: (sourceId) => {
        const source = sourceCache.get(sourceId);
        if (source === undefined) throw new AssistantError(ERROR_CODES.notFound, `数据源不存在或不属于当前项目：${sourceId}`);
        return source;
      },
      resolvePassword,
      runner: this.#runner,
      signal,
      limits: this.#limits,
      onProgress: (progress) => {
        this.#updateProgress(projectId, run.runId, progress).catch(() => {});
      },
    });
    return this.#finish(projectId, run.runId, {
      status: result.status === 'exceptions' ? 'exceptions' : result.status === 'incomplete' ? 'incomplete' : result.status === 'succeeded' ? 'passed' : 'undetermined',
      stats: result.stats,
      warnings: result.warnings,
      coverage: result.coverage,
      readConsistency: result.readConsistency,
      contentHash: result.contentHash,
      complete: result.complete,
      exceptionsTruncated: result.exceptionsTruncated,
      exceptions: result.exceptions,
      reviewed: {pending: result.exceptions.length, confirmed: 0, excluded: 0, insufficient: 0},
    });
  }

  /**
   * Persist a progress note without failing the run.
   *
   * @param {string} projectId project id.
   * @param {string} runId run id.
   * @param {object} progress progress.
   * @returns {Promise<void>} resolves after the write.
   */
  async #updateProgress(projectId, runId, progress) {
    // Serialize the read-modify-write per run and refuse to touch a run that has
    // already been finalized: a late progress write must never set a finished
    // run back to "running".
    const previous = this.#progressChains.get(runId) ?? Promise.resolve();
    const task = previous.then(async () => {
      if (this.#finished.has(runId)) return;
      const run = await this.#store.readJson(`projects/${projectId}/runs/${runId}/run.json`, null);
      if (run === null || run.status !== 'running') return;
      run.progress = {phase: progress.phase, loadedRows: progress.loaded ?? 0, side: progress.side ?? null};
      run.updatedAt = new Date().toISOString();
      await this.#store.writeJson(`projects/${projectId}/runs/${runId}/run.json`, run);
    });
    this.#progressChains.set(runId, task.catch(() => {}));
    return task;
  }

  /**
   * Finalize a run, writing exceptions and the summary.
   *
   * @param {string} projectId project id.
   * @param {string} runId run id.
   * @param {object} outcome outcome payload.
   * @returns {Promise<object>} final run record.
   */
  async #finish(projectId, runId, outcome) {
    this.#finished.add(runId);
    // Let any in-flight progress write settle before the final record is
    // written, then drop the chain.
    await (this.#progressChains.get(runId) ?? Promise.resolve()).catch(() => {});
    this.#progressChains.delete(runId);
    const run = await this.getRun(projectId, runId);
    const finishedAt = new Date().toISOString();
    const exceptions = outcome.exceptions ?? [];
    if (outcome.exceptions !== undefined) {
      await this.#writeExceptions(projectId, runId, run, exceptions);
    }
    const next = {
      ...run,
      status: outcome.status,
      finishedAt,
      durationMs: Date.parse(finishedAt) - Date.parse(run.startedAt),
      stats: outcome.stats ?? run.stats,
      warnings: outcome.warnings ?? run.warnings,
      coverage: outcome.coverage ?? run.coverage,
      // Persist the consistency level with the run: without the level the receipt and
      // the evidence pack cannot state what guarantee the numbers have.
      readConsistency: outcome.readConsistency ?? run.readConsistency ?? null,
      contentHash: outcome.contentHash ?? null,
      complete: outcome.complete ?? null,
      exceptionsTruncated: outcome.exceptionsTruncated ?? false,
      exceptionCount: outcome.exceptions === undefined ? run.exceptionCount : exceptions.length,
      reviewed: outcome.reviewed ?? run.reviewed,
      failure: outcome.failure ?? null,
      progress: {phase: 'done', loadedRows: 0},
    };
    await this.#store.writeJson(`projects/${projectId}/runs/${runId}/run.json`, next);
    await this.#store.writeJson(`projects/${projectId}/runs/${runId}/summary.json`, {
      runId,
      projectId,
      ruleId: next.ruleId,
      ruleVersion: next.ruleVersion,
      status: next.status,
      complete: next.complete,
      contentHash: next.contentHash,
      stats: next.stats,
      coverage: next.coverage,
      readConsistency: next.readConsistency,
      warnings: next.warnings,
      generatedAt: finishedAt,
    });
    await this.#replaceIndexEntry(projectId, indexEntryOf(next));
    return next;
  }

  /**
   * Persist exceptions with their provenance envelope.
   *
   * @param {string} projectId project id.
   * @param {string} runId run id.
   * @param {object} run run record.
   * @param {object[]} exceptions findings.
   * @returns {Promise<void>} resolves after the write.
   */
  async #writeExceptions(projectId, runId, run, exceptions) {
    const relative = `projects/${projectId}/runs/${runId}/exceptions.jsonl`;
    const path = this.#store.path(relative);
    await fs.mkdir(join(this.#store.projectPath(projectId), 'runs', runId), {recursive: true});
    // Rewrite rather than append: a re-run of the same run id must not duplicate.
    await fs.writeFile(path, '');
    for (const exception of exceptions) {
      await this.#store.appendJsonl(relative, {
        exceptionId: exception.exceptionId,
        sequence: exception.sequence,
        projectId,
        runId,
        ruleId: run.ruleId,
        ruleVersion: run.ruleVersion,
        ruleFingerprint: run.ruleFingerprint,
        kind: exception.kind,
        side: exception.side,
        message: exception.message,
        keys: exception.keys,
        values: exception.values,
        leftRowNumbers: exception.leftRowNumbers,
        rightRowNumbers: exception.rightRowNumbers,
      });
    }
  }

  /**
   * Append one entry to the run index.
   *
   * @param {string} projectId project id.
   * @param {object} entry index entry.
   * @returns {Promise<void>} resolves after the write.
   */
  async #appendIndex(projectId, entry) {
    const index = await this.#store.readJson(`projects/${projectId}/runs.json`, {runs: []});
    await this.#store.writeJson(`projects/${projectId}/runs.json`, {runs: [...index.runs, entry]});
  }

  /**
   * Replace one run index entry.
   *
   * @param {string} projectId project id.
   * @param {object} entry index entry.
   * @returns {Promise<void>} resolves after the write.
   */
  async #replaceIndexEntry(projectId, entry) {
    const index = await this.#store.readJson(`projects/${projectId}/runs.json`, {runs: []});
    const runs = index.runs.filter((candidate) => candidate.runId !== entry.runId);
    runs.push(entry);
    await this.#store.writeJson(`projects/${projectId}/runs.json`, {runs});
  }

  /**
   * Cancel a running task.
   *
   * @param {string} projectId project id.
   * @param {string} runId run id.
   * @returns {Promise<object>} run record (still running until the run settles).
   */
  async cancelRun(projectId, runId) {
    const run = await this.getRun(projectId, runId);
    if (run.status !== 'running') return run;
    const active = this.#active.get(runId);
    if (active === undefined) {
      // A run left `running` by a previous process cannot be cancelled; the run is
      // marked cancelled here so the receipt never claims a result the run lacks.
      return this.#finish(projectId, runId, {status: 'cancelled', failure: {message: '任务已中断（宿主重启或插件重载）。'}});
    }
    active.controller.abort(new Error('用户取消'));
    return run;
  }

  /**
   * Mark runs left `running` by a previous process as interrupted.
   *
   * @param {string} projectId project id.
   * @returns {Promise<number>} number of repaired runs.
   */
  async repairInterruptedRuns(projectId) {
    const index = await this.#store.readJson(`projects/${projectId}/runs.json`, {runs: []});
    let repaired = 0;
    for (const entry of index.runs) {
      if (entry.status !== 'running') continue;
      // A run owned by this process is still live: `overview` polls this method
      // while work is running, and marking a live run cancelled destroys its
      // final result and disables cancellation.
      if (this.#active.has(entry.runId)) continue;
      const run = await this.#store.readJson(`projects/${projectId}/runs/${entry.runId}/run.json`, null);
      if (run === null || run.status !== 'running') continue;
      await this.#finish(projectId, entry.runId, {
        status: 'cancelled',
        failure: {message: '任务未完成：宿主在任务运行期间退出或被重载。'},
      });
      repaired += 1;
    }
    return repaired;
  }

  /**
   * Page through exception records.
   *
   * @param {string} projectId project id.
   * @param {string} runId run id.
   * @param {{cursor?: number, pageSize?: number, reviewStatus?: string, kind?: string, query?: string}} options filters.
   * @returns {Promise<{total: number, items: object[], nextCursor: number|null}>} page.
   */
  async listExceptions(projectId, runId, options = {}) {
    await this.getRun(projectId, runId);
    const all = await this.#store.readJsonl(`projects/${projectId}/runs/${runId}/exceptions.jsonl`);
    const reviews = await this.#store.readJson(`projects/${projectId}/reviews/${runId}.json`, {reviews: {}});
    const pageSize = Math.min(Math.max(Number(options.pageSize ?? 50), 1), 500);
    const cursor = Math.max(Number(options.cursor ?? 0), 0);
    const query = String(options.query ?? '').trim().toLowerCase();
    const filtered = all.filter((exception) => {
      const review = reviews.reviews[exception.exceptionId]?.status ?? 'pending';
      if (options.reviewStatus !== undefined && review !== options.reviewStatus) return false;
      if (options.kind !== undefined && exception.kind !== options.kind) return false;
      if (query !== '') {
        const haystack = `${exception.message} ${JSON.stringify(exception.keys)} ${JSON.stringify(exception.values)}`.toLowerCase();
        if (!haystack.includes(query)) return false;
      }
      return true;
    });
    const items = filtered.slice(cursor, cursor + pageSize).map((exception) => ({
      ...exception,
      review: reviews.reviews[exception.exceptionId] ?? {status: 'pending', note: '', by: '未复核', at: null},
    }));
    return {total: filtered.length, items, nextCursor: cursor + pageSize < filtered.length ? cursor + pageSize : null};
  }

  /**
   * Count exceptions by review status.
   *
   * @param {string} projectId project id.
   * @param {string} runId run id.
   * @returns {Promise<Record<string, number>>} counts.
   */
  async reviewCounts(projectId, runId) {
    const all = await this.#store.readJsonl(`projects/${projectId}/runs/${runId}/exceptions.jsonl`);
    const reviews = await this.#store.readJson(`projects/${projectId}/reviews/${runId}.json`, {reviews: {}});
    const counts = {pending: 0, confirmed: 0, excluded: 0, insufficient: 0};
    for (const exception of all) {
      const status = reviews.reviews[exception.exceptionId]?.status ?? 'pending';
      counts[status] = (counts[status] ?? 0) + 1;
    }
    return counts;
  }

  /**
   * Record a human review decision.
   *
   * @param {string} projectId project id.
   * @param {string} runId run id.
   * @param {string} exceptionId exception id.
   * @param {{status: string, note?: string, by?: string, reviewer?: string}} request decision.
   * @returns {Promise<object>} stored review.
   */
  async reviewException(projectId, runId, exceptionId, request) {
    if (!REVIEW_STATUSES.includes(request.status)) {
      throw new AssistantError(ERROR_CODES.invalidInput, `未知的复核状态：${request.status}`);
    }
    const reviewer = String(request.by ?? request.reviewer ?? '').trim();
    if (reviewer === '') throw new AssistantError(ERROR_CODES.invalidInput, '复核记录必须填写复核人。');
    await this.getRun(projectId, runId);
    const relative = `projects/${projectId}/reviews/${runId}.json`;
    const state = await this.#store.readJson(relative, {reviews: {}});
    const previous = state.reviews[exceptionId];
    const at = new Date().toISOString();
    const history = [...(previous?.history ?? []), {status: request.status, note: String(request.note ?? '').slice(0, 4000), by: reviewer, at}];
    state.reviews[exceptionId] = {
      status: request.status,
      note: String(request.note ?? '').slice(0, 4000),
      by: reviewer,
      at,
      history,
    };
    await this.#store.writeJson(relative, state);
    // Keep the run summary's counters current without touching its status.
    const counts = await this.reviewCounts(projectId, runId);
    const run = await this.getRun(projectId, runId);
    if (run.status !== 'running') {
      const next = {...run, reviewed: counts};
      await this.#store.writeJson(`projects/${projectId}/runs/${runId}/run.json`, next);
      await this.#replaceIndexEntry(projectId, indexEntryOf(next));
    }
    return state.reviews[exceptionId];
  }

  /**
   * Read the review file of a run.
   *
   * @param {string} projectId project id.
   * @param {string} runId run id.
   * @returns {Promise<object>} review state.
   */
  async reviewsOf(projectId, runId) {
    return this.#store.readJson(`projects/${projectId}/reviews/${runId}.json`, {reviews: {}});
  }
}

/**
 * Build a run index entry.
 *
 * @param {object} run run record.
 * @returns {object} index entry.
 */
function indexEntryOf(run) {
  return {
    runId: run.runId,
    ruleId: run.ruleId,
    ruleVersion: run.ruleVersion,
    ruleName: run.ruleName,
    ruleKind: run.ruleKind,
    name: run.name,
    status: run.status,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    durationMs: run.durationMs,
    exceptionCount: run.exceptionCount,
    exceptionCounts: run.reviewed ?? null,
    complete: run.complete,
    contentHash: run.contentHash,
    progress: run.progress ?? null,
    failure: run.failure ?? null,
    safeName: safeSegment(run.name, 40),
  };
}


/**
 * Overall status of one combination run.
 *
 * @param {object} group group record.
 * @returns {string} status.
 */
function groupStatus(group) {
  const children = group.rules ?? [];
  if (children.length === 0) return 'failed';
  if (group.cancelRequested || children.some((child) => child.status === 'cancelled')) return 'cancelled';
  const failed = children.filter((child) => child.status === 'failed').length;
  if (failed === children.length) return 'failed';
  const clean = children.every((child) => child.status === 'passed' || child.status === 'exceptions');
  if (failed > 0 || children.some((child) => child.status === 'incomplete' || child.status === 'undetermined')) return 'partial';
  return clean && children.length > 0 ? 'completed' : 'partial';
}

/**
 * Aggregate statistics for a combination run, keeping event counts and record
 * counts distinct.
 *
 * @param {object} group group record.
 * @returns {object} stats.
 */
function groupStats(group) {
  const children = group.rules ?? [];
  const count = (status) => children.filter((child) => child.status === status).length;
  const reviewed = children.reduce((sum, child) => sum + Number(child.reviewed?.confirmed ?? 0), 0);
  const pending = children.reduce((sum, child) => sum + Number(child.reviewed?.pending ?? 0), 0);
  return {
    rules: children.length,
    passed: count('passed'),
    exceptions: count('exceptions'),
    incomplete: count('incomplete'),
    undetermined: count('undetermined'),
    failed: count('failed'),
    cancelled: count('cancelled'),
    exceptionEvents: children.reduce((sum, child) => sum + Number(child.exceptionCount ?? 0), 0),
    reviewed,
    pending,
    uniqueRecords: null,
    uniqueNote: '不同规则可能命中同一条原始记录；未提供统一去重口径时不给唯一记录数，只给异常事件数。',
  };
}

/**
 * Public group shape.
 *
 * @param {object} group stored group.
 * @returns {object} public copy.
 */
function publicGroup(group) {
  return {
    groupId: group.groupId,
    projectId: group.projectId,
    name: group.name,
    status: group.status,
    createdAt: group.createdAt,
    finishedAt: group.finishedAt ?? null,
    rules: group.rules ?? [],
    stats: group.stats ?? groupStats(group, null, group.projectId),
    consistency: group.consistency,
    cancelRequested: group.cancelRequested === true,
  };
}
