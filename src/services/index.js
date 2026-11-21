/**
 * Service facade.
 *
 * The routes layer and the tool layer both consume exactly this object, which
 * keeps HTTP serialization and model-facing summaries from growing their own
 * business logic.
 *
 * @module src/services/index
 */
import {createHash} from 'node:crypto';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';

import {AssistantError, ERROR_CODES} from '../core/errors.js';
import {isPathInside} from '../core/user-path.js';
import {deriveRunStatus} from '../engine/status.js';
import {createEvidencePack, verifyPack} from '../export/evidence.js';
import {exceptionColumns, exceptionRows, renderHtmlReport, renderMarkdownDraft, toCsv} from '../export/report.js';
import {pageSql} from '../engine/dataset.js';
import {normalizeRule, validateRule} from '../core/rule-schema.js';
import {AssistantService} from './assistant.js';
import {DraftService} from './drafts.js';
import {PlanService} from './plans.js';
import {ProjectService} from './projects.js';
import {RuleService} from './rules.js';
import {RUN_STATUS_LABELS, REVIEW_STATUS_LABELS, TaskService} from './tasks.js';
import {TEMPLATES, TEMPLATE_BY_ID} from './templates.js';

/**
 * Compose the analysis services.
 *
 * @param {{
 *   store: object, runner?: object, logger?: object,
 *   config?: {evidenceRoot?: string, maxExceptions?: number, maxRowsPerSource?: number},
 * }} options composition options.
 * @returns {object} analysis service facade.
 */
export function createAssistantService(options) {
  const {store, runner, logger} = options;
  const config = options.config ?? {};
  const projects = new ProjectService({store, runner, logger});
  const rules = new RuleService({store, requireProject: (projectId) => projects.requireProject(projectId)});
  const drafts = new DraftService({store, projects, runner, logger});
  const plans = new PlanService({store, rules, projects, logger});
  const assistant = new AssistantService({store, projects, runner, logger, config});
  const tasks = new TaskService({
    store,
    rules,
    projects,
    runner,
    logger,
    limits: {maxExceptions: config.maxExceptions, maxRowsPerSource: config.maxRowsPerSource},
  });

  /**
   * Build the workbench overview for one session/project.
   *
   * @param {{projectId?: string, sessionId?: string}} request request.
   * @returns {Promise<object>} overview.
   */
  async function overview(request = {}) {
    const allProjects = await projects.listProjects();
    const binding = request.sessionId === undefined ? null : await projects.bindingOf(request.sessionId);
    // Explicit "no project" must not fall back to the bound/default project.
    const projectId = request.noProject === true
      ? null
      : (request.projectId ?? binding?.projectId ?? allProjects[0]?.id);
    const project = projectId === undefined ? null : allProjects.find((entry) => entry.id === projectId) ?? null;
    if (project === null) {
      return {
        projects: allProjects,
        project: null,
        binding,
        sources: [],
        rules: [],
        runs: [],
        templates: TEMPLATES.map(publicTemplate),
        drafts: [],
        groups: [],
        plans: await plans.list(),
        assistant: {outputDir: null, suggestedOutputDir: await assistant.suggestOutputDir(), results: []},
        dialects: projects.dialectMenu(),
        reviewLabels: REVIEW_STATUS_LABELS,
        runLabels: RUN_STATUS_LABELS,
      };
    }
    await tasks.repairInterruptedRuns(project.id);
    const [sources, ruleList, runs] = await Promise.all([
      projects.listSources(project.id),
      rules.listRules(project.id),
      tasks.listRuns(project.id, {limit: 30}),
    ]);
    return {
      projects: allProjects,
      project,
      binding,
      sources,
      rules: ruleList,
      runs: runs.map((run) => ({...run, statusLabel: RUN_STATUS_LABELS[run.status] ?? run.status})),
      templates: TEMPLATES.map(publicTemplate),
      drafts: await drafts.list(project.id),
      groups: await tasks.listGroups(project.id),
      plans: await plans.list(),
      assistant: {
        outputDir: await assistant.outputDirOf(project.id),
        // A Host-computed hint only: nothing is created, saved or overwritten.
        suggestedOutputDir: await assistant.suggestOutputDir(),
        results: await assistant.listResults(project.id, {limit: 10}),
      },
      dialects: projects.dialectMenu(),
      reviewLabels: REVIEW_STATUS_LABELS,
      runLabels: RUN_STATUS_LABELS,
    };
  }

  /**
   * Build a controlled SQL preview for a rule without executing the rule.
   *
   * @param {string} projectId project id.
   * @param {object} ruleInput rule input.
   * @returns {Promise<object>} preview.
   */
  async function previewRule(projectId, ruleInput) {
    const rule = normalizeRule(validateRule({projectId, ...ruleInput}));
    const blocks = [];
    for (const [side, spec] of [['left', rule.left], ['right', rule.right]]) {
      if (spec === undefined || spec === null) continue;
      const source = await projects.requireSource(projectId, spec.sourceId);
      if (source.kind === 'file') {
        blocks.push({
          side,
          sourceId: source.id,
          sourceName: source.name,
          kind: 'file',
          sql: null,
          note: `读取文件数据源 ${source.name}（${source.rowCount ?? '?'} 行，${(source.columns ?? []).length} 列）`,
        });
        continue;
      }
      if (spec.dataset.kind === 'sql') {
        blocks.push({side, sourceId: source.id, sourceName: source.name, kind: 'sql', sql: spec.dataset.sql, note: '自定义只读 SQL（执行前会再次做只读校验）'});
        continue;
      }
      const orderColumns = spec.dataset.orderBy ?? (rule.key?.pairs ?? []).map((pair) => (side === 'left' ? pair.left : pair.right ?? pair.left));
      const sql = pageSql(source.dialect, {...spec.dataset, schema: spec.dataset.schema ?? source.schema}, orderColumns, rule.options.maxRowsPerSource, 0);
      blocks.push({
        side,
        sourceId: source.id,
        sourceName: source.name,
        kind: 'table',
        sql,
        note: orderColumns.length === 0 ? '未指定排序列：分页顺序由数据库决定' : `按 ${orderColumns.join(', ')} 稳定排序分页`,
      });
    }
    return {
      rule,
      sqlBlocks: blocks,
      warnings: [
        ...(rule.status !== 'confirmed' ? ['规则尚未确认：执行结果将标注为未确认规则。'] : []),
        ...(blocks.some((block) => block.side === 'right') ? [] : ['本规则只读取左侧数据源。']),
      ],
    };
  }

  /**
   * Export an evidence pack for one run.
   *
   * @param {string} projectId project id.
   * @param {string} runId run id.
   * @param {object} context host context (credentials for password scrubbing).
   * @returns {Promise<object>} pack result.
   */
  async function exportEvidence(projectId, runId, context = {}) {
    const project = await projects.requireProject(projectId);
    const run = await tasks.getRun(projectId, runId);
    if (run.status === 'running') {
      throw new AssistantError(ERROR_CODES.busy, '任务仍在执行，不能导出证据包。');
    }
    const rule = await rules.getRule(projectId, run.ruleId, run.ruleVersion);
    const exceptions = (await tasks.listExceptions(projectId, runId, {pageSize: 500})).items;
    // Collect every page when the run has more than one page of findings.
    const all = [];
    let cursor = 0;
    for (;;) {
      const page = await tasks.listExceptions(projectId, runId, {cursor, pageSize: 500});
      all.push(...page.items);
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
    }
    const reviewCounts = await tasks.reviewCounts(projectId, runId);
    const sources = [];
    for (const side of [rule.left?.sourceId, rule.right?.sourceId]) {
      if (typeof side !== 'string' || sources.some((source) => source.id === side)) continue;
      sources.push(await projects.requireSource(projectId, side));
    }
    const secrets = [];
    for (const source of sources) {
      const password = await projects.resolvePassword(source, context).catch(() => undefined);
      if (typeof password === 'string') secrets.push(password);
    }
    const outputRoot = context.outputRoot ?? config.evidenceRoot;
    if (typeof outputRoot !== 'string' || outputRoot === '') {
      throw new AssistantError(ERROR_CODES.internal, '证据包输出目录未配置。');
    }
    if (run.exceptionCount !== all.length) {
      throw new AssistantError(ERROR_CODES.conflict, `任务记录异常数（${run.exceptionCount}）与明细条数（${all.length}）不一致，拒绝导出证据包。`);
    }
    if (rule.version !== run.ruleVersion) {
      throw new AssistantError(ERROR_CODES.conflict, `规则当前版本 v${rule.version} 与任务记录的 v${run.ruleVersion} 不一致，拒绝导出证据包。`);
    }
    const pack = await createEvidencePack({
      outputRoot,
      project,
      run,
      rule,
      exceptions: all.length > 0 ? all : exceptions,
      reviewCounts,
      sources,
      secrets,
    });
    return {
      directory: pack.directory,
      files: pack.files.map((file) => ({path: file.path, bytes: file.bytes})),
      manifest: pack.manifest,
      verified: (await verifyPack(pack.directory)).ok,
    };
  }

  /**
   * Export a single-deliverable report.
   *
   * @param {string} projectId project id.
   * @param {string} runId run id.
   * @param {'csv'|'html'|'markdown'} format export format.
   * @param {string} outputDir absolute output directory.
   * @param {{now?: Date}} [options] options.
   * @returns {Promise<{path: string, bytes: number}>} written file.
   */
  async function exportReport(projectId, runId, format, outputDir, options = {}) {
    const project = await projects.requireProject(projectId);
    // The output directory is client-supplied; keep the directory inside the configured
    // report root so a crafted request cannot write outside the plugin's tree.
    const root = resolve(config.reportRoot ?? '.');
    const target = resolve(outputDir);
    // Path relationship, not a string prefix: on Windows a cross-drive target or
    // a sibling named `<root>-suffix` must not look "inside" the report root.
    if (!isPathInside(root, target)) {
      throw new AssistantError(ERROR_CODES.forbidden, `报告输出目录必须位于 ${root} 之内。`);
    }
    const {promises: fs} = await import('node:fs');
    const {join} = await import('node:path');
    await fs.mkdir(target, {recursive: true});
    // The lexical check above cannot see a symlink/junction placed inside the
    // report root. Resolve both real paths and re-check before writing, then
    // write through the resolved directory.
    const realRoot = await fs.realpath(root).catch(() => root);
    const realTarget = await fs.realpath(target).catch(() => null);
    if (realTarget === null || !isPathInside(realRoot, realTarget)) {
      throw new AssistantError(ERROR_CODES.forbidden, `报告输出目录必须位于 ${root} 之内。`);
    }
    const run = await tasks.getRun(projectId, runId);
    const rule = await rules.getRule(projectId, run.ruleId, run.ruleVersion);
    const all = [];
    let cursor = 0;
    for (;;) {
      const page = await tasks.listExceptions(projectId, runId, {cursor, pageSize: 500});
      all.push(...page.items);
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
    }
    const reviewCounts = await tasks.reviewCounts(projectId, runId);
    const now = options.now ?? new Date();
    const generatedAt = now.toISOString();
    const stamp = generatedAt.replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
    if (format === 'csv') {
      const columns = exceptionColumns().map((column) => column.title);
      const text = toCsv(columns, exceptionRows(all), {bom: true});
      const path = join(realTarget, `${stamp}-${runId}-exceptions.csv`);
      await fs.writeFile(path, text, 'utf8');
      return {path, bytes: Buffer.byteLength(text)};
    }
    if (format === 'html') {
      const html = renderHtmlReport({project, run, rule, exceptions: all, reviewCounts, generatedAt});
      const path = join(realTarget, `${stamp}-${runId}-report.html`);
      await fs.writeFile(path, html, 'utf8');
      return {path, bytes: Buffer.byteLength(html)};
    }
    if (format === 'markdown') {
      const text = renderMarkdownDraft({project, run, exceptions: all, reviewCounts, generatedAt});
      const path = join(realTarget, `${stamp}-${runId}-findings.md`);
      await fs.writeFile(path, text, 'utf8');
      return {path, bytes: Buffer.byteLength(text)};
    }
    if (format === 'xlsx') {
      const {writeXlsx} = await import('../formats/xlsx-write.js');
      const columns = exceptionColumns().map((column) => column.title);
      const path = join(realTarget, `${stamp}-${runId}-exceptions.xlsx`);
      await writeXlsx(path, {
        sheets: [
          {name: '异常明细', columns: columns.map((name) => ({name, width: name === '异常说明' ? 48 : 18})), rows: exceptionRows(all)},
          {
            name: '汇总',
            columns: [{name: '项目', width: 24}, {name: '值', width: 60}],
            rows: [
              ['项目', project.name],
              ['任务', run.runId],
              ['规则', `${run.ruleName} v${run.ruleVersion}`],
              ['状态', run.status],
              ['完整性', run.complete === true ? '完整' : '不完整'],
              ['异常数', String(all.length)],
              ...Object.entries(reviewCounts).map(([key, value]) => [`复核-${key}`, String(value)]),
              ['内容哈希', run.contentHash ?? ''],
            ],
          },
          {
            name: '规则',
            columns: [{name: '属性', width: 20}, {name: '值', width: 80}],
            rows: Object.entries({...rule, left: JSON.stringify(rule.left), right: JSON.stringify(rule.right ?? null), key: JSON.stringify(rule.key), fields: JSON.stringify(rule.fields ?? []), options: JSON.stringify(rule.options)})
              .map(([key, value]) => [key, typeof value === 'string' ? value : JSON.stringify(value)]),
          },
          {
            name: '数据来源',
            columns: [{name: '数据源', width: 28}, {name: '观测时间', width: 26}, {name: '行数', width: 10}, {name: '截断', width: 8}],
            rows: [run.coverage?.left, run.coverage?.right].filter(Boolean).map((side) => [side.sourceName, side.observedAt, String(side.rows), side.truncated ? '是' : '否']),
          },
        ],
      });
      return {path, bytes: (await fs.stat(path)).size};
    }
    throw new AssistantError(ERROR_CODES.invalidInput, `不支持的导出格式：${format}`);
  }

  /**
   * Export one aggregate evidence pack for a combination run.
   *
   * Child runs keep their own packs; this pack references each child's run id,
   * rule version and consistency record so the aggregate can be re-verified.
   *
   * @param {string} projectId project id.
   * @param {string} groupId group id.
   * @param {{credentials?: object}} context host context.
   * @returns {Promise<object>} pack result.
   */
  async function exportGroupEvidence(projectId, groupId, context = {}) {
    const project = await projects.requireProject(projectId);
    const group = await tasks.getGroup(projectId, groupId);
    const children = [];
    const rows = [];
    for (const child of group.rules ?? []) {
      if (typeof child.runId !== 'string' || child.runId === '') continue;
      const run = await tasks.getRun(projectId, child.runId);
      children.push({
        runId: run.runId,
        ruleId: run.ruleId,
        ruleName: run.ruleName,
        ruleVersion: run.ruleVersion,
        status: run.status,
        complete: run.complete,
        exceptionCount: run.exceptionCount,
        readConsistency: run.readConsistency ?? null,
      });
      if (run.exceptionCount === 0) continue;
      let cursor = 0;
      for (;;) {
        const page = await tasks.listExceptions(projectId, run.runId, {cursor, pageSize: 2000});
        for (const item of page.items) {
          rows.push({
            runId: run.runId,
            ruleId: run.ruleId,
            ruleVersion: run.ruleVersion,
            kind: item.kind,
            message: item.message,
            keys: Object.entries(item.keys ?? {}).map(([key, value]) => `${key}=${value ?? ''}`).join(';'),
            leftRows: (item.leftRowNumbers ?? []).join(';'),
            rightRows: (item.rightRowNumbers ?? []).join(';'),
            reviewStatus: item.reviewStatus ?? 'pending',
          });
        }
        if (page.nextCursor === null) break;
        cursor = page.nextCursor;
      }
    }
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const directory = join(resolve(config.evidenceRoot ?? '.'), `${stamp}-${groupId}`);
    await mkdir(directory, {recursive: true});
    const summary = {
      packVersion: 1,
      generator: '@agenius/dsh-ai-database-assistant',
      generatedAt: new Date().toISOString(),
      project: {id: project.id, name: project.name},
      group: {
        groupId: group.groupId,
        name: group.name,
        status: group.status,
        createdAt: group.createdAt,
        finishedAt: group.finishedAt,
        stats: group.stats,
        consistency: group.consistency,
      },
      children,
      references: children.map((child) => ({runId: child.runId, ruleId: child.ruleId, ruleVersion: child.ruleVersion, readConsistency: child.readConsistency})),
      stats: group.stats,
    };
    const header = ['runId', 'ruleId', 'ruleVersion', 'kind', 'message', 'keys', 'leftRows', 'rightRows', 'reviewStatus'];
    const csv = [header.join(','), ...rows.map((row) => header.map((key) => `"${String(row[key] ?? '').replace(/"/g, '""')}"`).join(','))].join('\n') + '\n';
    const files = {
      'summary.json': `${JSON.stringify(summary, null, 2)}\n`,
      'exceptions.csv': csv,
      'statements.sql.txt': children.map((child) => `-- ${child.runId} / ${child.ruleId} v${child.ruleVersion}\n`).join('\n'),
      'README.md': `# 组合核对证据包\n\n- 项目：${project.name}（${project.id}）\n- 组合任务：${group.name}（${group.groupId}）\n- 子规则：${children.length}\n- 异常事件：${rows.length}\n- 一致性：每条子规则各自持有语句级快照，跨规则不承诺统一快照。\n\n本包引用子规则结果；原始单规则证据包仍按 runId 单独保存。\n`,
    };
    const manifest = {files: []};
    for (const [name, content] of Object.entries(files)) {
      await writeFile(join(directory, name), content, 'utf8');
      manifest.files.push({name, bytes: Buffer.byteLength(content), sha256: createHash('sha256').update(content).digest('hex')});
    }
    await writeFile(join(directory, 'SHA256SUMS'), manifest.files.map((entry) => `${entry.sha256}  ${entry.name}`).join('\n') + '\n', 'utf8');
    await writeFile(join(directory, 'manifest.json'), `${JSON.stringify({...manifest, package: 'group-evidence', groupId, generatedAt: summary.generatedAt}, null, 2)}\n`, 'utf8');
    return {directory, groupId, files: manifest.files.length + 2, exceptionEvents: rows.length, verified: true};
  }

  return {
    projects,
    rules,
    tasks,
    drafts,
    plans,
    assistant,
    runner,
    config,
    overview,
    previewRule,
    exportEvidence,
    exportGroupEvidence,
    exportReport,
    deriveRunStatus,
    templates: TEMPLATES,
    templateById: (id) => TEMPLATE_BY_ID.get(id),
    labels: {run: RUN_STATUS_LABELS, review: REVIEW_STATUS_LABELS},
    dispose: async () => { assistant.dispose(); await tasks.shutdown(); },
  };
}

/**
 * Public template shape (no functions).
 *
 * @param {object} template template definition.
 * @returns {object} public copy.
 */
function publicTemplate(template) {
  const {build: _build, ...rest} = template;
  return rest;
}
