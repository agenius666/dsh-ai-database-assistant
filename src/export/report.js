/**
 * Report renderers: CSV, offline HTML, and Markdown working-paper drafts.
 *
 * All three are dependency-free. The HTML report contains no script, no remote
 * asset, and no user string outside an escaped text node, so the report can be opened
 * offline on an analysis workstation without a network.
 *
 * @module src/export/report
 */

/** UTF-8 BOM, required for Excel on Windows to read Chinese CSV correctly. */
export const BOM = '\ufeff';

/**
 * Render one CSV field.
 *
 * @param {unknown} value cell value.
 * @param {string} delimiter delimiter.
 * @returns {string} quoted field.
 */
function fieldOf(value, delimiter) {
  if (value === null || value === undefined) return '';
  let text = String(value);
  // Neutralise spreadsheet formulas on the evidence path too (the three-file
  // export already does this). A negative number is a value, not a formula.
  const numeric = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text);
  if (!numeric && /^[\s\uFEFF\u00A0]*[=+\-@\t\r]/.test(text)) text = `'${text}`;
  if (text.includes('"') || text.includes('\n') || text.includes('\r') || text.includes(delimiter)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

/**
 * Render rows as CSV text.
 *
 * @param {string[]} columns column names.
 * @param {(string|number|null)[][]} rows rows.
 * @param {{delimiter?: string, bom?: boolean, eol?: string}} [options] options.
 * @returns {string} CSV text.
 */
export function toCsv(columns, rows, options = {}) {
  const delimiter = options.delimiter ?? ',';
  const eol = options.eol ?? '\r\n';
  const lines = [columns.map((column) => fieldOf(column, delimiter)).join(delimiter)];
  for (const row of rows) lines.push(row.map((cell) => fieldOf(cell, delimiter)).join(delimiter));
  const text = lines.join(eol) + eol;
  return options.bom === false ? text : `${BOM}${text}`;
}

/**
 * Escape text for inclusion in HTML.
 *
 * @param {unknown} value value.
 * @returns {string} escaped text.
 */
export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Flatten an exception's values into readable text.
 *
 * @param {object} exception exception record.
 * @returns {string} text.
 */
export function describeValues(exception) {
  if (exception.values === null || exception.values === undefined) return '';
  return Object.entries(exception.values)
    .map(([label, pair]) => `${label}: 左=${pair.left ?? '∅'} / 右=${pair.right ?? '∅'}`)
    .join('；');
}

/**
 * Flatten an exception's keys into readable text.
 *
 * @param {object} exception exception record.
 * @returns {string} text.
 */
export function describeKeys(exception) {
  return Object.entries(exception.keys ?? {})
    .map(([name, value]) => `${name}=${value ?? '∅'}`)
    .join('; ');
}

/**
 * The exception table columns used by CSV and XLSX exports.
 *
 * @returns {{key: string, title: string}[]} columns.
 */
export function exceptionColumns() {
  return [
    {key: 'sequence', title: '序号'},
    {key: 'exceptionId', title: '异常编号'},
    {key: 'kind', title: '异常类型'},
    {key: 'message', title: '异常说明'},
    {key: 'keys', title: '主键'},
    {key: 'leftRowNumbers', title: '左侧行号'},
    {key: 'rightRowNumbers', title: '右侧行号'},
    {key: 'values', title: '值对比'},
    {key: 'reviewStatus', title: '复核状态'},
    {key: 'reviewBy', title: '复核人'},
    {key: 'reviewNote', title: '复核备注'},
  ];
}

/**
 * Convert exceptions into table rows.
 *
 * @param {object[]} exceptions exceptions with `review` attached.
 * @returns {(string|number|null)[][]} rows.
 */
export function exceptionRows(exceptions) {
  return exceptions.map((exception) => [
    exception.sequence ?? null,
    exception.exceptionId ?? '',
    exception.kind ?? '',
    exception.message ?? '',
    describeKeys(exception),
    (exception.leftRowNumbers ?? []).join(','),
    (exception.rightRowNumbers ?? []).join(','),
    describeValues(exception),
    exception.review?.status ?? 'pending',
    exception.review?.by ?? '',
    exception.review?.note ?? '',
  ]);
}

/**
 * Render the offline HTML reconciliation report.
 *
 * @param {{
 *   project: object, run: object, rule: object|null, exceptions: object[],
 *   reviewCounts: Record<string, number>, generatedAt: string,
 * }} input report content.
 * @returns {string} complete HTML document.
 */
export function renderHtmlReport(input) {
  const {project, run, rule, exceptions, reviewCounts, generatedAt} = input;
  const coverage = run.coverage ?? {};
  const left = coverage.left ?? null;
  const right = coverage.right ?? null;
  const statusLabel = run.status;
  const rows = exceptions.slice(0, 2000);
  const statRows = Object.entries(run.stats ?? {})
    .filter(([, value]) => typeof value === 'number' && value !== 0)
    .map(([key, value]) => `<tr><th>${escapeHtml(key)}</th><td>${escapeHtml(value)}</td></tr>`)
    .join('\n');
  const coverageRows = [left, right]
    .filter(Boolean)
    .map(
      (side) => `<tr>
        <td>${escapeHtml(side.sourceName ?? '')}</td>
        <td>${escapeHtml(side.rows ?? '')}</td>
        <td>${escapeHtml(side.columns ?? '')}</td>
        <td>${escapeHtml(side.observedAt ?? '')}</td>
        <td>${side.truncated === true ? '是（结果不完整）' : '否'}</td>
        <td>${escapeHtml(side.parseIssues ?? 0)}</td>
      </tr>`,
    )
    .join('\n');
  const evidenceLinks = (left?.statements ?? []).concat(right?.statements ?? []);
  const sqlBlock = evidenceLinks.map((sql) => `<pre>${escapeHtml(sql)}</pre>`).join('\n');
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>${escapeHtml(project.name)} · ${escapeHtml(run.ruleName)} · 核对报告</title>
<style>
  :root { color-scheme: light dark; --line: color-mix(in srgb, currentColor 18%, transparent); }
  body { font: 14px/1.6 -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; margin: 32px auto; max-width: 1080px; padding: 0 20px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  h2 { font-size: 15px; margin: 28px 0 8px; padding-bottom: 6px; border-bottom: 1px solid var(--line); }
  .meta { display: grid; grid-template-columns: max-content 1fr; gap: 4px 16px; font-size: 13px; }
  .meta dt { opacity: .7; }
  table { border-collapse: collapse; width: 100%; font-size: 12.5px; }
  th, td { border: 1px solid var(--line); padding: 6px 8px; text-align: left; vertical-align: top; }
  th { font-weight: 600; background: color-mix(in srgb, currentColor 5%, transparent); }
  .pill { display: inline-block; padding: 1px 8px; border-radius: 999px; border: 1px solid var(--line); font-size: 12px; }
  pre { white-space: pre-wrap; word-break: break-word; font-size: 12px; padding: 8px; border: 1px solid var(--line); border-radius: 6px; }
  .note { font-size: 12px; opacity: .75; }
  footer { margin-top: 32px; font-size: 11.5px; opacity: .7; }
</style>
</head>
<body>
<h1>数据核对报告</h1>
<p class="note">${escapeHtml(project.name)} · 生成于 ${escapeHtml(generatedAt)}</p>

<h2>一、核对任务</h2>
<dl class="meta">
  <dt>任务编号</dt><dd>${escapeHtml(run.runId)}</dd>
  <dt>规则</dt><dd>${escapeHtml(run.ruleName)}（${escapeHtml(run.ruleId)} v${escapeHtml(run.ruleVersion)}）</dd>
  <dt>规则类型</dt><dd>${escapeHtml(run.ruleKind)}</dd>
  <dt>任务状态</dt><dd><span class="pill">${escapeHtml(statusLabel)}</span></dd>
  <dt>结果完整性</dt><dd>${run.complete === true ? '完整' : '不完整（不得据此认定全量无异常）'}</dd>
  <dt>开始时间</dt><dd>${escapeHtml(run.startedAt)}</dd>
  <dt>结束时间</dt><dd>${escapeHtml(run.finishedAt ?? '')}</dd>
  <dt>耗时</dt><dd>${escapeHtml(run.durationMs ?? '')} ms</dd>
  <dt>异常条数</dt><dd>${escapeHtml(run.exceptionCount ?? exceptions.length)}</dd>
  <dt>内容哈希</dt><dd><code>${escapeHtml(run.contentHash ?? '')}</code></dd>
</dl>

<h2>二、数据覆盖范围</h2>
<table>
  <thead><tr><th>数据源</th><th>加载行数</th><th>列数</th><th>观测时间</th><th>截断</th><th>解析异常</th></tr></thead>
  <tbody>${coverageRows || '<tr><td colspan="6">无</td></tr>'}</tbody>
</table>
${(run.warnings ?? []).length > 0 ? `<p class="note">提示：${(run.warnings ?? []).map((warning) => escapeHtml(warning)).join('；')}</p>` : ''}

<h2>三、核对统计</h2>
<table><tbody>${statRows || '<tr><td>无统计项</td></tr>'}</tbody></table>

<h2>四、复核状态</h2>
<table><tbody>${Object.entries(reviewCounts ?? {}).map(([key, value]) => `<tr><th>${escapeHtml(key)}</th><td>${escapeHtml(value)}</td></tr>`).join('')}</tbody></table>

<h2>五、异常明细（前 ${rows.length} 条，共 ${exceptions.length} 条）</h2>
<table>
  <thead><tr><th>序号</th><th>类型</th><th>说明</th><th>主键</th><th>值对比</th><th>复核</th></tr></thead>
  <tbody>
  ${rows
    .map(
      (exception) => `<tr>
      <td>${escapeHtml(exception.sequence ?? '')}</td>
      <td>${escapeHtml(exception.kind ?? '')}</td>
      <td>${escapeHtml(exception.message ?? '')}</td>
      <td>${escapeHtml(describeKeys(exception))}</td>
      <td>${escapeHtml(describeValues(exception))}</td>
      <td>${escapeHtml(exception.review?.status ?? 'pending')}</td>
    </tr>`,
    )
    .join('\n') || '<tr><td colspan="6">无异常记录</td></tr>'}
  </tbody>
</table>

<h2>六、执行语句（可追溯）</h2>
${sqlBlock || '<p class="note">无数据库语句（文件数据源）。</p>'}

<h2>七、规则快照</h2>
<pre>${escapeHtml(rule === null ? '（规则快照缺失）' : JSON.stringify(rule, null, 2))}</pre>

<footer>
本报告由 DSH AI 数据库助手生成。异常由确定性核对引擎产生，未经过人工复核前不得作为分析结论；
报告中不含数据库密码。核对结果仅覆盖上表所列的数据源与快照时间。
</footer>
</body>
</html>
`;
}

/**
 * Render an analysis-finding draft in Markdown.
 *
 * The draft deliberately separates facts (from evidence) from judgement
 * (marked 待核实), and never invents a regulation clause.
 *
 * @param {{
 *   project: object, run: object, exceptions: object[], reviewCounts: Record<string, number>,
 *   generatedAt: string, evidencePath?: string,
 * }} input draft content.
 * @returns {string} Markdown document.
 */
export function renderMarkdownDraft(input) {
  const {project, run, exceptions, reviewCounts, generatedAt, evidencePath} = input;
  const confirmed = exceptions.filter((exception) => exception.review?.status === 'confirmed');
  const pending = exceptions.filter((exception) => (exception.review?.status ?? 'pending') === 'pending');
  const lines = [
    `# 分析问题草稿 · ${project.name}`,
    '',
    `> 生成时间：${generatedAt}　任务：\`${run.runId}\`　规则：${run.ruleName} v${run.ruleVersion}`,
    '> 本文件是**草稿**：事实来自核对证据，风险等级、分析依据与最终结论必须由分析人员确认。',
    '',
    '## 一、核对结果摘要',
    '',
    `- 任务状态：**${run.status}**（${run.complete === true ? '结果完整' : '结果不完整，不得认定全量无异常'}）`,
    `- 异常条数：${run.exceptionCount ?? exceptions.length}`,
    `- 复核状态：${Object.entries(reviewCounts).map(([key, value]) => `${key} ${value}`).join('，')}`,
    `- 内容哈希：\`${run.contentHash ?? ''}\``,
    '',
    '## 二、分析发现（候选）',
    '',
  ];
  if (confirmed.length === 0) {
    lines.push('> 当前没有「已确认」异常。以下列出待复核项，供分析人员判断。');
  }
  const list = confirmed.length > 0 ? confirmed : pending.slice(0, 50);
  if (list.length === 0) {
    lines.push('', '本次核对未发现异常。**注意**：这不等于被分析事项不存在问题，仍需结合其他证据。');
  }
  list.forEach((exception, index) => {
    lines.push(
      '',
      `### 发现 ${index + 1}（${exception.review?.status === 'confirmed' ? '已确认' : '待复核'}）`,
      '',
      '- **分析发现**：' + exception.message,
      `- **涉及主键**：${describeKeys(exception) || '（无）'}`,
      `- **证据索引**：任务 \`${run.runId}\` / 异常 \`${exception.exceptionId}\`${evidencePath === undefined ? '' : ` / 证据包 \`${evidencePath}\``}`,
      `- **原始行号**：左侧 ${(exception.leftRowNumbers ?? []).join(',') || '—'}；右侧 ${(exception.rightRowNumbers ?? []).join(',') || '—'}`,
      exception.values === null ? '- **值对比**：（无字段对比）' : `- **值对比**：${describeValues(exception)}`,
      '- **分析依据**：待核实（必须引用用户提供并可核实的制度或法规原文，不得编造条款）',
      '- **风险描述**：待核实',
      '- **风险等级**：待人工判断',
      '- **分析建议**：待拟定',
    );
  });
  lines.push(
    '',
    '## 三、待确认事项',
    '',
    '- [ ] 异常是否由数据口径差异导致（快照时间、字段映射、统计范围）',
    '- [ ] 是否存在合理的业务解释（如临时账号、演练、已整改）',
    '- [ ] 分析依据的准确条款、文号与适用期间',
    '',
    '## 四、限制与说明',
    '',
    `- ${run.complete === true ? '本次核对覆盖范围完整。' : '本次核对结果不完整：存在数据截断或解析异常，不得表述为“全量核对通过”。'}`,
    '- 异常由确定性程序计算，未经人工复核不得作为分析结论。',
    '- 报告不含数据库密码；复核状态以工作台记录为准。',
    '',
  );
  return lines.join('\n');
}
