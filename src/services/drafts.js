/**
 * Agent rule drafts.
 *
 * An agent may propose a rule, but only a human may create and confirm one.
 * A draft is therefore a *candidate payload* with provenance: the draft is validated
 * against the current project, its sources and table columns at import
 * time, but the draft never becomes a rule by itself.
 *
 * Storage: `projects/<projectId>/drafts.json` (one bounded list per project).
 *
 * @module src/services/drafts
 */
import {createHash, randomBytes} from 'node:crypto';

import {AssistantError, ERROR_CODES} from '../core/errors.js';
import {validateRule, normalizeRule} from '../core/rule-schema.js';

/** Current draft schema version. */
export const DRAFT_SCHEMA_VERSION = 1;

/** How many drafts a project keeps. */
const MAX_DRAFTS = 50;

/**
 * Stable identifier for one candidate payload.
 *
 * @param {object} value serializable value.
 * @returns {string} sha256 hex.
 */
function fingerprintOf(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/**
 * Build a short draft id.
 *
 * @returns {string} id.
 */
function newDraftId() {
  return `DR-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${randomBytes(3).toString('hex')}`;
}

/** Draft service. */
export class DraftService {
  /** @type {object} */
  #store;
  /** @type {object} */
  #projects;
  /** @type {object|null} */
  #runner;
  /** @type {object} */
  #logger;

  /**
   * @param {{store: object, projects: object, runner?: object, logger?: object}} options composition.
   */
  constructor(options) {
    this.#store = options.store;
    this.#projects = options.projects;
    this.#runner = options.runner ?? null;
    this.#logger = options.logger ?? {};
  }

  /**
   * Read the project's draft list.
   *
   * @param {string} projectId project id.
   * @returns {Promise<object[]>} drafts.
   */
  async #read(projectId) {
    const state = await this.#store.readJson(`projects/${projectId}/drafts.json`, {drafts: []});
    return Array.isArray(state.drafts) ? state.drafts : [];
  }

  /** @param {string} projectId project id. @param {object[]} drafts drafts. @returns {Promise<void>} */
  async #write(projectId, drafts) {
    await this.#store.writeJson(`projects/${projectId}/drafts.json`, {drafts: drafts.slice(-MAX_DRAFTS)});
  }

  /**
   * Persist (or refresh) a draft produced by the agent.
   *
   * @param {string} projectId project id.
   * @param {object} ruleInput rule candidate (validated by the caller or here).
   * @param {{sessionId?: string, assumptions?: string[], warnings?: string[], sourceMetadata?: object}} meta provenance.
   * @returns {Promise<object>} stored draft.
   */
  async create(projectId, ruleInput, meta = {}) {
    await this.#projects.requireProject(projectId);
    const rule = normalizeRule(validateRule({...ruleInput, projectId}));
    const fingerprint = fingerprintOf({rule: ruleForFingerprint(rule)});
    const drafts = await this.#read(projectId);
    const existing = drafts.find((entry) => entry.fingerprint === fingerprint && entry.status !== 'discarded');
    const now = new Date().toISOString();
    const sourceIds = [...new Set([rule.left?.sourceId, rule.right?.sourceId].filter((value) => typeof value === 'string'))];
    if (existing !== undefined) {
      existing.lastSeenAt = now;
      existing.warnings = mergeList(existing.warnings, meta.warnings);
      existing.assumptions = mergeList(existing.assumptions, meta.assumptions);
      await this.#write(projectId, drafts);
      return publicDraft(existing);
    }
    const draft = {
      id: newDraftId(),
      schemaVersion: DRAFT_SCHEMA_VERSION,
      projectId,
      sessionId: typeof meta.sessionId === 'string' ? meta.sessionId : null,
      sourceIds,
      rule,
      ruleName: rule.name,
      ruleKind: rule.kind,
      fingerprint,
      status: 'pending',
      assumptions: mergeList([], meta.assumptions),
      warnings: mergeList([], meta.warnings),
      sourceMetadata: meta.sourceMetadata ?? null,
      createdAt: now,
      lastSeenAt: now,
      importedAt: null,
      importCount: 0,
    };
    drafts.push(draft);
    await this.#write(projectId, drafts);
    return publicDraft(draft);
  }

  /**
   * List drafts for a project, newest first.
   *
   * @param {string} projectId project id.
   * @returns {Promise<object[]>} drafts.
   */
  async list(projectId) {
    await this.#projects.requireProject(projectId);
    const drafts = await this.#read(projectId);
    return drafts
      .filter((entry) => entry.status !== 'discarded')
      .sort((left, right) => (left.createdAt < right.createdAt ? 1 : -1))
      .map(publicDraft);
  }

  /**
   * Read one draft.
   *
   * @param {string} projectId project id.
   * @param {string} draftId draft id.
   * @returns {Promise<object>} draft.
   */
  async get(projectId, draftId) {
    const drafts = await this.#read(projectId);
    const draft = drafts.find((entry) => entry.id === draftId);
    if (draft === undefined) throw new AssistantError(ERROR_CODES.notFound, `规则草稿不存在：${draftId}`);
    if (draft.projectId !== projectId) throw new AssistantError(ERROR_CODES.forbidden, '草稿不属于当前项目。');
    return draft;
  }

  /**
   * Discard a draft (kept for analysis trail, hidden from the list).
   *
   * @param {string} projectId project id.
   * @param {string} draftId draft id.
   * @returns {Promise<object>} updated draft.
   */
  async discard(projectId, draftId) {
    const drafts = await this.#read(projectId);
    const draft = drafts.find((entry) => entry.id === draftId);
    if (draft === undefined) throw new AssistantError(ERROR_CODES.notFound, `规则草稿不存在：${draftId}`);
    if (draft.projectId !== projectId) throw new AssistantError(ERROR_CODES.forbidden, '草稿不属于当前项目。');
    draft.status = 'discarded';
    draft.discardedAt = new Date().toISOString();
    await this.#write(projectId, drafts);
    return publicDraft(draft);
  }

  /**
   * Validate a draft against the *current* project state and load its payload.
   *
   * Import means "open this candidate in the rule editor". Import never confirms a
   * rule; the caller must still save/confirm through the human path.
   *
   * @param {string} projectId project id.
   * @param {string} draftId draft id.
   * @param {{credentials?: object, sessionId?: string}} context host context.
   * @returns {Promise<{draft: object, rule: object, confirmations: object[], warnings: string[]}>} import result.
   */
  async import(projectId, draftId, context = {}) {
    const drafts = await this.#read(projectId);
    const draft = drafts.find((entry) => entry.id === draftId);
    if (draft === undefined) throw new AssistantError(ERROR_CODES.notFound, `规则草稿不存在：${draftId}`);
    if (draft.projectId !== projectId) throw new AssistantError(ERROR_CODES.forbidden, '草稿不属于当前项目，已拒绝导入。');
    if (draft.status === 'discarded') throw new AssistantError(ERROR_CODES.conflict, '草稿已被丢弃，不能导入。');
    if (draft.schemaVersion !== DRAFT_SCHEMA_VERSION) {
      throw new AssistantError(ERROR_CODES.conflict, `草稿版本 ${draft.schemaVersion} 与当前版本 ${DRAFT_SCHEMA_VERSION} 不兼容。`);
    }
    if (typeof context.sessionId === 'string' && context.sessionId !== '') {
      const binding = await this.#projects.bindingOf(context.sessionId);
      if (binding !== null && binding.projectId !== projectId) {
        throw new AssistantError(ERROR_CODES.forbidden, '当前会话绑定的项目与草稿不一致，已拒绝导入。');
      }
    }
    const confirmations = [];
    const warnings = [];
    for (const [side, spec] of [['left', draft.rule.left], ['right', draft.rule.right]]) {
      if (spec === undefined || spec === null) continue;
      let source;
      try {
        source = await this.#projects.requireSource(projectId, spec.sourceId);
      } catch {
        throw new AssistantError(ERROR_CODES.sourceUnavailable, `${side === 'left' ? '左' : '右'}侧数据源已被删除或不属于当前项目，草稿无法导入。`);
      }
      const dataset = spec.dataset ?? {};
      if (dataset.kind === 'table') {
        if (this.#runner === null) throw new AssistantError(ERROR_CODES.internal, '数据库执行器未就绪，无法校验草稿字段。');
        const password = await this.#projects.resolvePassword(source, context);
        let columns;
        try {
          columns = await this.#runner.describeTable(source, {table: dataset.table, schema: dataset.schema, password});
        } catch (error) {
          throw new AssistantError(ERROR_CODES.sourceUnavailable, `${side === 'left' ? '左' : '右'}侧表「${dataset.table}」不可读取：${error instanceof Error ? error.message : String(error)}`);
        }
        const names = new Set(columns.map((column) => column.name));
        const required = [];
        for (const pair of draft.rule.key?.pairs ?? []) required.push(side === 'left' ? pair.left : (pair.right ?? pair.left));
        for (const field of draft.rule.fields ?? []) {
          const name = side === 'left' ? field.left : field.right;
          if (typeof name === 'string' && name !== '') required.push(name);
        }
        if (typeof draft.rule.time?.column === 'string') required.push(draft.rule.time.column);
        const missing = [...new Set(required)].filter((name) => !names.has(name));
        if (missing.length > 0) {
          throw new AssistantError(ERROR_CODES.invalidInput, `${side === 'left' ? '左' : '右'}侧表「${dataset.table}」缺少草稿引用的字段：${missing.join('、')}。表结构可能已变化，请重新生成草稿。`);
        }
        confirmations.push({side, sourceId: source.id, sourceName: source.name, table: dataset.table, confirmed: false, note: '表与字段存在，但映射仍需人工确认'});
        warnings.push(`${side === 'left' ? '左' : '右'}侧字段存在性已校验；映射与业务口径仍需人工确认。`);
      } else if (dataset.kind === 'file') {
        if (source.kind !== 'file') throw new AssistantError(ERROR_CODES.invalidInput, `${side} 侧声明为文件数据集，但数据源不是文件。`);
        confirmations.push({side, sourceId: source.id, sourceName: source.name, table: null, confirmed: false, note: '文件数据源，字段沿用导入时的解析结果'});
      } else if (dataset.kind === 'sql') {
        confirmations.push({side, sourceId: source.id, sourceName: source.name, table: null, confirmed: false, note: '自定义 SQL 数据集：列名无法静态校验，执行时由只读守卫复核'});
        warnings.push(`${side === 'left' ? '左' : '右'}侧是自定义 SQL，字段存在性未静态校验。`);
      }
    }
    draft.status = 'imported';
    draft.importedAt = new Date().toISOString();
    draft.importCount = (draft.importCount ?? 0) + 1;
    await this.#write(projectId, drafts);
    return {draft: publicDraft(draft), rule: draft.rule, confirmations, warnings};
  }
}

/**
 * Rule projection used for deduplication: excludes volatile human-editable
 * status fields so "same content" means the same candidate.
 *
 * @param {object} rule normalized rule.
 * @returns {object} stable projection.
 */
function ruleForFingerprint(rule) {
  return {
    // The display name is presentation only: the same candidate regenerated
    // under a different name must still dedupe to one draft.
    kind: rule.kind,
    left: rule.left,
    right: rule.right,
    key: rule.key,
    fields: rule.fields,
    options: rule.options,
    filters: rule.filters,
    groupBy: rule.groupBy,
    time: rule.time,
    threshold: rule.threshold,
  };
}

/**
 * Merge two string lists without duplicates or empty values.
 *
 * @param {string[]|undefined} left existing list.
 * @param {string[]|undefined} right new list.
 * @returns {string[]} merged.
 */
function mergeList(left, right) {
  const merged = [];
  for (const value of [...(left ?? []), ...(right ?? [])]) {
    if (typeof value === 'string' && value.trim() !== '' && !merged.includes(value)) merged.push(value);
  }
  return merged;
}

/**
 * Public draft shape (never leaks internal storage fields).
 *
 * @param {object} draft stored draft.
 * @returns {object} public copy.
 */
function publicDraft(draft) {
  return {
    id: draft.id,
    schemaVersion: draft.schemaVersion,
    projectId: draft.projectId,
    sessionId: draft.sessionId,
    sourceIds: draft.sourceIds,
    rule: draft.rule,
    ruleName: draft.ruleName,
    ruleKind: draft.ruleKind,
    fingerprints: draft.fingerprint,
    status: draft.status,
    assumptions: draft.assumptions,
    warnings: draft.warnings,
    sourceMetadata: draft.sourceMetadata,
    createdAt: draft.createdAt,
    lastSeenAt: draft.lastSeenAt,
    importedAt: draft.importedAt,
    importCount: draft.importCount,
  };
}
