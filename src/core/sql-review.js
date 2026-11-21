/**
 * Static SQL review for common business-logic hazards.
 *
 * This is a heuristic reviewer, not a semantic prover. The reviewer highlights patterns
 * that frequently change aggregate results (JOIN fan-out, LEFT JOIN collapsed
 * by WHERE, COUNT(*) vs COUNT(column), SELECT *) and returns structured
 * findings the agent can explain to the user or verify with a small probe.
 *
 * @module src/core/sql-review
 */

/** Remove comments and string literals so keywords inside literals do not match. */
function normalize(sql) {
  return String(sql)
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'(?:[^'\\]|\\.|'')*'/g, "''")
    .replace(/"(?:[^"\\]|\\.|"")*"/g, '""');
}

/**
 * Extract aliases introduced by JOIN clauses.
 *
 * @param {string} text normalized SQL.
 * @returns {{type: string, alias: string}[]} joined aliases.
 */
function joinedAliases(text) {
  const result = [];
  const pattern = /\b(?:(left|right|inner|cross)\s+)?(?:outer\s+)?join\s+([`\w.]+)(?:\s+(?:as\s+)?([`\w]+))?/gi;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const keyword = (match[1] ?? 'inner').toLowerCase();
    let alias = (match[3] ?? '').replace(/`/g, '');
    // `JOIN customers ON ...` makes the capture swallow the `ON` keyword as if
    // it were an alias, so the LEFT-JOIN-collapsed-by-WHERE check silently never
    // fired for unaliased joins. Treat a clause keyword as "no alias" and fall
    // back to the joined table's own name, which is how unaliased joins are
    // referenced in WHERE.
    if (/^(on|using|where|group|order|having|limit|offset|fetch|join|left|right|inner|cross|outer|union|set|for|window|qualify|and|or|select|from)$/i.test(alias)) alias = '';
    const table = (match[2] ?? '').replace(/`/g, '');
    const effective = alias === '' ? table.split('.').pop() : alias;
    result.push({
      type: keyword === 'left' || keyword === 'right' || keyword === 'cross' ? keyword : 'inner',
      alias: effective,
      explicitAlias: alias !== '',
    });
  }
  return result;
}

/**
 * Analyze one read-only SQL statement.
 *
 * @param {string} sql SQL text.
 * @returns {{findings: object[], hasJoin: boolean, hasAggregate: boolean, hasGroupBy: boolean, note: string}} review.
 */
export function analyzeSql(sql) {
  const text = normalize(sql);
  const findings = [];
  const joins = joinedAliases(text);
  const hasJoin = joins.length > 0;
  const hasAggregate = /\b(sum|avg|count|min|max)\s*\(/i.test(text);
  const hasGroupBy = /\bgroup\s+by\b/i.test(text);
  const hasWhere = /\bwhere\b/i.test(text);
  const whereClause = (text.match(/\bwhere\b([\s\S]*?)(?:\bgroup\s+by\b|\border\s+by\b|\bhaving\b|\blimit\b|$)/i) ?? [])[1] ?? '';

  if (hasJoin) {
    const hasCross = joins.some((entry) => entry.type === 'cross');
    if (!hasCross && !/\bon\b|\busing\s*\(/i.test(text)) {
      findings.push({
        level: 'warn',
        code: 'join-without-condition',
        message: 'JOIN 没有找到 ON/USING 条件，可能产生笛卡尔积。',
      });
    }
    for (const join of joins.filter((entry) => entry.type === 'left')) {
      if (join.alias === '' || whereClause === '') continue;
      const reference = new RegExp(`\\b${join.alias}\\.`, 'i');
      if (!reference.test(whereClause)) continue;
      // Anti-join (`WHERE right.id IS NULL`) is a legitimate pattern: strip those
      // predicates and check whether the alias is referenced anywhere else.
      const withoutNullChecks = whereClause.replace(
        new RegExp(`\\b${join.alias}\\.\\w+\\s+is\\s+(?:not\\s+)?null`, 'gi'),
        ' ',
      );
      if (!reference.test(withoutNullChecks)) {
        findings.push({
          level: 'info',
          code: 'left-join-antijoin',
          message: `LEFT JOIN 别名 ${join.alias} 仅用于 IS NULL 反连接检查，这是正常写法。`,
        });
        continue;
      }
      findings.push({
        level: 'warn',
        code: 'left-join-where',
        message: `LEFT JOIN 别名 ${join.alias} 出现在 WHERE 中，结果可能等价于 INNER JOIN，左表未匹配的记录会丢失。`,
      });
    }
    if (/\bsum\s*\(/i.test(text)) {
      findings.push({
        level: 'warn',
        code: 'sum-after-join',
        message: 'SUM 出现在 JOIN 查询中：若被汇总表在关联键上不唯一，同一业务记录会被重复累计。建议先用 COUNT(*) 与 COUNT(DISTINCT 关联键) 验证关联键唯一性。',
      });
    }
    if (/\bcount\s*\(\s*\*\s*\)/i.test(text)) {
      findings.push({
        level: 'info',
        code: 'count-star-after-join',
        message: 'COUNT(*) 统计的是 JOIN 后的行数，可能因一对多关系放大；若需要业务记录数，请用 COUNT(DISTINCT 主键)。',
      });
    }
  }

  if (hasAggregate && !hasGroupBy && hasJoin) {
    findings.push({
      level: 'info',
      code: 'global-aggregate-after-join',
      message: '未使用 GROUP BY 的全局聚合叠加 JOIN，行数放大同样会放大 SUM/AVG。',
    });
  }
  if (/\bcount\s*\(\s*[`\w.]+\s*\)/i.test(text) && !/\bcount\s*\(\s*distinct/i.test(text)) {
    findings.push({
      level: 'info',
      code: 'count-column-null',
      message: 'COUNT(列) 不统计 NULL；如果需要记录总数请确认应对 NULL 的处理口径（COUNT(*) 或 COUNT(DISTINCT)）。',
    });
  }
  if (/\bselect\s+\*/i.test(text) && !/\bcount\s*\(/i.test(text)) {
    findings.push({
      level: 'info',
      code: 'select-star',
      message: 'SELECT * 会返回全部列，可能包含不必要的敏感字段；导出前建议只选需要的列。',
    });
  }
  if (!hasWhere && !/\blimit\b/i.test(text) && !hasAggregate) {
    findings.push({
      level: 'info',
      code: 'no-filter',
      message: '查询没有 WHERE 或 LIMIT，可能返回整表；请确认范围是否过大。',
    });
  }
  if (/\b(distinct)\b/i.test(text) && /\bcount\s*\(\s*distinct/i.test(text)) {
    findings.push({
      level: 'info',
      code: 'count-distinct',
      message: 'COUNT(DISTINCT) 会忽略 NULL；若用户口径是"包含空值"，需要单独确认。',
    });
  }

  return {
    findings,
    hasJoin,
    hasAggregate,
    hasGroupBy,
    note: '静态启发式检查，只能提示常见风险，不能证明 SQL 业务语义正确；涉及口径歧义时应向用户确认。',
  };
}
