/**
 * Evidence package writer.
 *
 * A pack is a directory, never a single archive, so an user can inspect every
 * file without extraction tooling. The directory name is derived from time and
 * run id and is never reused: an existing pack is never overwritten.
 *
 * Integrity: `manifest.json` and `SHA256SUMS` record the digest of every file in
 * the pack. That proves the files were not altered after export; the hashes are not a
 * notarized timestamp, and the README says so.
 *
 * @module src/export/evidence
 */
import {promises as fs} from 'node:fs';
import {isAbsolute, join} from 'node:path';

import {isPathInside} from '../core/user-path.js';

import {canonicalJson, sha256Hex} from '../core/ids.js';
import {containsNoSecret} from '../core/redact.js';
import {exceptionColumns, exceptionRows, renderHtmlReport, renderMarkdownDraft, toCsv} from './report.js';

/** Generator identity recorded in every manifest. */
export const GENERATOR = '@agenius/dsh-ai-database-assistant';
/** Pack format version. */
export const PACK_VERSION = 1;

/**
 * Build the pack directory name and guarantee uniqueness.
 *
 * @param {string} parent parent directory.
 * @param {string} runId run id.
 * @param {Date} now generation time.
 * @returns {Promise<string>} absolute directory path.
 */
async function uniqueDirectory(parent, runId, now) {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
  const base = `${stamp}-${runId}`;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const candidate = join(parent, attempt === 0 ? base : `${base}-${attempt + 1}`);
    try {
      await fs.mkdir(candidate, {recursive: false});
      return candidate;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
  throw new Error('无法创建唯一的证据包目录（已尝试 100 次）。');
}

/**
 * Write one text file and return its digest.
 *
 * @param {string} directory pack directory.
 * @param {string} name file name.
 * @param {string} text content.
 * @returns {Promise<{path: string, sha256: string, bytes: number}>} file record.
 */
async function writeText(directory, name, text) {
  const path = join(directory, name);
  await fs.writeFile(path, text, 'utf8');
  return {path: name, sha256: sha256Hex(text), bytes: Buffer.byteLength(text)};
}

/**
 * Write one binary file and return its digest.
 *
 * @param {string} directory pack directory.
 * @param {string} name file name.
 * @param {Uint8Array} bytes content.
 * @returns {Promise<{path: string, sha256: string, bytes: number}>} file record.
 */
async function writeBytes(directory, name, bytes) {
  const path = join(directory, name);
  await fs.writeFile(path, bytes);
  return {path: name, sha256: sha256Hex(bytes), bytes: bytes.byteLength};
}

/**
 * Create one evidence pack.
 *
 * @param {{
 *   outputRoot: string,
 *   project: object,
 *   run: object,
 *   rule: object,
 *   exceptions: object[],
 *   reviewCounts: Record<string, number>,
 *   sources: object[],
 *   now?: Date,
 *   secrets?: string[],
 * }} input pack input.
 * @returns {Promise<{directory: string, manifest: object, files: object[]}>} written pack.
 */
export async function createEvidencePack(input) {
  const now = input.now ?? new Date();
  await fs.mkdir(input.outputRoot, {recursive: true});
  const directory = await uniqueDirectory(input.outputRoot, input.run.runId, now);
  const secrets = input.secrets ?? [];
  const files = [];
  const generatedAt = now.toISOString();

  const sourcesPublic = input.sources.map((source) => ({
    id: source.id,
    name: source.name,
    kind: source.kind,
    ...(source.kind === 'database'
      ? {dialect: source.dialect, host: source.host ?? null, port: source.port ?? null, database: source.database ?? null, user: source.user ?? null, enforcement: source.status?.enforcement ?? null}
      : {originalName: source.originalName, hash: source.hash, rowCount: source.rowCount, sheet: source.sheet ?? null, encoding: source.encoding ?? null}),
    hasCredential: source.passwordRef !== undefined && source.passwordRef !== '',
  }));

  const statements = [];
  for (const side of ['left', 'right']) {
    const coverage = input.run.coverage?.[side];
    for (const sql of coverage?.statements ?? []) statements.push(sql);
  }

  files.push(await writeText(directory, 'summary.json', `${JSON.stringify({
    packVersion: PACK_VERSION,
    generator: GENERATOR,
    generatedAt,
    project: {id: input.project.id, name: input.project.name},
    run: {
      runId: input.run.runId,
      status: input.run.status,
      complete: input.run.complete,
      contentHash: input.run.contentHash,
      startedAt: input.run.startedAt,
      finishedAt: input.run.finishedAt,
      ruleId: input.run.ruleId,
      ruleVersion: input.run.ruleVersion,
      ruleFingerprint: input.run.ruleFingerprint,
      exceptionCount: input.run.exceptionCount,
      stats: input.run.stats,
      // The pack must state what consistency guarantee the numbers have.
      readConsistency: input.run.readConsistency ?? null,
      reviewCounts: input.reviewCounts,
      warnings: input.run.warnings,
    },
  }, null, 2)}\n`));
  files.push(await writeText(directory, 'run.json', `${JSON.stringify(input.run, null, 2)}\n`));
  files.push(await writeText(directory, 'rule.json', `${JSON.stringify(input.rule, null, 2)}\n`));
  files.push(await writeText(directory, 'sources.json', `${JSON.stringify(sourcesPublic, null, 2)}\n`));
  files.push(await writeText(directory, 'statements.sql.txt', statements.map((sql) => `${sql};\n`).join('\n')));

  const columns = exceptionColumns().map((column) => column.title);
  const rows = exceptionRows(input.exceptions);
  files.push(await writeText(directory, 'exceptions.csv', toCsv(columns, rows, {bom: true})));
  files.push(
    await writeText(
      directory,
      'exceptions.jsonl',
      input.exceptions.map((exception) => JSON.stringify(exception)).join('\n') + (input.exceptions.length > 0 ? '\n' : ''),
    ),
  );

  const html = renderHtmlReport({
    project: input.project,
    run: input.run,
    rule: input.rule,
    exceptions: input.exceptions,
    reviewCounts: input.reviewCounts,
    generatedAt,
  });
  files.push(await writeText(directory, 'report.html', html));
  const draft = renderMarkdownDraft({
    project: input.project,
    run: input.run,
    exceptions: input.exceptions,
    reviewCounts: input.reviewCounts,
    generatedAt,
    evidencePath: directory,
  });
  files.push(await writeText(directory, 'analysis-findings-draft.md', draft));

  const {writeXlsx} = await import('../formats/xlsx-write.js');
  const xlsxPath = join(directory, 'exceptions.xlsx');
  await writeXlsx(xlsxPath, {
    sheets: [
      {
        name: '异常明细',
        columns: columns.map((title) => ({name: title, width: title === '异常说明' ? 48 : 18})),
        rows,
      },
      {
        name: '汇总',
        columns: [{name: '项目', width: 24}, {name: '值', width: 60}],
        rows: [
          ['项目名称', input.project.name],
          ['任务编号', input.run.runId],
          ['规则', `${input.run.ruleName} v${input.run.ruleVersion}`],
          ['任务状态', input.run.status],
          ['结果完整性', input.run.complete === true ? '完整' : '不完整'],
          ['异常条数', String(input.run.exceptionCount ?? input.exceptions.length)],
          ...Object.entries(input.reviewCounts).map(([key, value]) => [`复核-${key}`, String(value)]),
          ['内容哈希', input.run.contentHash ?? ''],
          ['生成时间', generatedAt],
        ],
      },
      {
        name: '数据来源',
        columns: [{name: '数据源', width: 28}, {name: '类型', width: 12}, {name: '观测时间', width: 26}, {name: '行数', width: 10}, {name: '截断', width: 8}],
        rows: [input.run.coverage?.left, input.run.coverage?.right]
          .filter(Boolean)
          .map((side) => [side.sourceName, '数据库/文件', side.observedAt, String(side.rows), side.truncated ? '是' : '否']),
      },
    ],
  });
  const xlsxBytes = await fs.readFile(xlsxPath);
  files.push({path: 'exceptions.xlsx', sha256: sha256Hex(xlsxBytes), bytes: xlsxBytes.byteLength});

  files.push(
    await writeText(
      directory,
      'README.md',
      [
        `# 证据包 · ${input.project.name}`,
        '',
        `- 任务：\`${input.run.runId}\`，状态 **${input.run.status}**，完整性：${input.run.complete === true ? '完整' : '不完整'}`,
        `- 规则：${input.run.ruleName}（${input.run.ruleId} v${input.run.ruleVersion}）`,
        `- 生成时间：${generatedAt}`,
        `- 生成器：${GENERATOR} v${PACK_VERSION}`,
        '',
        '## 内容',
        '',
        '| 文件 | 说明 |',
        '| --- | --- |',
        '| `summary.json` | 核对结果汇总与内容哈希 |',
        '| `run.json` | 任务完整记录（状态、覆盖范围、进度、警告） |',
        '| `rule.json` | 本次执行使用的规则版本快照 |',
        '| `sources.json` | 数据源清单（不含任何密码） |',
        '| `statements.sql.txt` | 实际执行的查询语句 |',
        '| `exceptions.csv` / `exceptions.xlsx` | 异常明细（含原始行号，可回溯原始记录） |',
        '| `exceptions.jsonl` | 异常明细的机器可读形式 |',
        '| `report.html` | 离线核对报告（无脚本、无外部资源） |',
        '| `analysis-findings-draft.md` | 分析问题草稿（依据与风险等级待人工确认） |',
        '| `manifest.json` / `SHA256SUMS` | 文件哈希清单 |',
        '',
        '## 完整性说明',
        '',
        '`SHA256SUMS` 与 `manifest.json` 用于校验本证据包在导出后未被改动。它们**不是**时间戳或第三方存证，',
        '不能证明导出时刻，也不能防止有权限的人重新生成整个包。',
        '',
        '## 限制',
        '',
        '- 异常由确定性程序计算；未经人工复核不得作为分析结论。',
        '- 本包不包含数据库密码，也不包含被截断数据之外的隐含内容。',
        `- ${input.run.complete === true ? '核对覆盖范围完整。' : '核对结果不完整，不得表述为“全量核对通过”。'}`,
        '',
      ].join('\n'),
    ),
  );

  const manifest = {
    packVersion: PACK_VERSION,
    generator: GENERATOR,
    generatedAt,
    projectId: input.project.id,
    runId: input.run.runId,
    contentHash: input.run.contentHash,
    files,
  };
  files.push(await writeText(directory, 'manifest.json', `${JSON.stringify(manifest, null, 2)}\n`));
  const sums = manifest.files.filter((file) => file.path !== 'manifest.json').map((file) => `${file.sha256}  ${file.path}`).join('\n') + '\n';
  files.push(await writeText(directory, 'SHA256SUMS', sums));

  // Last line of defense for requirement 12: no credential text may be written.
  for (const file of files) {
    if (!/\.(json|jsonl|csv|txt|md|html)$/.test(file.path)) continue;
    const text = await fs.readFile(join(directory, file.path), 'utf8');
    if (!containsNoSecret(text, secrets)) {
      await fs.rm(directory, {recursive: true, force: true});
      throw new Error(`证据包中发现疑似凭据文本（文件 ${file.path}），已中止导出并删除该目录。`);
    }
  }
  return {directory, manifest, files};
}

/**
 * Verify every digest recorded in a pack.
 *
 * @param {string} directory pack directory.
 * @returns {Promise<{ok: boolean, checked: number, mismatches: string[]}>} check result.
 */
export async function verifyPack(directory) {
  const payload = await fs.readFile(join(directory, 'manifest.json'), 'utf8');
  const manifest = JSON.parse(payload);
  const mismatches = [];
  for (const file of manifest.files) {
    if (file.path === 'manifest.json') continue;
    // A manifest is data, not an instruction: a tampered `../` or absolute
    // path must be reported as a mismatch instead of being read outside the
    // pack directory.
    const relative = typeof file.path === 'string' ? file.path : '';
    const target = join(directory, relative);
    if (relative === '' || isAbsolute(relative) || !isPathInside(directory, target)) {
      mismatches.push(String(file.path));
      continue;
    }
    const bytes = await fs.readFile(target);
    if (sha256Hex(bytes) !== file.sha256) mismatches.push(file.path);
  }
  return {ok: mismatches.length === 0, checked: manifest.files.length - 1, mismatches, contentHash: manifest.contentHash};
}

/**
 * Stable text form of a pack manifest, used by tests and receipts.
 *
 * @param {object} manifest manifest.
 * @returns {string} canonical JSON.
 */
export function serializeManifest(manifest) {
  return canonicalJson(manifest);
}
