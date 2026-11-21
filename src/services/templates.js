/**
 * AI database assistant rule templates.
 *
 * A template never hard-codes a customer's column names. The template declares the inputs
 * an user must supply (which column is the employee id, which column is the
 * account state, and so on) and builds ordinary draft rules from them. The
 * drafts still go through confirmation in the workbench.
 *
 * @module src/services/templates
 */

/**
 * @typedef {Object} TemplateInput
 * @property {string} key input key.
 * @property {string} label label shown to the user.
 * @property {'left'|'right'|'any'} side side the column belongs to.
 * @property {boolean} [optional] whether the input may be empty.
 * @property {string} [hint] closer description.
 */

/**
 * Build one key mapping pair list.
 *
 * @param {{left: string, right: string}} pair key pair.
 * @returns {{pairs: {left: string, right: string}[]}} rule key block.
 */
function keyOf(pair) {
  return {pairs: [pair]};
}

/**
 * Build a rule draft.
 *
 * @param {object} input rule fields.
 * @returns {object} rule draft.
 */
function draft(input) {
  return {status: 'pending', ...input};
}

/** @type {readonly object[]} */
const BASE_TEMPLATES = [
  {
    id: 'account-leaver',
    name: '离职人员账号核对',
    scenario: '账号与权限管理',
    description:
      '把人事系统的离职名单与目标系统的账号清单按工号/账号关联，核对离职人员账号是否仍处于启用状态，并列出只在账号侧存在的记录。',
    applies: ['field', 'missing'],
    inputs: [
      {key: 'keyLeft', label: '离职名单中的工号列', side: 'left'},
      {key: 'keyRight', label: '账号清单中的账号列', side: 'right'},
      {key: 'statusLeft', label: '离职名单中的状态列（可留空，用于缺失检查）', side: 'left', optional: true},
      {key: 'expectedLeft', label: '离职名单中的“应有账号状态”列', side: 'left', hint: '例如 expected_account_state：离职人员应为「停用」'},
      {key: 'statusRight', label: '账号清单中的实际状态列', side: 'right'},
    ],
    /**
     * Build the draft rules.
     *
     * @param {Record<string, string>} values input values.
     * @param {{projectId: string, leftSourceId: string, rightSourceId: string}} context build context.
     * @returns {object[]} draft rules.
     */
    build(values, context) {
      const key = keyOf({left: values.keyLeft, right: values.keyRight});
      const rules = [
        draft({
          name: '离职人员账号仍启用',
          kind: 'match',
          projectId: context.projectId,
          template: 'account-leaver',
          description: '按工号/账号关联，比较账号启用状态；未匹配的离职人员由缺失检查规则覆盖。',
          left: {sourceId: context.leftSourceId, dataset: {kind: 'table'}},
          right: {sourceId: context.rightSourceId, dataset: {kind: 'table'}},
          key,
          // Compare the expected state (left) with the actual account state (right);
          // using the right column on both sides would flag every leaver.
          fields: [{left: values.expectedLeft, right: values.statusRight, label: '账号状态'}],
          options: {caseInsensitive: true, trim: true},
          notes:
            '本规则只比较双方都存在的账号。发现“状态不一致”后仍需人工确认：账号可能已停用但目录未同步，或存在合理例外。',
        }),
      ];
      if (typeof values.statusLeft === 'string' && values.statusLeft !== '') {
        rules.push(
          draft({
            name: '离职人员缺少账号记录',
            kind: 'missing',
            projectId: context.projectId,
            template: 'account-leaver',
            description: '列出只在离职名单中出现的工号，确认这些人员是否确实没有对应账号。',
            left: {sourceId: context.leftSourceId, dataset: {kind: 'table'}},
            right: {sourceId: context.rightSourceId, dataset: {kind: 'table'}},
            key,
            options: {caseInsensitive: true, trim: true},
          }),
        );
      }
      return rules;
    },
  },
  {
    id: 'backup-status',
    name: '数据库备份执行情况核对',
    scenario: '备份与恢复管理',
    description:
      '按任务标识与执行日期统计备份记录，区分成功、失败、带错误完成与未知状态；识别同一任务重复采集与失败记录。',
    applies: ['required', 'duplicate', 'threshold'],
    inputs: [
      {key: 'taskColumn', label: '任务标识列', side: 'left'},
      {key: 'timeColumn', label: '执行时间列', side: 'left'},
      {key: 'statusColumn', label: '执行状态列', side: 'left'},
      {key: 'successValues', label: '成功状态取值（逗号分隔）', side: 'left'},
      {key: 'failureValues', label: '失败状态取值（逗号分隔）', side: 'left'},
    ],
    /**
     * Build the draft rules.
     *
     * @param {Record<string, string>} values input values.
     * @param {{projectId: string, leftSourceId: string}} context build context.
     * @returns {object[]} draft rules.
     */
    build(values, context) {
      const base = {
        projectId: context.projectId,
        template: 'backup-status',
        left: {sourceId: context.leftSourceId, dataset: {kind: 'table'}},
      };
      return [
        draft({
          ...base,
          name: '备份任务标识为空',
          kind: 'required',
          description: '关键字段为空的备份记录无法归属到任何任务，必须先修复采集口径。',
          fields: [{left: values.taskColumn, label: '任务标识'}, {left: values.timeColumn, label: '执行时间'}],
        }),
        draft({
          ...base,
          name: '备份记录重复采集',
          kind: 'duplicate',
          description: '同一任务在同一执行日期出现多条记录时，可能是重复采集而不是真实失败，需人工确认。',
          key: {pairs: [{left: values.taskColumn, right: values.taskColumn}]},
          options: {duplicatePolicy: 'report'},
        }),
        draft({
          ...base,
          name: '备份任务缺少恢复测试证据',
          kind: 'referential',
          description: '以任务清单为左、恢复测试记录为右，列出没有任何恢复测试记录的任务；只说明"未匹配到记录"，不等于未开展恢复测试。',
          right: {sourceId: context.rightSourceId ?? context.leftSourceId, dataset: {kind: 'table'}},
          key: {pairs: [{left: values.taskColumn, right: values.taskColumn}]},
        }),
        draft({
          ...base,
          name: '备份失败记录',
          kind: 'threshold',
          description: '统计状态属于失败取值的记录数；大于 0 即提示存在失败备份（后续成功不会抹掉这些记录）。',
          threshold: {aggregate: 'count', op: 'gt', value: 0, label: '失败备份记录数'},
          notes: `失败状态取值：${values.failureValues ?? '待确认'}；后续重试成功需另行关联，不会自动抵消本条记录。`,
        }),
      ];
    },
  },
  {
    id: 'asset-vulnerability',
    name: '资产台账与漏洞扫描覆盖核对',
    scenario: '资产与漏洞管理',
    description:
      '把资产台账与扫描结果按资产编号关联，找出未纳入扫描范围的资产，并按明确的修复期限识别逾期未修复漏洞。',
    applies: ['missing', 'time'],
    inputs: [
      {key: 'assetKeyLeft', label: '资产台账中的资产编号列', side: 'left'},
      {key: 'assetKeyRight', label: '扫描结果中的资产编号列', side: 'right'},
      {key: 'foundColumn', label: '扫描结果中的发现时间列', side: 'right', optional: true},
      {key: 'days', label: '修复期限（天）', side: 'right', optional: true},
    ],
    /**
     * Build the draft rules.
     *
     * @param {Record<string, string>} values input values.
     * @param {{projectId: string, leftSourceId: string, rightSourceId: string}} context build context.
     * @returns {object[]} draft rules.
     */
    build(values, context) {
      return [
        draft({
          name: '未纳入扫描范围的资产',
          kind: 'missing',
          projectId: context.projectId,
          template: 'asset-vulnerability',
          description: '列出仅在资产台账中出现的资产编号；需要人工确认该资产是否已下线或属于扫描豁免范围。',
          left: {sourceId: context.leftSourceId, dataset: {kind: 'table'}},
          right: {sourceId: context.rightSourceId, dataset: {kind: 'table'}},
          key: keyOf({left: values.assetKeyLeft, right: values.assetKeyRight}),
          options: {caseInsensitive: true, trim: true},
        }),
      ];
    },
  },
  {
    id: 'change-management',
    name: '变更工单与实施记录核对',
    scenario: '变更管理',
    description:
      '把变更工单与部署/实施记录按变更单号关联，找出无对应工单的实施记录，并核对实施时间是否早于审批时间。',
    applies: ['missing', 'time'],
    inputs: [
      {key: 'ticketKeyLeft', label: '部署记录中的变更单号列', side: 'left'},
      {key: 'ticketKeyRight', label: '工单系统中的变更单号列', side: 'right'},
      {key: 'implementTime', label: '实施时间列', side: 'left', optional: true},
      {key: 'approveTime', label: '审批时间列', side: 'right', optional: true},
    ],
    /**
     * Build the draft rules.
     *
     * @param {Record<string, string>} values input values.
     * @param {{projectId: string, leftSourceId: string, rightSourceId: string}} context build context.
     * @returns {object[]} draft rules.
     */
    build(values, context) {
      const rules = [
        draft({
          name: '无对应变更工单的实施记录',
          kind: 'missing',
          projectId: context.projectId,
          template: 'change-management',
          description: '列出只在部署记录中出现、工单系统中不存在的变更单号；候选异常，需人工确认是否为紧急变更或记录缺失。',
          left: {sourceId: context.leftSourceId, dataset: {kind: 'table'}},
          right: {sourceId: context.rightSourceId, dataset: {kind: 'table'}},
          key: keyOf({left: values.ticketKeyLeft, right: values.ticketKeyRight}),
          options: {caseInsensitive: true, trim: true},
        }),
      ];
      if (values.implementTime !== undefined) {
        rules.push(
          draft({
            name: '实施时间早于审批时间',
            kind: 'time',
            projectId: context.projectId,
            template: 'change-management',
            description: '在工单侧核对该工单的实施时间是否晚于审批时间；只读工单侧数据，候选异常需人工确认。',
            left: {sourceId: context.rightSourceId, dataset: {kind: 'table'}},
            time: {column: values.implementTime, op: 'after', referenceColumn: values.approveTime, label: '实施时间晚于审批时间'},
            notes: '若审批时间列缺失，请改用「时间范围检查」手工配置。',
          }),
        );
      }
      return rules;
    },
  },
];

/** Lookup by template id. */
/**
 * Add the table-name parameters every database template needs.
 *
 * A template cannot know a customer's table names; without them the built rule
 * datasets are incomplete and validation rejects them.
 *
 * @param {object} template base template.
 * @returns {object} template with table inputs.
 */
function withTableInputs(template) {
  return {
    ...template,
    inputs: [
      {key: 'leftTable', label: '左侧表名', side: 'left', hint: '例如 employees'},
      {key: 'rightTable', label: '右侧表名（可留空）', side: 'right', optional: true, hint: '例如 accounts'},
      ...template.inputs,
    ],
  };
}

/** @type {readonly object[]} */
export const TEMPLATES = Object.freeze(BASE_TEMPLATES.map(withTableInputs));

/**
 * Fill dataset table names from the user's parameters.
 *
 * @param {object[]} rules generated rule drafts.
 * @param {Record<string, string>} values template parameters.
 * @returns {object[]} rules with table names.
 */
export function applyTableNames(rules, values) {
  return rules.map((rule) => {
    const fix = (spec, tableValue, side) => {
      if (spec === undefined || spec === null) return spec;
      const dataset = spec.dataset ?? {};
      if (dataset.kind !== 'table') return spec;
      const table = typeof dataset.table === 'string' && dataset.table !== '' ? dataset.table : tableValue;
      if (typeof table !== 'string' || table.trim() === '') {
        throw new Error(`模板缺少${side === 'left' ? '左' : '右'}侧表名：请填写“${side === 'left' ? '左侧表名' : '右侧表名'}”。`);
      }
      return {...spec, dataset: {...dataset, table: table.trim()}};
    };
    return {...rule, left: fix(rule.left, values.leftTable, 'left'), right: fix(rule.right, values.rightTable, 'right')};
  });
}

export const TEMPLATE_BY_ID = new Map(TEMPLATES.map((template) => [template.id, template]));
