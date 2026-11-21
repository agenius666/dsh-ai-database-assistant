/**
 * Deterministic rule execution.
 *
 * `runRuleOnDatasets` is the pure core: given two loaded datasets and a rule, the runner
 * returns findings in a stable order with content-derived ids. `executeRule`
 * adds record loading. Splitting them keeps the engine testable without a
 * database or a file.
 *
 * Determinism contract:
 *   * findings are sorted by a canonical key;
 *   * exception ids are hashes of finding content, so re-running the same rule
 *     over the same snapshot reproduces the same ids and keeps review notes
 *     attached;
 *   * `contentHash` covers the sorted findings and statistics only.
 *
 * @module src/engine/runner
 */
import {AssistantError, ERROR_CODES} from '../core/errors.js';
import {canonicalJson, sha256Hex} from '../core/ids.js';
import {normalizeRule, validateRule} from '../core/rule-schema.js';
import {loadDataset} from './dataset.js';
import {KIND_HANDLERS} from './kinds.js';
import {assertColumns, keyPairsOf, referencedColumns} from './normalize.js';

/** Default cap on findings kept for one run. */
export const DEFAULT_MAX_EXCEPTIONS = 20_000;

/**
 * Build the canonical sort key of a finding.
 *
 * @param {object} finding finding.
 * @returns {string} sort key.
 */
function sortKeyOf(finding) {
  return [
    finding.kind,
    canonicalJson(finding.keys ?? {}),
    canonicalJson(finding.values ?? {}),
    finding.message,
    (finding.leftRows ?? []).join(','),
    (finding.rightRows ?? []).join(','),
  ].join('|');
}

/**
 * Derive a stable exception id from finding content.
 *
 * @param {object} finding finding.
 * @returns {string} identifier.
 */
function exceptionIdOf(finding) {
  return `X-${sha256Hex(sortKeyOf(finding)).slice(0, 16)}`;
}

/**
 * Run a validated rule over already-loaded datasets.
 *
 * @param {{
 *   rule: object,
 *   left: import('./dataset.js').Dataset,
 *   right?: import('./dataset.js').Dataset|null,
 *   limits?: {maxExceptions?: number},
 * }} request execution request.
 * @returns {{
 *   ruleId: string, ruleVersion: number, status: string, complete: boolean,
 *   stats: Record<string, number>, exceptions: object[], warnings: string[],
 *   coverage: object, contentHash: string, exceptionsTruncated: boolean,
 * }} run result.
 */
export function runRuleOnDatasets(request) {
  const rule = request.rule;
  const handler = KIND_HANDLERS[rule.kind];
  if (handler === undefined) throw new AssistantError(ERROR_CODES.invalidInput, `未实现的核对规则类型：${rule.kind}`);
  const options = rule.options;
  const left = request.left;
  const right = request.right ?? null;
  const limits = {maxExceptions: DEFAULT_MAX_EXCEPTIONS, ...(request.limits ?? {})};

  const keyed = keyPairsOf(rule).length > 0;
  if (keyed) {
    assertColumns(left, referencedColumns({key: rule.key}, 'left'), '左侧');
    if (right !== null) assertColumns(right, referencedColumns({key: rule.key}, 'right'), '右侧');
  }

  const stats = {
    leftRows: left.rowCount,
    rightRows: right?.rowCount ?? 0,
    leftDistinctKeys: 0,
    rightDistinctKeys: 0,
    matchedRows: 0,
    unmatchedLeft: 0,
    unmatchedRight: 0,
    multiplicity: 0,
    missingLeft: 0,
    missingRight: 0,
    duplicates: 0,
    fieldDifferences: 0,
    blankKeys: 0,
    requiredBlank: 0,
    orphans: 0,
    unparseableDates: 0,
    timeViolations: 0,
    thresholdViolations: 0,
    groupsCompared: 0,
    totalMismatches: 0,
  };
  // Surface dataset-level warnings on the run receipt: a side that returned no
  // rows (so its columns could not be checked), an unstable page order, or a
  // truncated file must be visible without digging into coverage.
  const warnings = [...new Set([...(left.warnings ?? []), ...(right?.warnings ?? [])])];
  /** @type {object[]} */
  const findings = [];
  let exceptionsTruncated = false;
  const emit = (finding) => {
    if (findings.length >= limits.maxExceptions) {
      exceptionsTruncated = true;
      return;
    }
    findings.push(finding);
  };

  handler({rule, options, left, right, emit, stats, warnings});

  findings.sort((leftFinding, rightFinding) => {
    const leftKey = sortKeyOf(leftFinding);
    const rightKey = sortKeyOf(rightFinding);
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
  const exceptions = findings.map((finding, index) => ({
    exceptionId: exceptionIdOf(finding),
    sequence: index + 1,
    kind: finding.kind,
    side: finding.side ?? 'both',
    message: finding.message,
    keys: finding.keys ?? {},
    values: finding.values ?? null,
    leftRowNumbers: finding.leftRows ?? [],
    rightRowNumbers: finding.rightRows ?? [],
  }));
  if (exceptionsTruncated) warnings.push(`异常数量超过上限，只保留了前 ${limits.maxExceptions} 条；结果不完整。`);

  const parseIssues = (left.parseIssues?.length ?? 0) + (right?.parseIssues?.length ?? 0);
  const truncated = left.truncated || (right?.truncated ?? false);
  // A capped exception list is not a complete result: the run must not be
  // reported as passed/complete while findings were dropped.
  const complete = !truncated && parseIssues === 0 && !exceptionsTruncated;
  const status = !complete ? 'incomplete' : exceptions.length > 0 ? 'exceptions' : 'succeeded';
  const coverage = {
    left: coverageOf(left),
    right: right === null ? null : coverageOf(right),
  };
  const contentHash = sha256Hex(
    canonicalJson({
      ruleId: rule.id,
      ruleVersion: rule.version,
      status,
      complete,
      exceptionsTruncated,
      stats,
      exceptions: exceptions.map((exception) => ({
        exceptionId: exception.exceptionId,
        kind: exception.kind,
        message: exception.message,
        keys: exception.keys,
        values: exception.values,
        leftRowNumbers: exception.leftRowNumbers,
        rightRowNumbers: exception.rightRowNumbers,
      })),
    }),
  );
  const sides = [left, right].filter((side) => side !== null);
  const levels = [...new Set(sides.map((side) => side.consistency?.level ?? 'page-offset'))];
  const readConsistency = {
    level: levels.length === 1 ? levels[0] : 'mixed',
    crossSource: sides.length > 1 ? 'separate-statements' : 'single-source',
    note: levels.length === 1 && levels[0] === 'statement-snapshot'
      ? (sides.length > 1
        ? '每侧为单条语句的 InnoDB 语句级快照；左右两侧是不同语句，跨数据源不是同一时点。'
        : '单条语句的 InnoDB 语句级快照。')
      : '存在按页读取的数据源，跨页一致性未保证。',
    sides: sides.map((side) => ({
      side: side.side,
      sourceId: side.sourceId,
      level: side.consistency?.level ?? 'page-offset',
      observedAt: side.observedAt,
      startedAt: side.consistency?.startedAt ?? null,
      finishedAt: side.consistency?.finishedAt ?? null,
    })),
  };
  return {ruleId: rule.id, ruleVersion: rule.version, status, complete, stats, exceptions, warnings, coverage, contentHash, exceptionsTruncated, readConsistency};
}

/**
 * Summarize one dataset for the run receipt.
 *
 * @param {import('./dataset.js').Dataset} dataset dataset.
 * @returns {object} coverage entry.
 */
function coverageOf(dataset) {
  return {
    sourceId: dataset.sourceId,
    sourceName: dataset.sourceName,
    rows: dataset.rowCount,
    columns: dataset.columns.length,
    columnsKnown: dataset.columnsKnown ?? dataset.columns.length > 0,
    truncated: dataset.truncated,
    observedAt: dataset.observedAt,
    statements: dataset.statements,
    parseIssues: dataset.parseIssues?.length ?? 0,
    warnings: dataset.warnings,
    orderStable: dataset.orderStable,
    readEngine: dataset.readEngine ?? 'paged-offset',
    consistency: dataset.consistency ?? {
      level: 'page-offset',
      note: '该数据源按页读取，跨页一致性未保证。',
    },
  };
}

/**
 * Validate, load, and execute one rule.
 *
 * @param {{
 *   rule: object,
 *   getSource: (sourceId: string) => object,
 *   resolvePassword?: (source: object) => Promise<string|undefined>,
 *   runner: import('../db/read.js').ReadOnlyRunner,
 *   signal?: AbortSignal,
 *   onProgress?: (progress: {phase: string, loaded: number, side?: string}) => void,
 *   limits?: {maxExceptions?: number, maxRowsPerSource?: number},
 * }} request execution request.
 * @returns {Promise<object>} run result including the loaded coverage.
 */
export async function executeRule(request) {
  const validated = normalizeRule(validateRule(request.rule));
  const limits = {
    maxExceptions: request.limits?.maxExceptions ?? DEFAULT_MAX_EXCEPTIONS,
    maxRowsPerSource: request.limits?.maxRowsPerSource ?? validated.options.maxRowsPerSource,
  };
  const load = async (side) => {
    const datasetSpec = side === 'left' ? validated.left : validated.right;
    if (datasetSpec === undefined || datasetSpec === null) return null;
    const source = request.getSource(datasetSpec.sourceId);
    const password = request.resolvePassword === undefined ? undefined : await request.resolvePassword(source);
    request.onProgress?.({phase: 'loading', loaded: 0, side});
    const dataset = {...(datasetSpec.dataset ?? datasetSpec)};
    // The preview qualifies the table with the source's configured schema; the
    // run must use the same scope or it would read the connection default schema
    // (or fail with "relation does not exist") while the preview looked right.
    if ((dataset.schema === undefined || dataset.schema === null || dataset.schema === '')
      && typeof source.schema === 'string' && source.schema !== '') {
      dataset.schema = source.schema;
    }
    // Keyed rules get a stable ORDER BY from their own key mapping: without the ordering
    // the database may return rows in any order and the recorded row numbers
    // (used for traceability) would differ between runs.
    const pairs = validated.key?.pairs ?? [];
    if (pairs.length > 0 && (dataset.orderBy === undefined || dataset.orderBy.length === 0)) {
      dataset.orderBy = pairs.map((pair) => (side === 'left' ? pair.left : pair.right ?? pair.left));
    }
    return loadDataset({
      side,
      source,
      dataset,
      runner: request.runner,
      password,
      signal: request.signal,
      maxRows: limits.maxRowsPerSource,
      onProgress: (progress) => request.onProgress?.({...progress, side}),
    });
  };
  const left = await load('left');
  if (left === null) throw new AssistantError(ERROR_CODES.invalidInput, '规则缺少左侧数据集。');
  const right = await load('right');
  request.onProgress?.({phase: 'computing', loaded: left.rowCount + (right?.rowCount ?? 0)});
  return runRuleOnDatasets({rule: validated, left, right, limits: {maxExceptions: limits.maxExceptions}});
}
