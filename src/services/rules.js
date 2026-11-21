/**
 * Rule versioning.
 *
 * Rules are append-only: every change creates a new version file, and the old
 * version stays readable because past runs reference `(ruleId, version)`.
 * Confirmation is a status change, which is itself a version, so "who confirmed
 * which logic" is answerable from the record.
 *
 * @module src/services/rules
 */
import {AssistantError, ERROR_CODES} from '../core/errors.js';
import {fingerprintOf, newId} from '../core/ids.js';
import {normalizeRule, RULE_STATUSES, validateRule} from '../core/rule-schema.js';

/**
 * Rule repository bound to one project directory.
 */
export class RuleService {
  /** @type {import('../store.js').JsonStore} */
  #store;
  /** @type {(projectId: string) => Promise<object>} */
  #requireProject;

  /**
   * @param {{store: object, requireProject?: (projectId: string) => Promise<object>}} options services.
   */
  constructor(options) {
    this.#store = options.store;
    this.#requireProject = options.requireProject ?? (async () => ({}));
  }

  /**
   * Read a rule index.
   *
   * @param {string} projectId project id.
   * @param {string} ruleId rule id.
   * @returns {Promise<object>} index.
   */
  async #readIndex(projectId, ruleId) {
    const index = await this.#store.readJson(`projects/${projectId}/rules/${ruleId}/index.json`, null);
    if (index === null) throw new AssistantError(ERROR_CODES.notFound, `核对规则不存在：${ruleId}`);
    return index;
  }

  /**
   * List the latest version of every rule in a project.
   *
   * @param {string} projectId project id.
   * @returns {Promise<object[]>} rule summaries.
   */
  async listRules(projectId) {
    await this.#requireProject(projectId);
    const entries = await this.#store.list(`projects/${projectId}/rules`);
    const summaries = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const index = await this.#store.readJson(`projects/${projectId}/rules/${entry.name}/index.json`, null);
      if (index === null) continue;
      const current = index.versions.find((version) => version.version === index.currentVersion);
      if (current === undefined) continue;
      summaries.push({
        ruleId: index.ruleId,
        name: current.name,
        kind: current.kind,
        version: current.version,
        status: current.status,
        fingerprint: current.fingerprint,
        createdAt: current.createdAt,
        confirmedAt: current.confirmedAt ?? null,
        versions: index.versions.length,
        template: current.template ?? null,
      });
    }
    return summaries.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  /**
   * Read one rule version.
   *
   * @param {string} projectId project id.
   * @param {string} ruleId rule id.
   * @param {number} [version] exact version; defaults to current.
   * @returns {Promise<object>} rule.
   */
  async getRule(projectId, ruleId, version) {
    await this.#requireProject(projectId);
    const index = await this.#readIndex(projectId, ruleId);
    const target = version ?? index.currentVersion;
    const entry = index.versions.find((candidate) => candidate.version === target);
    if (entry === undefined) throw new AssistantError(ERROR_CODES.notFound, `规则版本不存在：${ruleId} v${target}`);
    const rule = await this.#store.readJson(`projects/${projectId}/rules/${ruleId}/v${target}.json`, null);
    if (rule === null) throw new AssistantError(ERROR_CODES.internal, `规则版本文件缺失：${ruleId} v${target}`);
    return rule;
  }

  /**
   * List version history of one rule.
   *
   * @param {string} projectId project id.
   * @param {string} ruleId rule id.
   * @returns {Promise<object[]>} versions.
   */
  async listVersions(projectId, ruleId) {
    await this.#requireProject(projectId);
    const index = await this.#readIndex(projectId, ruleId);
    return index.versions;
  }

  /**
   * Persist a new rule version.
   *
   * @param {string} projectId project id.
   * @param {object} rule validated rule.
   * @param {object} index index to update.
   * @param {object} entry version summary.
   * @returns {Promise<object>} stored rule.
   */
  async #writeVersion(projectId, rule, index, entry) {
    await this.#store.writeJson(`projects/${projectId}/rules/${rule.id}/v${entry.version}.json`, rule);
    const nextIndex = {
      ruleId: rule.id,
      currentVersion: entry.version,
      versions: [...index.versions, entry],
    };
    await this.#store.writeJson(`projects/${projectId}/rules/${rule.id}/index.json`, nextIndex);
    return rule;
  }

  /**
   * Create a rule version 1.
   *
   * @param {string} projectId project id.
   * @param {object} input rule input.
   * @param {{author?: string}} [options] creation options.
   * @returns {Promise<object>} stored rule.
   */
  async createRule(projectId, input, options = {}) {
    await this.#requireProject(projectId);
    const ruleId = typeof input.id === 'string' && input.id !== '' ? input.id : newId('R');
    const existing = await this.#store.readJson(`projects/${projectId}/rules/${ruleId}/index.json`, null);
    if (existing !== null) throw new AssistantError(ERROR_CODES.conflict, `规则 ID 已存在：${ruleId}`);
    const now = new Date().toISOString();
    const candidate = validateRule({
      ...input,
      id: ruleId,
      version: 1,
      projectId,
      status: input.status ?? 'draft',
      createdAt: now,
      createdBy: options.author ?? 'unknown',
    });
    const normalized = normalizeRule(candidate);
    const entry = {
      version: 1,
      name: normalized.name,
      kind: normalized.kind,
      status: normalized.status,
      fingerprint: fingerprintOf(normalized),
      createdAt: now,
    };
    return this.#writeVersion(projectId, normalized, {versions: []}, entry);
  }

  /**
   * Create a new version from a patch or full replacement.
   *
   * @param {string} projectId project id.
   * @param {string} ruleId rule id.
   * @param {object} patch changes applied over the current version.
   * @param {{author?: string, note?: string, expectedVersion?: number}} [options] options.
   * @returns {Promise<object>} new version.
   */
  async updateRule(projectId, ruleId, patch, options = {}) {
    await this.#requireProject(projectId);
    const index = await this.#readIndex(projectId, ruleId);
    if (options.expectedVersion !== undefined && options.expectedVersion !== index.currentVersion) {
      throw new AssistantError(ERROR_CODES.conflict, `规则已被修改：当前版本 v${index.currentVersion}，你编辑的是 v${options.expectedVersion}。请刷新后重试。`, {
        details: {currentVersion: index.currentVersion},
      });
    }
    const current = await this.getRule(projectId, ruleId);
    const now = new Date().toISOString();
    const merged = {
      ...current,
      ...patch,
      id: ruleId,
      projectId,
      version: index.currentVersion + 1,
      // Any content change returns the rule to draft: a confirmed rule must not
      // silently acquire new logic.
      status: patch.status ?? 'draft',
      updatedAt: now,
      createdAt: current.createdAt,
    };
    if (options.note !== undefined) merged.notes = String(options.note).slice(0, 4000);
    const validated = normalizeRule(validateRule(merged));
    const entry = {
      version: validated.version,
      name: validated.name,
      kind: validated.kind,
      status: validated.status,
      fingerprint: fingerprintOf(validated),
      createdAt: now,
      note: options.note ?? null,
    };
    return this.#writeVersion(projectId, validated, index, entry);
  }

  /**
   * Change only the lifecycle status (draft → pending → confirmed / disabled).
   *
   * @param {string} projectId project id.
   * @param {string} ruleId rule id.
   * @param {{status: string, expectedVersion?: number, author?: string, note?: string}} request status change.
   * @returns {Promise<object>} new version.
   */
  async setStatus(projectId, ruleId, request) {
    await this.#requireProject(projectId);
    if (!RULE_STATUSES.includes(request.status)) {
      throw new AssistantError(ERROR_CODES.invalidInput, `未知的规则状态：${request.status}`);
    }
    const index = await this.#readIndex(projectId, ruleId);
    if (request.expectedVersion !== undefined && request.expectedVersion !== index.currentVersion) {
      throw new AssistantError(ERROR_CODES.conflict, `规则已被修改：当前版本 v${index.currentVersion}。`, {details: {currentVersion: index.currentVersion}});
    }
    const current = await this.getRule(projectId, ruleId);
    const now = new Date().toISOString();
    const next = {
      ...current,
      version: index.currentVersion + 1,
      status: request.status,
      updatedAt: now,
      ...(request.status === 'confirmed' ? {confirmedAt: now, confirmedBy: request.author ?? 'unknown'} : {}),
    };
    const validated = normalizeRule(validateRule(next));
    const entry = {
      version: validated.version,
      name: validated.name,
      kind: validated.kind,
      status: validated.status,
      fingerprint: fingerprintOf(validated),
      createdAt: now,
      confirmedAt: validated.confirmedAt ?? null,
      note: request.note ?? null,
    };
    return this.#writeVersion(projectId, validated, index, entry);
  }
}
