/**
 * Route half of the AI database assistant plugin.
 *
 * This row owns HTTP parsing, bounds checking, and the trust fence only. Every
 * business decision lives in the service facade, which is also what the model
 * tools consume, so the workbench and the agent cannot drift apart.
 *
 * @module routes
 */
import {applyTableNames} from './src/services/templates.js';
import {AssistantError, ERROR_CODES, describeError} from './src/core/errors.js';
import {credentialRefForSource, isCredentialRef} from './src/core/credential-ref.js';

/** Cordis function-plugin name. */
export const name = 'ai-database-assistant-routes';
/** The server and the analysis service must exist before routes mount. */
export const inject = ['webServer', 'connection', 'aiDatabaseAssistant'];
/** Route prefix owned by this plugin. */
export const ROUTE_PREFIX = '/__ai-database-assistant';
/** Body ceiling: rule definitions are small; larger bodies are hostile. */
const MAX_BODY_BYTES = 8 * 1024 * 1024;

/**
 * Write one JSON response.
 *
 * @param {import('node:http').ServerResponse} res response.
 * @param {number} status HTTP status.
 * @param {unknown} payload body.
 */
function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(payload));
}

/**
 * Read a bounded UTF-8 body.
 *
 * @param {import('node:http').IncomingMessage} req request.
 * @param {number} limit byte ceiling.
 * @returns {Promise<string|null>} body text, or null past the ceiling.
 */
async function readBoundedBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.byteLength;
    if (size > limit) {
      req.resume();
      return null;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size).toString('utf8');
}

/**
 * Require a bounded string field.
 *
 * @param {unknown} value candidate.
 * @param {string} field field name for the error.
 * @param {number} [maxLength] maximum length.
 * @returns {string} value.
 */
function requireString(value, field, maxLength = 500) {
  if (typeof value !== 'string' || value.trim() === '') throw new AssistantError('invalid-input', `缺少参数：${field}`);
  if (value.length > maxLength) throw new AssistantError('invalid-input', `参数过长：${field}`);
  return value;
}

/**
 * Optional bounded string.
 *
 * @param {unknown} value candidate.
 * @param {string} field field name.
 * @param {number} [maxLength] maximum length.
 * @returns {string|undefined} value.
 */
function optionalString(value, field, maxLength = 500) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new AssistantError('invalid-input', `参数类型错误：${field}`);
  if (value.length > maxLength) throw new AssistantError('invalid-input', `参数过长：${field}`);
  return value;
}

/**
 * Optional bounded integer.
 *
 * @param {unknown} value candidate.
 * @param {string} field field name.
 * @returns {number|undefined} value.
 */
function optionalInteger(value, field) {
  if (value === undefined || value === null || value === '') return undefined;
  // Number(true) === 1 and Number([]) === 0 used to pass; only a JSON number
  // or a plain integer string is accepted.
  const number = typeof value === 'number'
    ? value
    : (typeof value === 'string' && /^-?\d+$/.test(value) ? Number(value) : Number.NaN);
  if (!Number.isInteger(number)) throw new AssistantError('invalid-input', `参数必须是整数：${field}`);
  return number;
}

/**
 * Build the action table.
 *
 * @param {object} service analysis service facade.
 * @param {object} ctx plugin context.
 * @returns {Record<string, (body: object) => Promise<unknown>>} actions.
 */
function createActions(service, ctx) {
  // Resolve per request: at plugin-apply time the credentials service may not be
  // provided yet, and a captured `undefined` would make every password lookup
  // fail with "宿主凭据服务不可用" even though the service is live.
  const credentials = () => ctx.get('credentials');
  return {
    /** Workbench bootstrap: projects, sources, rules, runs, templates. */
    async overview(body) {
      return service.overview({
        projectId: optionalString(body.projectId, 'projectId', 100),
        sessionId: optionalString(body.sessionId, 'sessionId', 200),
        noProject: body.noProject === true,
      });
    },

    async 'project.create'(body) {
      return service.projects.createProject({name: requireString(body.name, 'name', 120), description: optionalString(body.description, 'description', 2000)});
    },
    async 'project.update'(body) {
      return service.projects.updateProject(requireString(body.projectId, 'projectId', 100), {
        name: optionalString(body.name, 'name', 120),
        // Pass an explicitly empty description through: mapping '' to undefined
        // made "clear the description" a silent no-op.
        description: typeof body.description === 'string' ? body.description.slice(0, 2000) : undefined,
      });
    },
    async 'project.delete'(body) {
      if (body.confirm !== true) throw new AssistantError('invalid-input', '删除项目需要二次确认（confirm: true）。');
      const projectId = requireString(body.projectId, 'projectId', 100);
      const deleted = await service.projects.deleteProject(projectId);
      // Release the credentials this project owned when no other project still
      // references them; deleting a project must not leave database passwords
      // in the credential store forever.
      const refs = Array.isArray(deleted.passwordRefs) ? deleted.passwordRefs : [];
      if (refs.length > 0) {
        const inUse = await service.projects.credentialRefsInUse();
        const credentialService = credentials();
        if (credentialService !== undefined && typeof credentialService.unset === 'function') {
          for (const ref of refs) {
            if (inUse.has(ref) || !ref.startsWith('ai_database_assistant_') || !isCredentialRef(ref)) continue;
            await credentialService.unset(ref).catch(() => {});
          }
        }
      }
      return {deleted: deleted.deleted, retainedData: deleted.retainedData};
    },
    async 'project.bind'(body) {
      return service.projects.bindSession(requireString(body.sessionId, 'sessionId', 200), requireString(body.projectId, 'projectId', 100));
    },
    async 'project.unbind'(body) {
      return service.projects.unbindSession(requireString(body.sessionId, 'sessionId', 200));
    },

    async 'source.list'(body) {
      return service.projects.listSources(requireString(body.projectId, 'projectId', 100));
    },
    async 'source.create'(body) {
      return service.projects.createDatabaseSource(requireString(body.projectId, 'projectId', 100), body.source ?? {});
    },
    async 'source.update'(body) {
      const projectId = requireString(body.projectId, 'projectId', 100);
      const sourceId = requireString(body.sourceId, 'sourceId', 100);
      const previous = await service.projects.requireSource(projectId, sourceId);
      const updated = await service.projects.updateSource(projectId, sourceId, body.patch ?? {});
      // Replacing the plugin-owned credential reference must release the old
      // secret once no source uses the reference any more.
      const oldRef = previous.passwordRef;
      const newRef = updated.passwordRef;
      if (typeof oldRef === 'string' && oldRef !== newRef && oldRef.startsWith('ai_database_assistant_') && isCredentialRef(oldRef)) {
        const inUse = await service.projects.credentialRefsInUse();
        const credentialService = credentials();
        if (!inUse.has(oldRef) && credentialService !== undefined && typeof credentialService.unset === 'function') {
          await credentialService.unset(oldRef).catch(() => {});
        }
      }
      return updated;
    },
    async 'source.copy-candidates'(body) {
      return service.projects.listCopyCandidates(requireString(body.projectId, 'projectId', 100));
    },
    async 'source.copy'(body) {
      return service.projects.copySource(
        requireString(body.projectId, 'projectId', 100),
        requireString(body.fromProjectId, 'fromProjectId', 100),
        requireString(body.sourceId, 'sourceId', 100),
      );
    },
    async 'source.delete'(body) {
      if (body.confirm !== true) throw new AssistantError('invalid-input', '删除数据源需要二次确认（confirm: true）。');
      const projectId = requireString(body.projectId, 'projectId', 100);
      const sourceId = requireString(body.sourceId, 'sourceId', 100);
      const source = await service.projects.requireSource(projectId, sourceId);
      const ref = source.passwordRef;
      const deleted = await service.projects.deleteSource(projectId, sourceId);
      // A copied source shares the reference; only drop the secret when no
      // remaining source (in any project) still points at the reference.
      if (typeof ref === 'string' && ref.startsWith('ai_database_assistant_') && isCredentialRef(ref)) {
        const inUse = await service.projects.credentialRefsInUse();
        const credentialService = credentials();
        if (!inUse.has(ref) && credentialService !== undefined && typeof credentialService.unset === 'function') {
          await credentialService.unset(ref).catch(() => {});
        }
      }
      return deleted;
    },
    async 'source.test'(body) {
      return service.projects.testSource(requireString(body.projectId, 'projectId', 100), requireString(body.sourceId, 'sourceId', 100), {
        credentials: credentials(),
        password: optionalString(body.password, 'password', 1000),
      });
    },
    async 'source.password'(body) {
      const projectId = requireString(body.projectId, 'projectId', 100);
      const sourceId = requireString(body.sourceId, 'sourceId', 100);
      const password = requireString(body.password, 'password', 1000);
      const source = await service.projects.requireSource(projectId, sourceId);
      const credentialService = credentials();
      if (credentialService === undefined || credentialService === null || typeof credentialService.set !== 'function') {
        throw new AssistantError(ERROR_CODES.internal, 'DSH 凭据服务不可用，无法保存密码。');
      }
      const ref = credentialRefForSource(source.id);
      if (!isCredentialRef(ref)) throw new AssistantError(ERROR_CODES.internal, '生成的凭据引用不符合 DSH 命名规则。');
      await credentialService.set(ref, password);
      const saved = await service.projects.updateSource(projectId, sourceId, {passwordRef: ref});
      return {saved: true, passwordRef: saved.passwordRef ?? ref};
    },
    async 'source.import'(body) {
      return service.projects.importFileSource(requireString(body.projectId, 'projectId', 100), {
        path: requireString(body.path, 'path', 2000),
        name: optionalString(body.name, 'name', 200),
        sheet: optionalString(body.sheet, 'sheet', 100),
      });
    },
    async 'source.inspect'(body) {
      return service.projects.inspectCatalog(requireString(body.projectId, 'projectId', 100), requireString(body.sourceId, 'sourceId', 100), {
        refresh: body.refresh === true,
        credentials: credentials(),
      });
    },
    async 'source.describe'(body) {
      return service.projects.describeTable(requireString(body.projectId, 'projectId', 100), requireString(body.sourceId, 'sourceId', 100), {
        table: requireString(body.table, 'table', 200),
        schema: optionalString(body.schema, 'schema', 200),
        credentials: credentials(),
      });
    },
    async 'catalog.search'(body) {
      return service.projects.searchCatalog(requireString(body.projectId, 'projectId', 100), {
        query: requireString(body.query, 'query', 200),
        sourceId: optionalString(body.sourceId, 'sourceId', 100),
        limit: optionalInteger(body.limit, 'limit'),
      });
    },

    async 'draft.list'(body) {
      return service.drafts.list(requireString(body.projectId, 'projectId', 100));
    },
    async 'draft.get'(body) {
      return service.drafts.get(requireString(body.projectId, 'projectId', 100), requireString(body.draftId, 'draftId', 100));
    },
    async 'draft.import'(body) {
      return service.drafts.import(
        requireString(body.projectId, 'projectId', 100),
        requireString(body.draftId, 'draftId', 100),
        {credentials: credentials(), sessionId: optionalString(body.sessionId, 'sessionId', 200)},
      );
    },
    async 'draft.discard'(body) {
      return service.drafts.discard(requireString(body.projectId, 'projectId', 100), requireString(body.draftId, 'draftId', 100));
    },
    async 'rule.list'(body) {
      return service.rules.listRules(requireString(body.projectId, 'projectId', 100));
    },
    async 'rule.get'(body) {
      return service.rules.getRule(requireString(body.projectId, 'projectId', 100), requireString(body.ruleId, 'ruleId', 100), optionalInteger(body.version, 'version'));
    },
    async 'rule.versions'(body) {
      return service.rules.listVersions(requireString(body.projectId, 'projectId', 100), requireString(body.ruleId, 'ruleId', 100));
    },
    async 'rule.create'(body) {
      return service.rules.createRule(requireString(body.projectId, 'projectId', 100), body.rule ?? {}, {author: optionalString(body.author, 'author', 100)});
    },
    async 'rule.update'(body) {
      return service.rules.updateRule(
        requireString(body.projectId, 'projectId', 100),
        requireString(body.ruleId, 'ruleId', 100),
        body.patch ?? {},
        {author: optionalString(body.author, 'author', 100), note: optionalString(body.note, 'note', 4000), expectedVersion: optionalInteger(body.expectedVersion, 'expectedVersion')},
      );
    },
    async 'rule.status'(body) {
      return service.rules.setStatus(requireString(body.projectId, 'projectId', 100), requireString(body.ruleId, 'ruleId', 100), {
        status: requireString(body.status, 'status', 30),
        expectedVersion: optionalInteger(body.expectedVersion, 'expectedVersion'),
        author: optionalString(body.author, 'author', 100),
        note: optionalString(body.note, 'note', 4000),
      });
    },
    async 'rule.preview'(body) {
      return service.previewRule(requireString(body.projectId, 'projectId', 100), body.rule ?? {});
    },
    async 'plan.list'(body) {
      return service.plans.list({includeDisabled: body.includeDisabled === true});
    },
    async 'plan.get'(body) {
      return service.plans.get(requireString(body.planId, 'planId', 100));
    },
    async 'plan.apply'(body) {
      return service.plans.apply(requireString(body.projectId, 'projectId', 100), requireString(body.planId, 'planId', 100), {
        leftSourceId: requireString(body.leftSourceId, 'leftSourceId', 100),
        rightSourceId: optionalString(body.rightSourceId, 'rightSourceId', 100),
        values: body.values === undefined || body.values === null ? {} : body.values,
        author: optionalString(body.author, 'author', 100),
      });
    },
    async 'plan.save'(body) {
      return service.plans.save({
        name: requireString(body.name, 'name', 120),
        category: optionalString(body.category, 'category', 100),
        description: optionalString(body.description, 'description', 1000),
        templateId: requireString(body.templateId, 'templateId', 100),
        values: body.values === undefined || body.values === null ? {} : body.values,
      });
    },
    async 'plan.update'(body) {
      return service.plans.update(requireString(body.planId, 'planId', 100), {
        name: optionalString(body.name, 'name', 120),
        description: optionalString(body.description, 'description', 1000),
        values: body.values === undefined ? undefined : body.values,
        status: body.status === 'disabled' || body.status === 'active' ? body.status : undefined,
      });
    },
    async 'plan.copy'(body) {
      return service.plans.copy(requireString(body.planId, 'planId', 100), optionalString(body.name, 'name', 120));
    },
    async 'template.apply'(body) {
      const template = service.templateById(requireString(body.templateId, 'templateId', 100));
      if (template === undefined) throw new AssistantError('not-found', `模板不存在：${body.templateId}`);
      const values = body.values ?? {};
      // Templates carry no table names; the user's parameters supply them.
      const drafts = applyTableNames(template.build(values, {
        projectId: requireString(body.projectId, 'projectId', 100),
        leftSourceId: requireString(body.leftSourceId, 'leftSourceId', 100),
        rightSourceId: optionalString(body.rightSourceId, 'rightSourceId', 100) ?? '',
      }), values);
      const created = [];
      for (const rule of drafts) created.push(await service.rules.createRule(body.projectId, {...rule, status: 'draft'}, {author: optionalString(body.author, 'author', 100)}));
      return created;
    },

    async 'run.start'(body) {
      const handle = await service.tasks.startRun(
        requireString(body.projectId, 'projectId', 100),
        {
          ruleId: requireString(body.ruleId, 'ruleId', 100),
          ruleVersion: optionalInteger(body.ruleVersion, 'ruleVersion'),
          allowUnconfirmed: body.allowUnconfirmed === true,
          name: optionalString(body.name, 'name', 200),
        },
        {sessionId: optionalString(body.sessionId, 'sessionId', 200), credentials: credentials()},
      );
      return {runId: handle.runId};
    },
    async 'assistant.query'(body) {
      return service.assistant.query(requireString(body.projectId, 'projectId', 100), {
        sql: requireString(body.sql, 'sql', 20000),
        mode: body.mode === 'explore' ? 'explore' : 'final',
        sourceId: optionalString(body.sourceId, 'sourceId', 100),
        purpose: optionalString(body.purpose, 'purpose', 500),
        baseName: optionalString(body.baseName, 'baseName', 120),
      }, {credentials: credentials(), sessionId: optionalString(body.sessionId, 'sessionId', 200)});
    },
    async 'assistant.results'(body) {
      const projectId = requireString(body.projectId, 'projectId', 100);
      if (body.page !== undefined) {
        return service.assistant.listResultsPage(projectId, {
          page: optionalInteger(body.page, 'page') ?? 1,
          pageSize: optionalInteger(body.pageSize, 'pageSize') ?? 10,
        });
      }
      return service.assistant.listResults(projectId, {limit: optionalInteger(body.limit, 'limit') ?? 20});
    },
    async 'assistant.result'(body) {
      return service.assistant.getResult(requireString(body.projectId, 'projectId', 100), requireString(body.resultId, 'resultId', 100));
    },
    async 'assistant.export'(body) {
      if (body.overwrite === true && body.confirm !== true) {
        throw new AssistantError('invalid-input', '覆盖已有导出文件需要二次确认（confirm: true）。');
      }
      return service.assistant.exportResult(
        requireString(body.projectId, 'projectId', 100),
        requireString(body.resultId, 'resultId', 100),
        {
          baseName: optionalString(body.baseName, 'baseName', 120),
          directory: optionalString(body.directory, 'directory', 1000),
          formats: Array.isArray(body.formats) ? body.formats.map((entry) => requireString(entry, 'formats', 10)) : undefined,
          overwrite: body.overwrite === true,
          sessionId: optionalString(body.sessionId, 'sessionId', 200),
        },
      );
    },
    async 'assistant.set-output'(body) {
      return service.assistant.setOutputDir(requireString(body.projectId, 'projectId', 100), requireString(body.directory, 'directory', 1000));
    },
    async 'assistant.harden-results'(body) {
      return service.assistant.hardenPermissions(optionalString(body.projectId, 'projectId', 100) ?? null);
    },
    async 'assistant.clear-results'(body) {
      if (body.confirm !== true) throw new AssistantError('invalid-input', '清理历史结果需要二次确认（confirm: true）。');
      return service.assistant.clearResults(requireString(body.projectId, 'projectId', 100), {
        keep: optionalInteger(body.keep, 'keep') ?? 10,
      });
    },
    async 'run.start-group'(body) {
      const ruleIds = Array.isArray(body.ruleIds) ? body.ruleIds.map((id) => requireString(id, 'ruleIds', 100)) : null;
      if (ruleIds === null) throw new AssistantError('invalid-input', '缺少参数：ruleIds');
      return service.tasks.startGroup(requireString(body.projectId, 'projectId', 100), {
        ruleIds,
        name: optionalString(body.name, 'name', 200),
      }, {sessionId: optionalString(body.sessionId, 'sessionId', 200), credentials: credentials()});
    },
    async 'run.group-list'(body) {
      return service.tasks.listGroups(requireString(body.projectId, 'projectId', 100));
    },
    async 'run.group-get'(body) {
      return service.tasks.getGroup(requireString(body.projectId, 'projectId', 100), requireString(body.groupId, 'groupId', 100));
    },
    async 'run.group-cancel'(body) {
      return service.tasks.cancelGroup(requireString(body.projectId, 'projectId', 100), requireString(body.groupId, 'groupId', 100));
    },
    async 'run.list'(body) {
      return service.tasks.listRuns(requireString(body.projectId, 'projectId', 100), {limit: optionalInteger(body.limit, 'limit')});
    },
    async 'run.get'(body) {
      const projectId = requireString(body.projectId, 'projectId', 100);
      const runId = requireString(body.runId, 'runId', 100);
      const [run, counts] = await Promise.all([service.tasks.getRun(projectId, runId), service.tasks.reviewCounts(projectId, runId)]);
      return {...run, reviewed: counts};
    },
    async 'run.cancel'(body) {
      return service.tasks.cancelRun(requireString(body.projectId, 'projectId', 100), requireString(body.runId, 'runId', 100));
    },
    async 'run.exceptions'(body) {
      return service.tasks.listExceptions(requireString(body.projectId, 'projectId', 100), requireString(body.runId, 'runId', 100), {
        cursor: optionalInteger(body.cursor, 'cursor'),
        pageSize: optionalInteger(body.pageSize, 'pageSize'),
        reviewStatus: optionalString(body.reviewStatus, 'reviewStatus', 30),
        kind: optionalString(body.kind, 'kind', 60),
        query: optionalString(body.query, 'query', 200),
      });
    },
    async 'run.review'(body) {
      return service.tasks.reviewException(
        requireString(body.projectId, 'projectId', 100),
        requireString(body.runId, 'runId', 100),
        requireString(body.exceptionId, 'exceptionId', 100),
        {status: requireString(body.status, 'status', 30), note: optionalString(body.note, 'note', 4000), by: requireString(body.by, 'by', 100)},
      );
    },
    async 'run.reviews'(body) {
      return service.tasks.reviewsOf(requireString(body.projectId, 'projectId', 100), requireString(body.runId, 'runId', 100));
    },

    async 'evidence.export'(body) {
      return service.exportEvidence(requireString(body.projectId, 'projectId', 100), requireString(body.runId, 'runId', 100), {credentials: credentials()});
    },
    async 'evidence.export-group'(body) {
      return service.exportGroupEvidence(
        requireString(body.projectId, 'projectId', 100),
        requireString(body.groupId, 'groupId', 100),
        {credentials: credentials()},
      );
    },
    async 'report.export'(body) {
      const format = requireString(body.format, 'format', 20);
      const outputDir = optionalString(body.outputDir, 'outputDir', 2000) ?? service.config.reportRoot;
      if (typeof outputDir !== 'string') throw new AssistantError('internal', '报告输出目录未配置。');
      return service.exportReport(requireString(body.projectId, 'projectId', 100), requireString(body.runId, 'runId', 100), format, outputDir);
    },
  };
}

/**
 * Mount the routes.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx plugin context.
 */
/** Actions that remain part of the current assistant surface. */
export const ACTIVE_ACTIONS = Object.freeze(new Set([
  'overview',
  'project.create', 'project.update', 'project.delete', 'project.bind', 'project.unbind',
  'source.list', 'source.create', 'source.update', 'source.delete', 'source.test', 'source.password', 'source.inspect', 'source.describe', 'source.copy-candidates', 'source.copy',
  'assistant.query', 'assistant.results', 'assistant.result', 'assistant.export', 'assistant.set-output', 'assistant.clear-results', 'assistant.harden-results',
]));

export function apply(ctx) {
  const service = ctx.get('aiDatabaseAssistant');
  if (service === undefined || service === null) {
    ctx.logger.warn('ai-database-assistant-routes: aiDatabaseAssistant service is absent; routes not mounted');
    return;
  }
  const actions = createActions(service, ctx);
  ctx.effect(
    () => {
      const disposers = [];
      for (const [action, handler] of Object.entries(actions)) {
        // Retired analysis actions stay in source for rollback but are not mounted;
        // the browser must not be able to call rule/run/plan/evidence APIs.
        if (!ACTIVE_ACTIONS.has(action)) continue;
        disposers.push(
          ctx.webServer.register({
            kind: 'exact',
            path: `${ROUTE_PREFIX}/${action}`,
            handler: (req, res) => serve(ctx, action, handler, req, res),
          }),
        );
      }
      return () => {
        for (const dispose of disposers) dispose();
      };
    },
    'ai-database-assistant: local JSON API',
  );
  ctx.logger.info(`ai-database-assistant: local API mounted at ${ROUTE_PREFIX}/*`);
}

/**
 * Serve one action behind the trust fence.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx plugin context.
 * @param {string} action action name.
 * @param {(body: object) => Promise<unknown>} handler business handler.
 * @param {import('node:http').IncomingMessage} req request.
 * @param {import('node:http').ServerResponse} res response.
 * @returns {Promise<void>} resolves after the response ends.
 */
async function serve(ctx, action, handler, req, res) {
  try {
    const connection = ctx.get('connection');
    // Fail closed: without the Host trust fence every action (including
    // source.password and project.delete) would be callable by any local page.
    // The official DSH plugin contract declares `connection`, so a missing
    // service means the profile is misconfigured, not that requests are trusted.
    if (connection === undefined || connection === null || typeof connection.requestRejection !== 'function') {
      sendJson(res, 503, {ok: false, code: 'host-unavailable', message: '宿主连接服务不可用，已拒绝请求。'});
      return;
    }
    const rejection = connection.requestRejection(req);
    if (typeof rejection === 'number') {
      res.statusCode = rejection;
      res.end();
      return;
    }
    if (req.method !== 'POST') {
      res.statusCode = 405;
      res.setHeader('allow', 'POST');
      res.end();
      return;
    }
    const mediaType = String(req.headers['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase();
    if (mediaType !== 'application/json') {
      sendJson(res, 415, {ok: false, code: 'unsupported-media', message: '请求必须使用 application/json。'});
      return;
    }
    const raw = await readBoundedBody(req, MAX_BODY_BYTES);
    if (raw === null) {
      sendJson(res, 413, {ok: false, code: 'body-too-large', message: '请求内容过大。'});
      return;
    }
    let body = {};
    if (raw.trim() !== '') {
      try {
        body = JSON.parse(raw);
      } catch {
        sendJson(res, 400, {ok: false, code: 'invalid-json', message: '请求 JSON 无法解析。'});
        return;
      }
    }
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      sendJson(res, 400, {ok: false, code: 'invalid-json', message: '请求必须是 JSON 对象。'});
      return;
    }
    const result = await handler(body);
    sendJson(res, 200, {ok: true, result});
  } catch (error) {
    const {code, message} = describeError(error);
    if (error instanceof AssistantError) {
      sendJson(res, 200, {ok: false, code, message, details: error.details});
      return;
    }
    ctx.logger.warn(`ai-database-assistant: ${action} failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    sendJson(res, 500, {ok: false, code, message});
  }
}
