/**
 * Analysis plan library.
 *
 * A plan is *not* a rule and *not* a run: the plan is a reusable, versioned recipe
 * (template + parameter values) that produces ordinary draft rules in a
 * project. Rules stay the unit of execution; plans only carry analysis logic.
 *
 * Built-in plans are the four shipped templates and are protected: they can be
 * applied or copied, never edited in place. Custom plans live in
 * `$DSH_HOME/ai-database-assistant/plans.json`.
 *
 * @module src/services/plans
 */
import {createHash, randomBytes} from 'node:crypto';

import {AssistantError, ERROR_CODES} from '../core/errors.js';
import {TEMPLATES, TEMPLATE_BY_ID, applyTableNames} from './templates.js';

/** Current plan schema version. */
export const PLAN_SCHEMA_VERSION = 1;

const BUILTIN = TEMPLATES.map((template) => ({
  id: `plan-${template.id}`,
  version: 1,
  schemaVersion: PLAN_SCHEMA_VERSION,
  name: template.name,
  category: template.scenario,
  description: template.description,
  templateId: template.id,
  values: {},
  source: 'builtin',
  protected: true,
  status: 'active',
  createdAt: null,
  updatedAt: null,
  history: [],
}));

/** Plan service. */
export class PlanService {
  /** @type {object} */
  #store;
  /** @type {object} */
  #rules;
  /** @type {object} */
  #projects;
  /** @type {object} */
  #logger;

  /**
   * @param {{store: object, rules: object, projects: object, logger?: object}} options composition.
   */
  constructor(options) {
    this.#store = options.store;
    this.#rules = options.rules;
    this.#projects = options.projects;
    this.#logger = options.logger ?? {};
  }

  /** @returns {Promise<object[]>} stored custom plans. */
  async #read() {
    const state = await this.#store.readJson('plans.json', {plans: []});
    return Array.isArray(state.plans) ? state.plans : [];
  }

  /** @param {object[]} plans custom plans. @returns {Promise<void>} */
  async #write(plans) {
    await this.#store.writeJson('plans.json', {plans: plans.slice(-200)});
  }

  /**
   * List built-in and custom plans.
   *
   * @param {{includeDisabled?: boolean}} [options] options.
   * @returns {Promise<object[]>} plans.
   */
  async list(options = {}) {
    const customs = await this.#read();
    const all = [...BUILTIN, ...customs.map(publicPlan)];
    return all.filter((plan) => options.includeDisabled === true || plan.status === 'active');
  }

  /**
   * Read one plan.
   *
   * @param {string} planId plan id.
   * @returns {Promise<object>} plan.
   */
  async get(planId) {
    const builtin = BUILTIN.find((plan) => plan.id === planId);
    if (builtin !== undefined) return publicPlan(builtin);
    const custom = (await this.#read()).find((plan) => plan.id === planId);
    if (custom === undefined) throw new AssistantError(ERROR_CODES.notFound, `核对方案不存在：${planId}`);
    return publicPlan(custom);
  }

  /**
   * Save a new custom plan (or a copy of a built-in).
   *
   * @param {{name: string, category?: string, description?: string, templateId: string, values?: object}} input plan input.
   * @returns {Promise<object>} created plan.
   */
  async save(input) {
    const template = TEMPLATE_BY_ID.get(input.templateId);
    if (template === undefined) throw new AssistantError(ERROR_CODES.invalidInput, `模板不存在：${input.templateId}`);
    const name = typeof input.name === 'string' && input.name.trim() !== '' ? input.name.trim() : `${template.name}（自定义）`;
    const now = new Date().toISOString();
    const plan = {
      id: `PLAN-${randomBytes(4).toString('hex')}`,
      version: 1,
      schemaVersion: PLAN_SCHEMA_VERSION,
      name,
      category: typeof input.category === 'string' && input.category !== '' ? input.category : template.scenario,
      description: typeof input.description === 'string' ? input.description : template.description,
      templateId: input.templateId,
      values: sanitizeValues(input.values),
      source: 'custom',
      protected: false,
      status: 'active',
      createdAt: now,
      updatedAt: now,
      history: [],
    };
    const plans = await this.#read();
    plans.push(plan);
    await this.#write(plans);
    return publicPlan(plan);
  }

  /**
   * Update a custom plan; every edit creates a new version and keeps history.
   *
   * @param {string} planId plan id.
   * @param {{name?: string, description?: string, values?: object, status?: string}} patch patch.
   * @returns {Promise<object>} updated plan.
   */
  async update(planId, patch) {
    if (BUILTIN.some((plan) => plan.id === planId)) {
      throw new AssistantError(ERROR_CODES.forbidden, '预置方案受保护，请复制为自定义方案后再修改。');
    }
    const plans = await this.#read();
    const plan = plans.find((entry) => entry.id === planId);
    if (plan === undefined) throw new AssistantError(ERROR_CODES.notFound, `核对方案不存在：${planId}`);
    if (plan.protected === true) throw new AssistantError(ERROR_CODES.forbidden, '预置方案受保护，请复制后再修改。');
    plan.history.push({version: plan.version, name: plan.name, description: plan.description, values: plan.values, updatedAt: plan.updatedAt});
    plan.version += 1;
    if (typeof patch.name === 'string' && patch.name.trim() !== '') plan.name = patch.name.trim();
    if (typeof patch.description === 'string') plan.description = patch.description;
    if (patch.values !== undefined) plan.values = sanitizeValues(patch.values);
    if (patch.status === 'disabled' || patch.status === 'active') plan.status = patch.status;
    plan.updatedAt = new Date().toISOString();
    await this.#write(plans);
    return publicPlan(plan);
  }

  /**
   * Copy any plan into a new custom plan.
   *
   * @param {string} planId plan id.
   * @param {string} [name] new name.
   * @returns {Promise<object>} copied plan.
   */
  async copy(planId, name) {
    const source = await this.get(planId);
    return this.save({
      name: typeof name === 'string' && name.trim() !== '' ? name.trim() : `${source.name}（副本）`,
      category: source.category,
      description: source.description,
      templateId: source.templateId,
      values: source.values,
    });
  }

  /**
   * Apply a plan to a project: build parameterised rule drafts.
   *
   * Cross-project reuse never carries records, credentials or confirmations: the
   * caller must supply the target project's sources and confirm the drafts.
   *
   * @param {string} projectId target project id.
   * @param {string} planId plan id.
   * @param {{leftSourceId: string, rightSourceId?: string, values?: object, author?: string}} request apply request.
   * @returns {Promise<{plan: object, rules: object[], drafts: object[]}>} generated rules.
   */
  async apply(projectId, planId, request) {
    const plan = await this.get(planId);
    await this.#projects.requireProject(projectId);
    const template = TEMPLATE_BY_ID.get(plan.templateId);
    if (template === undefined) throw new AssistantError(ERROR_CODES.conflict, `方案引用的模板不存在：${plan.templateId}`);
    const values = {...plan.values, ...(sanitizeValues(request.values) ?? {})};
    const candidates = applyTableNames(template.build(values, {
      projectId,
      leftSourceId: request.leftSourceId,
      rightSourceId: request.rightSourceId ?? '',
    }), values);
    const drafts = [];
    for (const candidate of candidates) {
      const created = await this.#rules.createRule(projectId, {...candidate, name: candidate.name, status: 'draft'}, {author: request.author ?? 'plan'});
      drafts.push(created);
    }
    return {plan: publicPlan(plan), rules: drafts};
  }
}

/**
 * Keep only string parameter values; plan files never hold credentials.
 *
 * @param {object|undefined} values raw values.
 * @returns {Record<string, string>} sanitized values.
 */
function sanitizeValues(values) {
  if (values === null || typeof values !== 'object') return {};
  const output = {};
  for (const [key, value] of Object.entries(values)) {
    if (typeof value === 'string') output[key] = value.slice(0, 500);
  }
  return output;
}

/**
 * Public plan shape (no storage internals).
 *
 * @param {object} plan plan.
 * @returns {object} public copy.
 */
function publicPlan(plan) {
  return {
    id: plan.id,
    version: plan.version,
    schemaVersion: plan.schemaVersion,
    name: plan.name,
    category: plan.category,
    description: plan.description,
    templateId: plan.templateId,
    values: {...plan.values},
    source: plan.source,
    protected: plan.protected === true,
    status: plan.status,
    createdAt: plan.createdAt ?? null,
    updatedAt: plan.updatedAt ?? null,
    historyCount: Array.isArray(plan.history) ? plan.history.length : 0,
  };
}

/**
 * Stable hash of a plan definition, used for provenance.
 *
 * @param {object} plan plan.
 * @returns {string} sha256 hex.
 */
export function fingerprintPlan(plan) {
  return createHash('sha256').update(JSON.stringify({
    name: plan.name, templateId: plan.templateId, values: plan.values, version: plan.version,
  })).digest('hex');
}
