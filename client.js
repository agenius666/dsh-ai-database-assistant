window.__ModuleLoader__.load({
  id: '@agenius/dsh-ai-database-assistant',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const {useCallback, useEffect, useMemo, useRef, useState} = React;
    // Render-time translation: the workbench is written with Simplified
    // Chinese source strings; `e()` translates text children and display-only
    // props through the active DSH locale table. Values, keys and handlers are
    // never touched.
    const DATA_TAGS = new Set(['pre', 'code', 'td', 'th']);
    const e = (tag, props, ...children) => {
      // SQL, code and table cells carry database data: translating a cell whose
      // text happens to equal a UI key (a value of `保存` became `Save` in the
      // English UI) silently rewrites the data on screen. `raw` opts a specific
      // text node (a column name, a data-source name) out as well.
      const {raw, ...rest} = props ?? {};
      const translate = raw !== true && !DATA_TAGS.has(tag);
      return h(
        tag,
        translateDisplayProps(rest),
        ...children.map((child) => (typeof child === 'string' && translate ? tr(child) : child)),
      );
    };

    const PANEL_ID = 'ai-database-assistant';
    const NS = 'ai-database-assistant';
    const ROUTE = '/__ai-database-assistant';
    const STORE_KEY = 'dsh.ai-database-assistant.project.v1';
    const REVIEWER_KEY = 'dsh.ai-database-assistant.reviewer.v1';
    const SESSION_KEY = (projectId) => `dsh.ai-database-assistant.session.${projectId}`;
    const DRAFT_KEY = (projectId) => `dsh.ai-database-assistant.draft.${projectId}`;
    const PROJECT_EVENT = 'ai-database-assistant:project';

    /* ------------------------------------------------------------------ */
    /* i18n                                                                */
    /* ------------------------------------------------------------------ */

    const DICT = {
      zh: {
        'panel.label': 'AI 数据库助手',
        'tab.sources': '项目与数据源',
        'tab.mapping': '字段映射',
        'tab.rules': '核对规则',
        'tab.tasks': '核对任务',
        'tab.results': '核对结果',
        'tab.evidence': '分析证据',
        'common.refresh': '刷新',
        'common.save': '保存',
        'common.cancel': '取消',
        'common.delete': '删除',
        'common.close': '关闭',
        'common.loading': '加载中…',
        'common.none': '暂无数据',
        'common.optional': '可留空',
        'common.copy': '复制',
        'common.copied': '已复制',
        'project.title': '分析项目',
        'project.new': '新建项目',
        'project.name': '项目名称',
        'project.desc': '项目说明',
        'project.current': '当前项目',
        'project.rename': '重命名',
        'project.deleteHint': '删除只移除项目记录，已生成的成果文件与证据包会保留在磁盘。',
        'session.pick': '选择要绑定的会话',
        'session.boundTo': '已绑定会话',
        'source.addDb': '添加数据库连接',
        'source.import': '导入数据文件',
        'source.name': '数据源名称',
        'source.dialect': '数据库类型',
        'source.host': '主机',
        'source.port': '端口',
        'source.user': '账号',
        'source.database': '数据库/服务名',
        'source.passwordRef': '凭据引用名（可选）',
        'source.passwordRefHint': '密码不保存在插件里；请先在 DSH 凭据中保存，再填写引用名。',
        'source.filePath': 'SQLite 数据库文件（绝对路径）',
        'source.importPath': '文件绝对路径',
        'source.sheet': '工作表（可选）',
        'source.test': '测试连接',
        'source.inspect': '查看库表',
        'source.describe': '查看字段',
        'source.status': '状态',
        'source.available': '可用',
        'source.unavailable': '不可用',
        'source.untested': '未测试',
        'source.rows': '行数',
        'source.cols': '字段数',
        'source.enforcement': '只读级别',
        'source.delete': '移除数据源',
        'mapping.title': '字段映射助手',
        'mapping.hint': '选择左右数据源，查看双方字段，生成主键映射建议。AI 或程序给出的映射都只是“待确认”，必须由你确认后才能用于正式核对。',
        'mapping.left': '左侧数据源',
        'mapping.right': '右侧数据源',
        'mapping.keyLeft': '左侧主键列',
        'mapping.keyRight': '右侧主键列',
        'mapping.fieldLeft': '左侧比较列',
        'mapping.fieldRight': '右侧比较列',
        'mapping.createRule': '用此映射新建规则',
        'mapping.preview': '字段对照',
        'rule.title': '核对规则',
        'rule.new': '新建规则',
        'rule.kind': '规则类型',
        'rule.name': '规则名称',
        'rule.status': '状态',
        'rule.version': '版本',
        'rule.preview': '预览与校验',
        'rule.confirm': '确认规则',
        'rule.disable': '停用',
        'rule.run': '执行核对',
        'rule.previewOk': '校验通过',
        'rule.saved': '规则已保存',
        'rule.needConfirm': '未确认规则不能正式执行；可先用“预览执行”并标注未确认。',
        'run.title': '核对任务',
        'run.start': '启动任务',
        'run.cancel': '取消任务',
        'run.status': '状态',
        'run.progress': '进度',
        'run.exceptions': '异常数',
        'run.duration': '耗时',
        'run.complete': '完整性',
        'run.error': '错误原因',
        'run.rule': '规则',
        'run.empty': '还没有任务。选择一条已确认规则并执行。',
        'result.title': '核对结果',
        'result.pickRun': '选择任务',
        'result.summary': '结果概览',
        'result.exceptions': '异常明细',
        'result.review': '复核',
        'result.reviewer': '复核人',
        'result.note': '复核意见',
        'result.mark': '记录复核',
        'result.detail': '查看详情',
        'result.sql': '执行语句',
        'result.coverage': '覆盖范围',
        'result.noException': '本任务没有异常记录。注意：这不等于不存在问题。',
        'result.incomplete': '结果不完整，不得据此认定全量无异常。',
        'evidence.title': '分析证据',
        'evidence.export': '导出证据包',
        'evidence.report': '导出报告',
        'evidence.lastExport': '最近导出',
        'evidence.verified': '哈希校验通过',
        'evidence.note': '证据包不会覆盖既有目录；哈希用于校验导出后未被改动，不是第三方存证。',
      },
      en: {
        'panel.label': 'AI Database Assistant',
        'tab.sources': 'Project & sources',
        'tab.mapping': 'Field mapping',
        'tab.rules': 'Rules',
        'tab.tasks': 'Tasks',
        'tab.results': 'Results',
        'tab.evidence': 'Evidence',
        'common.refresh': 'Refresh',
        'common.save': 'Save',
        'common.cancel': 'Cancel',
        'common.delete': 'Delete',
        'common.close': 'Close',
        'common.loading': 'Loading…',
        'common.none': 'Nothing yet',
        'common.optional': 'optional',
        'common.copy': 'Copy',
        'common.copied': 'Copied',
        'project.title': 'Analysis project',
        'project.new': 'New project',
        'project.name': 'Project name',
        'project.desc': 'Description',
        'project.current': 'Current project',
        'project.rename': 'Rename',
        'project.deleteHint': 'Deleting removes the project record only; exported files and evidence packs stay on disk.',
        'session.pick': 'Session to bind',
        'session.boundTo': 'Bound session',
        'source.addDb': 'Add database',
        'source.import': 'Import record file',
        'source.name': 'Source name',
        'source.dialect': 'Database type',
        'source.host': 'Host',
        'source.port': 'Port',
        'source.user': 'User',
        'source.database': 'Database / service',
        'source.passwordRef': 'Credential reference (optional)',
        'source.passwordRefHint': 'Passwords are never stored by the plugin; save one in DSH credentials and reference the credential here.',
        'source.filePath': 'SQLite file (absolute path)',
        'source.importPath': 'File absolute path',
        'source.sheet': 'Sheet (optional)',
        'source.test': 'Test connection',
        'source.inspect': 'Inspect tables',
        'source.describe': 'Inspect columns',
        'source.status': 'Status',
        'source.available': 'Available',
        'source.unavailable': 'Unavailable',
        'source.untested': 'Not tested',
        'source.rows': 'Rows',
        'source.cols': 'Columns',
        'source.enforcement': 'Read-only level',
        'source.delete': 'Remove source',
        'mapping.title': 'Field mapping helper',
        'mapping.hint': 'Pick both sources and compare their columns. Any mapping produced by AI or by this page is a proposal that you must confirm.',
        'mapping.left': 'Left source',
        'mapping.right': 'Right source',
        'mapping.keyLeft': 'Left key column',
        'mapping.keyRight': 'Right key column',
        'mapping.fieldLeft': 'Left compare column',
        'mapping.fieldRight': 'Right compare column',
        'mapping.createRule': 'Create rule from this mapping',
        'mapping.preview': 'Column pairs',
        'rule.title': 'Rules',
        'rule.new': 'New rule',
        'rule.kind': 'Rule kind',
        'rule.name': 'Rule name',
        'rule.status': 'Status',
        'rule.version': 'Version',
        'rule.preview': 'Preview & validate',
        'rule.confirm': 'Confirm rule',
        'rule.disable': 'Disable',
        'rule.run': 'Run reconciliation',
        'rule.previewOk': 'Validation passed',
        'rule.saved': 'Rule saved',
        'rule.needConfirm': 'An unconfirmed rule cannot run formally; use preview run and mark the run unconfirmed.',
        'run.title': 'Tasks',
        'run.start': 'Start',
        'run.cancel': 'Cancel',
        'run.status': 'Status',
        'run.progress': 'Progress',
        'run.exceptions': 'Exceptions',
        'run.duration': 'Duration',
        'run.complete': 'Completeness',
        'run.error': 'Error',
        'run.rule': 'Rule',
        'run.empty': 'No task yet. Pick a confirmed rule and run the rule.',
        'result.title': 'Results',
        'result.pickRun': 'Task',
        'result.summary': 'Summary',
        'result.exceptions': 'Exceptions',
        'result.review': 'Review',
        'result.reviewer': 'Reviewer',
        'result.note': 'Note',
        'result.mark': 'Record review',
        'result.detail': 'Details',
        'result.sql': 'Statements',
        'result.coverage': 'Coverage',
        'result.noException': 'No exception in this run. That does not mean nothing is wrong.',
        'result.incomplete': 'The result is incomplete; do not conclude that everything is fine.',
        'evidence.title': 'Evidence',
        'evidence.export': 'Export evidence pack',
        'evidence.report': 'Export report',
        'evidence.lastExport': 'Last export',
        'evidence.verified': 'Hashes verified',
        'evidence.note': 'Packs are never overwritten. Hashes prove the files were not modified after export; they are not third-party notarization.',
      },
    };

    /* ------------------------------------------------------------------ */
    /* Runtime UI translation (zh / zh-TW / en)                            */
    /* ------------------------------------------------------------------ */

    /**
     * Exact Simplified-Chinese surface strings → English / Traditional.
     *
     * A table keyed by the rendered Simplified text keeps translations close to
     * the UI without rewriting every render site: the `e()` helper translates
     * text children and the display-only props below at render time.
     */
    const UI_TRANSLATIONS = [
      ["AI 数据库助手", "AI Database Assistant", "AI 資料庫助手"],
      ["用自然语言查询与分析数据", "Query and analyze data in natural language", "以自然語言查詢與分析資料"],
      ["只读连接 MySQL / PostgreSQL / SQL Server / Oracle / SQLite；AI 自己查表、写 SQL、执行并解释结果。需要导出时生成 Excel、CSV 和最终 SQL。", "Read-only connections to MySQL, PostgreSQL, SQL Server, Oracle and SQLite. The assistant explores schemas, writes SQL, runs it and explains the result. Exports produce Excel, CSV and the final SQL.", "唯讀連線 MySQL / PostgreSQL / SQL Server / Oracle / SQLite；AI 自行查表、撰寫 SQL、執行並解釋結果。需要匯出時產生 Excel、CSV 與最終 SQL。"],
      ["正在切换项目…", "Switching project…", "正在切換專案…"],
      ["正在切换项目", "Switching project", "正在切換專案"],
      ["未选择项目", "No project selected", "未選擇專案"],
      ["工作台加载失败", "Failed to load the workbench", "工作台載入失敗"],
      ["重试", "Retry", "重試"],
      ["本地插件服务暂时没有返回数据。已有项目不会丢失；可直接重试，仍失败时请查看宿主日志。", "The local plugin service returned no data. Existing projects are safe; retry, and check the host log if it keeps failing.", "本機外掛服務暫時沒有回傳資料。既有專案不會遺失；可直接重試，仍失敗時請查看宿主日誌。"],
      ["正在加载新项目的数据…", "Loading the new project…", "正在載入新專案的資料…"],
      ["先建一个项目", "Create a project first", "先建立一個專案"],
      ["项目保存数据库连接、保存目录和会话历史。点上方「新建项目」开始。", "A project stores database connections, the delivery directory and session history. Start with “New project” above.", "專案會保存資料庫連線、交付目錄與工作階段歷史。點上方「新增專案」開始。"],
      ["数据库连接", "Database connections", "資料庫連線"],
      ["收起设置", "Hide settings", "收合設定"],
      ["添加连接", "Add connection", "新增連線"],
      ["复制其他项目连接", "Copy from another project", "複製其他專案連線"],
      ["刷新", "Refresh", "重新整理"],
      ["还没有数据库连接。点「添加连接」选择数据库类型（MySQL / PostgreSQL / SQL Server / Oracle / SQLite）。", "No database connections yet. Choose “Add connection” and pick MySQL, PostgreSQL, SQL Server, Oracle or SQLite.", "尚無資料庫連線。點「新增連線」選擇資料庫類型（MySQL / PostgreSQL / SQL Server / Oracle / SQLite）。"],
      ["测试连接", "Test connection", "測試連線"],
      ["编辑", "Edit", "編輯"],
      ["删除连接", "Delete connection", "刪除連線"],
      ["可用", "Available", "可用"],
      ["不可用", "Unavailable", "不可用"],
      ["未测试", "Not tested", "未測試"],
      ["新建数据库连接", "New database connection", "新增資料庫連線"],
      ["编辑数据库连接", "Edit database connection", "編輯資料庫連線"],
      ["使用只读账号；密码保存在 DSH 凭据中，这里只填引用名。SQLite 以只读方式打开文件。", "Use a read-only account. Passwords live in DSH credentials; enter only the credential reference here. SQLite is opened read-only.", "使用唯讀帳號；密碼保存在 DSH 憑證中，這裡只填參照名稱。SQLite 以唯讀方式開啟檔案。"],
      ["数据库类型", "Database type", "資料庫類型"],
      ["连接名称", "Connection name", "連線名稱"],
      ["数据库文件路径", "Database file path", "資料庫檔案路徑"],
      ["绝对路径；只会以只读方式打开，不会创建或修改文件", "Absolute path; opened read-only and never created or modified", "絕對路徑；只會以唯讀方式開啟，不會建立或修改檔案"],
      ["本机绝对路径（按当前操作系统填写）", "Absolute path on this machine (use this OS format)", "本機絕對路徑（依目前作業系統填寫）"],
      ["主机", "Host", "主機"],
      ["端口", "Port", "連接埠"],
      ["只读账号", "Read-only user", "唯讀帳號"],
      ["数据库", "Database", "資料庫"],
      ["可选；Oracle/SQL Server/PostgreSQL 的默认 schema", "Optional; default schema for Oracle / SQL Server / PostgreSQL", "選填；Oracle / SQL Server / PostgreSQL 的預設 schema"],
      ["信任服务器证书（仅用于自签名测试环境；默认关闭）", "Trust server certificate (self-signed test environments only; off by default)", "信任伺服器憑證（僅供自簽測試環境；預設關閉）"],
      ["密码", "Password", "密碼"],
      ["仅用于本次保存，不会写入配置或日志", "Used only for this save; never written to configuration or logs", "僅用於本次儲存，不會寫入設定或日誌"],
      ["可选；留空则使用凭据引用", "Optional; leave empty to use the credential reference", "選填；留空則使用憑證參照"],
      ["凭据引用", "Credential reference", "憑證參照"],
      ["只能使用字母、数字、下划线，且必须以字母或下划线开头；与上方密码二选一", "Letters, digits and underscores only, starting with a letter or underscore; use either this or the password above", "僅可使用字母、數字與底線，且必須以字母或底線開頭；與上方密碼擇一"],
      ["记住密码（保存到 DSH 凭据）", "Remember password (saved in DSH credentials)", "記住密碼（儲存至 DSH 憑證）"],
      ["客户端可执行文件", "Client executable", "用戶端執行檔"],
      ["可选；留空则自动从系统 PATH 查找。填写本机 MySQL 客户端可执行文件的绝对路径。", "Optional; when empty the client is resolved from the system PATH. Enter the absolute path of the MySQL client on this machine.", "選填；留空則自動從系統 PATH 尋找。填寫本機 MySQL 用戶端執行檔的絕對路徑。"],
      ["可选；留空则自动从系统 PATH 查找。填写本机 MySQL 客户端可执行文件的绝对路径。", "Optional; when empty the client is resolved from the system PATH. Enter the absolute path of the MySQL client on this machine.", "選填；留空則自動從系統 PATH 尋找。填寫本機 MySQL 用戶端執行檔的絕對路徑。"],
      ["本机 MySQL 客户端可执行文件的绝对路径", "Absolute path of the local MySQL client", "本機 MySQL 用戶端執行檔的絕對路徑"],
      ["保存并测试", "Save and test", "儲存並測試"],
      ["取消编辑", "Cancel editing", "取消編輯"],
      ["更新并测试", "Update and test", "更新並測試"],
      ["交付设置", "Delivery settings", "交付設定"],
      ["已授权目录", "Authorized directory", "已授權目錄"],
      ["结果保存目录", "Result directory", "結果儲存目錄"],
      ["Excel、CSV、SQL 只会写入这里", "Excel, CSV and SQL files are written here only", "Excel、CSV、SQL 只會寫入這裡"],
      ["选择目录", "Choose directory", "選擇目錄"],
      ["保存目录", "Save directory", "儲存目錄"],
      ["问 AI", "Ask AI", "詢問 AI"],
      ["直接用自然语言描述你要的数据。AI 会自己查表、写并执行只读 SQL；不清楚时会反问你，可继续补充或修改。", "Describe the data you need in natural language. The assistant explores schemas, writes and runs read-only SQL, and asks follow-up questions when the requirement is ambiguous.", "直接用自然語言描述你要的資料。AI 會自行查表、撰寫並執行唯讀 SQL；不清楚時會反問，可繼續補充或修改。"],
      ["例如：统计 2026 年各数据库备份失败的次数，按失败次数从高到低排序", "e.g. Count failed backups per database in 2026, highest first", "例如：統計 2026 年各資料庫備份失敗的次數，依失敗次數由高到低排序"],
      ["发送", "Send", "傳送"],
      ["查询结果", "Query results", "查詢結果"],
      ["清理历史结果", "Clear history", "清除歷史結果"],
      ["清理插件内部历史快照，仅保留最近 10 个；已导出的 Excel/CSV/SQL 文件不会受影响。", "Clear the plugin's internal result snapshots, keeping the latest 10. Exported Excel/CSV/SQL files are untouched.", "清除外掛內部歷史快照，僅保留最近 10 個；已匯出的 Excel/CSV/SQL 檔案不受影響。"],
      ["还没有结果。向 AI 提问并执行查询后，这里会列出可查看与导出的结果。", "No results yet. Ask the assistant and run a query; viewable and exportable results will appear here.", "尚無結果。向 AI 提問並執行查詢後，這裡會列出可檢視與匯出的結果。"],
      ["查看", "View", "檢視"],
      ["导出", "Export", "匯出"],
      ["导出 Excel、CSV、SQL 三个文件", "Export Excel, CSV and SQL", "匯出 Excel、CSV、SQL 三個檔案"],
      ["已导出", "Exported", "已匯出"],
      ["完整", "Complete", "完整"],
      ["不完整", "Incomplete", "不完整"],
      ["数据快照已清理；不能导出，但仍可查看当时执行的 SQL。", "The data snapshot was cleared; it cannot be exported, but the SQL is still available.", "資料快照已清除；無法匯出，但仍可檢視當時執行的 SQL。"],
      ["该结果的数据快照已清理，不能再查看预览或导出；SQL 仍保留在下方。", "The snapshot for this result was cleared; preview and export are unavailable, but the SQL is kept below.", "該結果的資料快照已清除，無法再檢視預覽或匯出；SQL 仍保留在下方。"],
      ["本次结果不完整（达到行数或字节上限），不能导出；请缩小范围或先聚合再重试。", "This result is incomplete (row or byte limit reached) and cannot be exported. Narrow the query or aggregate first.", "本次結果不完整（達到列數或位元組上限），無法匯出；請縮小範圍或先彙總再重試。"],
      ["仅预览前 20 行；导出使用完整结果。", "Preview shows the first 20 rows only; export uses the complete result.", "僅預覽前 20 列；匯出使用完整結果。"],
      ["上一页", "Previous", "上一頁"],
      ["下一页", "Next", "下一頁"],
      ["复制其他项目的数据库连接", "Copy a database connection from another project", "複製其他專案的資料庫連線"],
      ["只复制连接配置（主机、端口、账号、库名、凭据引用），不复制查询结果、会话和保存目录。", "Copies connection settings only (host, port, user, database, credential reference); results, sessions and the delivery directory are not copied.", "僅複製連線設定（主機、連接埠、帳號、資料庫、憑證參照），不複製查詢結果、工作階段與儲存目錄。"],
      ["正在读取其他项目的连接…", "Reading connections from other projects…", "正在讀取其他專案的連線…"],
      ["没有其他项目可复制的数据库连接。", "No connections in other projects to copy.", "沒有其他專案可複製的資料庫連線。"],
      ["读取失败，请重试。", "Failed to read. Please retry.", "讀取失敗，請重試。"],
      ["复制", "Copy", "複製"],
      ["已复制", "Copied", "已複製"],
      ["项目", "Project", "專案"],
      ["还没有项目", "No projects yet", "尚無專案"],
      ["选择项目", "Select project", "選擇專案"],
      ["删除项目", "Delete project", "刪除專案"],
      ["用于区分不同的数据库分析项目", "Identifies this analysis project", "用於區分不同的資料庫分析專案"],
      ["例如：2026 年备份分析", "e.g. 2026 backup analysis", "例如：2026 年備份分析"],
      ["可选，写一句项目说明", "Optional one-line description", "選填，寫一句專案說明"],
      ["例如：只读连接 app_db，分析备份失败", "e.g. read-only connection to app_db, analyzing backup failures", "例如：唯讀連線 app_db，分析備份失敗"],
      ["新建项目", "New project", "新增專案"],
      ["重命名", "Rename", "重新命名"],
      ["项目名称", "Project name", "專案名稱"],
      ["项目说明", "Description", "專案說明"],
      ["删除只移除项目记录，已生成的成果文件与证据包会保留在磁盘。", "Deleting removes the project record only; generated files and evidence packs stay on disk.", "刪除只移除專案記錄，已產生的成果檔案與證據包會保留在磁碟。"],
      ["保存", "Save", "儲存"],
      ["取消", "Cancel", "取消"],
      ["删除", "Delete", "刪除"],
      ["连接未通过测试", "Connection did not pass the test", "連線未通過測試"],
      ["询问 AI", "Ask AI", "詢問 AI"],
      ["已发送到 AI 会话，正在切换过去…", "Sent to an AI session; switching over…", "已傳送至 AI 工作階段，正在切換過去…"],
      ["密码与凭据引用只能二选一：要记住密码就清空引用名，要用已有引用就不填密码。", "Use either a password or a credential reference: clear the reference to remember a password, or leave the password empty to use the reference.", "密碼與憑證參照只能擇一：要記住密碼就清空參照名稱，要使用既有參照就不填密碼。"],
      ["端口必须是 1-65535 之间的整数。", "Port must be an integer between 1 and 65535.", "連接埠必須是 1–65535 之間的整數。"],
      ["当前环境不支持目录选择，请手动输入本机绝对路径。", "Directory picking is unavailable here; enter the absolute path manually.", "目前環境不支援目錄選擇，請手動輸入本機絕對路徑。"],
      ["数据库连接已保存", "Connection saved", "資料庫連線已儲存"],
      ["数据库连接已更新", "Connection updated", "資料庫連線已更新"],
      ["例如 生产库 / 本地 SQLite", "e.g. Production DB / local SQLite", "例如 生產庫 / 本機 SQLite"],
      ["只能使用字母、数字、下划线，且以字母或下划线开头；与上方密码二选一", "Letters, digits and underscores only, starting with a letter or underscore; use either this or the password above", "僅可使用字母、數字與底線，且必須以字母或底線開頭；與上方密碼擇一"],
      ["未设置凭据引用", "No credential reference", "未設定憑證參照"],
      ["凭据引用已配置", "Credential reference configured", "憑證參照已設定"],
      ["左侧", "Left", "左側"],
      [" 发送", " Send", " 傳送"],
      [" 正在加载新项目的数据…", " Loading the new project…", " 正在載入新專案的資料…"],
      [" 正在读取其他项目的连接…", " Reading connections from other projects…", " 正在讀取其他專案的連線…"],
      ["会话服务不可用，请刷新页面后重试；若仍失败，请重启 DSH。", "Session service is unavailable. Refresh the page; if it still fails, restart DSH.", "工作階段服務無法使用，請重新整理頁面後重試；若仍失敗，請重新啟動 DSH。"],
      ["会话发送服务不可用，请刷新页面后重试；若仍失败，请重启 DSH。", "Session delivery is unavailable. Refresh the page; if it still fails, restart DSH.", "工作階段傳送服務無法使用，請重新整理頁面後重試；若仍失敗，請重新啟動 DSH。"],
      ["会话拒绝接收本次请求。", "The session rejected this request.", "工作階段拒絕接收本次請求。"],
      ["文件", "File", "檔案"],
      ["服务名 / SID", "Service name / SID", "服務名稱 / SID"],
      ["连接已保存，但本次密码未记住；后续查询需要改用 DSH 凭据引用。", "The connection was saved, but this password was not remembered; later queries must use a DSH credential reference.", "連線已儲存，但本次密碼未被記住；後續查詢需改用 DSH 憑證參照。"],
      ["数据库连接已保存，并已通过测试连接。", "Connection saved and test passed.", "資料庫連線已儲存，並已通過測試連線。"],
      ["数据库连接已更新，并已通过测试连接。", "Connection updated and test passed.", "資料庫連線已更新，並已通過測試連線。"],
      ["已复制数据库连接", "Copied database connection", "已複製資料庫連線"],
      ["已删除连接", "Deleted connection", "已刪除連線"],
      ["已导出到", "Exported to", "已匯出至"],
      ["已清理", "Cleared", "已清除"],
      ["个历史快照，保留", "snapshots, kept", "個歷史快照，保留"],
      ["个；导出的文件未受影响。", "; exported files are untouched.", "個；匯出的檔案未受影響。"],
      ["个数据源", "sources", "個資料來源"],
      ["条结果", "results", "筆結果"],
      ["第", "Page", "第"],
      ["页 · 共", "·", "頁 · 共"],
      ["保存目录：", "Save directory: ", "儲存目錄："],
      ["询问 AI 时出错", "Failed to ask AI", "詢問 AI 時發生錯誤"],
    ];

    /** Regex rules for the dynamic strings that cannot be exact table keys. */
    const UI_RULES = {
      en: [
        [/^(\d+) 条结果$/, (m) => `${m[1]} results`],
        [/^(\d+) 个数据源 · 结果 (\d+) 个$/, (m) => `${m[1]} sources · ${m[2]} results`],
        [/^第 (\d+) \/ (\d+) 页 · 共 (\d+) 条$/, (m) => `Page ${m[1]} / ${m[2]} · ${m[3]} total`],
        [/^保存目录：(.+)$/, (m) => `Save directory: ${m[1]}`],
        [/^已复制数据库连接：(.+)$/, (m) => `Copied connection: ${m[1]}`],
        [/^已删除连接：(.+)$/, (m) => `Deleted connection: ${m[1]}`],
        [/^已发送到会话 (.+)，正在切换过去；后续可在该会话继续追问。$/, (m) => `Sent to session ${m[1]}; switching over. Continue there if needed.`],
        [/^已清理 (\d+) 个历史快照，保留 (\d+) 个；导出的文件未受影响。$/, (m) => `Cleared ${m[1]} snapshots, kept ${m[2]}; exported files are untouched.`],
        [/^数据库连接已保存，但测试连接未通过：(.+)$/, (m) => `Connection saved, but the test failed: ${m[1]}`],
        [/^数据库连接已更新，但测试连接未通过：(.+)$/, (m) => `Connection updated, but the test failed: ${m[1]}`],
        [/^已导出到 (.+?)(?:：(.+))?$/, (m) => (m[2] ? `Exported to ${m[1]}: ${m[2]}` : `Exported to ${m[1]}`)],
        [/^(\d+) 行 · 完整性：(.+) · (\d+) ms(.*)$/, (m) => `${m[1]} rows · ${m[2] === '完整' ? 'complete' : 'incomplete'} · ${m[3]} ms${m[4] ?? ''}`],
        [/^保存目录必须是绝对路径.*$/, () => 'The save directory must be an absolute path.'],
        [/^保存目录不能为空。$/, () => 'The save directory cannot be empty.'],
        [/^指定路径不是文件夹。$/, () => 'The specified path is not a folder.'],
        [/^尚未设置保存目录。.*$/, () => 'No save directory is set. Choose one at the top of the project first.'],
        [/^数据库「(.+)」尚未连接成功。请先测试连接。$/, (m) => `Database “${m[1]}” is not connected. Test the connection first.`],
        [/^导出只能写入项目设置里授权的保存目录。$/, () => 'Exports can only be written to the directory authorized in the project settings.'],
        [/^结果不完整.*不能导出.*$/, () => 'The result is incomplete and cannot be exported. Narrow the query or aggregate first.'],
        [/^该结果属于其他会话.*$/, () => 'This result belongs to another session.'],
        [/^分析项目不存在：(.+)$/, (m) => `Project not found: ${m[1]}`],
        [/^项目名称已存在：(.+)$/, (m) => `A project with this name already exists: ${m[1]}`],
        [/^未知数据库类型：(.+)$/, (m) => `Unknown database type: ${m[1]}`],
      ],
      'zh-TW': [
        [/^(\d+) 条结果$/, (m) => `${m[1]} 筆結果`],
        [/^(\d+) 个数据源 · 结果 (\d+) 个$/, (m) => `${m[1]} 個資料來源 · 結果 ${m[2]} 個`],
        [/^第 (\d+) \/ (\d+) 页 · 共 (\d+) 条$/, (m) => `第 ${m[1]} / ${m[2]} 頁 · 共 ${m[3]} 筆`],
        [/^保存目录：(.+)$/, (m) => `儲存目錄：${m[1]}`],
        [/^已复制数据库连接：(.+)$/, (m) => `已複製資料庫連線：${m[1]}`],
        [/^已删除连接：(.+)$/, (m) => `已刪除連線：${m[1]}`],
        [/^已发送到会话 (.+)，正在切换过去；后续可在该会话继续追问。$/, (m) => `已傳送至工作階段 ${m[1]}，正在切換過去；後續可在該工作階段繼續追問。`],
        [/^已清理 (\d+) 个历史快照，保留 (\d+) 个；导出的文件未受影响。$/, (m) => `已清除 ${m[1]} 個歷史快照，保留 ${m[2]} 個；匯出的檔案未受影響。`],
        [/^数据库连接已保存，但测试连接未通过：(.+)$/, (m) => `資料庫連線已儲存，但測試連線未通過：${m[1]}`],
        [/^数据库连接已更新，但测试连接未通过：(.+)$/, (m) => `資料庫連線已更新，但測試連線未通過：${m[1]}`],
        [/^已导出到 (.+?)(?:：(.+))?$/, (m) => (m[2] ? `已匯出至 ${m[1]}：${m[2]}` : `已匯出至 ${m[1]}`)],
        [/^(\d+) 行 · 完整性：(.+) · (\d+) ms(.*)$/, (m) => `${m[1]} 列 · 完整性：${m[2]} · ${m[3]} ms${m[4] ?? ''}`],
        [/^保存目录必须是绝对路径.*$/, () => '儲存目錄必須是絕對路徑。'],
        [/^保存目录不能为空。$/, () => '儲存目錄不能為空。'],
        [/^指定路径不是文件夹。$/, () => '指定路徑不是資料夾。'],
        [/^尚未设置保存目录。.*$/, () => '尚未設定儲存目錄。請先在專案頂端選擇儲存資料夾。'],
        [/^数据库「(.+)」尚未连接成功。请先测试连接。$/, (m) => `資料庫「${m[1]}」尚未連線成功。請先測試連線。`],
        [/^导出只能写入项目设置里授权的保存目录。$/, () => '匯出只能寫入專案設定中授權的儲存目錄。'],
        [/^结果不完整.*不能导出.*$/, () => '結果不完整，無法匯出。請縮小查詢範圍或先彙總。'],
        [/^该结果属于其他会话.*$/, () => '此結果屬於其他工作階段。'],
        [/^分析项目不存在：(.+)$/, (m) => `分析專案不存在：${m[1]}`],
        [/^项目名称已存在：(.+)$/, (m) => `專案名稱已存在：${m[1]}`],
        [/^未知数据库类型：(.+)$/, (m) => `未知的資料庫類型：${m[1]}`],
      ],
    };

    const UI_TEXT = { en: Object.create(null), 'zh-TW': Object.create(null) };
    for (const [zh, en, tw] of UI_TRANSLATIONS) {
      UI_TEXT.en[zh] = en;
      UI_TEXT['zh-TW'][zh] = tw;
    }
    // Legacy keyed labels (panel label, refresh, …) get a Traditional dictionary
    // as well; DSH falls back to zh for any key left out.
    DICT['zh-TW'] = Object.fromEntries(Object.entries(DICT.zh).map(([key, value]) => [key, UI_TEXT['zh-TW'][value] ?? value]));

    // Additional DSH languages. static labels are exact matches; keyed labels
    // fall back to tr() when no per-language DICT is registered.
    const UI_EXTRA = {"ja":{"AI 数据库助手":"AIデータベースアシスタント","用自然语言查询与分析数据":"自然言語でデータを照会・分析","只读连接 MySQL / PostgreSQL / SQL Server / Oracle / SQLite；AI 自己查表、写 SQL、执行并解释结果。需要导出时生成 Excel、CSV 和最终 SQL。":"MySQL / PostgreSQL / SQL Server / Oracle / SQLite への読み取り専用接続。 AI はテーブルを検索し、SQL を書き、実行して結果を解釈します。エクスポートが必要な場合は、Excel、CSV、および最終 SQL を生成します。","正在切换项目…":"プロジェクトを切り替えています…","正在切换项目":"プロジェクトの切り替え","未选择项目":"項目が選択されていません","工作台加载失败":"ワークベンチのロードに失敗しました","重试":"再試行","本地插件服务暂时没有返回数据。已有项目不会丢失；可直接重试，仍失败时请查看宿主日志。":"ローカル プラグイン サービスはまだデータを返しません。既存のプロジェクトは失われません。直接再試行できます。それでも失敗する場合は、ホストのログを確認してください。","正在加载新项目的数据…":"新しいプロジェクトのデータをロードしています...","先建一个项目":"最初にプロジェクトをビルドする","项目保存数据库连接、保存目录和会话历史。点上方「新建项目」开始。":"プロジェクトはデータベース接続、ディレクトリ、およびセッション履歴を保存します。上の「新しいプロジェクト」をクリックして開始します。","数据库连接":"データベース接続","收起设置":"設定を折りたたむ","添加连接":"接続の追加","复制其他项目连接":"他のプロジェクト接続をコピーする","刷新":"リフレッシュ","还没有数据库连接。点「添加连接」选择数据库类型（MySQL / PostgreSQL / SQL Server / Oracle / SQLite）。":"まだデータベース接続がありません。 「接続の追加」をクリックしてデータベースの種類 (MySQL / PostgreSQL / SQL Server / Oracle / SQLite) を選択します。","测试连接":"接続テスト","编辑":"編集","删除连接":"接続の削除","可用":"利用可能","不可用":"利用できません","未测试":"テストされていません","新建数据库连接":"新しいデータベース接続を作成する","编辑数据库连接":"データベース接続の編集","使用只读账号；密码保存在 DSH 凭据中，这里只填引用名。SQLite 以只读方式打开文件。":"読み取り専用アカウントを使用します。パスワードは DSH 認証情報に保存され、ここには参照名のみが入力されます。 SQLite はファイルを読み取り専用で開きます。","数据库类型":"データベースの種類","连接名称":"接続名","数据库文件路径":"データベースファイルのパス","绝对路径；只会以只读方式打开，不会创建或修改文件":"絶対パス。読み取り専用でのみ開かれ、ファイルは作成または変更されません","本机绝对路径（按当前操作系统填写）":"ローカル マシンの絶対パス (現在のオペレーティング システムに従って入力)","主机":"ホスト","端口":"ポート","只读账号":"読み取り専用アカウント","数据库":"データベース","可选；Oracle/SQL Server/PostgreSQL 的默认 schema":"オプション。 Oracle/SQL Server/PostgreSQL のデフォルトのスキーマ","信任服务器证书（仅用于自签名测试环境；默认关闭）":"サーバー証明書を信頼する (自己署名テスト環境のみ、デフォルトでオフ)","密码":"パスワード","仅用于本次保存，不会写入配置或日志":"この保存にのみ使用され、構成やログは書き込まれません。","可选；留空则使用凭据引用":"オプション。資格情報参照を使用するには空白のままにします","凭据引用":"資格情報の参照","只能使用字母、数字、下划线，且必须以字母或下划线开头；与上方密码二选一":"文字、数字、アンダースコアのみを使用でき、文字またはアンダースコアで始める必要があります。上のパスワードから 1 つを選択してください","记住密码（保存到 DSH 凭据）":"パスワードを記憶する (DSH 認証情報に保存)","客户端可执行文件":"クライアント実行ファイル","可选；留空则自动从系统 PATH 查找。填写本机 MySQL 客户端可执行文件的绝对路径。":"オプション。システム PATH から自動的に検索するには、空白のままにします。ネイティブ MySQL クライアント実行可能ファイルへの絶対パスを入力します。","本机 MySQL 客户端可执行文件的绝对路径":"ネイティブ MySQL クライアント実行可能ファイルへの絶対パス","保存并测试":"保存してテストする","取消编辑":"編集をキャンセルする","更新并测试":"アップデートとテスト","交付设置":"配信設定","已授权目录":"許可されたディレクトリ","结果保存目录":"結果保存ディレクトリ","Excel、CSV、SQL 只会写入这里":"Excel、CSV、SQLはここのみに記述します","选择目录":"ディレクトリの選択","保存目录":"保存ディレクトリ","问 AI":"AIに聞く","直接用自然语言描述你要的数据。AI 会自己查表、写并执行只读 SQL；不清楚时会反问你，可继续补充或修改。":"必要なデータを自然言語で直接記述します。 AI はテーブルを検索し、読み取り専用 SQL を記述して実行します。不明な点があるかどうかを尋ねられますが、追加または変更を続けることができます。","例如：统计 2026 年各数据库备份失败的次数，按失败次数从高到低排序":"たとえば、2026 年の各データベースのバックアップ失敗数をカウントし、失敗数の多い順に並べ替えます。","发送":"送信","查询结果":"クエリ結果","清理历史结果":"履歴結果を整理","清理插件内部历史快照，仅保留最近 10 个；已导出的 Excel/CSV/SQL 文件不会受影响。":"プラグイン内部の履歴スナップショットをクリーンアップし、最後の 10 個のみを保持します。エクスポートされた Excel/CSV/SQL ファイルには影響しません。","还没有结果。向 AI 提问并执行查询后，这里会列出可查看与导出的结果。":"まだ結果はありません。 AI に質問してクエリを実行すると、結果がここにリストされ、表示およびエクスポートできます。","查看":"表示","导出":"エクスポート","导出 Excel、CSV、SQL 三个文件":"Excel、CSV、SQLの3つのファイルをエクスポート","已导出":"輸出済み","完整":"完了","不完整":"不完全な","数据快照已清理；不能导出，但仍可查看当时执行的 SQL。":"データ スナップショットはクリーンアップされました。エクスポートすることはできませんが、その時点で実行された SQL を表示することはできます。","该结果的数据快照已清理，不能再查看预览或导出；SQL 仍保留在下方。":"この結果のデータ スナップショットはクリーンアップされたため、プレビューまたはエクスポートで表示できなくなりました。 SQL は以下に残ります。","本次结果不完整（达到行数或字节上限），不能导出；请缩小范围或先聚合再重试。":"今回の結果は不完全 (行数またはバイト数の上限に達している) であるため、エクスポートできません。範囲を狭めるか集約してから再試行してください。","仅预览前 20 行；导出使用完整结果。":"最初の 20 行のみがプレビューされます。エクスポートでは完全な結果が使用されます。","上一页":"前のページへ","下一页":"次のページ","复制其他项目的数据库连接":"他のプロジェクトからデータベース接続をコピーする","只复制连接配置（主机、端口、账号、库名、凭据引用），不复制查询结果、会话和保存目录。":"接続構成 (ホスト、ポート、アカウント、ライブラリ名、資格情報参照) のみがコピーされ、クエリ結果、セッション、および保存ディレクトリはコピーされません。","正在读取其他项目的连接…":"他のプロジェクトからの接続を読み取り中...","没有其他项目可复制的数据库连接。":"他のプロジェクト用に複製するデータベース接続はありません。","读取失败，请重试。":"読み取りに失敗しました。もう一度お試しください。","复制":"コピー","已复制":"コピーされました","项目":"プロジェクト","还没有项目":"まだプロジェクトはありません","选择项目":"項目を選択","删除项目":"プロジェクトの削除","用于区分不同的数据库分析项目":"さまざまなデータベース分析プロジェクトを区別するために使用されます","例如：2026 年备份分析":"例: 2026 年のバックアップ分析","可选，写一句项目说明":"オプション、プロジェクトの説明を記入します","例如：只读连接 app_db，分析备份失败":"例: 読み取り専用接続 app_db、分析バックアップ失敗","新建项目":"新しいプロジェクト","重命名":"名前の変更","项目名称":"プロジェクト名","项目说明":"プロジェクトの説明","删除只移除项目记录，已生成的成果文件与证据包会保留在磁盘。":"削除するとプロジェクト レコードのみが削除され、生成された結果ファイルと証拠パッケージはディスク上に残ります。","保存":"保存","取消":"キャンセル","删除":"削除","连接未通过测试":"接続テストに失敗しました","询问 AI":"AIに聞く","已发送到 AI 会话，正在切换过去…":"AI セッションに送信され、そこで切り替えられます...","密码与凭据引用只能二选一：要记住密码就清空引用名，要用已有引用就不填密码。":"パスワード参照と認証情報参照のどちらかのみを選択できます。パスワードを覚えておきたい場合は、参照名をクリアします。既存の参照を使用する場合は、パスワードを空白のままにしてください。","端口必须是 1-65535 之间的整数。":"ポートは 1 ～ 65535 の整数である必要があります。","当前环境不支持目录选择，请手动输入本机绝对路径。":"現在の環境ではディレクトリの選択はサポートされていません。ローカル マシンの絶対パスを手動で入力してください。","数据库连接已保存":"データベース接続が保存されました","数据库连接已更新":"データベース接続が更新されました","例如 生产库 / 本地 SQLite":"例: 本番ライブラリ/ローカル SQLite","只能使用字母、数字、下划线，且以字母或下划线开头；与上方密码二选一":"文字、数字、アンダースコアのみを使用でき、文字またはアンダースコアで始まります。上記のパスワードのいずれかを選択してください","未设置凭据引用":"資格情報参照が設定されていません","凭据引用已配置":"資格情報参照が構成されました","左侧":"左側"," 发送":"送信する"," 正在加载新项目的数据…":"新しいプロジェクトのデータをロードしています..."," 正在读取其他项目的连接…":"他のプロジェクトからの接続を読み取り中...","会话服务不可用，请刷新页面后重试；若仍失败，请重启 DSH。":"セッション サービスは利用できません。ページを更新して再試行してください。それでも失敗する場合は、DSH を再起動してください。","会话发送服务不可用，请刷新页面后重试；若仍失败，请重启 DSH。":"セッション送信サービスは利用できません。ページを更新して再試行してください。それでも失敗する場合は、DSH を再起動してください。","会话拒绝接收本次请求。":"セッションはこのリクエストの受け入れを拒否します。","文件":"ファイル","服务名 / SID":"サービス名/SID","连接已保存，但本次密码未记住；后续查询需要改用 DSH 凭据引用。":"接続は保存されましたが、今回のパスワードは記憶されていません。後続のクエリでは、代わりに DSH 資格情報参照を使用する必要があります。","数据库连接已保存，并已通过测试连接。":"データベース接続が保存され、テスト接続が渡されます。","数据库连接已更新，并已通过测试连接。":"データベース接続が更新され、テスト接続に合格しました。","已复制数据库连接":"データベース接続がコピーされました","已删除连接":"接続が削除されました","已导出到":"輸出先","已清理":"掃除済み","个历史快照，保留":"履歴スナップショット、保持","个；导出的文件未受影响。":";エクスポートされたファイルは影響を受けません。","个数据源":"データソース","条结果":"結果","第":"いいえ。","页 · 共":"ページ数 · 合計","保存目录：":"保存ディレクトリ:","询问 AI 时出错":"AI への問い合わせ中にエラーが発生しました","确认删除项目「{name}」？项目配置会删除，历史结果文件保留在磁盘上。":"アイテム「{name}」を削除してもよろしいですか?プロジェクト構成は削除され、履歴結果ファイルはディスク上に残ります。","确认删除项目「{name}」？{hint}":"アイテム「{name}」を削除してもよろしいですか? {ヒント}","删除连接「{name}」（{dialect}）？只会删除 DSH 中保存的连接配置，不会删除真实数据库、SQLite 文件或历史导出文件。":"接続「{名前}」（{方言}）を削除しますか？ DSH に保存された接続構成のみが削除され、実際のデータベース、SQLite ファイル、履歴エクスポート ファイルは削除されません。","清理插件内部历史快照，仅保留最近 {keep} 个；已导出的 Excel/CSV/SQL 文件不会受影响。":"プラグイン内部の履歴スナップショットをクリーンアップし、最新の {keep} のみを保持します。エクスポートされた Excel/CSV/SQL ファイルには影響しません。","页面渲染出错":"ページの描画エラー","插件界面遇到一个错误，数据不会被修改。可以先点重试；若重复出现，请把下面的错误信息发给 AI 排查。":"プラグイン インターフェイスでエラーが発生したため、データは変更されません。最初に「再試行」をクリックしても構いません。繰り返し発生する場合は、トラブルシューティングのために以下のエラー メッセージを AI に送信してください。","错误详情":"エラーの詳細","我在使用 DSH AI 数据库助手时遇到错误，请帮我定位并给出修复步骤。\n\n项目：{project}（{id}）\n错误：{message}\n\n请先判断原因（配置、客户端、权限、网络或插件缺陷），给出可执行排查步骤；如判断是插件缺陷，请指出文件与最小修复方案。不要修改生产数据，也不要向我索取密码。":"DSH AI データベース アシスタントの使用中にエラーが発生しました。場所を特定し、修復手順を教えてください。\n\nプロジェクト: {プロジェクト} ({id})\nエラー: {メッセージ}\n\nまず原因 (構成、クライアント、権限、ネットワークまたはプラグインの欠陥) を特定し、実行可能なトラブルシューティング手順を提供してください。プラグインの欠陥であると判断された場合は、ファイルと最小限の修復計画を示してください。本番データを変更したり、パスワードを要求したりしないでください。"},"ko":{"AI 数据库助手":"AI 데이터베이스 도우미","用自然语言查询与分析数据":"자연어로 데이터를 조회하고 분석하세요","只读连接 MySQL / PostgreSQL / SQL Server / Oracle / SQLite；AI 自己查表、写 SQL、执行并解释结果。需要导出时生成 Excel、CSV 和最终 SQL。":"MySQL / PostgreSQL / SQL Server / Oracle / SQLite에 대한 읽기 전용 연결; AI가 스스로 테이블을 조회하고, SQL을 작성하고, 결과를 실행하고 해석합니다. 내보내기가 필요한 경우 Excel, CSV 및 최종 SQL을 생성합니다.","正在切换项目…":"프로젝트 전환 중…","正在切换项目":"프로젝트 전환","未选择项目":"선택한 항목이 없습니다.","工作台加载失败":"워크벤치 로딩 실패","重试":"다시 시도","本地插件服务暂时没有返回数据。已有项目不会丢失；可直接重试，仍失败时请查看宿主日志。":"로컬 플러그인 서비스는 아직 데이터를 반환하지 않습니다. 기존 프로젝트는 손실되지 않습니다. 직접 다시 시도할 수 있습니다. 그래도 실패할 경우 호스트 로그를 확인하세요.","正在加载新项目的数据…":"새 프로젝트에 대한 데이터 로드 중...","先建一个项目":"먼저 프로젝트를 빌드하세요","项目保存数据库连接、保存目录和会话历史。点上方「新建项目」开始。":"프로젝트는 데이터베이스 연결, 디렉터리 및 세션 기록을 저장합니다. 시작하려면 위의 \"새 프로젝트\"를 클릭하세요.","数据库连接":"데이터베이스 연결","收起设置":"설정 접기","添加连接":"연결 추가","复制其他项目连接":"다른 프로젝트 연결 복사","刷新":"새로고침","还没有数据库连接。点「添加连接」选择数据库类型（MySQL / PostgreSQL / SQL Server / Oracle / SQLite）。":"아직 데이터베이스 연결이 없습니다. 데이터베이스 유형(MySQL / PostgreSQL / SQL Server / Oracle / SQLite)을 선택하려면 \"연결 추가\"를 클릭하세요.","测试连接":"연결 테스트","编辑":"편집","删除连接":"연결 삭제","可用":"가능","不可用":"사용할 수 없음","未测试":"테스트되지 않음","新建数据库连接":"새 데이터베이스 연결 만들기","编辑数据库连接":"데이터베이스 연결 편집","使用只读账号；密码保存在 DSH 凭据中，这里只填引用名。SQLite 以只读方式打开文件。":"읽기 전용 계정을 사용하십시오. 비밀번호는 DSH 자격 증명에 저장되며 여기에는 참조 이름만 입력됩니다. SQLite는 파일을 읽기 전용으로 엽니다.","数据库类型":"데이터베이스 유형","连接名称":"연결 이름","数据库文件路径":"데이터베이스 파일 경로","绝对路径；只会以只读方式打开，不会创建或修改文件":"절대 경로; 읽기 전용으로만 열리며 파일이 생성되거나 수정되지 않습니다.","本机绝对路径（按当前操作系统填写）":"로컬 머신의 절대 경로(현재 운영 체제에 따라 입력)","主机":"호스트","端口":"항구","只读账号":"읽기 전용 계정","数据库":"데이터베이스","可选；Oracle/SQL Server/PostgreSQL 的默认 schema":"선택 과목; Oracle/SQL Server/PostgreSQL의 기본 스키마","信任服务器证书（仅用于自签名测试环境；默认关闭）":"신뢰 서버 인증서(자체 서명된 테스트 환경에만 해당, 기본적으로 꺼져 있음)","密码":"비밀번호","仅用于本次保存，不会写入配置或日志":"이 저장에만 사용되며 구성이나 로그가 기록되지 않습니다.","可选；留空则使用凭据引用":"선택사항; 자격 증명 참조를 사용하려면 비워 두세요.","凭据引用":"자격 증명 참조","只能使用字母、数字、下划线，且必须以字母或下划线开头；与上方密码二选一":"문자, 숫자, 밑줄만 사용할 수 있으며 문자나 밑줄로 시작해야 합니다. 위의 비밀번호 중 하나를 선택하세요","记住密码（保存到 DSH 凭据）":"비밀번호 기억(DSH 자격 증명에 저장)","客户端可执行文件":"클라이언트 실행 파일","可选；留空则自动从系统 PATH 查找。填写本机 MySQL 客户端可执行文件的绝对路径。":"선택사항; 시스템 PATH에서 자동으로 검색하려면 공백으로 두십시오. 기본 MySQL 클라이언트 실행 파일의 절대 경로를 입력합니다.","本机 MySQL 客户端可执行文件的绝对路径":"기본 MySQL 클라이언트 실행 파일의 절대 경로","保存并测试":"저장 및 테스트","取消编辑":"편집 취소","更新并测试":"업데이트 및 테스트","交付设置":"배송 설정","已授权目录":"승인된 디렉토리","结果保存目录":"결과 저장 디렉터리","Excel、CSV、SQL 只会写入这里":"Excel, CSV, SQL은 여기에만 작성됩니다.","选择目录":"디렉토리 선택","保存目录":"저장 디렉터리","问 AI":"AI에게 물어보세요","直接用自然语言描述你要的数据。AI 会自己查表、写并执行只读 SQL；不清楚时会反问你，可继续补充或修改。":"원하는 데이터를 자연어로 직접 기술해보세요. AI는 스스로 테이블을 조회하고 읽기 전용 SQL을 작성 및 실행합니다. 불분명한지 묻는 메시지가 표시되며 계속 추가하거나 수정할 수 있습니다.","例如：统计 2026 年各数据库备份失败的次数，按失败次数从高到低排序":"예를 들어 2026년 각 데이터베이스의 백업 실패 횟수를 계산하고 실패 횟수를 기준으로 높은 순으로 정렬합니다.","发送":"보내기","查询结果":"쿼리 결과","清理历史结果":"과거 결과 정리","清理插件内部历史快照，仅保留最近 10 个；已导出的 Excel/CSV/SQL 文件不会受影响。":"플러그인 내부 기록 스냅샷을 정리하고 마지막 10개만 유지합니다. 내보낸 Excel/CSV/SQL 파일은 영향을 받지 않습니다.","还没有结果。向 AI 提问并执行查询后，这里会列出可查看与导出的结果。":"아직 결과가 없습니다. AI에게 질문하고 쿼리를 실행하면 결과가 여기에 나열되며 확인하고 내보낼 수 있습니다.","查看":"보기","导出":"내보내기","导出 Excel、CSV、SQL 三个文件":"Excel, CSV, SQL 3개 파일 내보내기","已导出":"수출됨","完整":"완료","不完整":"불완전한","数据快照已清理；不能导出，但仍可查看当时执行的 SQL。":"데이터 스냅샷이 정리되었습니다. 내보낼 수는 없지만 그 당시 실행된 SQL은 계속 볼 수 있습니다.","该结果的数据快照已清理，不能再查看预览或导出；SQL 仍保留在下方。":"이 결과의 데이터 스냅샷은 정리되었으며 더 이상 미리보기나 내보내기에서 볼 수 없습니다. SQL은 아래에 남아 있습니다.","本次结果不完整（达到行数或字节上限），不能导出；请缩小范围或先聚合再重试。":"이번 결과는 불완전하며(행 또는 바이트의 상한에 도달함) 내보낼 수 없습니다. 먼저 범위를 좁히거나 집계한 후 다시 시도하세요.","仅预览前 20 行；导出使用完整结果。":"처음 20개 행만 미리 볼 수 있습니다. 내보내기에서는 전체 결과를 사용합니다.","上一页":"이전 페이지","下一页":"다음 페이지","复制其他项目的数据库连接":"다른 프로젝트의 데이터베이스 연결 복사","只复制连接配置（主机、端口、账号、库名、凭据引用），不复制查询结果、会话和保存目录。":"연결 구성(호스트, 포트, 계정, 라이브러리 이름, 자격 증명 참조)만 복사되고 쿼리 결과, 세션 및 저장 디렉터리는 복사되지 않습니다.","正在读取其他项目的连接…":"다른 프로젝트의 연결을 읽는 중...","没有其他项目可复制的数据库连接。":"다른 프로젝트에 대해 복제할 데이터베이스 연결이 없습니다.","读取失败，请重试。":"읽지 못했습니다. 다시 시도해 주세요.","复制":"복사","已复制":"복사됨","项目":"프로젝트","还没有项目":"아직 프로젝트가 없습니다.","选择项目":"항목 선택","删除项目":"프로젝트 삭제","用于区分不同的数据库分析项目":"다양한 데이터베이스 분석 프로젝트를 구별하는 데 사용됩니다.","例如：2026 年备份分析":"예: 2026년 백업 분석","可选，写一句项目说明":"선택사항, 프로젝트 설명 작성","例如：只读连接 app_db，分析备份失败":"예: 읽기 전용 연결 app_db, 분석 백업 실패","新建项目":"새 프로젝트","重命名":"이름 바꾸기","项目名称":"프로젝트 이름","项目说明":"프로젝트 설명","删除只移除项目记录，已生成的成果文件与证据包会保留在磁盘。":"삭제하면 프로젝트 기록만 제거되며, 생성된 결과 파일과 증거 패키지는 디스크에 남습니다.","保存":"저장","取消":"취소","删除":"삭제","连接未通过测试":"연결 실패 테스트","询问 AI":"AI에게 물어보세요","已发送到 AI 会话，正在切换过去…":"AI 세션으로 전송되었습니다. 거기서 전환 중입니다...","密码与凭据引用只能二选一：要记住密码就清空引用名，要用已有引用就不填密码。":"비밀번호와 자격 증명 참조 중에서만 선택할 수 있습니다. 비밀번호를 기억하려면 참조 이름을 지우세요. 기존 참조를 사용하려면 비밀번호를 비워 두세요.","端口必须是 1-65535 之间的整数。":"포트는 1~65535 사이의 정수여야 합니다.","当前环境不支持目录选择，请手动输入本机绝对路径。":"현재 환경은 디렉터리 선택을 지원하지 않습니다. 로컬 컴퓨터의 절대 경로를 수동으로 입력하세요.","数据库连接已保存":"데이터베이스 연결이 저장되었습니다.","数据库连接已更新":"데이터베이스 연결이 업데이트되었습니다.","例如 生产库 / 本地 SQLite":"예를 들어 프로덕션 라이브러리/로컬 SQLite","只能使用字母、数字、下划线，且以字母或下划线开头；与上方密码二选一":"문자, 숫자, 밑줄만 사용할 수 있으며, 문자나 밑줄로 시작합니다. 위의 비밀번호 중 하나를 선택하세요","未设置凭据引用":"자격증명 참조가 설정되지 않았습니다.","凭据引用已配置":"자격 증명 참조가 구성되었습니다.","左侧":"왼쪽"," 发送":"보내다"," 正在加载新项目的数据…":"새 프로젝트에 대한 데이터 로드 중..."," 正在读取其他项目的连接…":"다른 프로젝트의 연결을 읽는 중...","会话服务不可用，请刷新页面后重试；若仍失败，请重启 DSH。":"세션 서비스를 사용할 수 없습니다. 페이지를 새로 고친 후 다시 시도하세요. 그래도 실패하면 DSH를 다시 ​​시작하십시오.","会话发送服务不可用，请刷新页面后重试；若仍失败，请重启 DSH。":"세션 전송 서비스를 사용할 수 없습니다. 페이지를 새로 고친 후 다시 시도하세요. 그래도 실패하면 DSH를 다시 ​​시작하십시오.","会话拒绝接收本次请求。":"세션은 이 요청의 수락을 거부합니다.","文件":"파일","服务名 / SID":"서비스 이름/SID","连接已保存，但本次密码未记住；后续查询需要改用 DSH 凭据引用。":"연결이 저장되었지만 이번에는 비밀번호가 기억되지 않습니다. 후속 쿼리에서는 대신 DSH 자격 증명 참조를 사용해야 합니다.","数据库连接已保存，并已通过测试连接。":"데이터베이스 연결이 저장되고 테스트 연결이 통과됩니다.","数据库连接已更新，并已通过测试连接。":"데이터베이스 연결이 업데이트되었으며 테스트 연결이 통과되었습니다.","已复制数据库连接":"데이터베이스 연결이 복사되었습니다.","已删除连接":"연결이 삭제되었습니다.","已导出到":"다음으로 내보냈습니다.","已清理":"청소됨","个历史快照，保留":"기록 스냅샷, 보관됨","个；导出的文件未受影响。":"; 내보낸 파일은 영향을 받지 않습니다.","个数据源":"데이터 소스","条结果":"결과","第":"아니요.","页 · 共":"페이지 · 전체","保存目录：":"저장 디렉토리:","询问 AI 时出错":"AI를 심문하는 중 오류가 발생했습니다.","确认删除项目「{name}」？项目配置会删除，历史结果文件保留在磁盘上。":"\"{name}\" 항목을 삭제하시겠습니까? 프로젝트 구성이 삭제되고 기록 결과 파일이 디스크에 남아 있습니다.","确认删除项目「{name}」？{hint}":"\"{name}\" 항목을 삭제하시겠습니까? {힌트}","删除连接「{name}」（{dialect}）？只会删除 DSH 中保存的连接配置，不会删除真实数据库、SQLite 文件或历史导出文件。":"\"{name}\"({dialect}) 연결을 삭제하시겠습니까? DSH에 저장된 연결 구성만 삭제되며 실제 데이터베이스, SQLite 파일 또는 기록 내보내기 파일은 삭제되지 않습니다.","清理插件内部历史快照，仅保留最近 {keep} 个；已导出的 Excel/CSV/SQL 文件不会受影响。":"플러그인 내부 기록 스냅샷을 정리하고 가장 최근의 {keep}만 유지합니다. 내보낸 Excel/CSV/SQL 파일은 영향을 받지 않습니다.","页面渲染出错":"페이지 렌더링 오류","插件界面遇到一个错误，数据不会被修改。可以先点重试；若重复出现，请把下面的错误信息发给 AI 排查。":"플러그인 인터페이스에 오류가 발생하여 데이터가 수정되지 않습니다. 먼저 재시도를 클릭할 수 있습니다. 반복적으로 발생하는 경우, 문제 해결을 위해 아래 오류 메시지를 AI에 보내주세요.","错误详情":"오류 세부정보","我在使用 DSH AI 数据库助手时遇到错误，请帮我定位并给出修复步骤。\n\n项目：{project}（{id}）\n错误：{message}\n\n请先判断原因（配置、客户端、权限、网络或插件缺陷），给出可执行排查步骤；如判断是插件缺陷，请指出文件与最小修复方案。不要修改生产数据，也不要向我索取密码。":"DSH AI 데이터베이스 도우미를 사용할 때 오류가 발생했습니다. 제가 찾을 수 있도록 도와주시고 수리 단계를 알려주세요.\n\n프로젝트: {project} ({id})\n오류: {메시지}\n\n먼저 원인(구성, 클라이언트, 권한, 네트워크 또는 플러그인 결함)을 파악하고 실행 가능한 문제 해결 단계를 제공하십시오. 플러그인 불량으로 판단되면 파일과 최소한의 수리 계획을 알려주세요. 생산 데이터를 수정하지 마시고 비밀번호를 묻지 마세요."},"es":{"AI 数据库助手":"Asistente de base de datos de IA","用自然语言查询与分析数据":"Consulta y analiza datos con lenguaje natural","只读连接 MySQL / PostgreSQL / SQL Server / Oracle / SQLite；AI 自己查表、写 SQL、执行并解释结果。需要导出时生成 Excel、CSV 和最终 SQL。":"Conexión de solo lectura a MySQL/PostgreSQL/SQL Server/Oracle/SQLite; La IA busca tablas, escribe SQL, ejecuta e interpreta los resultados por sí misma. Genere Excel, CSV y SQL final cuando sea necesario exportar.","正在切换项目…":"Cambiando de proyecto...","正在切换项目":"Cambiando de proyecto","未选择项目":"No hay elementos seleccionados","工作台加载失败":"Error al cargar el banco de trabajo","重试":"Reintentar","本地插件服务暂时没有返回数据。已有项目不会丢失；可直接重试，仍失败时请查看宿主日志。":"El servicio de complemento local aún no devuelve datos. Los proyectos existentes no se perderán; puedes volver a intentarlo directamente. Si aún falla, verifique el registro del host.","正在加载新项目的数据…":"Cargando datos para nuevo proyecto...","先建一个项目":"Construya un proyecto primero","项目保存数据库连接、保存目录和会话历史。点上方「新建项目」开始。":"Los proyectos guardan conexiones de bases de datos, guardan directorios e historial de sesiones. Haga clic en \"Nuevo proyecto\" arriba para comenzar.","数据库连接":"Conexión de base de datos","收起设置":"Contraer configuración","添加连接":"Agregar conexión","复制其他项目连接":"Copiar otras conexiones del proyecto","刷新":"Actualizar","还没有数据库连接。点「添加连接」选择数据库类型（MySQL / PostgreSQL / SQL Server / Oracle / SQLite）。":"Aún no hay conexión a la base de datos. Haga clic en \"Agregar conexión\" para seleccionar el tipo de base de datos (MySQL / PostgreSQL / SQL Server / Oracle / SQLite).","测试连接":"Probar conexión","编辑":"Editar","删除连接":"Eliminar conexión","可用":"Disponible","不可用":"No disponible","未测试":"No probado","新建数据库连接":"Crear una nueva conexión de base de datos","编辑数据库连接":"Editar conexión de base de datos","使用只读账号；密码保存在 DSH 凭据中，这里只填引用名。SQLite 以只读方式打开文件。":"Utilice una cuenta de sólo lectura; la contraseña se guarda en las credenciales de DSH y aquí solo se completa el nombre de referencia. SQLite abre el archivo como de solo lectura.","数据库类型":"Tipo de base de datos","连接名称":"nombre de conexión","数据库文件路径":"Ruta del archivo de base de datos","绝对路径；只会以只读方式打开，不会创建或修改文件":"Camino absoluto; solo se abrirá en modo de solo lectura, el archivo no se creará ni modificará","本机绝对路径（按当前操作系统填写）":"Ruta absoluta de la máquina local (completar según el sistema operativo actual)","主机":"Anfitrión","端口":"puerto","只读账号":"Cuenta de solo lectura","数据库":"base de datos","可选；Oracle/SQL Server/PostgreSQL 的默认 schema":"Opcional; esquema predeterminado para Oracle/SQL Server/PostgreSQL","信任服务器证书（仅用于自签名测试环境；默认关闭）":"Certificado de servidor de confianza (solo para entornos de prueba autofirmados; desactivado de forma predeterminada)","密码":"Contraseña","仅用于本次保存，不会写入配置或日志":"Solo se utiliza para este guardado, no se escribirán configuraciones ni registros.","可选；留空则使用凭据引用":"Opcional; déjelo en blanco para usar la referencia de credencial","凭据引用":"Referencia de credencial","只能使用字母、数字、下划线，且必须以字母或下划线开头；与上方密码二选一":"Sólo se pueden utilizar letras, números y guiones bajos, y deben comenzar con una letra o un guión bajo; elija una de la contraseña de arriba","记住密码（保存到 DSH 凭据）":"Recordar contraseña (guardar en credenciales DSH)","客户端可执行文件":"Ejecutable del cliente","可选；留空则自动从系统 PATH 查找。填写本机 MySQL 客户端可执行文件的绝对路径。":"Opcional; déjelo en blanco para buscar automáticamente desde la RUTA del sistema. Complete la ruta absoluta al ejecutable del cliente MySQL nativo.","本机 MySQL 客户端可执行文件的绝对路径":"Ruta absoluta al ejecutable del cliente MySQL nativo","保存并测试":"Guardar y probar","取消编辑":"Cancelar edición","更新并测试":"Actualizar y probar","交付设置":"Configuración de entrega","已授权目录":"Directorio autorizado","结果保存目录":"Directorio para guardar resultados","Excel、CSV、SQL 只会写入这里":"Excel, CSV, SQL solo se escribirán aquí","选择目录":"Seleccionar directorio","保存目录":"Guardar directorio","问 AI":"Pregúntale a la IA","直接用自然语言描述你要的数据。AI 会自己查表、写并执行只读 SQL；不清楚时会反问你，可继续补充或修改。":"Describe directamente los datos que deseas en lenguaje natural. La IA buscará tablas, escribirá y ejecutará SQL de solo lectura por sí misma; Le preguntará si no está claro y podrá continuar agregándolo o modificándolo.","例如：统计 2026 年各数据库备份失败的次数，按失败次数从高到低排序":"Por ejemplo: cuente la cantidad de fallas de copia de seguridad para cada base de datos en 2026 y ordénelas de mayor a menor según la cantidad de fallas.","发送":"Enviar","查询结果":"Resultados de la consulta","清理历史结果":"Limpiar resultados históricos","清理插件内部历史快照，仅保留最近 10 个；已导出的 Excel/CSV/SQL 文件不会受影响。":"Limpiar las instantáneas históricas internas del complemento y conservar solo las últimas 10; Los archivos Excel/CSV/SQL exportados no se verán afectados.","还没有结果。向 AI 提问并执行查询后，这里会列出可查看与导出的结果。":"Aún no hay resultados. Después de hacerle una pregunta a la IA y ejecutar una consulta, los resultados se enumeran aquí y se pueden ver y exportar.","查看":"Ver","导出":"Exportar","导出 Excel、CSV、SQL 三个文件":"Exportar tres archivos Excel, CSV, SQL","已导出":"Exportado","完整":"completo","不完整":"incompleto","数据快照已清理；不能导出，但仍可查看当时执行的 SQL。":"La instantánea de datos se ha limpiado; no se puede exportar, pero aún se puede ver el SQL ejecutado en ese momento.","该结果的数据快照已清理，不能再查看预览或导出；SQL 仍保留在下方。":"La instantánea de datos de este resultado se limpió y ya no se puede ver en la vista previa ni en la exportación; el SQL permanece debajo.","本次结果不完整（达到行数或字节上限），不能导出；请缩小范围或先聚合再重试。":"Esta vez el resultado está incompleto (se ha alcanzado el límite superior de filas o bytes) y no se puede exportar; reduzca el rango o agréguelo primero y vuelva a intentarlo.","仅预览前 20 行；导出使用完整结果。":"Sólo se obtienen una vista previa de las primeras 20 filas; la exportación utiliza los resultados completos.","上一页":"Página anterior","下一页":"Página siguiente","复制其他项目的数据库连接":"Copiar conexiones de bases de datos de otros proyectos","只复制连接配置（主机、端口、账号、库名、凭据引用），不复制查询结果、会话和保存目录。":"Solo se copia la configuración de la conexión (host, puerto, cuenta, nombre de la biblioteca, referencia de credenciales) y no se copian los resultados de las consultas, las sesiones ni los directorios de guardado.","正在读取其他项目的连接…":"Leyendo conexiones de otros proyectos...","没有其他项目可复制的数据库连接。":"No hay conexiones de bases de datos para replicar para otros proyectos.","读取失败，请重试。":"No se pudo leer, inténtalo de nuevo.","复制":"Copiar","已复制":"Copiado","项目":"Proyecto","还没有项目":"Aún no hay proyectos","选择项目":"Seleccionar elemento","删除项目":"Eliminar proyecto","用于区分不同的数据库分析项目":"Se utiliza para distinguir diferentes proyectos de análisis de bases de datos.","例如：2026 年备份分析":"Por ejemplo: Análisis de copia de seguridad de 2026","可选，写一句项目说明":"Opcional, escriba una descripción del proyecto.","例如：只读连接 app_db，分析备份失败":"Por ejemplo: conexión de solo lectura app_db, error en la copia de seguridad del análisis","新建项目":"Nuevo proyecto","重命名":"Cambiar nombre","项目名称":"Nombre del proyecto","项目说明":"Descripción del proyecto","删除只移除项目记录，已生成的成果文件与证据包会保留在磁盘。":"La eliminación solo elimina el registro del proyecto y los archivos de resultados generados y los paquetes de evidencia permanecerán en el disco.","保存":"Guardar","取消":"Cancelar","删除":"Eliminar","连接未通过测试":"Prueba de conexión fallida","询问 AI":"Pregúntale a la IA","已发送到 AI 会话，正在切换过去…":"Enviado a una sesión de IA, cambiando allí...","密码与凭据引用只能二选一：要记住密码就清空引用名，要用已有引用就不填密码。":"Sólo puede elegir entre contraseña y referencias de credenciales: si desea recordar la contraseña, borre el nombre de la referencia; Si desea utilizar una referencia existente, deje la contraseña en blanco.","端口必须是 1-65535 之间的整数。":"El puerto debe ser un número entero entre 1-65535.","当前环境不支持目录选择，请手动输入本机绝对路径。":"El entorno actual no admite la selección de directorios. Ingrese manualmente la ruta absoluta de la máquina local.","数据库连接已保存":"Conexión de base de datos guardada","数据库连接已更新":"Conexión de base de datos actualizada","例如 生产库 / 本地 SQLite":"Por ejemplo biblioteca de producción/SQLite local","只能使用字母、数字、下划线，且以字母或下划线开头；与上方密码二选一":"Sólo se pueden utilizar letras, números y guiones bajos, y comienza con una letra o un guión bajo; elija una de las contraseñas anteriores","未设置凭据引用":"Referencia de credencial no establecida","凭据引用已配置":"Referencia de credenciales configurada","左侧":"lado izquierdo"," 发送":"enviar"," 正在加载新项目的数据…":"Cargando datos para nuevo proyecto..."," 正在读取其他项目的连接…":"Leyendo conexiones de otros proyectos...","会话服务不可用，请刷新页面后重试；若仍失败，请重启 DSH。":"El servicio de sesión no está disponible, actualice la página e inténtelo nuevamente; Si aún falla, reinicie DSH.","会话发送服务不可用，请刷新页面后重试；若仍失败，请重启 DSH。":"El servicio de envío de sesiones no está disponible, actualice la página e inténtelo nuevamente; Si aún falla, reinicie DSH.","会话拒绝接收本次请求。":"El consistorio se niega a aceptar esta petición.","文件":"Archivo","服务名 / SID":"Nombre del servicio/SID","连接已保存，但本次密码未记住；后续查询需要改用 DSH 凭据引用。":"La conexión se ha guardado, pero esta vez no se recuerda la contraseña; Las consultas posteriores deben utilizar la referencia de credencial DSH.","数据库连接已保存，并已通过测试连接。":"La conexión de la base de datos se guarda y se pasa la conexión de prueba.","数据库连接已更新，并已通过测试连接。":"La conexión de la base de datos se actualizó y la conexión de prueba pasó.","已复制数据库连接":"Conexión de base de datos copiada","已删除连接":"Conexión eliminada","已导出到":"Exportado a","已清理":"limpiado","个历史快照，保留":"instantáneas históricas, conservadas","个；导出的文件未受影响。":"; Los archivos exportados no se ven afectados.","个数据源":"fuentes de datos","条结果":"resultados","第":"No.","页 · 共":"Páginas · Total","保存目录：":"Guardar directorio:","询问 AI 时出错":"Error al interrogar a la IA","确认删除项目「{name}」？项目配置会删除，历史结果文件保留在磁盘上。":"¿Está seguro de que desea eliminar el elemento \"{name}\"? La configuración del proyecto se elimina y los archivos de resultados históricos permanecen en el disco.","确认删除项目「{name}」？{hint}":"¿Está seguro de que desea eliminar el elemento \"{name}\"? {pista}","删除连接「{name}」（{dialect}）？只会删除 DSH 中保存的连接配置，不会删除真实数据库、SQLite 文件或历史导出文件。":"¿Eliminar la conexión \"{nombre}\" ({dialecto})? Solo se eliminará la configuración de conexión guardada en DSH, no la base de datos real, los archivos SQLite ni los archivos de exportación históricos.","清理插件内部历史快照，仅保留最近 {keep} 个；已导出的 Excel/CSV/SQL 文件不会受影响。":"Limpiar las instantáneas históricas internas del complemento y conservar solo las más recientes {conservar}; Los archivos Excel/CSV/SQL exportados no se verán afectados.","页面渲染出错":"Error al representar la página","插件界面遇到一个错误，数据不会被修改。可以先点重试；若重复出现，请把下面的错误信息发给 AI 排查。":"La interfaz del complemento encontró un error y los datos no se modificarán. Puede hacer clic en Reintentar primero; Si ocurre repetidamente, envíe el siguiente mensaje de error a AI para solucionar el problema.","错误详情":"Detalles del error","我在使用 DSH AI 数据库助手时遇到错误，请帮我定位并给出修复步骤。\n\n项目：{project}（{id}）\n错误：{message}\n\n请先判断原因（配置、客户端、权限、网络或插件缺陷），给出可执行排查步骤；如判断是插件缺陷，请指出文件与最小修复方案。不要修改生产数据，也不要向我索取密码。":"Encontré un error al utilizar el asistente de base de datos DSH AI. Por favor ayúdame a localizarlo y dame los pasos de reparación.\n\nProyecto: {proyecto} ({id})\nError: {mensaje}\n\nPrimero determine la causa (configuración, cliente, permisos, defectos de red o complementos) y proporcione pasos ejecutables para la solución de problemas; Si se considera que se trata de un defecto del complemento, indique el archivo y el plan mínimo de reparación. No modifiques datos de producción y no me pidas tu contraseña."},"fr":{"AI 数据库助手":"Assistant de base de données IA","用自然语言查询与分析数据":"Interrogez et analysez les données en langage naturel","只读连接 MySQL / PostgreSQL / SQL Server / Oracle / SQLite；AI 自己查表、写 SQL、执行并解释结果。需要导出时生成 Excel、CSV 和最终 SQL。":"Connexion en lecture seule à MySQL / PostgreSQL / SQL Server / Oracle / SQLite ; L'IA recherche des tables, écrit du SQL, exécute et interprète elle-même les résultats. Générez Excel, CSV et SQL final lorsque l'exportation est requise.","正在切换项目…":"Changer de projet…","正在切换项目":"Changer de projet","未选择项目":"Aucun élément sélectionné","工作台加载失败":"Échec du chargement du Workbench","重试":"Réessayer","本地插件服务暂时没有返回数据。已有项目不会丢失；可直接重试，仍失败时请查看宿主日志。":"Le service de plug-in local ne renvoie pas encore de données. Les projets existants ne seront pas perdus ; vous pouvez réessayer directement. Si l'échec persiste, veuillez vérifier le journal de l'hôte.","正在加载新项目的数据…":"Chargement des données pour un nouveau projet...","先建一个项目":"Construisez d’abord un projet","项目保存数据库连接、保存目录和会话历史。点上方「新建项目」开始。":"Les projets enregistrent les connexions à la base de données, enregistrent les répertoires et l'historique des sessions. Cliquez sur \"Nouveau projet\" ci-dessus pour commencer.","数据库连接":"Connexion à la base de données","收起设置":"Réduire les paramètres","添加连接":"Ajouter une connexion","复制其他项目连接":"Copier d'autres connexions de projet","刷新":"Actualiser","还没有数据库连接。点「添加连接」选择数据库类型（MySQL / PostgreSQL / SQL Server / Oracle / SQLite）。":"Il n'y a pas encore de connexion à la base de données. Cliquez sur \"Ajouter une connexion\" pour sélectionner le type de base de données (MySQL / PostgreSQL / SQL Server / Oracle / SQLite).","测试连接":"Tester la connexion","编辑":"Modifier","删除连接":"Supprimer la connexion","可用":"Disponible","不可用":"Non disponible","未测试":"Non testé","新建数据库连接":"Créer une nouvelle connexion à la base de données","编辑数据库连接":"Modifier la connexion à la base de données","使用只读账号；密码保存在 DSH 凭据中，这里只填引用名。SQLite 以只读方式打开文件。":"Utilisez un compte en lecture seule ; le mot de passe est enregistré dans les informations d'identification DSH et seul le nom de référence est renseigné ici. SQLite ouvre le fichier en lecture seule.","数据库类型":"Type de base de données","连接名称":"nom de connexion","数据库文件路径":"Chemin du fichier de base de données","绝对路径；只会以只读方式打开，不会创建或修改文件":"Chemin absolu ; ne sera ouvert qu'en lecture seule, le fichier ne sera ni créé ni modifié","本机绝对路径（按当前操作系统填写）":"Chemin absolu de la machine locale (à renseigner selon le système d'exploitation actuel)","主机":"Hôte","端口":"port","只读账号":"Compte en lecture seule","数据库":"base de données","可选；Oracle/SQL Server/PostgreSQL 的默认 schema":"Facultatif; schéma par défaut pour Oracle/SQL Server/PostgreSQL","信任服务器证书（仅用于自签名测试环境；默认关闭）":"Certificat de serveur de confiance (uniquement pour les environnements de test auto-signés ; désactivé par défaut)","密码":"Mot de passe","仅用于本次保存，不会写入配置或日志":"Utilisé uniquement pour cette sauvegarde, aucune configuration ni journal ne sera écrit.","可选；留空则使用凭据引用":"Facultatif ; laisser vide pour utiliser la référence des informations d'identification","凭据引用":"Référence des informations d'identification","只能使用字母、数字、下划线，且必须以字母或下划线开头；与上方密码二选一":"Seuls des lettres, des chiffres et des traits de soulignement peuvent être utilisés et doivent commencer par une lettre ou un trait de soulignement ; choisissez-en un parmi le mot de passe ci-dessus","记住密码（保存到 DSH 凭据）":"Mémoriser le mot de passe (enregistrer dans les informations d'identification DSH)","客户端可执行文件":"Exécutable client","可选；留空则自动从系统 PATH 查找。填写本机 MySQL 客户端可执行文件的绝对路径。":"Facultatif ; laissez-le vide pour effectuer une recherche automatique à partir du PATH du système. Remplissez le chemin absolu vers l’exécutable du client MySQL natif.","本机 MySQL 客户端可执行文件的绝对路径":"Chemin absolu vers l'exécutable du client MySQL natif","保存并测试":"Enregistrer et tester","取消编辑":"Annuler la modification","更新并测试":"Mise à jour et test","交付设置":"Paramètres de livraison","已授权目录":"Annuaire autorisé","结果保存目录":"Répertoire de sauvegarde des résultats","Excel、CSV、SQL 只会写入这里":"Excel, CSV, SQL ne seront écrits qu'ici","选择目录":"Sélectionner le répertoire","保存目录":"Enregistrer le répertoire","问 AI":"Demandez à l'IA","直接用自然语言描述你要的数据。AI 会自己查表、写并执行只读 SQL；不清楚时会反问你，可继续补充或修改。":"Décrivez directement les données souhaitées en langage naturel. L'IA recherchera des tables, écrira et exécutera elle-même du SQL en lecture seule ; il vous demandera si ce n'est pas clair et vous pourrez continuer à l'ajouter ou à le modifier.","例如：统计 2026 年各数据库备份失败的次数，按失败次数从高到低排序":"Par exemple : comptez le nombre d'échecs de sauvegarde pour chaque base de données en 2026 et triez-les de haut en bas en fonction du nombre d'échecs.","发送":"Envoyer","查询结果":"Résultats de la requête","清理历史结果":"Nettoyer les résultats historiques","清理插件内部历史快照，仅保留最近 10 个；已导出的 Excel/CSV/SQL 文件不会受影响。":"Nettoyez les instantanés historiques internes du plug-in, en ne conservant que les 10 derniers ; les fichiers Excel/CSV/SQL exportés ne seront pas affectés.","还没有结果。向 AI 提问并执行查询后，这里会列出可查看与导出的结果。":"Aucun résultat pour l'instant. Après avoir posé une question à l'IA et exécuté une requête, les résultats sont répertoriés ici et peuvent être visualisés et exportés.","查看":"Voir","导出":"Exporter","导出 Excel、CSV、SQL 三个文件":"Exporter trois fichiers Excel, CSV, SQL","已导出":"Exporté","完整":"complet","不完整":"incomplet","数据快照已清理；不能导出，但仍可查看当时执行的 SQL。":"L'instantané de données a été nettoyé ; il ne peut pas être exporté, mais le SQL exécuté à ce moment-là peut toujours être visualisé.","该结果的数据快照已清理，不能再查看预览或导出；SQL 仍保留在下方。":"L'instantané des données de ce résultat a été nettoyé et ne peut plus être visualisé en aperçu ou en exportation ; le SQL reste en dessous.","本次结果不完整（达到行数或字节上限），不能导出；请缩小范围或先聚合再重试。":"Le résultat cette fois est incomplet (la limite supérieure de lignes ou d'octets a été atteinte) et ne peut pas être exporté ; veuillez d'abord réduire la plage ou la regrouper, puis réessayer.","仅预览前 20 行；导出使用完整结果。":"Seules les 20 premières lignes sont prévisualisées ; l'export utilise les résultats complets.","上一页":"Page précédente","下一页":"Page suivante","复制其他项目的数据库连接":"Copier les connexions à la base de données d'autres projets","只复制连接配置（主机、端口、账号、库名、凭据引用），不复制查询结果、会话和保存目录。":"Seule la configuration de la connexion (hôte, port, compte, nom de bibliothèque, référence des informations d'identification) est copiée et les résultats des requêtes, les sessions et les répertoires de sauvegarde ne sont pas copiés.","正在读取其他项目的连接…":"Lecture des connexions d'autres projets...","没有其他项目可复制的数据库连接。":"Il n'existe aucune connexion à la base de données à répliquer pour d'autres projets.","读取失败，请重试。":"Échec de la lecture, veuillez réessayer.","复制":"Copier","已复制":"Copié","项目":"Projet","还没有项目":"Aucun projet pour l'instant","选择项目":"Sélectionner un article","删除项目":"Supprimer le projet","用于区分不同的数据库分析项目":"Utilisé pour distinguer différents projets d'analyse de bases de données","例如：2026 年备份分析":"Par exemple : Analyse des sauvegardes 2026","可选，写一句项目说明":"Facultatif, rédigez une description du projet","例如：只读连接 app_db，分析备份失败":"Par exemple : connexion en lecture seule app_db, échec de sauvegarde d'analyse","新建项目":"Nouveau projet","重命名":"Renommer","项目名称":"Nom du projet","项目说明":"Description du projet","删除只移除项目记录，已生成的成果文件与证据包会保留在磁盘。":"La suppression supprime uniquement l'enregistrement du projet, et les fichiers de résultats et les ensembles de preuves générés resteront sur le disque.","保存":"Enregistrer","取消":"Annuler","删除":"Supprimer","连接未通过测试":"Test de connexion échoué","询问 AI":"Demandez à l'IA","已发送到 AI 会话，正在切换过去…":"Envoyé à la session IA, j'y change...","密码与凭据引用只能二选一：要记住密码就清空引用名，要用已有引用就不填密码。":"Vous ne pouvez choisir qu'entre les références de mot de passe et d'identifiant : si vous souhaitez mémoriser le mot de passe, effacez le nom de référence ; si vous souhaitez utiliser une référence existante, laissez le mot de passe vide.","端口必须是 1-65535 之间的整数。":"Le port doit être un entier compris entre 1 et 65535.","当前环境不支持目录选择，请手动输入本机绝对路径。":"L'environnement actuel ne prend pas en charge la sélection de répertoire. Veuillez saisir manuellement le chemin absolu de la machine locale.","数据库连接已保存":"Connexion à la base de données enregistrée","数据库连接已更新":"Connexion à la base de données mise à jour","例如 生产库 / 本地 SQLite":"Par exemple bibliothèque de production / SQLite local","只能使用字母、数字、下划线，且以字母或下划线开头；与上方密码二选一":"Seuls des lettres, des chiffres et des traits de soulignement peuvent être utilisés, et cela commence par une lettre ou un trait de soulignement ; choisissez l'un des mots de passe ci-dessus","未设置凭据引用":"Référence des informations d'identification non définie","凭据引用已配置":"Référence des identifiants configurée","左侧":"côté gauche"," 发送":"envoyer"," 正在加载新项目的数据…":"Chargement des données pour un nouveau projet..."," 正在读取其他项目的连接…":"Lecture des connexions d'autres projets...","会话服务不可用，请刷新页面后重试；若仍失败，请重启 DSH。":"Le service de session n'est pas disponible, veuillez actualiser la page et réessayer ; si l'échec persiste, veuillez redémarrer DSH.","会话发送服务不可用，请刷新页面后重试；若仍失败，请重启 DSH。":"Le service d'envoi de session n'est pas disponible, veuillez actualiser la page et réessayer ; si l'échec persiste, veuillez redémarrer DSH.","会话拒绝接收本次请求。":"La session refuse d'accepter cette demande.","文件":"Fichier","服务名 / SID":"Nom/SID du service","连接已保存，但本次密码未记住；后续查询需要改用 DSH 凭据引用。":"La connexion a été enregistrée, mais le mot de passe cette fois n'est pas mémorisé ; les requêtes ultérieures doivent plutôt utiliser la référence d’informations d’identification DSH.","数据库连接已保存，并已通过测试连接。":"La connexion à la base de données est enregistrée et la connexion test est réussie.","数据库连接已更新，并已通过测试连接。":"La connexion à la base de données a été mise à jour et la connexion test a réussi.","已复制数据库连接":"Connexion à la base de données copiée","已删除连接":"Connexion supprimée","已导出到":"Exporté vers","已清理":"Nettoyé","个历史快照，保留":"instantanés historiques, conservés","个；导出的文件未受影响。":"; les fichiers exportés ne sont pas affectés.","个数据源":"sources de données","条结果":"résultats","第":"Non.","页 · 共":"Pages · Total","保存目录：":"Enregistrer le répertoire :","询问 AI 时出错":"Erreur lors de l'interrogation de l'IA","确认删除项目「{name}」？项目配置会删除，历史结果文件保留在磁盘上。":"Êtes-vous sûr de vouloir supprimer l'élément « {name} » ? La configuration du projet est supprimée et les fichiers de résultats historiques restent sur le disque.","确认删除项目「{name}」？{hint}":"Êtes-vous sûr de vouloir supprimer l'élément « {name} » ? {indice}","删除连接「{name}」（{dialect}）？只会删除 DSH 中保存的连接配置，不会删除真实数据库、SQLite 文件或历史导出文件。":"Supprimer la connexion \"{name}\" ({dialecte}) ? Seule la configuration de connexion enregistrée dans DSH sera supprimée, pas la base de données réelle, les fichiers SQLite ou les fichiers d'exportation historiques.","清理插件内部历史快照，仅保留最近 {keep} 个；已导出的 Excel/CSV/SQL 文件不会受影响。":"Nettoyez les instantanés historiques internes du plug-in, en ne conservant que les {keep} les plus récents ; les fichiers Excel/CSV/SQL exportés ne seront pas affectés.","页面渲染出错":"Erreur de rendu de la page","插件界面遇到一个错误，数据不会被修改。可以先点重试；若重复出现，请把下面的错误信息发给 AI 排查。":"L'interface du plug-in a rencontré une erreur et les données ne seront pas modifiées. Vous pouvez d'abord cliquer sur Réessayer ; si cela se produit à plusieurs reprises, veuillez envoyer le message d'erreur ci-dessous à AI pour le dépannage.","错误详情":"Détails de l'erreur","我在使用 DSH AI 数据库助手时遇到错误，请帮我定位并给出修复步骤。\n\n项目：{project}（{id}）\n错误：{message}\n\n请先判断原因（配置、客户端、权限、网络或插件缺陷），给出可执行排查步骤；如判断是插件缺陷，请指出文件与最小修复方案。不要修改生产数据，也不要向我索取密码。":"J'ai rencontré une erreur lors de l'utilisation de l'assistant de base de données DSH AI. S'il vous plaît, aidez-moi à le localiser et donnez-moi les étapes de réparation.\n\nProjet : {projet} ({id})\nErreur : {message}\n\nVeuillez d'abord déterminer la cause (défauts de configuration, de client, d'autorisations, de réseau ou de plug-in) et fournir des étapes de dépannage exécutables ; s'il s'agit d'un défaut du plug-in, veuillez indiquer le dossier et le plan de réparation minimum. Ne modifiez pas les données de production et ne me demandez pas votre mot de passe."},"de":{"AI 数据库助手":"KI-Datenbankassistent","用自然语言查询与分析数据":"Daten mit natürlicher Sprache abfragen und analysieren","只读连接 MySQL / PostgreSQL / SQL Server / Oracle / SQLite；AI 自己查表、写 SQL、执行并解释结果。需要导出时生成 Excel、CSV 和最终 SQL。":"Schreibgeschützte Verbindung zu MySQL / PostgreSQL / SQL Server / Oracle / SQLite; KI sucht nach Tabellen, schreibt SQL, führt die Ergebnisse selbst aus und interpretiert sie. Generieren Sie Excel, CSV und endgültiges SQL, wenn ein Export erforderlich ist.","正在切换项目…":"Projekte wechseln…","正在切换项目":"Projekte wechseln","未选择项目":"Keine Elemente ausgewählt","工作台加载失败":"Das Laden der Workbench ist fehlgeschlagen","重试":"Erneut versuchen","本地插件服务暂时没有返回数据。已有项目不会丢失；可直接重试，仍失败时请查看宿主日志。":"Der lokale Plug-in-Dienst gibt noch keine Daten zurück. Bestehende Projekte gehen nicht verloren; Sie können es direkt erneut versuchen. Wenn es immer noch fehlschlägt, überprüfen Sie bitte das Hostprotokoll.","正在加载新项目的数据…":"Daten für neues Projekt werden geladen...","先建一个项目":"Erstellen Sie zuerst ein Projekt","项目保存数据库连接、保存目录和会话历史。点上方「新建项目」开始。":"Projekte speichern Datenbankverbindungen, speichern Verzeichnisse und den Sitzungsverlauf. Klicken Sie oben auf „Neues Projekt“, um zu beginnen.","数据库连接":"Datenbankverbindung","收起设置":"Einstellungen reduzieren","添加连接":"Verbindung hinzufügen","复制其他项目连接":"Andere Projektverbindungen kopieren","刷新":"Aktualisieren","还没有数据库连接。点「添加连接」选择数据库类型（MySQL / PostgreSQL / SQL Server / Oracle / SQLite）。":"Es besteht noch keine Datenbankverbindung. Klicken Sie auf „Verbindung hinzufügen“, um den Datenbanktyp auszuwählen (MySQL / PostgreSQL / SQL Server / Oracle / SQLite).","测试连接":"Verbindung testen","编辑":"Bearbeiten","删除连接":"Verbindung löschen","可用":"Verfügbar","不可用":"Nicht verfügbar","未测试":"Nicht getestet","新建数据库连接":"Erstellen Sie eine neue Datenbankverbindung","编辑数据库连接":"Datenbankverbindung bearbeiten","使用只读账号；密码保存在 DSH 凭据中，这里只填引用名。SQLite 以只读方式打开文件。":"Verwenden Sie ein schreibgeschütztes Konto. Das Passwort wird in den DSH-Zugangsdaten gespeichert und hier wird nur der Referenzname eingetragen. SQLite öffnet die Datei schreibgeschützt.","数据库类型":"Datenbanktyp","连接名称":"Verbindungsname","数据库文件路径":"Pfad der Datenbankdatei","绝对路径；只会以只读方式打开，不会创建或修改文件":"Absoluter Pfad; wird nur schreibgeschützt geöffnet, die Datei wird nicht erstellt oder geändert","本机绝对路径（按当前操作系统填写）":"Absoluter Pfad der lokalen Maschine (entsprechend dem aktuellen Betriebssystem ausfüllen)","主机":"Gastgeber","端口":"Hafen","只读账号":"Schreibgeschütztes Konto","数据库":"Datenbank","可选；Oracle/SQL Server/PostgreSQL 的默认 schema":"Optional; Standardschema für Oracle/SQL Server/PostgreSQL","信任服务器证书（仅用于自签名测试环境；默认关闭）":"Serverzertifikat vertrauen (nur für selbstsignierte Testumgebungen; standardmäßig deaktiviert)","密码":"Passwort","仅用于本次保存，不会写入配置或日志":"Wird nur für diese Speicherung verwendet, es werden keine Konfigurationen oder Protokolle geschrieben.","可选；留空则使用凭据引用":"Optional; Lassen Sie das Feld leer, um die Anmeldeinformationsreferenz zu verwenden","凭据引用":"Referenz zur Referenz","只能使用字母、数字、下划线，且必须以字母或下划线开头；与上方密码二选一":"Es dürfen nur Buchstaben, Zahlen und Unterstriche verwendet werden und müssen mit einem Buchstaben oder Unterstrich beginnen. Wählen Sie eines aus dem obigen Passwort","记住密码（保存到 DSH 凭据）":"Passwort merken (in den DSH-Zugangsdaten speichern)","客户端可执行文件":"Client-Programmdatei","可选；留空则自动从系统 PATH 查找。填写本机 MySQL 客户端可执行文件的绝对路径。":"Optional; Lassen Sie es leer, um automatisch vom Systempfad aus zu suchen. Geben Sie den absoluten Pfad zur ausführbaren Datei des nativen MySQL-Clients ein.","本机 MySQL 客户端可执行文件的绝对路径":"Absoluter Pfad zur ausführbaren Datei des nativen MySQL-Clients","保存并测试":"Speichern und testen","取消编辑":"Bearbeitung abbrechen","更新并测试":"Aktualisieren und testen","交付设置":"Liefereinstellungen","已授权目录":"Autorisiertes Verzeichnis","结果保存目录":"Ergebnisspeicherverzeichnis","Excel、CSV、SQL 只会写入这里":"Excel, CSV, SQL werden hier nur geschrieben","选择目录":"Verzeichnis auswählen","保存目录":"Verzeichnis speichern","问 AI":"Fragen Sie die KI","直接用自然语言描述你要的数据。AI 会自己查表、写并执行只读 SQL；不清楚时会反问你，可继续补充或修改。":"Beschreiben Sie die gewünschten Daten direkt in natürlicher Sprache. KI sucht selbst nach Tabellen, schreibt und führt schreibgeschütztes SQL aus. Sie werden gefragt, ob etwas unklar ist, und Sie können es weiter hinzufügen oder ändern.","例如：统计 2026 年各数据库备份失败的次数，按失败次数从高到低排序":"Beispiel: Zählen Sie die Anzahl der Sicherungsfehler für jede Datenbank im Jahr 2026 und sortieren Sie sie von hoch nach niedrig nach der Anzahl der Fehler.","发送":"Senden","查询结果":"Abfrageergebnisse","清理历史结果":"Verlauf bereinigen","清理插件内部历史快照，仅保留最近 10 个；已导出的 Excel/CSV/SQL 文件不会受影响。":"Bereinigen Sie die internen historischen Snapshots des Plug-Ins und behalten Sie nur die letzten 10 bei. Exportierte Excel-/CSV-/SQL-Dateien sind davon nicht betroffen.","还没有结果。向 AI 提问并执行查询后，这里会列出可查看与导出的结果。":"Noch keine Ergebnisse. Nachdem Sie der KI eine Frage gestellt und eine Abfrage ausgeführt haben, werden die Ergebnisse hier aufgelistet und können angezeigt und exportiert werden.","查看":"Anzeigen","导出":"Exportieren","导出 Excel、CSV、SQL 三个文件":"Exportieren Sie drei Excel-, CSV- und SQL-Dateien","已导出":"Exportiert","完整":"abgeschlossen","不完整":"unvollständig","数据快照已清理；不能导出，但仍可查看当时执行的 SQL。":"Der Daten-Snapshot wurde bereinigt; Es kann nicht exportiert werden, aber die zu diesem Zeitpunkt ausgeführte SQL kann weiterhin angezeigt werden.","该结果的数据快照已清理，不能再查看预览或导出；SQL 仍保留在下方。":"Der Daten-Snapshot für dieses Ergebnis wurde bereinigt und kann nicht mehr in der Vorschau oder im Export angezeigt werden; das SQL bleibt unten.","本次结果不完整（达到行数或字节上限），不能导出；请缩小范围或先聚合再重试。":"Das Ergebnis ist dieses Mal unvollständig (die Obergrenze der Zeilen oder Bytes wurde erreicht) und kann nicht exportiert werden; Bitte grenzen Sie den Bereich ein oder aggregieren Sie ihn zuerst und versuchen Sie es erneut.","仅预览前 20 行；导出使用完整结果。":"Nur die ersten 20 Zeilen werden in der Vorschau angezeigt. Beim Export werden die vollständigen Ergebnisse verwendet.","上一页":"Vorherige Seite","下一页":"Nächste Seite","复制其他项目的数据库连接":"Datenbankverbindungen aus anderen Projekten kopieren","只复制连接配置（主机、端口、账号、库名、凭据引用），不复制查询结果、会话和保存目录。":"Nur die Verbindungskonfiguration (Host, Port, Konto, Bibliotheksname, Anmeldeinformationsreferenz) wird kopiert, Abfrageergebnisse, Sitzungen und Speicherverzeichnisse werden nicht kopiert.","正在读取其他项目的连接…":"Zusammenhänge aus anderen Projekten lesen...","没有其他项目可复制的数据库连接。":"Es gibt keine Datenbankverbindungen, die für andere Projekte repliziert werden könnten.","读取失败，请重试。":"Fehler beim Lesen, bitte versuchen Sie es erneut.","复制":"Kopieren","已复制":"Kopiert","项目":"Projekt","还没有项目":"Noch keine Projekte","选择项目":"Element auswählen","删除项目":"Projekt löschen","用于区分不同的数据库分析项目":"Wird zur Unterscheidung verschiedener Datenbankanalyseprojekte verwendet","例如：2026 年备份分析":"Beispiel: Backup-Analyse 2026","可选，写一句项目说明":"Optional können Sie eine Projektbeschreibung verfassen","例如：只读连接 app_db，分析备份失败":"Beispiel: schreibgeschützte Verbindung app_db, Analysesicherungsfehler","新建项目":"Neues Projekt","重命名":"Umbenennen","项目名称":"Projektname","项目说明":"Projektbeschreibung","删除只移除项目记录，已生成的成果文件与证据包会保留在磁盘。":"Durch das Löschen wird nur der Projektdatensatz entfernt und die generierten Ergebnisdateien und Beweispakete bleiben auf der Festplatte.","保存":"Speichern","取消":"Abbrechen","删除":"Löschen","连接未通过测试":"Der Verbindungstest ist fehlgeschlagen","询问 AI":"Fragen Sie die KI","已发送到 AI 会话，正在切换过去…":"An AI-Sitzung gesendet, dort wechseln...","密码与凭据引用只能二选一：要记住密码就清空引用名，要用已有引用就不填密码。":"Sie können nur zwischen Passwort- und Anmeldeinformationsreferenzen wählen: Wenn Sie sich das Passwort merken möchten, löschen Sie den Referenznamen; Wenn Sie eine vorhandene Referenz verwenden möchten, lassen Sie das Passwort leer.","端口必须是 1-65535 之间的整数。":"Der Port muss eine Ganzzahl zwischen 1 und 65535 sein.","当前环境不支持目录选择，请手动输入本机绝对路径。":"Die aktuelle Umgebung unterstützt keine Verzeichnisauswahl. Bitte geben Sie den absoluten Pfad des lokalen Rechners manuell ein.","数据库连接已保存":"Datenbankverbindung gespeichert","数据库连接已更新":"Datenbankverbindung aktualisiert","例如 生产库 / 本地 SQLite":"Zum Beispiel Produktionsbibliothek/lokales SQLite","只能使用字母、数字、下划线，且以字母或下划线开头；与上方密码二选一":"Es können nur Buchstaben, Zahlen und Unterstriche verwendet werden, und es beginnt mit einem Buchstaben oder Unterstrich; Wählen Sie eines der oben genannten Passwörter","未设置凭据引用":"Anmeldeinformationsreferenz nicht festgelegt","凭据引用已配置":"Anmeldeinformationsreferenz konfiguriert","左侧":"linke Seite"," 发送":"senden"," 正在加载新项目的数据…":"Daten für neues Projekt werden geladen..."," 正在读取其他项目的连接…":"Zusammenhänge aus anderen Projekten lesen...","会话服务不可用，请刷新页面后重试；若仍失败，请重启 DSH。":"Der Sitzungsdienst ist nicht verfügbar. Bitte aktualisieren Sie die Seite und versuchen Sie es erneut. Wenn es immer noch fehlschlägt, starten Sie DSH bitte neu.","会话发送服务不可用，请刷新页面后重试；若仍失败，请重启 DSH。":"Der Dienst zum Senden von Sitzungen ist nicht verfügbar. Bitte aktualisieren Sie die Seite und versuchen Sie es erneut. Wenn es immer noch fehlschlägt, starten Sie DSH bitte neu.","会话拒绝接收本次请求。":"Die Sitzung weigert sich, diese Anfrage anzunehmen.","文件":"Datei","服务名 / SID":"Dienstname/SID","连接已保存，但本次密码未记住；后续查询需要改用 DSH 凭据引用。":"Die Verbindung wurde gespeichert, aber das Passwort wird dieses Mal nicht gespeichert; Nachfolgende Abfragen müssen stattdessen die DSH-Anmeldeinformationsreferenz verwenden.","数据库连接已保存，并已通过测试连接。":"Die Datenbankverbindung wird gespeichert und die Testverbindung wird bestanden.","数据库连接已更新，并已通过测试连接。":"Die Datenbankverbindung wurde aktualisiert und die Testverbindung bestanden.","已复制数据库连接":"Datenbankverbindung kopiert","已删除连接":"Verbindung gelöscht","已导出到":"Exportiert nach","已清理":"Gereinigt","个历史快照，保留":"historische Momentaufnahmen, beibehalten","个；导出的文件未受影响。":"; exportierte Dateien sind nicht betroffen.","个数据源":"Datenquellen","条结果":"Ergebnisse","第":"Nein.","页 · 共":"Seiten · Gesamt","保存目录：":"Verzeichnis speichern:","询问 AI 时出错":"Fehler beim Abfragen der KI","确认删除项目「{name}」？项目配置会删除，历史结果文件保留在磁盘上。":"Sind Sie sicher, dass Sie das Element „{name}“ löschen möchten? Die Projektkonfiguration wird gelöscht und die historischen Ergebnisdateien verbleiben auf der Festplatte.","确认删除项目「{name}」？{hint}":"Sind Sie sicher, dass Sie das Element „{name}“ löschen möchten? {Hinweis}","删除连接「{name}」（{dialect}）？只会删除 DSH 中保存的连接配置，不会删除真实数据库、SQLite 文件或历史导出文件。":"Verbindung „{name}“ ({dialect}) löschen? Es wird nur die in DSH gespeicherte Verbindungskonfiguration gelöscht, nicht die echte Datenbank, SQLite-Dateien oder historischen Exportdateien.","清理插件内部历史快照，仅保留最近 {keep} 个；已导出的 Excel/CSV/SQL 文件不会受影响。":"Bereinigen Sie die internen historischen Snapshots des Plug-Ins und behalten Sie nur die neuesten {keep}; Exportierte Excel-/CSV-/SQL-Dateien sind davon nicht betroffen.","页面渲染出错":"Fehler beim Rendern der Seite","插件界面遇到一个错误，数据不会被修改。可以先点重试；若重复出现，请把下面的错误信息发给 AI 排查。":"In der Plug-in-Schnittstelle ist ein Fehler aufgetreten und die Daten werden nicht geändert. Sie können zuerst auf „Wiederholen“ klicken. Wenn es wiederholt auftritt, senden Sie bitte die folgende Fehlermeldung zur Fehlerbehebung an AI.","错误详情":"Fehlerdetails","我在使用 DSH AI 数据库助手时遇到错误，请帮我定位并给出修复步骤。\n\n项目：{project}（{id}）\n错误：{message}\n\n请先判断原因（配置、客户端、权限、网络或插件缺陷），给出可执行排查步骤；如判断是插件缺陷，请指出文件与最小修复方案。不要修改生产数据，也不要向我索取密码。":"Bei der Verwendung des DSH AI-Datenbankassistenten ist ein Fehler aufgetreten. Bitte helfen Sie mir, es zu finden und geben Sie mir die Reparaturschritte.\n\nProjekt: {project} ({id})\nFehler: {Nachricht}\n\nBitte ermitteln Sie zunächst die Ursache (Konfigurations-, Client-, Berechtigungs-, Netzwerk- oder Plug-in-Defekte) und stellen Sie ausführbare Schritte zur Fehlerbehebung bereit; Wenn festgestellt wird, dass es sich um einen Plug-In-Defekt handelt, geben Sie bitte die Datei und den Mindestreparaturplan an. Ändern Sie keine Produktionsdaten und fragen Sie mich nicht nach Ihrem Passwort."},"ru":{"AI 数据库助手":"Помощник по базам данных AI","用自然语言查询与分析数据":"Запрашивайте и анализируйте данные на естественном языке","只读连接 MySQL / PostgreSQL / SQL Server / Oracle / SQLite；AI 自己查表、写 SQL、执行并解释结果。需要导出时生成 Excel、CSV 和最终 SQL。":"Подключение только для чтения к MySQL/PostgreSQL/SQL Server/Oracle/SQLite; ИИ ищет таблицы, пишет SQL, самостоятельно выполняет и интерпретирует результаты. Сгенерируйте Excel, CSV и окончательный SQL, если требуется экспорт.","正在切换项目…":"Переключение проектов…","正在切换项目":"Переключение проектов","未选择项目":"Элементы не выбраны","工作台加载失败":"Не удалось загрузить рабочую среду","重试":"Повторить","本地插件服务暂时没有返回数据。已有项目不会丢失；可直接重试，仍失败时请查看宿主日志。":"Локальный сервис плагина пока не возвращает данные. Существующие проекты не будут потеряны; вы можете повторить попытку напрямую. Если это по-прежнему не удается, проверьте журнал хоста.","正在加载新项目的数据…":"Загрузка данных для нового проекта...","先建一个项目":"Сначала создайте проект","项目保存数据库连接、保存目录和会话历史。点上方「新建项目」开始。":"Проекты сохраняют подключения к базе данных, сохраняют каталоги и историю сеансов. Нажмите «Новый проект» выше, чтобы начать.","数据库连接":"Подключение к базе данных","收起设置":"Свернуть настройки","添加连接":"Добавить соединение","复制其他项目连接":"Копирование других подключений проекта","刷新":"Обновить","还没有数据库连接。点「添加连接」选择数据库类型（MySQL / PostgreSQL / SQL Server / Oracle / SQLite）。":"Подключения к базе данных пока нет. Нажмите «Добавить соединение», чтобы выбрать тип базы данных (MySQL/PostgreSQL/SQL Server/Oracle/SQLite).","测试连接":"Проверить подключение","编辑":"Изменить","删除连接":"Удалить соединение","可用":"Доступный","不可用":"Нет в наличии","未测试":"Не проверено","新建数据库连接":"Создать новое подключение к базе данных","编辑数据库连接":"Изменить подключение к базе данных","使用只读账号；密码保存在 DSH 凭据中，这里只填引用名。SQLite 以只读方式打开文件。":"Используйте учетную запись только для чтения; пароль сохраняется в учетных данных DSH, и здесь заполняется только ссылочное имя. SQLite открывает файл только для чтения.","数据库类型":"Тип базы данных","连接名称":"имя соединения","数据库文件路径":"Путь к файлу базы данных","绝对路径；只会以只读方式打开，不会创建或修改文件":"Абсолютный путь; будет открыт только для чтения, файл не будет создан или изменен","本机绝对路径（按当前操作系统填写）":"Абсолютный путь к локальной машине (заполняется в соответствии с текущей операционной системой)","主机":"Хозяин","端口":"порт","只读账号":"Аккаунт только для чтения","数据库":"база данных","可选；Oracle/SQL Server/PostgreSQL 的默认 schema":"Необязательный; схема по умолчанию для Oracle/SQL Server/PostgreSQL","信任服务器证书（仅用于自签名测试环境；默认关闭）":"Сертификат доверенного сервера (только для самозаверяющих тестовых сред; по умолчанию отключен)","密码":"пароль","仅用于本次保存，不会写入配置或日志":"Используется только для этого сохранения, никакая конфигурация или журналы не записываются.","可选；留空则使用凭据引用":"Необязательный; оставьте поле пустым, чтобы использовать ссылку на учетные данные","凭据引用":"Ссылка на учетные данные","只能使用字母、数字、下划线，且必须以字母或下划线开头；与上方密码二选一":"Можно использовать только буквы, цифры и символы подчеркивания; они должны начинаться с буквы или подчеркивания; выберите один из пароля выше","记住密码（保存到 DSH 凭据）":"Запомнить пароль (сохранить в учетных данных DSH)","客户端可执行文件":"Исполняемый файл клиента","可选；留空则自动从系统 PATH 查找。填写本机 MySQL 客户端可执行文件的绝对路径。":"Необязательный; оставьте это поле пустым для автоматического поиска по системной PATH. Укажите абсолютный путь к исполняемому файлу собственного клиента MySQL.","本机 MySQL 客户端可执行文件的绝对路径":"Абсолютный путь к собственному исполняемому файлу клиента MySQL.","保存并测试":"Сохраните и протестируйте","取消编辑":"Отменить редактирование","更新并测试":"Обновите и протестируйте","交付设置":"Настройки доставки","已授权目录":"Авторизованный каталог","结果保存目录":"Каталог сохранения результатов","Excel、CSV、SQL 只会写入这里":"Здесь будет писаться только Excel, CSV, SQL","选择目录":"Выберите каталог","保存目录":"Сохранить каталог","问 AI":"Спросите ИИ","直接用自然语言描述你要的数据。AI 会自己查表、写并执行只读 SQL；不清楚时会反问你，可继续补充或修改。":"Непосредственно опишите нужные данные на естественном языке. ИИ будет искать таблицы, писать и выполнять SQL только для чтения; он спросит вас, неясно ли что-то, и вы сможете продолжить добавлять или изменять его.","例如：统计 2026 年各数据库备份失败的次数，按失败次数从高到低排序":"Например: подсчитайте количество сбоев резервного копирования для каждой базы данных в 2026 году и отсортируйте их от большего к меньшему по количеству сбоев.","发送":"Отправить","查询结果":"Результаты запроса","清理历史结果":"Очистить исторические результаты","清理插件内部历史快照，仅保留最近 10 个；已导出的 Excel/CSV/SQL 文件不会受影响。":"Очистите внутренние исторические снимки плагина, оставив только последние 10; экспортированные файлы Excel/CSV/SQL не будут затронуты.","还没有结果。向 AI 提问并执行查询后，这里会列出可查看与导出的结果。":"Пока результатов нет. После того, как вы зададите ИИ вопрос и выполните запрос, результаты будут перечислены здесь, и их можно будет просмотреть и экспортировать.","查看":"Просмотр","导出":"Экспорт","导出 Excel、CSV、SQL 三个文件":"Экспортировать три файла Excel, CSV, SQL.","已导出":"Экспортировано","完整":"весь","不完整":"неполный","数据快照已清理；不能导出，但仍可查看当时执行的 SQL。":"Снимок данных очищен; его нельзя экспортировать, но SQL-код, выполненный в этот момент, все еще можно просмотреть.","该结果的数据快照已清理，不能再查看预览或导出；SQL 仍保留在下方。":"Снимок данных для этого результата был очищен, и его больше нельзя просмотреть в режиме предварительного просмотра или экспорта; SQL остается ниже.","本次结果不完整（达到行数或字节上限），不能导出；请缩小范围或先聚合再重试。":"Результат на этот раз неполный (достигнут верхний предел строк или байтов) и не может быть экспортирован; пожалуйста, сузьте диапазон или сначала агрегируйте его и повторите попытку.","仅预览前 20 行；导出使用完整结果。":"Предварительно просматриваются только первые 20 строк; при экспорте используются полные результаты.","上一页":"Предыдущая страница","下一页":"Следующая страница","复制其他项目的数据库连接":"Копирование подключений к базе данных из других проектов","只复制连接配置（主机、端口、账号、库名、凭据引用），不复制查询结果、会话和保存目录。":"Копируется только конфигурация подключения (хост, порт, учетная запись, имя библиотеки, ссылка на учетные данные), а результаты запросов, сеансы и каталоги сохранения не копируются.","正在读取其他项目的连接…":"Чтение связей из других проектов...","没有其他项目可复制的数据库连接。":"Нет подключений к базе данных, которые можно было бы реплицировать для других проектов.","读取失败，请重试。":"Не удалось прочитать, попробуйте еще раз.","复制":"копировать","已复制":"Скопировано","项目":"проект","还没有项目":"Пока нет проектов","选择项目":"Выберите элемент","删除项目":"Удалить проект","用于区分不同的数据库分析项目":"Используется для различения различных проектов анализа базы данных.","例如：2026 年备份分析":"Например: Анализ резервных копий за 2026 год.","可选，写一句项目说明":"Необязательно, напишите описание проекта","例如：只读连接 app_db，分析备份失败":"Например: соединение только для чтения app_db, ошибка резервного копирования анализа.","新建项目":"Новый проект","重命名":"Переименовать","项目名称":"Название проекта","项目说明":"Описание проекта","删除只移除项目记录，已生成的成果文件与证据包会保留在磁盘。":"При удалении удаляется только запись проекта, а сгенерированные файлы результатов и пакеты доказательств останутся на диске.","保存":"Сохранить","取消":"Отмена","删除":"Удалить","连接未通过测试":"Проверка соединения не удалась","询问 AI":"Спросите ИИ","已发送到 AI 会话，正在切换过去…":"Отправлено в сеанс AI, переключение туда...","密码与凭据引用只能二选一：要记住密码就清空引用名，要用已有引用就不填密码。":"Вы можете выбирать только между паролем и ссылками на учетные данные: если вы хотите запомнить пароль, очистите имя ссылки; если вы хотите использовать существующую ссылку, оставьте пароль пустым.","端口必须是 1-65535 之间的整数。":"Порт должен быть целым числом от 1 до 65535.","当前环境不支持目录选择，请手动输入本机绝对路径。":"Текущая среда не поддерживает выбор каталога. Пожалуйста, вручную введите абсолютный путь к локальному компьютеру.","数据库连接已保存":"Соединение с базой данных сохранено.","数据库连接已更新":"Соединение с базой данных обновлено.","例如 生产库 / 本地 SQLite":"Например, производственная библиотека/локальный SQLite.","只能使用字母、数字、下划线，且以字母或下划线开头；与上方密码二选一":"Можно использовать только буквы, цифры и символы подчеркивания, и они начинаются с буквы или подчеркивания; выберите один из паролей выше","未设置凭据引用":"Ссылка на учетные данные не установлена.","凭据引用已配置":"Ссылка на учетные данные настроена","左侧":"левая сторона"," 发送":"отправлять"," 正在加载新项目的数据…":"Загрузка данных для нового проекта..."," 正在读取其他项目的连接…":"Чтение связей из других проектов...","会话服务不可用，请刷新页面后重试；若仍失败，请重启 DSH。":"Служба сеанса недоступна, обновите страницу и повторите попытку; если это по-прежнему не удается, перезапустите DSH.","会话发送服务不可用，请刷新页面后重试；若仍失败，请重启 DSH。":"Служба отправки сеанса недоступна, обновите страницу и повторите попытку; если это по-прежнему не удается, перезапустите DSH.","会话拒绝接收本次请求。":"Сеанс отказывается принять этот запрос.","文件":"документ","服务名 / SID":"Имя службы/SID","连接已保存，但本次密码未记住；后续查询需要改用 DSH 凭据引用。":"Соединение сохранилось, но пароль на этот раз не запоминается; последующие запросы должны использовать вместо этого ссылку на учетные данные DSH.","数据库连接已保存，并已通过测试连接。":"Соединение с базой данных сохраняется, и тестовое соединение пройдено.","数据库连接已更新，并已通过测试连接。":"Соединение с базой данных было обновлено, и тестовое соединение пройдено.","已复制数据库连接":"Соединение с базой данных скопировано.","已删除连接":"Соединение удалено","已导出到":"Экспортировано в","已清理":"Очищенный","个历史快照，保留":"исторические снимки, сохранившиеся","个；导出的文件未受影响。":"; экспортированные файлы не затрагиваются.","个数据源":"источники данных","条结果":"результаты","第":"Нет.","页 · 共":"Страницы · Всего","保存目录：":"Сохранить каталог:","询问 AI 时出错":"Ошибка при опросе ИИ","确认删除项目「{name}」？项目配置会删除，历史结果文件保留在磁盘上。":"Вы уверены, что хотите удалить элемент «{name}»? Конфигурация проекта удаляется, а файлы исторических результатов остаются на диске.","确认删除项目「{name}」？{hint}":"Вы уверены, что хотите удалить элемент «{name}»? {намекать}","删除连接「{name}」（{dialect}）？只会删除 DSH 中保存的连接配置，不会删除真实数据库、SQLite 文件或历史导出文件。":"Удалить соединение \"{name}\" ({диалект})? Будет удалена только конфигурация подключения, сохраненная в DSH, а не реальная база данных, файлы SQLite или исторические файлы экспорта.","清理插件内部历史快照，仅保留最近 {keep} 个；已导出的 Excel/CSV/SQL 文件不会受影响。":"Очистите внутренние исторические снимки плагина, оставив только самые последние {keep}; экспортированные файлы Excel/CSV/SQL не будут затронуты.","页面渲染出错":"Ошибка отрисовки страницы","插件界面遇到一个错误，数据不会被修改。可以先点重试；若重复出现，请把下面的错误信息发给 AI 排查。":"В интерфейсе плагина произошла ошибка, и данные не будут изменены. Сначала вы можете нажать «Повторить»; Если это происходит неоднократно, отправьте приведенное ниже сообщение об ошибке в компанию AI для устранения неполадок.","错误详情":"Подробности ошибки","我在使用 DSH AI 数据库助手时遇到错误，请帮我定位并给出修复步骤。\n\n项目：{project}（{id}）\n错误：{message}\n\n请先判断原因（配置、客户端、权限、网络或插件缺陷），给出可执行排查步骤；如判断是插件缺陷，请指出文件与最小修复方案。不要修改生产数据，也不要向我索取密码。":"Я столкнулся с ошибкой при использовании помощника по работе с базами данных DSH AI. Пожалуйста, помогите мне найти его и дайте мне инструкции по ремонту.\n\nПроект: {project} ({id})\nОшибка: {сообщение}\n\nСначала определите причину (конфигурация, клиент, разрешения, дефекты сети или подключаемого модуля) и предоставьте выполнимые действия по устранению неполадок; Если будет установлено, что это дефект подключаемого модуля, укажите файл и минимальный план ремонта. Не изменяйте производственные данные и не спрашивайте у меня свой пароль."},"pt":{"AI 数据库助手":"Assistente de banco de dados de IA","用自然语言查询与分析数据":"Consulte e analise dados com linguagem natural","只读连接 MySQL / PostgreSQL / SQL Server / Oracle / SQLite；AI 自己查表、写 SQL、执行并解释结果。需要导出时生成 Excel、CSV 和最终 SQL。":"Conexão somente leitura com MySQL/PostgreSQL/SQL Server/Oracle/SQLite; A IA consulta tabelas, escreve SQL, executa e interpreta os resultados por si só. Gere Excel, CSV e SQL final quando a exportação for necessária.","正在切换项目…":"Mudando de projeto…","正在切换项目":"Trocando projetos","未选择项目":"Nenhum item selecionado","工作台加载失败":"Falha no carregamento do ambiente de trabalho","重试":"Tentar novamente","本地插件服务暂时没有返回数据。已有项目不会丢失；可直接重试，仍失败时请查看宿主日志。":"O serviço de plug-in local ainda não retorna dados. Os projetos existentes não serão perdidos; você pode tentar novamente diretamente. Se ainda falhar, verifique o log do host.","正在加载新项目的数据…":"Carregando dados para novo projeto...","先建一个项目":"Crie um projeto primeiro","项目保存数据库连接、保存目录和会话历史。点上方「新建项目」开始。":"Os projetos salvam conexões de banco de dados, salvam diretórios e histórico de sessões. Clique em \"Novo Projeto\" acima para começar.","数据库连接":"Conexão de banco de dados","收起设置":"Recolher configurações","添加连接":"Adicionar conexão","复制其他项目连接":"Copiar outras conexões do projeto","刷新":"Atualizar","还没有数据库连接。点「添加连接」选择数据库类型（MySQL / PostgreSQL / SQL Server / Oracle / SQLite）。":"Ainda não há conexão com o banco de dados. Clique em “Adicionar Conexão” para selecionar o tipo de banco de dados (MySQL/PostgreSQL/SQL Server/Oracle/SQLite).","测试连接":"Testar conexão","编辑":"Editar","删除连接":"Excluir conexão","可用":"Disponível","不可用":"Não disponível","未测试":"Não testado","新建数据库连接":"Crie uma nova conexão de banco de dados","编辑数据库连接":"Editar conexão com o banco de dados","使用只读账号；密码保存在 DSH 凭据中，这里只填引用名。SQLite 以只读方式打开文件。":"Use uma conta somente leitura; a senha é salva nas credenciais do DSH, e apenas o nome de referência é preenchido aqui. SQLite abre o arquivo somente leitura.","数据库类型":"Tipo de banco de dados","连接名称":"nome da conexão","数据库文件路径":"Caminho do arquivo do banco de dados","绝对路径；只会以只读方式打开，不会创建或修改文件":"Caminho absoluto; só será aberto como somente leitura, o arquivo não será criado ou modificado","本机绝对路径（按当前操作系统填写）":"Caminho absoluto da máquina local (preencher de acordo com o sistema operacional atual)","主机":"Anfitrião","端口":"porto","只读账号":"Conta somente leitura","数据库":"banco de dados","可选；Oracle/SQL Server/PostgreSQL 的默认 schema":"Opcional; esquema padrão para Oracle/SQL Server/PostgreSQL","信任服务器证书（仅用于自签名测试环境；默认关闭）":"Certificado de servidor confiável (somente para ambientes de teste autoassinados; desativado por padrão)","密码":"Senha","仅用于本次保存，不会写入配置或日志":"Usado apenas para este salvamento, nenhuma configuração ou logs serão gravados.","可选；留空则使用凭据引用":"Opcional; deixe em branco para usar referência de credencial","凭据引用":"Referência de credencial","只能使用字母、数字、下划线，且必须以字母或下划线开头；与上方密码二选一":"Somente letras, números e sublinhados podem ser usados e devem começar com uma letra ou sublinhado; escolha uma da senha acima","记住密码（保存到 DSH 凭据）":"Lembrar senha (salvar nas credenciais DSH)","客户端可执行文件":"Executável do cliente","可选；留空则自动从系统 PATH 查找。填写本机 MySQL 客户端可执行文件的绝对路径。":"Opcional; deixe em branco para pesquisar automaticamente no PATH do sistema. Preencha o caminho absoluto para o executável do cliente MySQL nativo.","本机 MySQL 客户端可执行文件的绝对路径":"Caminho absoluto para o executável do cliente MySQL nativo","保存并测试":"Salve e teste","取消编辑":"Cancelar edição","更新并测试":"Atualizar e testar","交付设置":"Configurações de entrega","已授权目录":"Diretório autorizado","结果保存目录":"Diretório de salvamento de resultados","Excel、CSV、SQL 只会写入这里":"Excel, CSV, SQL só serão escritos aqui","选择目录":"Selecionar diretório","保存目录":"Salvar diretório","问 AI":"Pergunte à IA","直接用自然语言描述你要的数据。AI 会自己查表、写并执行只读 SQL；不清楚时会反问你，可继续补充或修改。":"Descreva diretamente os dados que você deseja em linguagem natural. A IA procurará tabelas, escreverá e executará SQL somente leitura por si só; ele perguntará se não está claro e você poderá continuar a adicioná-lo ou modificá-lo.","例如：统计 2026 年各数据库备份失败的次数，按失败次数从高到低排序":"Por exemplo: conte o número de falhas de backup para cada banco de dados em 2026 e classifique-as de maior para menor de acordo com o número de falhas.","发送":"Enviar","查询结果":"Resultados da consulta","清理历史结果":"Limpar resultados históricos","清理插件内部历史快照，仅保留最近 10 个；已导出的 Excel/CSV/SQL 文件不会受影响。":"Limpe os snapshots históricos internos do plug-in, mantendo apenas os últimos 10; arquivos Excel/CSV/SQL exportados não serão afetados.","还没有结果。向 AI 提问并执行查询后，这里会列出可查看与导出的结果。":"Nenhum resultado ainda. Depois de fazer uma pergunta à IA e executar uma consulta, os resultados são listados aqui e podem ser visualizados e exportados.","查看":"Ver","导出":"Exportar","导出 Excel、CSV、SQL 三个文件":"Exporte três arquivos Excel, CSV, SQL","已导出":"Exportado","完整":"completo","不完整":"incompleto","数据快照已清理；不能导出，但仍可查看当时执行的 SQL。":"O instantâneo de dados foi limpo; ele não pode ser exportado, mas o SQL executado naquele momento ainda pode ser visualizado.","该结果的数据快照已清理，不能再查看预览或导出；SQL 仍保留在下方。":"O instantâneo de dados deste resultado foi limpo e não pode mais ser visualizado na visualização ou exportação; o SQL permanece abaixo.","本次结果不完整（达到行数或字节上限），不能导出；请缩小范围或先聚合再重试。":"O resultado desta vez está incompleto (o limite superior de linhas ou bytes foi atingido) e não pode ser exportado; restrinja o intervalo ou agregue-o primeiro e tente novamente.","仅预览前 20 行；导出使用完整结果。":"Somente as primeiras 20 linhas são visualizadas; a exportação usa os resultados completos.","上一页":"Página anterior","下一页":"Próxima página","复制其他项目的数据库连接":"Copiar conexões de banco de dados de outros projetos","只复制连接配置（主机、端口、账号、库名、凭据引用），不复制查询结果、会话和保存目录。":"Somente a configuração da conexão (host, porta, conta, nome da biblioteca, referência de credencial) é copiada e os resultados da consulta, sessões e diretórios de salvamento não são copiados.","正在读取其他项目的连接…":"Lendo conexões de outros projetos...","没有其他项目可复制的数据库连接。":"Não há conexões de banco de dados para replicar para outros projetos.","读取失败，请重试。":"Falha ao ler, tente novamente.","复制":"Copiar","已复制":"Copiado","项目":"Projeto","还没有项目":"Ainda não há projetos","选择项目":"Selecione o item","删除项目":"Excluir projeto","用于区分不同的数据库分析项目":"Usado para distinguir diferentes projetos de análise de banco de dados","例如：2026 年备份分析":"Por exemplo: Análise de Backup 2026","可选，写一句项目说明":"Opcional, escreva uma descrição do projeto","例如：只读连接 app_db，分析备份失败":"Por exemplo: conexão somente leitura app_db, falha de backup de análise","新建项目":"Novo projeto","重命名":"Renomear","项目名称":"Nome do projeto","项目说明":"Descrição do projeto","删除只移除项目记录，已生成的成果文件与证据包会保留在磁盘。":"A exclusão apenas remove o registro do projeto, e os arquivos de resultados e pacotes de evidências gerados permanecerão no disco.","保存":"Salvar","取消":"Cancelar","删除":"Excluir","连接未通过测试":"Falha no teste de conexão","询问 AI":"Pergunte à IA","已发送到 AI 会话，正在切换过去…":"Enviado para sessão AI, mudando para lá...","密码与凭据引用只能二选一：要记住密码就清空引用名，要用已有引用就不填密码。":"Você só pode escolher entre referências de senha e credencial: se quiser lembrar a senha, limpe o nome de referência; se quiser usar uma referência existente, deixe a senha em branco.","端口必须是 1-65535 之间的整数。":"A porta deve ser um número inteiro entre 1-65535.","当前环境不支持目录选择，请手动输入本机绝对路径。":"O ambiente atual não suporta seleção de diretório. Insira manualmente o caminho absoluto da máquina local.","数据库连接已保存":"Conexão de banco de dados salva","数据库连接已更新":"Conexão com o banco de dados atualizada","例如 生产库 / 本地 SQLite":"Por exemplo biblioteca de produção/SQLite local","只能使用字母、数字、下划线，且以字母或下划线开头；与上方密码二选一":"Apenas letras, números e sublinhados podem ser usados, e começa com uma letra ou sublinhado; escolha uma das senhas acima","未设置凭据引用":"Referência de credencial não definida","凭据引用已配置":"Referência de credenciais configurada","左侧":"lado esquerdo"," 发送":"enviar"," 正在加载新项目的数据…":"Carregando dados para novo projeto..."," 正在读取其他项目的连接…":"Lendo conexões de outros projetos...","会话服务不可用，请刷新页面后重试；若仍失败，请重启 DSH。":"O serviço de sessão não está disponível, atualize a página e tente novamente; se ainda falhar, reinicie o DSH.","会话发送服务不可用，请刷新页面后重试；若仍失败，请重启 DSH。":"O serviço de envio de sessões não está disponível, atualize a página e tente novamente; se ainda falhar, reinicie o DSH.","会话拒绝接收本次请求。":"A sessão se recusa a aceitar esta solicitação.","文件":"Arquivo","服务名 / SID":"Nome/SID do serviço","连接已保存，但本次密码未记住；后续查询需要改用 DSH 凭据引用。":"A conexão foi salva, mas a senha desta vez não foi lembrada; consultas subsequentes precisam usar referência de credencial DSH.","数据库连接已保存，并已通过测试连接。":"A conexão com o banco de dados é salva e a conexão de teste é aprovada.","数据库连接已更新，并已通过测试连接。":"A conexão com o banco de dados foi atualizada e a conexão de teste foi aprovada.","已复制数据库连接":"Conexão de banco de dados copiada","已删除连接":"Conexão excluída","已导出到":"Exportado para","已清理":"Limpo","个历史快照，保留":"instantâneos históricos, retidos","个；导出的文件未受影响。":"; os arquivos exportados não são afetados.","个数据源":"fontes de dados","条结果":"resultados","第":"Não.","页 · 共":"Páginas · Total","保存目录：":"Salvar diretório:","询问 AI 时出错":"Erro ao interrogar a IA","确认删除项目「{name}」？项目配置会删除，历史结果文件保留在磁盘上。":"Tem certeza de que deseja excluir o item \"{name}\"? A configuração do projeto é excluída e os arquivos de resultados históricos permanecem no disco.","确认删除项目「{name}」？{hint}":"Tem certeza de que deseja excluir o item \"{name}\"? {dica}","删除连接「{name}」（{dialect}）？只会删除 DSH 中保存的连接配置，不会删除真实数据库、SQLite 文件或历史导出文件。":"Excluir conexão \"{name}\" ({dialect})? Somente a configuração de conexão salva no DSH será excluída, não o banco de dados real, arquivos SQLite ou arquivos históricos de exportação.","清理插件内部历史快照，仅保留最近 {keep} 个；已导出的 Excel/CSV/SQL 文件不会受影响。":"Limpe os snapshots históricos internos do plug-in, mantendo apenas os mais recentes {keep}; arquivos Excel/CSV/SQL exportados não serão afetados.","页面渲染出错":"Erro ao renderizar a página","插件界面遇到一个错误，数据不会被修改。可以先点重试；若重复出现，请把下面的错误信息发给 AI 排查。":"A interface do plug-in encontrou um erro e os dados não serão modificados. Você pode clicar em Tentar novamente primeiro; se ocorrer repetidamente, envie a mensagem de erro abaixo para AI para solução de problemas.","错误详情":"Detalhes do erro","我在使用 DSH AI 数据库助手时遇到错误，请帮我定位并给出修复步骤。\n\n项目：{project}（{id}）\n错误：{message}\n\n请先判断原因（配置、客户端、权限、网络或插件缺陷），给出可执行排查步骤；如判断是插件缺陷，请指出文件与最小修复方案。不要修改生产数据，也不要向我索取密码。":"Encontrei um erro ao usar o assistente de banco de dados DSH AI. Por favor, ajude-me a localizá-lo e me dê as etapas de reparo.\n\nProjeto: {projeto} ({id})\nErro: {mensagem}\n\nPrimeiro determine a causa (defeitos de configuração, cliente, permissões, rede ou plug-in) e forneça etapas executáveis de solução de problemas; se for considerado um defeito de plug-in, indique o arquivo e o plano mínimo de reparo. Não modifique os dados de produção e não me peça sua senha."}};
    for (const [locale, table] of Object.entries(UI_EXTRA)) {
      UI_TEXT[locale] = Object.assign(Object.create(null), table);
    }

    /** Dynamic strings (counts, paths, notices) for the added languages. */
    const UI_DYNAMIC = {
      ja: {
        page: (a, b, c) => `${a} / ${b} ページ · 全${c}件`,
        results: (n) => `${n} 件の結果`,
        sources: (n, r) => `${n} 個のデータソース · 結果 ${r} 件`,
        dir: (p) => `保存先：${p}`,
        exported: (p, f) => `${p} にエクスポートしました：${f}`,
        testFail: (m) => `データベース接続は保存されましたが、接続テストに失敗しました：${m}`,
      },
      ko: {
        page: (a, b, c) => `${a} / ${b} 페이지 · 총 ${c}건`,
        results: (n) => `${n}개 결과`,
        sources: (n, r) => `${n}개 데이터 소스 · 결과 ${r}개`,
        dir: (p) => `저장 경로: ${p}`,
        exported: (p, f) => `${p}에 내보냈습니다: ${f}`,
        testFail: (m) => `데이터베이스 연결은 저장되었지만 연결 테스트에 실패했습니다: ${m}`,
      },
      es: {
        page: (a, b, c) => `Página ${a} / ${b} · ${c} en total`,
        results: (n) => `${n} resultados`,
        sources: (n, r) => `${n} fuentes de datos · ${r} resultados`,
        dir: (p) => `Directorio de guardado: ${p}`,
        exported: (p, f) => `Exportado a ${p}: ${f}`,
        testFail: (m) => `Conexión guardada, pero la prueba de conexión falló: ${m}`,
      },
      fr: {
        page: (a, b, c) => `Page ${a} / ${b} · ${c} au total`,
        results: (n) => `${n} résultats`,
        sources: (n, r) => `${n} sources · ${r} résultats`,
        dir: (p) => `Dossier d’enregistrement : ${p}`,
        exported: (p, f) => `Exporté vers ${p} : ${f}`,
        testFail: (m) => `Connexion enregistrée, mais le test a échoué : ${m}`,
      },
      de: {
        page: (a, b, c) => `Seite ${a} / ${b} · ${c} insgesamt`,
        results: (n) => `${n} Ergebnisse`,
        sources: (n, r) => `${n} Datenquellen · ${r} Ergebnisse`,
        dir: (p) => `Speicherordner: ${p}`,
        exported: (p, f) => `Nach ${p} exportiert: ${f}`,
        testFail: (m) => `Verbindung gespeichert, aber der Verbindungstest ist fehlgeschlagen: ${m}`,
      },
      ru: {
        page: (a, b, c) => `Страница ${a} / ${b} · всего ${c}`,
        results: (n) => `${n} результатов`,
        sources: (n, r) => `${n} источников · ${r} результатов`,
        dir: (p) => `Каталог сохранения: ${p}`,
        exported: (p, f) => `Экспортировано в ${p}: ${f}`,
        testFail: (m) => `Подключение сохранено, но проверка не удалась: ${m}`,
      },
      pt: {
        page: (a, b, c) => `Página ${a} / ${b} · ${c} no total`,
        results: (n) => `${n} resultados`,
        sources: (n, r) => `${n} fontes de dados · ${r} resultados`,
        dir: (p) => `Diretório de salvamento: ${p}`,
        exported: (p, f) => `Exportado para ${p}: ${f}`,
        testFail: (m) => `Conexão salva, mas o teste de conexão falhou: ${m}`,
      },
    };

    /** Locale templates for imperative strings (confirm dialogs, prompts). */
    const UI_TEMPLATES = {
      en: {
        deleteProject: 'Delete project “{name}”? Project settings are removed; result files stay on disk.',
        deleteProjectWithHint: 'Delete project “{name}”? {hint}',
        deleteConnection: 'Delete connection “{name}” ({dialect})? Only the saved DSH settings are removed; the database, SQLite file and exported files are untouched.',
        clearResults: 'Clear internal result snapshots, keeping the latest {keep}. Exported files are untouched.',
        askAiPrompt: 'I hit an error in the DSH AI Database Assistant. Please diagnose it and propose a fix.\n\nProject: {project} ({id})\nError: {message}\n\nFirst classify the cause (configuration, client, permission, network, or a plugin defect). Give concrete steps; if it is a plugin defect, name the file and the minimal fix. Do not modify production data and do not ask me for passwords.',
      },
      'zh-TW': {
        deleteProject: '確認刪除專案「{name}」？專案設定會刪除，歷史結果檔案保留在磁碟上。',
        deleteProjectWithHint: '確認刪除專案「{name}」？{hint}',
        deleteConnection: '刪除連線「{name}」（{dialect}）？只會刪除 DSH 中儲存的連線設定，不會刪除真實資料庫、SQLite 檔案或歷史匯出檔案。',
        clearResults: '清除外掛內部歷史快照，僅保留最近 {keep} 個；已匯出的檔案不受影響。',
        askAiPrompt: '我在使用 DSH AI 資料庫助手時遇到錯誤，請幫我定位並提出修正方式。\n\n專案：{project}（{id}）\n錯誤：{message}\n\n請先判斷原因（設定、用戶端、權限、網路或外掛缺陷），给出可執行的排查步驟；若是外掛缺陷，請指出檔案與最小修正。不要修改正式資料，也不要向我索取密碼。',
      },
      "ja": {"deleteProject":"プロジェクト「{name}」を削除しますか？プロジェクト設定は削除され、履歴結果ファイルはディスク上に残ります。","deleteProjectWithHint":"プロジェクト「{name}」を削除しますか？{hint}","deleteConnection":"接続「{name}」({dialect}) を削除しますか? DSH に保存された接続設定のみが削除され、実際のデータベース、SQLite ファイル、履歴エクスポート ファイルは削除されません。","clearResults":"プラグインの内部履歴スナップショットをクリーンアップし、最新の {keep} のみを保持します。エクスポートされたファイルは影響を受けません。","askAiPrompt":"DSH AI データベース アシスタントの使用中にエラーが発生しました。場所を特定し、修復手順を教えてください。\n\nプロジェクト: {project} ({id})\nエラー: {message}\n\nまず原因 (構成、クライアント、権限、ネットワークまたはプラグインの欠陥) を特定し、実行可能なトラブルシューティング手順を提供してください。プラグインの欠陥であると判断された場合は、ファイルと最小限の修復を指定してください。本番データを変更したり、パスワードを要求したりしないでください。"},
      "ko": {"deleteProject":"'{name}' 프로젝트를 삭제하시겠습니까? 프로젝트 설정이 삭제되고 기록 결과 파일은 디스크에 남습니다.","deleteProjectWithHint":"'{name}' 프로젝트를 삭제하시겠습니까? {hint}","deleteConnection":"연결 \"{name}\"({dialect})을 삭제하시겠습니까? DSH에 저장된 연결 설정만 삭제되며 실제 데이터베이스, SQLite 파일 또는 기록 내보내기 파일은 삭제되지 않습니다.","clearResults":"가장 최근의 {keep}만 유지하면서 플러그인의 내부 기록 스냅샷을 정리합니다. 내보낸 파일은 영향을 받지 않습니다.","askAiPrompt":"DSH AI 데이터베이스 도우미를 사용할 때 오류가 발생했습니다. 제가 찾을 수 있도록 도와주시고 수리 단계를 알려주세요.\n\n프로젝트: {project} ({id})\n오류: {message}\n\n먼저 원인(구성, 클라이언트, 권한, 네트워크 또는 플러그인 결함)을 파악하고 실행 가능한 문제 해결 단계를 제공하십시오. 플러그인 결함으로 판단되는 경우 파일과 최소한의 수리를 명시해 주십시오. 생산 데이터를 수정하지 마시고 비밀번호를 묻지 마세요."},
      "es": {"deleteProject":"¿Eliminar el proyecto \"{name}\"? La configuración del proyecto se elimina y los archivos de resultados históricos permanecen en el disco.","deleteProjectWithHint":"¿Eliminar el proyecto \"{name}\"? {hint}","deleteConnection":"¿Eliminar la conexión \"{name}\" ({dialect})? Solo se eliminan las configuraciones de conexión guardadas en DSH, no la base de datos real, los archivos SQLite o los archivos de exportación históricos.","clearResults":"Limpia las instantáneas históricas internas del complemento y conserva solo las {keep} más recientes; Los archivos exportados no se ven afectados.","askAiPrompt":"Encontré un error al utilizar el asistente de base de datos DSH AI. Por favor ayúdame a localizarlo y dame los pasos de reparación.\n\nProyecto: {project} ({id})\nError: {message}\n\nPrimero determine la causa (configuración, cliente, permisos, defectos de red o complementos) y proporcione pasos ejecutables para la solución de problemas; Si se considera que es un defecto del complemento, indique el archivo y la reparación mínima. No modifiques datos de producción y no me pidas tu contraseña."},
      "fr": {"deleteProject":"Supprimer le projet « {name} » ? Les paramètres du projet sont supprimés et les fichiers de résultats historiques restent sur le disque.","deleteProjectWithHint":"Supprimer le projet « {name} » ? {hint}","deleteConnection":"Supprimer la connexion \"{name}\" ({dialect}) ? Seuls les paramètres de connexion enregistrés dans DSH sont supprimés, pas la base de données réelle, les fichiers SQLite ou les fichiers d'exportation historiques.","clearResults":"Nettoyez les instantanés historiques internes du plug-in, en ne conservant que les {keep} les plus récents ; les fichiers exportés ne sont pas affectés.","askAiPrompt":"J'ai rencontré une erreur lors de l'utilisation de l'assistant de base de données DSH AI. S'il vous plaît, aidez-moi à le localiser et donnez-moi les étapes de réparation.\n\nProjet : {project} ({id})\nErreur : {message}\n\nVeuillez d'abord déterminer la cause (défauts de configuration, de client, d'autorisations, de réseau ou de plug-in) et fournir des étapes de dépannage exécutables ; s'il s'agit d'un défaut du plug-in, veuillez indiquer le fichier et la réparation minimale. Ne modifiez pas les données de production et ne me demandez pas votre mot de passe."},
      "de": {"deleteProject":"Projekt „{name}“ löschen? Die Projekteinstellungen werden gelöscht und historische Ergebnisdateien bleiben auf der Festplatte.","deleteProjectWithHint":"Projekt „{name}“ löschen? {hint}","deleteConnection":"Verbindung „{name}“ ({dialect}) löschen? Es werden nur die in DSH gespeicherten Verbindungseinstellungen gelöscht, nicht die echte Datenbank, SQLite-Dateien oder historischen Exportdateien.","clearResults":"Bereinigen Sie die internen historischen Snapshots des Plug-Ins und behalten Sie nur die neuesten {keep}; exportierte Dateien sind nicht betroffen.","askAiPrompt":"Bei der Verwendung des DSH AI-Datenbankassistenten ist ein Fehler aufgetreten. Bitte helfen Sie mir, es zu finden und geben Sie mir die Reparaturschritte.\n\nProjekt: {project} ({id})\nFehler: {message}\n\nBitte ermitteln Sie zunächst die Ursache (Konfigurations-, Client-, Berechtigungs-, Netzwerk- oder Plug-in-Defekte) und stellen Sie ausführbare Schritte zur Fehlerbehebung bereit; Wenn festgestellt wird, dass es sich um einen Plug-In-Defekt handelt, geben Sie bitte die Datei und die Mindestreparatur an. Ändern Sie keine Produktionsdaten und fragen Sie mich nicht nach Ihrem Passwort."},
      "ru": {"deleteProject":"Удалить проект \"{name}\"? Настройки проекта удаляются, а файлы исторических результатов остаются на диске.","deleteProjectWithHint":"Удалить проект \"{name}\"? {hint}","deleteConnection":"Удалить соединение «{name}» ({dialect})? Удалены только настройки подключения, сохраненные в DSH, а не реальная база данных, файлы SQLite или исторические файлы экспорта.","clearResults":"Очистите внутренние исторические снимки плагина, оставив только самые последние {keep}; экспортированные файлы не затрагиваются.","askAiPrompt":"Я столкнулся с ошибкой при использовании помощника по работе с базами данных DSH AI. Пожалуйста, помогите мне найти его и дайте мне инструкции по ремонту.\n\nПроект: {project} ({id})\nОшибка: {message}\n\nСначала определите причину (конфигурация, клиент, разрешения, дефекты сети или подключаемого модуля) и предоставьте выполнимые действия по устранению неполадок; если это будет признано дефектом плагина, укажите файл и минимальный ремонт. Не изменяйте производственные данные и не спрашивайте у меня свой пароль."},
      "pt": {"deleteProject":"Excluir o projeto \"{name}\"? As configurações do projeto são excluídas e os arquivos de resultados históricos permanecem no disco.","deleteProjectWithHint":"Excluir o projeto \"{name}\"? {hint}","deleteConnection":"Excluir conexão \"{name}\" ({dialect})? Somente as configurações de conexão salvas no DSH são excluídas, não o banco de dados real, os arquivos SQLite ou os arquivos históricos de exportação.","clearResults":"Limpe os snapshots históricos internos do plug-in, mantendo apenas os {keep} mais recentes; os arquivos exportados não são afetados.","askAiPrompt":"Encontrei um erro ao usar o assistente de banco de dados DSH AI. Por favor, ajude-me a localizá-lo e me dê as etapas de reparo.\n\nProjeto: {project} ({id})\nErro: {message}\n\nPrimeiro determine a causa (defeitos de configuração, cliente, permissões, rede ou plug-in) e forneça etapas executáveis de solução de problemas; se for considerado um defeito de plug-in, indique o arquivo e o reparo mínimo. Não modifique os dados de produção e não me peça sua senha."},
    };
    UI_TEMPLATES.zh = {
      deleteProject: '确认删除项目「{name}」？项目配置会删除，历史结果文件保留在磁盘上。',
      deleteProjectWithHint: '确认删除项目「{name}」？{hint}',
      deleteConnection: '删除连接「{name}」（{dialect}）？只会删除 DSH 中保存的连接配置，不会删除真实数据库、SQLite 文件或历史导出文件。',
      clearResults: '清理插件内部历史快照，仅保留最近 {keep} 个；已导出的 Excel/CSV/SQL 文件不会受影响。',
      askAiPrompt: '我在使用 DSH AI 数据库助手时遇到错误，请帮我定位并给出修复步骤。\n\n项目：{project}（{id}）\n错误：{message}\n\n请先判断原因（配置、客户端、权限、网络或插件缺陷），给出可执行排查步骤；如判断是插件缺陷，请指出文件与最小修复方案。不要修改生产数据，也不要向我索取密码。',
    };

    /** Fill a locale template with named parameters. */
    function tf(key, params) {
      const table = UI_TEMPLATES[activeLocale] ?? UI_TEMPLATES.zh;
      const template = table?.[key] ?? UI_TEMPLATES.zh[key];
      if (typeof template !== 'string') return '';
      return template.replace(/\{(\w+)\}/g, (match, name) => (params && name in params ? String(params[name]) : match));
    }

    /** Normalise a DSH locale id to the three supported UI languages. */
    function normalizeLocale(value) {
      const tag = String(value ?? '').trim().toLowerCase().replace(/_/g, '-');
      if (tag.startsWith('zh')) {
        return tag.includes('hant') || /^zh-(tw|hk|mo)(-|$)/.test(tag) ? 'zh-TW' : 'zh';
      }
      if (tag.startsWith('en')) return 'en';
      for (const id of ['ja', 'ko', 'es', 'fr', 'de', 'ru', 'pt']) {
        if (tag === id || tag.startsWith(`${id}-`)) return id;
      }
      return 'zh';
    }

    const TRANSLATE_PROP_NAMES = new Set(['title', 'placeholder', 'label', 'hint', 'aria-label', 'alt', 'description']);

    /** Translate display-only props; never touch values, keys or handlers. */
    function translateDisplayProps(props) {
      if (props === null || typeof props !== 'object' || activeLocale === 'zh') return props;
      let out = null;
      for (const name of Object.keys(props)) {
        if (name !== 'children' && !TRANSLATE_PROP_NAMES.has(name)) continue;
        const value = props[name];
        if (typeof value !== 'string') continue;
        const next = tr(value);
        if (next === value) continue;
        if (out === null) out = {...props};
        out[name] = next;
      }
      return out ?? props;
    }

    /** Translate one rendered string through exact matches and regex rules. */
    function tr(text) {
      if (typeof text !== 'string' || text === '' || activeLocale === 'zh') return text;
      const exact = UI_TEXT[activeLocale]?.[text];
      if (typeof exact === 'string') return exact;
      const dynamic = UI_DYNAMIC[activeLocale];
      if (dynamic !== undefined) {
        let match = /^第 (\d+) \/ (\d+) 页 · 共 (\d+) 条$/.exec(text);
        if (match !== null) return dynamic.page(match[1], match[2], match[3]);
        match = /^(\d+) 条结果$/.exec(text);
        if (match !== null) return dynamic.results(match[1]);
        match = /^(\d+) 个数据源 · 结果 (\d+) 个$/.exec(text);
        if (match !== null) return dynamic.sources(match[1], match[2]);
        match = /^保存目录：(.+)$/.exec(text);
        if (match !== null) return dynamic.dir(match[1]);
        match = /^已导出到 (.+)：(.+)$/.exec(text);
        if (match !== null) return dynamic.exported(match[1], match[2]);
        match = /^数据库连接已保存，但测试连接未通过：(.+)$/.exec(text);
        if (match !== null) return dynamic.testFail(match[1]);
      }
      for (const [pattern, replace] of (UI_RULES[activeLocale] ?? [])) {
        if (pattern.test(text)) return text.replace(pattern, (...args) => replace(args));
      }
      return text;
    }

    let activeLocale = 'zh';
    function t(key) {
      const base = DICT.zh[key] ?? key;
      if (activeLocale === 'zh') return base;
      const table = DICT[activeLocale];
      if (table !== undefined && typeof table[key] === 'string') return table[key];
      return tr(base);
    }

    /* ------------------------------------------------------------------ */
    /* Styles                                                              */
    /* ------------------------------------------------------------------ */

    const CSS = `
      .ita-page {
        box-sizing: border-box; flex: 1 1 auto; min-height: 0; height: 100%; overflow: auto;
        padding: calc(20px + var(--dsh-frame-top-clearance, 0px)) clamp(18px, 3.2vw, 44px) 64px;
        color: var(--dsw-alias-label-primary); font-size: 13px; line-height: 20px;
        background: radial-gradient(1200px 420px at 12% -8%, color-mix(in srgb, var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary)) 8%, transparent), transparent 70%);
      }
      .ita-wrap { width: 100%; max-width: 1120px; margin: 0 auto; display: flex; flex-direction: column; gap: 16px; padding-bottom: 10px; }

      /* Hero */
      .ita-hero { position: relative; display: flex; align-items: flex-start; justify-content: space-between; gap: 18px; flex-wrap: wrap;
        padding: 20px 22px; border-radius: 20px; border: 0.5px solid var(--dsw-alias-border-l2);
        background: linear-gradient(135deg, color-mix(in srgb, var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary)) 7%, transparent) 0%, transparent 52%),
          var(--dsw-alias-settings-card-fill, var(--dsw-alias-bg-layer-1)); overflow: hidden; }
      .ita-hero::after { content: ""; position: absolute; right: -70px; top: -90px; width: 230px; height: 230px; border-radius: 50%;
        background: radial-gradient(circle, color-mix(in srgb, var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary)) 16%, transparent), transparent 70%);
        pointer-events: none; }
      .ita-hero-main { position: relative; z-index: 1; min-width: 0; display: flex; flex-direction: column; gap: 5px; }
      .ita-eyebrow { color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); font-size: 10.5px; line-height: 16px;
        font-weight: 600; letter-spacing: 0.14em; text-transform: uppercase; }
      .ita-title { margin: 0; font-size: 23px; line-height: 31px; font-weight: 650; letter-spacing: 0.01em; }
      .ita-sub { margin: 0; max-width: 780px; color: var(--dsw-alias-label-secondary); font-size: 13px; line-height: 21px; }
      .ita-stage-pill { position: relative; z-index: 1; flex: none; display: inline-flex; align-items: center; gap: 7px; max-width: 340px;
        height: 28px; padding: 0 12px; border-radius: 999px; font-size: 12px; font-weight: 600;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        color: var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary));
        border: 0.5px solid color-mix(in srgb, var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary)) 34%, var(--dsw-alias-border-l2));
        background: color-mix(in srgb, var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary)) 9%, transparent); }
      .ita-stage-dot { width: 6px; height: 6px; border-radius: 50%;
        background: var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary)); }
      .ita-hero-side { position: relative; z-index: 1; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
      .ita-hero-note { flex: none; font-size: 11.5px; color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary));
        padding: 0 10px; height: 28px; display: inline-flex; align-items: center; border-radius: 999px;
        border: 0.5px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2, transparent); }
      .ita-db-icon { flex: none; width: 32px; height: 32px; border-radius: 10px; display: grid; place-items: center;
        color: var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary));
        background: color-mix(in srgb, var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary)) 10%, transparent); }

      /* Project row + segmented tabs */
      .ita-navcard { display: flex; flex-direction: column; gap: 10px; padding: 12px 14px;
        border: 0.5px solid var(--dsw-alias-border-l2); border-radius: 16px;
        background: var(--dsw-alias-settings-card-fill, var(--dsw-alias-bg-layer-1)); }
      .ita-tabs { display: flex; gap: 4px; padding: 4px; border-radius: 12px; border: 0.5px solid var(--dsw-alias-border-l1);
        background: var(--dsw-alias-bg-layer-2, transparent); overflow-x: auto; }
      .ita-tab { appearance: none; border: 0; background: transparent; color: var(--dsw-alias-label-secondary);
        font: inherit; font-size: 13px; font-weight: 500; line-height: 20px; white-space: nowrap; cursor: pointer;
        padding: 7px 14px; border-radius: 9px; transition: background 0.15s, color 0.15s, box-shadow 0.15s; }
      .ita-tab:hover { color: var(--dsw-alias-label-primary);
        background: color-mix(in srgb, var(--dsw-alias-label-primary) 5%, transparent); }
      .ita-tab:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary)); outline-offset: 1px; }

      /* Cards */
      .ita-phase { display: flex; flex-direction: column; gap: 12px; }
      .ita-card { position: relative; display: flex; flex-direction: column; gap: 14px; padding: 17px 19px 18px; margin: 0;
        border: 0.5px solid var(--dsw-alias-border-l2); border-radius: 18px;
        background: var(--dsw-alias-settings-card-fill, var(--dsw-alias-bg-layer-1));
        box-shadow: 0 1px 2px rgba(0, 0, 0, 0.03); }
      .ita-card-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
      .ita-card-title { margin: 0; font-size: 14px; font-weight: 600; line-height: 20px; letter-spacing: 0.01em;
        display: flex; align-items: center; gap: 8px; }

      /* Delivery directory */
      .ita-dir { display: flex; align-items: flex-start; gap: 14px; padding: 14px 15px;
        border: 0.5px solid color-mix(in srgb, var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary)) 18%, var(--dsw-alias-border-l2));
        border-radius: 14px;
        background: linear-gradient(135deg, color-mix(in srgb, var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary)) 5%, transparent), transparent 55%),
          var(--dsw-alias-bg-layer-1); }
      .ita-dir-icon { flex: none; width: 40px; height: 40px; border-radius: 12px; display: grid; place-items: center;
        color: var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary));
        background: color-mix(in srgb, var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary)) 11%, transparent);
        border: 0.5px solid color-mix(in srgb, var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary)) 18%, transparent); }
      .ita-dir-main { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 8px; }
      .ita-dir-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
      .ita-dir-title { font-size: 12.5px; font-weight: 600; color: var(--dsw-alias-label-primary); }
      .ita-dir-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
      .ita-dir-row .ita-input { flex: 1 1 340px; min-width: 200px; height: 36px; font-family: var(--ds-font-family-code, ui-monospace, Menlo, monospace);
        font-size: 11.5px; letter-spacing: -0.01em; }
      .ita-dir-actions { display: flex; align-items: center; gap: 8px; flex: none; }
      @media (width <= 720px) { .ita-dir { padding: 12px; } .ita-dir-icon { display: none; } .ita-dir-actions { width: 100%; } .ita-dir-actions .ita-btn { flex: 1; } }

      /* Ask panel */
      .ita-ask { display: flex; flex-direction: column; gap: 10px; }
      .ita-ask .ita-textarea { min-height: 112px; font-size: 13.5px; line-height: 21px; padding: 12px 13px; }
      .ita-ask-foot { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
      .ita-kbd { display: inline-flex; align-items: center; gap: 4px; color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); font-size: 11px; }
      .ita-kbd kbd { font-family: var(--ds-font-family-code, ui-monospace, Menlo, monospace); font-size: 10.5px; line-height: 16px;
        padding: 0 5px; border-radius: 5px; border: 0.5px solid var(--dsw-alias-border-l2);
        background: var(--dsw-alias-bg-layer-2, transparent); }

      .ita-pager { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap;
        padding-top: 10px; border-top: 0.5px solid var(--dsw-alias-border-l1); }

      /* Result row */
      .ita-result { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 12px 20px; align-items: start;
        padding: 14px 16px; border-radius: 14px; border: 0.5px solid var(--dsw-alias-border-l2);
        background: var(--dsw-alias-bg-layer-1); transition: border-color 0.15s, background 0.15s; }
      @media (hover: hover) { .ita-result:hover { border-color: var(--dsw-alias-border-l3); background: color-mix(in srgb, var(--dsw-alias-label-primary) 2%, var(--dsw-alias-bg-layer-1)); } }
      .ita-result-main { min-width: 0; display: flex; flex-direction: column; gap: 7px; }
      .ita-result-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; min-width: 0; }
      .ita-result-title { font-size: 13.5px; font-weight: 600; line-height: 20px; overflow-wrap: anywhere; }
      .ita-result-meta { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary));
        font-size: 11px; line-height: 17px; }
      .ita-result-meta .ita-mono { font-family: var(--ds-font-family-code, ui-monospace, Menlo, monospace); font-size: 10.5px; letter-spacing: -0.01em; }
      .ita-result-meta .ita-sep { opacity: 0.45; }
      .ita-result-exported { color: var(--dsw-alias-state-success-primary); font-size: 10.5px; }
      .ita-result-export { color: var(--dsw-alias-state-success-primary); font-size: 10.5px; line-height: 16px; overflow-wrap: anywhere; }
      .ita-result-actions { display: flex; flex-direction: column; align-items: flex-end; gap: 5px; flex: none; }
      .ita-result-actions .ita-btn { min-height: 32px; height: auto; }
      .ita-result-formats { color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); font-size: 10px; line-height: 14px; white-space: nowrap; }
      @media (width <= 720px) {
        .ita-result { grid-template-columns: minmax(0, 1fr); gap: 10px; padding: 13px 14px; }
        .ita-result-actions { flex-direction: row; align-items: center; justify-content: flex-end; width: 100%; }
        .ita-result-formats { display: none; }
      }

      /* Database form */
      .ita-db-form { display: flex; flex-direction: column; gap: 14px; padding: 16px; margin-top: 4px;
        border: 0.5px solid var(--dsw-alias-border-l2); border-radius: 14px;
        background: var(--dsw-alias-bg-layer-2, transparent); }
      .ita-db-form-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
      .ita-db-form-title { margin: 0; font-size: 13px; font-weight: 600; }
      .ita-db-form-foot { display: flex; justify-content: flex-end; gap: 8px; padding-top: 12px;
        border-top: 0.5px solid var(--dsw-alias-border-l1); }
      .ita-db-form .ita-input, .ita-db-form .ita-select, .ita-db-form .ita-textarea {
        height: 40px; border-radius: 10px;
        background: color-mix(in srgb, var(--dsw-alias-label-primary) 4%, var(--dsw-alias-bg-layer-2, transparent));
        border-color: color-mix(in srgb, var(--dsw-alias-label-primary) 9%, transparent);
        box-shadow: inset 0 1px 1px color-mix(in srgb, #000 3%, transparent); }
      .ita-db-form .ita-input:hover:not(:disabled) { border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary)) 28%, transparent); }
      .ita-db-form .ita-input:focus { background: var(--dsw-alias-bg-layer-1); }
      .ita-copy-project { margin: 4px 0 2px; font-size: 11px; font-weight: 600; letter-spacing: 0.04em;
        color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); text-transform: uppercase; }
      .ita-copy-item { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
      .ita-copy-main { min-width: 0; display: flex; flex-direction: column; gap: 3px; }
      .ita-copy-name { font-size: 13px; font-weight: 600; }
      @media (width <= 720px) { .ita-copy-item { align-items: flex-start; flex-direction: column; } }

      /* Connection tile */
      .ita-item { transition: border-color 0.15s, background 0.15s; }
      @media (hover: hover) { .ita-item:hover { border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary)) 26%, var(--dsw-alias-border-l2)); } }
      .ita-item .ita-row[style*="justify-content: space-between"] { flex-wrap: nowrap; }
      @media (width <= 720px) { .ita-item .ita-row[style*="justify-content: space-between"] { flex-wrap: wrap; } }

      /* Project row + grouped form */
      .ita-projects { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
      .ita-projects-label { flex: none; color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); font-size: 12px; }
      .ita-projects .ita-select { height: 34px; }
      .ita-projects-select { flex: 1 1 320px; min-width: 220px; max-width: 560px; }
      .ita-projects-meta { margin-left: auto; color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary));
        font-size: 11.5px; white-space: nowrap; }
      .ita-projects-actions { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
      .ita-group { display: flex; flex-direction: column; gap: 13px; padding: 15px 17px 16px;
        border: 0.5px solid var(--dsw-alias-border-l2); border-radius: 16px;
        background: var(--dsw-alias-settings-card-fill, var(--dsw-alias-bg-layer-1)); }
      .ita-group-head { display: flex; align-items: center; gap: 10px; }
      .ita-group-index { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px;
        border-radius: 8px; font-family: var(--ds-font-family-code, ui-monospace, Menlo, monospace); font-size: 10.5px; font-weight: 700;
        color: var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary));
        background: color-mix(in srgb, var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary)) 12%, transparent); }
      .ita-group-title { margin: 0; font-size: 14px; font-weight: 600; line-height: 20px; letter-spacing: 0.01em; }
      .ita-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px 18px; }
      @media (width <= 900px) { .ita-grid { grid-template-columns: minmax(0, 1fr); } }
      .ita-field--wide { grid-column: 1 / -1; }
      .ita-req { flex: none; color: var(--dsw-alias-state-error-primary); font-size: 10.5px; font-weight: 600; line-height: 16px;
        padding: 0 6px; border-radius: 999px; background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent); }
      .ita-check-grid { display: flex; flex-wrap: wrap; gap: 8px 18px; }
      .ita-check-row { display: inline-flex; align-items: center; gap: 8px; cursor: pointer; }
      .ita-checkbox { width: 16px; height: 16px; flex: none; cursor: pointer; border-radius: 4px;
        accent-color: var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary)); }
      .ita-check-text { color: var(--dsw-alias-label-secondary); font-size: 12.5px; }
      .ita-actionbar { display: flex; align-items: center; gap: 10px 14px; flex-wrap: wrap; padding-top: 12px;
        border-top: 0.5px solid var(--dsw-alias-border-l1); }
      .ita-actionbar-group { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
      .ita-status { margin-left: auto; display: inline-flex; align-items: center; gap: 7px; max-width: 100%; min-height: 28px; padding: 0 11px;
        border-radius: 999px; border: 0.5px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2, transparent);
        color: var(--dsw-alias-label-secondary); font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .ita-status::before { content: ""; flex: none; width: 6px; height: 6px; border-radius: 50%;
        background: var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary)); }

      /* Layout helpers */
      .ita-row { display: flex; gap: 8px; align-items: flex-end; flex-wrap: wrap; min-width: 0; }
      .ita-field { display: flex; flex-direction: column; gap: 6px; min-width: 150px; flex: 1 1 180px; }
      .ita-label { display: flex; align-items: center; gap: 7px; color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 18px; font-weight: 500; }
      .ita-grid2 { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px 16px; }
      @media (width <= 900px) { .ita-grid2 { grid-template-columns: minmax(0, 1fr); } }

      /* Inputs */
      .ita-input, .ita-select, .ita-textarea { box-sizing: border-box; flex: 1; min-width: 0; height: 38px; padding: 0 12px; font: inherit; font-size: 13px;
        color: var(--dsw-alias-label-primary); background: color-mix(in srgb, var(--dsw-alias-label-primary) 5%, var(--dsw-alias-bg-layer-2, transparent));
        border: 1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 10%, transparent); border-radius: 10px; outline: none;
        -webkit-appearance: none; appearance: none;
        box-shadow: inset 0 1px 1px color-mix(in srgb, #000 4%, transparent);
        transition: border-color 0.15s, box-shadow 0.15s, background 0.15s; }
      .ita-input::placeholder, .ita-textarea::placeholder { color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); }
      @media (hover: hover) { .ita-input:hover:not(:disabled), .ita-select:hover:not(:disabled), .ita-textarea:hover:not(:disabled) { border-color: var(--dsw-alias-border-l4, var(--dsw-alias-border-l3)); } }
      .ita-input:focus, .ita-select:focus, .ita-textarea:focus {
        border-color: var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary));
        box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary)) 16%, transparent);
        background: var(--dsw-alias-bg-layer-1); }
      .ita-select { appearance: auto; cursor: pointer; padding-inline: 9px; }
      .ita-textarea { height: auto; min-height: 96px; padding: 9px 11px; line-height: 19px; resize: vertical; font-family: inherit; }

      /* Buttons */
      .ita-btn { appearance: none; display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-height: 34px; height: auto; padding: 5px 14px;
        max-width: 100%; line-height: 1.25; text-align: center; font: inherit; font-size: 13px; font-weight: 500; white-space: normal; overflow-wrap: anywhere; cursor: pointer; color: var(--dsw-alias-label-primary);
        background: var(--dsw-alias-bg-layer-2, transparent); border: 0.5px solid var(--dsw-alias-border-l3, var(--dsw-alias-border-l2));
        border-radius: 10px; transition: background 0.15s, border-color 0.15s, opacity 0.15s, transform 0.06s; }
      @media (hover: hover) { .ita-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2)); border-color: var(--dsw-alias-border-l4, var(--dsw-alias-border-l3)); } }
      .ita-btn:active:not(:disabled) { transform: translateY(0.5px); }
      .ita-btn:disabled { opacity: 0.55; cursor: default; }
      .ita-btn:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary)); outline-offset: 1px; }
      .ita-btn--primary { color: var(--dsw-alias-label-primary-foreground, #fff); border-color: transparent;
        background: var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary));
        box-shadow: 0 1px 2px color-mix(in srgb, var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary)) 30%, transparent); }
      @media (hover: hover) { .ita-btn--primary:hover:not(:disabled) { filter: brightness(1.07); background: var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary)); } }
      .ita-btn--danger { color: var(--dsw-alias-state-error-primary); background: transparent;
        border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 42%, var(--dsw-alias-border-l3)); }
      @media (hover: hover) { .ita-btn--danger:hover:not(:disabled) {
        background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 8%, transparent); } }
      .ita-btn--ghost { background: transparent; border-color: var(--dsw-alias-border-l3, var(--dsw-alias-border-l2)); color: var(--dsw-alias-label-primary); }
      @media (hover: hover) { .ita-btn--ghost:hover:not(:disabled) { background: color-mix(in srgb, var(--dsw-alias-label-primary) 5%, transparent); border-color: var(--dsw-alias-border-l4, var(--dsw-alias-border-l3)); } }
      .ita-modal-close { border-color: transparent; background: transparent; }
      .ita-err-block { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
      .ita-warn-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
      .ita-warn-row .ita-err { margin: 0; }
      .ita-warn-row .ita-err-ask { flex: none; }
      .ita-err-block .ita-err { margin: 0; }
      .ita-err-ask { height: 28px; padding: 0 10px; font-size: 12px; border-radius: 8px; }

      /* Badges, chips, tables */
      .ita-badge { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; line-height: 17px; padding: 0 8px; border-radius: 999px;
        border: 0.5px solid var(--dsw-alias-border-l3); color: var(--dsw-alias-label-secondary); white-space: nowrap; }
      .ita-badge--ok { color: var(--dsw-alias-state-success-primary); border-color: color-mix(in srgb, currentColor 36%, transparent);
        background: color-mix(in srgb, currentColor 9%, transparent); }
      .ita-badge--warn { color: var(--dsw-alias-state-warn-primary, #8a5a00); border-color: color-mix(in srgb, currentColor 36%, transparent);
        background: color-mix(in srgb, currentColor 9%, transparent); }
      .ita-badge--bad { color: var(--dsw-alias-state-error-primary); border-color: color-mix(in srgb, currentColor 36%, transparent);
        background: color-mix(in srgb, currentColor 9%, transparent); }
      .ita-chip { display: inline-flex; align-items: center; gap: 6px; padding: 3px 9px; border-radius: 999px;
        border: 0.5px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2, transparent);
        color: var(--dsw-alias-label-secondary); font-size: 11.5px; line-height: 17px; }
      .ita-tag { font-size: 11px; padding: 1px 7px; border-radius: 6px; color: var(--dsw-alias-label-secondary);
        background: color-mix(in srgb, var(--dsw-alias-label-primary) 6%, transparent); }
      .ita-table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
      .ita-table th, .ita-table td { text-align: left; padding: 9px 10px; border-bottom: 0.5px solid var(--dsw-alias-border-l1); vertical-align: middle; }
      .ita-table th { font-weight: 600; color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary));
        font-size: 11px; letter-spacing: 0.04em; text-transform: uppercase; background: color-mix(in srgb, var(--dsw-alias-label-primary) 3%, transparent); }
      .ita-table tbody tr:hover { background: color-mix(in srgb, var(--dsw-alias-label-primary) 4%, transparent); }
      .ita-table .ita-btn { height: 28px; padding: 0 10px; font-size: 12px; border-radius: 8px; }
      .ita-scroll { overflow: auto; border: 0.5px solid var(--dsw-alias-border-l1); border-radius: 12px; }
      .ita-scroll .ita-table { margin: 0; }
      .ita-scroll .ita-table th { position: sticky; top: 0; z-index: 1; background: var(--dsw-alias-bg-layer-1); }

      /* Text blocks */
      .ita-hint { margin: 0; color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); font-size: 11.5px; line-height: 18px; }
      .ita-warn { margin: 0; color: var(--dsw-alias-state-warn-primary, #8a5a00); font-size: 12px; line-height: 18px; }
      .ita-err { margin: 0; color: var(--dsw-alias-state-error-primary); font-size: 12px; line-height: 18px; }
      .ita-kv { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 6px 16px; font-size: 12.5px; margin: 0; }
      .ita-kv dt { color: var(--dsw-alias-label-secondary); }
      .ita-kv dd { margin: 0; word-break: break-word; }
      .ita-pre { margin: 0; white-space: pre-wrap; word-break: break-word; font-family: var(--ds-font-family-code, ui-monospace, Menlo, monospace);
        font-size: 11.5px; line-height: 18px; background: var(--dsw-alias-bg-layer-2, transparent);
        border: 0.5px solid var(--dsw-alias-border-l1); border-radius: 10px; padding: 10px 12px; max-height: 280px; overflow: auto; }
      .ita-empty { display: flex; align-items: center; justify-content: center; min-height: 96px; padding: 22px; text-align: center;
        color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); font-size: 12.5px;
        border: 0.5px dashed var(--dsw-alias-border-l2); border-radius: 12px; }
      .ita-list { display: flex; flex-direction: column; gap: 8px; }
      .ita-item { display: flex; flex-direction: column; gap: 6px; padding: 11px 13px; border-radius: 12px;
        border: 0.5px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1); }
      .ita-item-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; }

      /* Modal */
      .ita-modal-mask { position: fixed; inset: 0; background: color-mix(in srgb, #000 38%, transparent); display: flex; align-items: center;
        justify-content: center; z-index: 2147000000; padding: 24px; backdrop-filter: blur(2px); }
      .ita-modal { box-sizing: border-box; background: var(--dsw-alias-bg-layer-1); border: 0.5px solid var(--dsw-alias-border-l2);
        border-radius: 20px; width: 100%; max-width: 920px; max-height: 86vh; overflow: auto; padding: 20px 22px;
        box-shadow: 0 18px 50px rgba(0, 0, 0, 0.28); display: flex; flex-direction: column; gap: 16px; }
      .ita-modal--sm { max-width: 560px; }
      .ita-modal--md { max-width: 720px; }
      .ita-modal-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
      .ita-modal-title { margin: 0; font-size: 15px; font-weight: 650; line-height: 22px; text-align: left; align-self: flex-start; }
      .ita-modal-body { display: flex; flex-direction: column; gap: 14px; min-width: 0; }
      .ita-form { display: flex; flex-direction: column; gap: 14px; align-items: stretch; }
      .ita-form .ita-field { flex: 0 0 auto; min-width: 0; }
      .ita-form .ita-input { flex: 0 0 auto; width: 100%; height: 36px; }
      .ita-form .ita-label, .ita-form .ita-hint { text-align: left; }
      .ita-modal-foot { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap;
        padding-top: 14px; border-top: 0.5px solid var(--dsw-alias-border-l1); }
      .ita-modal-foot .ita-row { margin-left: auto; }
      .ita-modal-close { width: 30px; height: 30px; padding: 0; border-radius: 9px; font-size: 16px; line-height: 1; }
      .ita-spin { display: inline-block; width: 12px; height: 12px; border: 1.5px solid currentColor;
        border-right-color: transparent; border-radius: 50%; animation: ita-spin 0.7s linear infinite; }
      @keyframes ita-spin { to { transform: rotate(360deg); } }
      @media (prefers-reduced-motion: reduce) { .ita-spin { animation: none; } .ita-tab, .ita-btn, .ita-input { transition: none; } }
    `;

    /* ------------------------------------------------------------------ */
    /* API                                                                 */
    /* ------------------------------------------------------------------ */

    /**
     * POST one action to the local Host API.
     * @param {string} action action name.
     * @param {object} payload JSON body.
     * @returns {Promise<any>} unwrapped payload.
     */
    async function post(action, payload = {}) {
      let response;
      try {
        response = await fetch(`${ROUTE}/${action}`, {
          method: 'POST',
          credentials: 'same-origin',
          cache: 'no-store',
          headers: {'content-type': 'application/json'},
          body: JSON.stringify(payload),
        });
      } catch (error) {
        throw new Error(`本地服务不可用：${error instanceof Error ? error.message : String(error)}`);
      }
      const raw = await response.text();
      let parsed = null;
      try {
        parsed = raw === '' ? {} : JSON.parse(raw);
      } catch {
        throw new Error(`本地服务返回了无法解析的响应（HTTP ${response.status}）。`);
      }
      if (parsed?.ok === false) {
        const error = new Error(parsed.message || `请求失败（HTTP ${response.status}）`);
        error.code = parsed.code;
        error.details = parsed.details;
        throw error;
      }
      if (!response.ok) throw new Error(`请求失败（HTTP ${response.status}）`);
      return parsed?.result;
    }

    /* ------------------------------------------------------------------ */
    /* Primitives                                                          */
    /* ------------------------------------------------------------------ */

    function Btn({children, onClick, kind, disabled, title, className, 'aria-label': ariaLabel}) {
      const tone = kind === 'primary' ? ' ita-btn--primary' : kind === 'danger' ? ' ita-btn--danger' : kind === 'ghost' ? ' ita-btn--ghost' : '';
      return e('button', {
        className: `ita-btn${tone}${typeof className === 'string' && className !== '' ? ` ${className}` : ''}`,
        onClick,
        disabled: disabled === true,
        title,
        'aria-label': ariaLabel,
        type: 'button',
      }, children);
    }

    function Field({label, children, hint, wide, required}) {
      return e('label', {className: `ita-field${wide === true ? ' ita-field--wide' : ''}`},
        e('span', {className: 'ita-label'}, label, required === true ? e('span', {className: 'ita-req'}, '必填') : null),
        children,
        hint === undefined ? null : e('span', {className: 'ita-hint'}, hint),
      );
    }

    function Input({value, onChange, placeholder, type, disabled, ...rest}) {
      return e('input', {
        className: 'ita-input',
        value: value ?? '',
        placeholder,
        type: type ?? 'text',
        disabled: disabled === true,
        onChange: (event) => onChange(event.target.value),
        ...rest,
      });
    }

    function Select({value, onChange, options, placeholder}) {
      return e('select', {className: 'ita-select', value: value ?? '', onChange: (event) => onChange(event.target.value)},
        placeholder === undefined ? null : e('option', {value: ''}, placeholder),
        options.map((option) => e('option', {key: option.value, value: option.value}, option.label)),
      );
    }

    function Badge({children, tone}) {
      return e('span', {className: `ita-badge${tone === 'ok' ? ' ita-badge--ok' : tone === 'warn' ? ' ita-badge--warn' : tone === 'bad' ? ' ita-badge--bad' : ''}`}, children);
    }

    function Card({title, actions, children}) {
      return e('section', {className: 'ita-card'},
        e('div', {className: 'ita-card-head'},
          e('h3', {className: 'ita-card-title'}, title),
          actions === undefined ? null : e('div', {className: 'ita-row'}, actions),
        ),
        children,
      );
    }

    function Empty({children}) {
      return e('div', {className: 'ita-empty'}, children ?? t('common.none'));
    }

    function ErrorLine({error}) {
      return error === null || error === undefined ? null : e('p', {className: 'ita-err'}, String(error.message ?? error));
    }

    /**
     * Error line with a one-click "ask the AI" action.
     *
     * The button sends the project, the error text and a diagnosis instruction
     * to a session bound to the project, so the user does not have to copy the
     * message by hand. It is only shown when a project session can be addressed.
     *
     * @param {{error: Error|null, project?: object|null, bridge?: object}} props props.
     * @returns {object|null} rendered error block.
     */
    function AskAiButton({error, project, bridge, className}) {
      const [busy, setBusy] = useState(false);
      const [askError, setAskError] = useState(null);
      const message = String(error?.message ?? error ?? '');
      const canAsk = project !== null && project !== undefined && bridge !== undefined && bridge !== null;
      const ask = async () => {
        if (!canAsk || busy) return;
        setBusy(true);
        setAskError(null);
        try {
          await sendToAssistantSession({bridge, project, text: tf('askAiPrompt', {project: project.name, id: project.id, message})});
        } catch (failure) {
          setAskError(failure);
        } finally {
          setBusy(false);
        }
      };
      if (!canAsk) return null;
      return e(React.Fragment, null,
        e(Btn, {kind: 'ghost', className: `ita-err-ask${className ? ` ${className}` : ''}`, disabled: busy, onClick: ask}, busy ? e(Spinner) : tr('询问 AI')),
        askError === null ? null : e('p', {className: 'ita-err'}, String(askError.message ?? askError)),
      );
    }

    function ErrorWithAsk({error, project, bridge}) {
      if (error === null || error === undefined) return null;
      return e('div', {className: 'ita-err-block'},
        e('p', {className: 'ita-err'}, String(error.message ?? error)),
        e(AskAiButton, {error, project, bridge}),
      );
    }

    function Spinner() {
      return e('span', {className: 'ita-spin', 'aria-hidden': true});
    }

    function Modal({title, onClose, children, actions, size}) {
      useEffect(() => {
        if (typeof document === 'undefined') return undefined;
        const onKey = (event) => { if (event.key === 'Escape') onClose(); };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
      }, [onClose]);
      return e('div', {className: 'ita-modal-mask', onClick: (event) => { if (event.target === event.currentTarget) onClose(); }},
        e('div', {className: `ita-modal${size === 'sm' ? ' ita-modal--sm' : size === 'md' ? ' ita-modal--md' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title, tabIndex: -1},
          e('div', {className: 'ita-modal-head'},
            e('h3', {className: 'ita-modal-title'}, title),
            e('div', {className: 'ita-row'},
              actions,
              Btn({children: '×', kind: 'ghost', className: 'ita-modal-close', 'aria-label': t('common.close'), title: t('common.close'), onClick: onClose}),
            ),
          ),
          e('div', {className: 'ita-modal-body'}, children),
        ),
      );
    }

    function statusTone(status) {
      if (status === 'passed' || status === 'confirmed') return 'ok';
      if (status === 'exceptions') return 'warn';
      if (status === 'incomplete' || status === 'undetermined') return 'warn';
      if (status === 'failed' || status === 'cancelled') return 'bad';
      return undefined;
    }

    function statusLabel(labels, status) {
      return labels?.[status] ?? status ?? '';
    }

    function useApiState(loader, deps) {
      const [state, setState] = useState({loading: true, payload: null, error: null});
      const reload = useCallback(() => {
        let cancelled = false;
        setState((previous) => ({...previous, loading: true, error: null}));
        Promise.resolve()
          .then(loader)
          .then((payload) => { if (!cancelled) setState({loading: false, payload, error: null}); })
          .catch((error) => { if (!cancelled) setState({loading: false, payload: null, error}); });
        return () => { cancelled = true; };
      }, deps ?? []);
      useEffect(() => reload(), [reload]);
      return [state, reload, setState];
    }

    function readStore(key, fallback) {
      try {
        const raw = window.localStorage.getItem(key);
        return raw === null ? fallback : JSON.parse(raw);
      } catch {
        return fallback;
      }
    }

    function writeStore(key, value) {
      try {
        window.localStorage.setItem(key, JSON.stringify(value));
      } catch {
        /* storage may be unavailable; the page still works per session */
      }
    }

    /**
     * Read one Client service by its dotted name.
     * @param {object} ctx client context.
     * @param {string} key service key.
     * @returns {any} the service or undefined.
     */
    function getService(ctx, key) {
      try {
        const direct = ctx.get(key);
        if (direct !== undefined && direct !== null) return direct;
      } catch {
        /* fall through to the dotted walk */
      }
      if (key.includes('.')) {
        try {
          const [head, ...rest] = key.split('.');
          let value = ctx.get(head);
          for (const part of rest) value = value?.[part];
          return value ?? undefined;
        } catch {
          return undefined;
        }
      }
      return undefined;
    }

    /** @returns {string|undefined} the browser time zone. */
    function timeZone() {
      try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone;
      } catch {
        return undefined;
      }
    }

    /**
     * Persist the active project and tell session-scoped binders about the project.
     * @param {string|null} projectId project id, or null to clear.
     */
    function setStoredProject(projectId) {
      writeStore(STORE_KEY, projectId);
      try {
        if (typeof window.dispatchEvent === 'function' && typeof window.CustomEvent === 'function') {
          window.dispatchEvent(new window.CustomEvent(PROJECT_EVENT, {detail: projectId}));
        }
      } catch {
        /* the event is an optimization; stored state remains the source of truth */
      }
    }

    /**
     * Draft prompt shown before the user writes their own request.
     * @param {object} overview workbench overview.
     * @returns {string} template text.
     */
    function buildAskTemplate(overview) {
      const project = overview.project;
      const sources = overview.sources ?? [];
      const lines = [
        `【分析项目】${project === null ? '' : project.name}`,
        '',
        '【本次核对需求】',
        '（在这里写清楚：核对哪两批数据、按什么主键关联、关注哪些异常。例如：核对人事系统的离职名单与 AD 账号，找出离职后仍然启用的账号。）',
        '',
        '【可用数据源】',
      ];
      if (sources.length === 0) lines.push('- （还没有数据源，请先添加数据库连接或导入文件）');
      for (const source of sources) {
        const status = source.status?.available === true ? '可用' : source.status?.available === false ? `不可用：${source.status.reason ?? ''}` : '未测试';
        const rows = typeof source.rowCount === 'number' ? `${source.rowCount} 行` : '';
        lines.push(`- ${source.name}（${source.kind === 'file' ? '文件' : source.dialect ?? '数据库'}${rows === '' ? '' : ` · ${rows}`} · ${status}）`);
      }
      lines.push('', '我会先用 db-info / db-schema-inspect 确认数据源与字段，再给你规则和 SQL 预览；执行核对前需要你确认规则。');
      return lines.join('\n');
    }

    /* ------------------------------------------------------------------ */
    /* Column helpers                                                      */
    /* ------------------------------------------------------------------ */

    function columnsOf(source) {
      if (source === null || source === undefined) return [];
      if (Array.isArray(source.columns)) return source.columns.map((column) => (typeof column === 'string' ? {name: column, kind: 'text'} : column));
      return [];
    }

    function suggestPairs(leftColumns, rightColumns) {
      const normalize = (name) => String(name).toLowerCase().replace(/[\s_-]/g, '');
      const pairs = [];
      const used = new Set();
      for (const left of leftColumns) {
        const match = rightColumns.find((right) => !used.has(right.name) && normalize(right.name) === normalize(left.name))
          ?? rightColumns.find((right) => !used.has(right.name) && (normalize(right.name).includes(normalize(left.name)) || normalize(left.name).includes(normalize(right.name))));
        if (match === undefined) continue;
        used.add(match.name);
        pairs.push({left: left.name, right: match.name, confidence: normalize(match.name) === normalize(left.name) ? 'strong' : 'weak'});
      }
      return pairs;
    }

    function extractSessions(snapshot) {
      if (snapshot === null || snapshot === undefined) return [];
      const list = Array.isArray(snapshot)
        ? snapshot
        : Array.isArray(snapshot.list) ? snapshot.list
          : Array.isArray(snapshot.sessions) ? snapshot.sessions
            : Array.isArray(snapshot.items) ? snapshot.items : [];
      return list.map((item) => {
        const id = item?.id ?? item?.sessionId ?? item?.session?.id;
        const title = item?.title ?? item?.name ?? item?.session?.title ?? '';
        return typeof id === 'string' ? {id, title} : null;
      }).filter(Boolean);
    }

    /* ------------------------------------------------------------------ */
    /* Tab: sources                                                        */
    /* ------------------------------------------------------------------ */

    function SourcesTab({overview, reload, refresh}) {
      const [busy, setBusy] = useState('');
      const [error, setError] = useState(null);
      const [dbForm, setDbForm] = useState({name: '', dialect: 'sqlite', host: '', port: '', user: '', database: '', serviceName: '', schema: '', file: '', passwordRef: '', command: ''});
      const [showDb, setShowDb] = useState(false);
      const [importForm, setImportForm] = useState({path: '', name: '', sheet: ''});
      const [showImport, setShowImport] = useState(false);
      const project = overview.project;
      const dialects = overview.dialects ?? [];

      const run = async (label, action) => {
        setBusy(label);
        setError(null);
        try {
          await action();
          await reload();
        } catch (failure) {
          setError(failure);
        } finally {
          setBusy('');
        }
      };

      if (project === null) {
        return e(Card, {title: t('project.title')},
          e(Empty, null, '请先新建一个分析项目，再添加数据源。'),
          e('div', {className: 'ita-row'},
            e('div', {style: {flex: '1 1 100%'}},
              e(ProjectCreator, {onCreated: async (created) => { refresh(created.id); await reload(); }}),
            ),
          ),
        );
      }

      return e('div', null,
        e(ErrorLine, {error}),
        e(Card, {
          title: t('source.addDb') + ' / ' + t('source.import'),
          actions: [
            Btn({children: t('source.addDb'), onClick: () => setShowDb(!showDb), kind: showDb ? 'ghost' : 'primary'}),
            Btn({children: t('source.import'), onClick: () => setShowImport(!showImport)}),
            Btn({children: t('common.refresh'), onClick: () => reload(), kind: 'ghost'}),
          ],
        },
          (overview.sources ?? []).length === 0
            ? e(Empty, null, '还没有数据源。可以添加数据库连接，或导入 Excel / CSV / JSON / 日志文件（导入为只读副本）。')
            : e('div', {className: 'ita-list'},
                overview.sources.map((source) => e('div', {className: 'ita-item', key: source.id},
                  e('div', {className: 'ita-item-head'},
                    e('div', {className: 'ita-row', style: {alignItems: 'center', gap: '8px'}},
                      e('strong', {raw: true}, source.name),
                      e('span', {className: 'ita-tag'}, source.kind === 'file' ? `文件 · ${source.originalName ?? ''}` : (source.dialect ?? 'db')),
                      source.status?.available === true ? e(Badge, {tone: 'ok'}, t('source.available'))
                        : source.status?.available === false ? e(Badge, {tone: 'bad'}, t('source.unavailable'))
                          : e(Badge, null, t('source.untested')),
                    ),
                    e('div', {className: 'ita-row'},
                      source.kind === 'database' ? Btn({children: busy === `test:${source.id}` ? e(Spinner) : t('source.test'), onClick: () => run(`test:${source.id}`, () => post('source.test', {projectId: project.id, sourceId: source.id})), disabled: busy !== ''}) : null,
                      source.kind === 'database' ? Btn({children: t('source.inspect'), onClick: () => run(`inspect:${source.id}`, () => post('source.inspect', {projectId: project.id, sourceId: source.id, refresh: true}))}) : null,
                      Btn({children: t('source.delete'), kind: 'danger', onClick: () => {
                        if (!window.confirm(`确认移除数据源「${source.name}」？`)) return;
                        return run(`delete:${source.id}`, () => post('source.delete', {projectId: project.id, sourceId: source.id}));
                      }}),
                    ),
                  ),
                  source.status?.available === false ? e('p', {className: 'ita-warn'}, source.status.reason) : null,
                  e('div', {className: 'ita-hint'},
                    [
                      source.kind === 'file' ? `行数 ${source.rowCount ?? '?'} · 字段 ${(source.columns ?? []).length} · 编码 ${source.encoding ?? '?'} · ${source.status?.enforcement ?? ''}` : null,
                      source.kind === 'database' ? `${source.host ?? ''}${source.port ? ':' + source.port : ''} · ${source.user ?? ''} · ${source.status?.enforcement ?? ''}` : null,
                      source.kind === 'file' ? `SHA-256 ${String(source.hash ?? '').slice(0, 16)}…` : null,
                    ].filter(Boolean).join('　'),
                  ),
                  source.catalog !== null && source.catalog !== undefined
                    ? e('div', {style: {marginTop: '6px'}},
                        e('div', {className: 'ita-hint'}, `库表扫描：${(source.catalog.tables ?? []).length} 张表 · ${source.catalog.scannedAt ?? ''}`),
                        (source.catalog.tables ?? []).length === 0
                          ? e('p', {className: 'ita-warn'}, '没有扫描到表。请检查数据库权限或库名是否正确。')
                          : e('div', {className: 'ita-row', style: {marginTop: '4px', flexWrap: 'wrap'}},
                              (source.catalog.tables ?? []).slice(0, 24).map((entry) => e('span', {className: 'ita-chip', key: `${entry.schema}.${entry.table}`},
                                entry.schema !== undefined && entry.schema !== source.database ? `${entry.schema}.${entry.table}` : entry.table)),
                              (source.catalog.tables ?? []).length > 24 ? e('span', {className: 'ita-hint'}, `… 共 ${source.catalog.tables.length} 张表`) : null,
                            ))
                    : null,
                  (source.columns ?? []).length > 0 ? e('div', {className: 'ita-row', style: {marginTop: '6px'}},
                    source.columns.slice(0, 14).map((column) => e('span', {className: 'ita-chip', key: column.name}, `${column.name}`, e('span', {className: 'ita-hint'}, column.kind ?? ''))),
                    source.columns.length > 14 ? e('span', {className: 'ita-hint'}, `… 共 ${source.columns.length} 个字段`) : null,
                  ) : null,
                )),
              ),
          showDb ? e('div', {style: {marginTop: '16px', borderTop: '0.5px solid var(--dsw-alias-border-l2)', paddingTop: '14px'}},
            e('div', {className: 'ita-row'},
              e(Field, {label: t('source.name')}, e(Input, {value: dbForm.name, onChange: (value) => setDbForm({...dbForm, name: value})})),
              e(Field, {label: t('source.dialect')}, e(Select, {
                value: dbForm.dialect,
                onChange: (value) => setDbForm({...dbForm, dialect: value}),
                options: dialects.map((dialect) => ({value: dialect.type, label: dialect.supported ? dialect.label : `${dialect.label}（不可用）`})),
              })),
              dbForm.dialect === 'sqlite'
                ? e(Field, {label: t('source.filePath')}, e(Input, {value: dbForm.file, onChange: (value) => setDbForm({...dbForm, file: value})}))
                : e(Field, {label: t('source.host')}, e(Input, {value: dbForm.host, onChange: (value) => setDbForm({...dbForm, host: value})})),
              dbForm.dialect === 'sqlite' ? null : e(Field, {label: t('source.port')}, e(Input, {value: dbForm.port, onChange: (value) => setDbForm({...dbForm, port: value})})),
              dbForm.dialect === 'sqlite' ? null : e(Field, {label: t('source.user')}, e(Input, {value: dbForm.user, onChange: (value) => setDbForm({...dbForm, user: value})})),
              dbForm.dialect === 'sqlite' ? null : e(Field, {label: t('source.database')}, e(Input, {value: dbForm.database, onChange: (value) => setDbForm({...dbForm, database: value})})),
              dbForm.dialect === 'sqlite' ? null : e(Field, {label: t('source.passwordRef'), hint: t('source.passwordRefHint')}, e(Input, {value: dbForm.passwordRef, onChange: (value) => setDbForm({...dbForm, passwordRef: value})})),
            ),
            e('div', {className: 'ita-row', style: {marginTop: '10px'}},
              Btn({children: busy === 'create-db' ? e(Spinner) : t('common.save'), kind: 'primary', disabled: busy !== '', onClick: () => run('create-db', async () => {
                const source = {...dbForm};
                if (source.port !== '') source.port = Number(source.port); else delete source.port;
                await post('source.create', {projectId: project.id, source});
                setDbForm({name: '', dialect: 'sqlite', host: '', port: '', user: '', database: '', serviceName: '', schema: '', file: '', passwordRef: '', command: ''});
                setShowDb(false);
              })}),
              Btn({children: t('common.cancel'), onClick: () => setShowDb(false)}),
            ),
            e('p', {className: 'ita-hint'}, '添加后请点「测试连接」：只有测试通过才会显示为可用。仅保存配置不等于已连接。'),
          ) : null,
          showImport ? e('div', {style: {marginTop: '16px', borderTop: '0.5px solid var(--dsw-alias-border-l2)', paddingTop: '14px'}},
            e('div', {className: 'ita-row'},
              e(Field, {label: t('source.importPath')}, e(Input, {value: importForm.path, onChange: (value) => setImportForm({...importForm, path: value})})),
              e(Field, {label: t('source.name')}, e(Input, {value: importForm.name, onChange: (value) => setImportForm({...importForm, name: value})})),
              e(Field, {label: t('source.sheet')}, e(Input, {value: importForm.sheet, onChange: (value) => setImportForm({...importForm, sheet: value})})),
            ),
            e('div', {className: 'ita-row', style: {marginTop: '10px'}},
              Btn({children: busy === 'import' ? e(Spinner) : t('common.save'), kind: 'primary', disabled: busy !== '', onClick: () => run('import', async () => {
                await post('source.import', {projectId: project.id, path: importForm.path, name: importForm.name || undefined, sheet: importForm.sheet || undefined});
                setImportForm({path: '', name: '', sheet: ''});
                setShowImport(false);
              })}),
              Btn({children: t('common.cancel'), onClick: () => setShowImport(false)}),
            ),
            e('p', {className: 'ita-hint'}, '导入会保存一份字节完全一致的只读副本，并记录文件名、工作表、行号与 SHA-256。公式单元格若无缓存值会标记为不可计算。'),
          ) : null,
        ),
      );
    }

    function ProjectCreator({onCreated}) {
      const [name, setName] = useState('');
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState(null);
      return e('div', null,
        e(ErrorLine, {error}),
        e('div', {className: 'ita-row'},
          e(Field, {label: t('project.name')}, e(Input, {value: name, onChange: setName})),
          Btn({children: busy ? e(Spinner) : t('project.new'), kind: 'primary', disabled: busy || name.trim() === '', onClick: async () => {
            setBusy(true);
            setError(null);
            try {
              const created = await post('project.create', {name});
              setName('');
              await onCreated(created);
            } catch (failure) {
              setError(failure);
            } finally {
              setBusy(false);
            }
          }}),
        ),
      );
    }

    /* ------------------------------------------------------------------ */
    /* Tab: mapping                                                        */
    /* ------------------------------------------------------------------ */

    function MappingTab({overview, onUseMapping}) {
      const sources = overview.sources ?? [];
      const projectId = overview.project?.id;
      const [leftId, setLeftId] = useState('');
      const [rightId, setRightId] = useState('');
      const [leftTable, setLeftTable] = useState('');
      const [rightTable, setRightTable] = useState('');
      const [leftCols, setLeftCols] = useState([]);
      const [rightCols, setRightCols] = useState([]);
      const [loading, setLoading] = useState('');
      const [error, setError] = useState(null);
      const left = sources.find((source) => source.id === leftId) ?? null;
      const right = sources.find((source) => source.id === rightId) ?? null;
      const tablesOf = (source) => (source?.kind === 'file' ? [] : (source?.catalog?.tables ?? []).map((entry) => ({
        value: entry.table,
        label: entry.schema !== undefined && entry.schema !== source.database ? `${entry.schema}.${entry.table}` : entry.table,
      })));

      const loadColumns = useCallback(async (side, sourceId, table) => {
        if (projectId === undefined || table === '') return;
        setLoading(side);
        setError(null);
        try {
          const described = await post('source.describe', {projectId, sourceId, table});
          const list = Array.isArray(described) ? described : (described.columns ?? []);
          if (side === 'left') setLeftCols(list); else setRightCols(list);
        } catch (failure) {
          setError(failure);
          if (side === 'left') setLeftCols([]); else setRightCols([]);
        } finally {
          setLoading('');
        }
      }, [projectId]);

      useEffect(() => {
        if (left?.kind !== 'database' || leftId === '' || leftTable === '') { setLeftCols([]); return; }
        loadColumns('left', leftId, leftTable);
      }, [leftId, leftTable, left?.kind, loadColumns]);
      useEffect(() => {
        if (right?.kind !== 'database' || rightId === '' || rightTable === '') { setRightCols([]); return; }
        loadColumns('right', rightId, rightTable);
      }, [rightId, rightTable, right?.kind, loadColumns]);

      const leftColumns = left?.kind === 'file' ? columnsOf(left) : leftCols;
      const rightColumns = right?.kind === 'file' ? columnsOf(right) : rightCols;
      const suggestions = useMemo(() => suggestPairs(leftColumns, rightColumns), [leftColumns, rightColumns]);
      const [keyLeft, setKeyLeft] = useState('');
      const [keyRight, setKeyRight] = useState('');
      const [fieldLeft, setFieldLeft] = useState('');
      const [fieldRight, setFieldRight] = useState('');
      const keyOptions = suggestions.filter((pair) => pair.confidence === 'strong');
      const ready = left !== null && right !== null
        && (left.kind === 'file' || leftTable !== '')
        && (right.kind === 'file' || rightTable !== '');

      return e('div', null,
        e(Card, {title: t('mapping.title')},
          e('p', {className: 'ita-hint'}, t('mapping.hint')),
          e('div', {className: 'ita-grid'},
            e(Field, {label: t('mapping.left')}, e(Select, {
              value: leftId, onChange: (value) => { setLeftId(value); setLeftTable(''); setKeyLeft(''); setFieldLeft(''); }, placeholder: '选择左侧数据源',
              options: sources.map((source) => ({value: source.id, label: source.name})),
            })),
            e(Field, {label: t('mapping.right')}, e(Select, {
              value: rightId, onChange: (value) => { setRightId(value); setRightTable(''); setKeyRight(''); setFieldRight(''); }, placeholder: '选择右侧数据源',
              options: sources.map((source) => ({value: source.id, label: source.name})),
            })),
          ),
          left === null || right === null
            ? e('div', {className: 'ita-empty'}, '选择左右两个数据源后，这里会显示字段对照、主键建议与规则入口。')
            : e('div', null,
            e('div', {className: 'ita-grid', style: {marginTop: '4px'}},
              left.kind === 'database'
                ? e(Field, {label: '左侧表'}, e(Select, {value: leftTable, onChange: setLeftTable, placeholder: '选择表', options: tablesOf(left)}))
                : null,
              right.kind === 'database'
                ? e(Field, {label: '右侧表'}, e(Select, {value: rightTable, onChange: setRightTable, placeholder: '选择表', options: tablesOf(right)}))
                : null,
            ),
            e(ErrorLine, {error}),
            loading === '' ? null : e('p', {className: 'ita-hint'}, `正在读取${loading === 'left' ? '左侧' : '右侧'}字段…`),
            !ready
              ? e('div', {className: 'ita-empty'}, '先为数据库数据源选择要核对的表，字段和主键建议随后出现。')
              : e('div', null,
                e('div', {className: 'ita-grid', style: {marginTop: '4px'}},
                  e(Field, {label: t('mapping.keyLeft')}, e(Select, {value: keyLeft, onChange: setKeyLeft, placeholder: '选择列', options: leftColumns.map((column) => ({value: column.name, label: column.name}))})),
                  e(Field, {label: t('mapping.keyRight')}, e(Select, {value: keyRight, onChange: setKeyRight, placeholder: '选择列', options: rightColumns.map((column) => ({value: column.name, label: column.name}))})),
                  e(Field, {label: t('mapping.fieldLeft')}, e(Select, {value: fieldLeft, onChange: setFieldLeft, placeholder: t('common.optional'), options: leftColumns.map((column) => ({value: column.name, label: column.name}))})),
                  e(Field, {label: t('mapping.fieldRight')}, e(Select, {value: fieldRight, onChange: setFieldRight, placeholder: t('common.optional'), options: rightColumns.map((column) => ({value: column.name, label: column.name}))})),
                ),
                e('div', {className: 'ita-actionbar'},
                  e('div', {className: 'ita-actionbar-group'},
                    Btn({children: t('mapping.createRule'), kind: 'primary', disabled: keyLeft === '' || keyRight === '', onClick: () => onUseMapping({
                      leftSourceId: leftId, rightSourceId: rightId, leftTable, rightTable, keyLeft, keyRight, fieldLeft, fieldRight,
                    })}),
                  ),
                  e('span', {className: 'ita-status'}, keyLeft === '' || keyRight === '' ? '先选择左右主键列' : '生成的是待确认规则草稿'),
                ),
              ),
          ),
        ),
        left === null || right === null ? null : e(Card, {title: t('mapping.preview')},
          e('div', {className: 'ita-grid2'},
            e('div', null,
              e('div', {className: 'ita-label'}, `${left.name}${leftTable === '' ? '' : ` · ${leftTable}`}`),
              e('div', {className: 'ita-row', style: {gap: '6px', maxHeight: '260px', overflow: 'auto'}},
                leftColumns.map((column) => e('span', {className: 'ita-chip', key: column.name}, column.name, e('span', {className: 'ita-hint'}, column.kind ?? ''))),
              ),
            ),
            e('div', null,
              e('div', {className: 'ita-label'}, `${right.name}${rightTable === '' ? '' : ` · ${rightTable}`}`),
              e('div', {className: 'ita-row', style: {gap: '6px', maxHeight: '260px', overflow: 'auto'}},
                rightColumns.map((column) => e('span', {className: 'ita-chip', key: column.name}, column.name, e('span', {className: 'ita-hint'}, column.kind ?? ''))),
              ),
            ),
          ),
          e('p', {className: 'ita-hint', style: {marginTop: '10px'}},
            suggestions.length === 0 ? '没有找到名称相近的字段，请手工选择主键列。'
              : `程序按名称相近给出了 ${suggestions.length} 组候选（${keyOptions.length} 组同名候选）。这些只是待确认建议，不会自动用于核对。`,
          ),
          suggestions.length === 0 ? null : e('table', {className: 'ita-table'},
            e('thead', null, e('tr', null, e('th', null, '左侧字段'), e('th', null, '右侧候选'), e('th', null, '置信度'))),
            e('tbody', null, suggestions.slice(0, 30).map((pair) => e('tr', {key: pair.left + pair.right},
              e('td', null, pair.left),
              e('td', null, pair.right),
              e('td', null, pair.confidence === 'strong' ? '同名（仍待确认）' : '名称相近（需确认）'),
            ))),
          ),
        ),
      );
    }

    /* ------------------------------------------------------------------ */
    /* Rule editor                                                         */
    /* ------------------------------------------------------------------ */

    const RULE_KINDS = [
      ['total', '总量核对'],
      ['match', '明细匹配'],
      ['missing', '缺失检查'],
      ['duplicate', '重复检查'],
      ['field', '字段一致性'],
      ['required', '完整性检查'],
      ['referential', '关联完整性'],
      ['time', '时间范围检查'],
      ['threshold', '阈值检查'],
      ['history', '历史变化检查'],
    ];
    const SINGLE_SIDED = ['required', 'time', 'threshold'];

    function blankRule() {
      return {
        name: '', kind: 'match', description: '',
        left: {sourceId: '', dataset: {kind: 'table'}},
        right: {sourceId: '', dataset: {kind: 'table'}},
        key: {pairs: [{left: '', right: ''}]},
        fields: [{left: '', right: '', type: 'text', label: ''}],
        options: {caseInsensitive: true, trim: true, nullEquals: 'equal'},
      };
    }

    function SideEditor({label, side, sources, value, onChange}) {
      const [columns, setColumns] = useState(side === 'left' ? [] : []);
      const [error, setError] = useState(null);
      const [busy, setBusy] = useState(false);
      const source = sources.find((entry) => entry.id === value.sourceId) ?? null;
      useEffect(() => {
        if (source === null) { setColumns([]); return; }
        if (source.kind === 'file') setColumns(columnsOf(source));
      }, [value.sourceId]);
      const loadColumns = async () => {
        if (source === null || source.kind !== 'database' || value.dataset.table === undefined) return;
        setBusy(true); setError(null);
        try {
          const described = await post('source.describe', {projectId: source.projectId, sourceId: source.id, table: value.dataset.table, schema: value.dataset.schema});
          setColumns(described.map((column) => ({name: column.name, kind: column.type ?? 'text'})));
        } catch (failure) { setError(failure); } finally { setBusy(false); }
      };
      return e('div', {className: 'ita-item'},
        e('div', {className: 'ita-label'}, label),
        e('div', {className: 'ita-row', style: {marginTop: '6px'}},
          e(Field, {label: '数据源'}, e(Select, {
            value: value.sourceId, placeholder: '选择数据源',
            options: sources.map((entry) => ({value: entry.id, label: entry.name})),
            onChange: (sourceId) => {
              const next = sources.find((entry) => entry.id === sourceId);
              onChange({sourceId, dataset: next?.kind === 'file' ? {kind: 'file', fileId: next.fileId} : {kind: 'table'}});
            },
          })),
          source?.kind === 'database' ? e(Field, {label: '表名'}, e(Input, {value: value.dataset.table ?? '', onChange: (table) => onChange({...value, dataset: {...value.dataset, table}}) })) : null,
          source?.kind === 'database' ? Btn({children: busy ? e(Spinner) : '加载字段', onClick: loadColumns}) : null,
        ),
        e(ErrorLine, {error}),
        columns.length === 0 ? null : e('div', {className: 'ita-row', style: {gap: '6px', marginTop: '6px'}},
          columns.slice(0, 60).map((column) => e('span', {className: 'ita-chip', key: column.name}, column.name)),
        ),
      );
    }

    function RuleEditor({overview, initial, onClose, onSaved}) {
      const sources = overview.sources ?? [];
      const [rule, setRule] = useState(() => initial ?? blankRule());
      const [preview, setPreview] = useState(null);
      const [error, setError] = useState(null);
      const [busy, setBusy] = useState('');
      const singleSided = SINGLE_SIDED.includes(rule.kind);
      const keyed = !singleSided;
      const needsFields = ['match', 'field', 'history', 'total'].includes(rule.kind);

      const buildRule = () => {
        const next = {...rule, projectId: overview.project.id};
        if (singleSided) delete next.right;
        if (rule.kind === 'required') next.fields = (rule.fields ?? []).filter((field) => field.left !== '');
        if (rule.kind === 'time' && next.time === undefined) next.time = {column: next.fields?.[0]?.left ?? '', op: 'after', referenceValue: '', label: '时间条件'};
        return next;
      };

      const save = async (confirmAfter) => {
        setBusy(confirmAfter ? 'confirm' : 'save');
        setError(null);
        try {
          const payload = buildRule();
          let saved;
          if (rule.ruleId !== undefined && rule.version !== undefined) {
            saved = await post('rule.update', {projectId: overview.project.id, ruleId: rule.ruleId, patch: payload, expectedVersion: rule.version, author: 'workbench'});
          } else {
            saved = await post('rule.create', {projectId: overview.project.id, rule: payload, author: 'workbench'});
          }
          if (confirmAfter) {
            saved = await post('rule.status', {projectId: overview.project.id, ruleId: saved.id, status: 'confirmed', expectedVersion: saved.version, author: 'workbench'});
          }
          await onSaved(saved);
          onClose();
        } catch (failure) {
          setError(failure);
        } finally {
          setBusy('');
        }
      };

      const runPreview = async () => {
        setBusy('preview');
        setError(null);
        try {
          setPreview(await post('rule.preview', {projectId: overview.project.id, rule: buildRule()}));
        } catch (failure) {
          setError(failure);
          setPreview(null);
        } finally {
          setBusy('');
        }
      };

      return e(Modal, {title: rule.ruleId === undefined ? '新建核对规则' : `编辑规则 ${rule.name}`, onClose},
        e(ErrorLine, {error}),
        e('div', {className: 'ita-row'},
          e(Field, {label: t('rule.name')}, e(Input, {value: rule.name, onChange: (name) => setRule({...rule, name})})),
          e(Field, {label: t('rule.kind')}, e(Select, {
            value: rule.kind, options: RULE_KINDS.map(([value, label]) => ({value, label})),
            onChange: (kind) => setRule({...rule, kind}),
          })),
        ),
        e('div', {className: 'ita-row', style: {marginTop: '10px'}},
          e(Field, {label: '规则说明'}, e(Input, {value: rule.description ?? '', onChange: (description) => setRule({...rule, description})})),
        ),
        e('div', {className: 'ita-grid2', style: {marginTop: '12px'}},
          e(SideEditor, {label: '左侧数据集', side: 'left', sources, value: rule.left, onChange: (left) => setRule({...rule, left})}),
          singleSided ? e('div', {className: 'ita-item'}, e('p', {className: 'ita-hint'}, '本规则类型只读取左侧数据源。')) : e(SideEditor, {label: '右侧数据集', side: 'right', sources, value: rule.right, onChange: (right) => setRule({...rule, right})}),
        ),
        keyed ? e('div', {style: {marginTop: '12px'}},
          e('div', {className: 'ita-label'}, '主键映射（复合主键可增加多行）'),
          (rule.key?.pairs ?? []).map((pair, index) => e('div', {className: 'ita-row', key: index, style: {marginTop: '6px'}},
            e(Field, {label: `左侧主键 ${index + 1}`}, e(Input, {value: pair.left, onChange: (value) => {
              const pairs = [...rule.key.pairs];
              pairs[index] = {...pair, left: value};
              setRule({...rule, key: {pairs}});
            }})),
            e(Field, {label: `右侧主键 ${index + 1}`}, e(Input, {value: pair.right, onChange: (value) => {
              const pairs = [...rule.key.pairs];
              pairs[index] = {...pair, right: value};
              setRule({...rule, key: {pairs}});
            }})),
            (rule.key.pairs.length > 1 ? Btn({children: t('common.delete'), kind: 'ghost', onClick: () => setRule({...rule, key: {pairs: rule.key.pairs.filter((_, position) => position !== index)}})}) : null),
          )),
          Btn({children: '+ 增加主键列', kind: 'ghost', onClick: () => setRule({...rule, key: {pairs: [...(rule.key?.pairs ?? []), {left: '', right: ''}]}})}),
        ) : null,
        needsFields ? e('div', {style: {marginTop: '12px'}},
          e('div', {className: 'ita-label'}, rule.kind === 'required' ? '需要检查非空的字段（左侧）' : '需要比较的字段'),
          (rule.fields ?? []).map((field, index) => e('div', {className: 'ita-row', key: index, style: {marginTop: '6px'}},
            e(Field, {label: `字段 ${index + 1}（左）`}, e(Input, {value: field.left, onChange: (value) => {
              const fields = [...rule.fields];
              fields[index] = {...field, left: value};
              setRule({...rule, fields});
            }})),
            rule.kind === 'required' ? null : e(Field, {label: `字段 ${index + 1}（右）`}, e(Input, {value: field.right ?? '', onChange: (value) => {
              const fields = [...rule.fields];
              fields[index] = {...field, right: value};
              setRule({...rule, fields});
            }})),
            rule.kind === 'required' ? null : e(Field, {label: '类型'}, e(Select, {
              value: field.type ?? 'text',
              options: [['text', '文本'], ['integer', '整数'], ['decimal', '金额/小数'], ['date', '日期'], ['datetime', '日期时间']].map(([value, label]) => ({value, label})),
              onChange: (value) => {
                const fields = [...rule.fields];
                fields[index] = {...field, type: value};
                setRule({...rule, fields});
              },
            })),
            (rule.fields.length > 1 ? Btn({children: t('common.delete'), kind: 'ghost', onClick: () => setRule({...rule, fields: rule.fields.filter((_, position) => position !== index)})}) : null),
          )),
          Btn({children: '+ 增加字段', kind: 'ghost', onClick: () => setRule({...rule, fields: [...(rule.fields ?? []), {left: '', right: '', type: 'text'}]})}),
        ) : null,
        rule.kind === 'time' ? e('div', {className: 'ita-row', style: {marginTop: '12px'}},
          e(Field, {label: '时间列'}, e(Input, {value: rule.time?.column ?? '', onChange: (column) => setRule({...rule, time: {...(rule.time ?? {op: 'after'}), column}})})),
          e(Field, {label: '判定条件'}, e(Select, {
            value: rule.time?.op ?? 'after',
            options: [['after', '晚于参考时间'], ['before', '早于参考时间'], ['within-days', '与参考时间相差超过 N 天'], ['order', '晚于另一列（顺序异常）']].map(([value, label]) => ({value, label})),
            onChange: (op) => setRule({...rule, time: {...(rule.time ?? {column: ''}), op}}),
          })),
          e(Field, {label: '参考时间（常量）'}, e(Input, {value: rule.time?.referenceValue ?? '', onChange: (referenceValue) => setRule({...rule, time: {...(rule.time ?? {column: ''}), referenceValue}})})),
          e(Field, {label: '参考列（顺序异常时）'}, e(Input, {value: rule.time?.referenceColumn ?? '', onChange: (referenceColumn) => setRule({...rule, time: {...(rule.time ?? {column: ''}), referenceColumn}})})),
          e(Field, {label: '天数'}, e(Input, {value: rule.time?.days ?? '', onChange: (days) => setRule({...rule, time: {...(rule.time ?? {column: ''}), days: Number(days) || 0}})})),
        ) : null,
        e('div', {className: 'ita-row', style: {marginTop: '12px'}},
          e(Field, {label: '数字容差（金额核对）'}, e(Input, {value: rule.options?.numericTolerance ?? '', onChange: (numericTolerance) => setRule({...rule, options: {...rule.options, numericTolerance: numericTolerance || undefined}})})),
          e(Field, {label: '大小写不敏感'}, e(Select, {
            value: rule.options?.caseInsensitive === false ? 'false' : 'true',
            options: [{value: 'true', label: '是'}, {value: 'false', label: '否'}],
            onChange: (value) => setRule({...rule, options: {...rule.options, caseInsensitive: value === 'true'}}),
          })),
          e(Field, {label: '去除首尾空格'}, e(Select, {
            value: rule.options?.trim === false ? 'false' : 'true',
            options: [{value: 'true', label: '是'}, {value: 'false', label: '否'}],
            onChange: (value) => setRule({...rule, options: {...rule.options, trim: value === 'true'}}),
          })),
        ),
        e('div', {className: 'ita-row', style: {marginTop: '14px'}},
          Btn({children: busy === 'preview' ? e(Spinner) : t('rule.preview'), onClick: runPreview, disabled: busy !== ''}),
          Btn({children: busy === 'save' ? e(Spinner) : '保存草稿', onClick: () => save(false), disabled: busy !== ''}),
          Btn({children: busy === 'confirm' ? e(Spinner) : '保存并确认', kind: 'primary', onClick: () => save(true), disabled: busy !== ''}),
        ),
        preview === null ? null : e('div', {style: {marginTop: '12px'}},
          e('p', {className: 'ita-hint'}, t('rule.previewOk') + '：以下为受控 SQL 预览（未执行）。'),
          (preview.warnings ?? []).map((warning, index) => e('p', {className: 'ita-warn', key: index}, warning)),
          (preview.sqlBlocks ?? []).map((block) => e('div', {key: block.side},
            e('div', {className: 'ita-label'}, `${block.side === 'left' ? '左侧' : '右侧'} · ${block.sourceName}`),
            block.sql === null ? e('p', {className: 'ita-hint'}, block.note) : e('pre', {className: 'ita-pre'}, block.sql),
          )),
        ),
      );
    }

    /* ------------------------------------------------------------------ */
    /* Tab: rules                                                          */
    /* ------------------------------------------------------------------ */

    function RulesTab({overview, reload, onRun}) {
      const [editing, setEditing] = useState(null);
      const [error, setError] = useState(null);
      const [busy, setBusy] = useState('');
      const [importNotes, setImportNotes] = useState([]);
      const [selectedRules, setSelectedRules] = useState([]);
      const [groupName, setGroupName] = useState('');
      const project = overview.project;
      const rules = overview.rules ?? [];
      const drafts = overview.drafts ?? [];
      const groups = overview.groups ?? [];
      const templates = overview.templates ?? [];
      const [templateId, setTemplateId] = useState('');
      const [templateValues, setTemplateValues] = useState({});
      const [templateSources, setTemplateSources] = useState({left: '', right: ''});
      const [planId, setPlanId] = useState('');
      const [planName, setPlanName] = useState('');
      const selectedPlan = (overview.plans ?? []).find((plan) => plan.id === planId) ?? null;
      const template = templates.find((entry) => entry.id === templateId) ?? null;
      const sources = overview.sources ?? [];

      const act = async (label, action) => {
        setBusy(label); setError(null);
        try { await action(); await reload(); return true; } catch (failure) { setError(failure); return false; } finally { setBusy(''); }
      };

      const toggleRule = (ruleId) => setSelectedRules((current) => current.includes(ruleId) ? current.filter((id) => id !== ruleId) : [...current, ruleId]);
      const importDraft = (draftId) => act(`draft:${draftId}`, async () => {
        const imported = await post('draft.import', {projectId: project.id, draftId, sessionId: overview.binding?.sessionId});
        setImportNotes([...(imported.warnings ?? []), ...(imported.confirmations ?? []).map((entry) => `${entry.side === 'left' ? '左' : '右'}侧：${entry.note}`)]);
        setEditing({...imported.rule, id: undefined, version: undefined, status: 'draft'});
      });

      return e('div', null,
        e(ErrorLine, {error}),
        drafts.length === 0 ? null : e(Card, {title: 'Agent 规则草稿（导入后仍需人工确认）'},
          e('p', {className: 'ita-hint'}, '这些是 Agent 通过 db-query 校验后留下的候选规则。导入只表示进入编辑流程，不会替你确认。'),
          e('div', {className: 'ita-list'},
            drafts.map((draft) => e('div', {className: 'ita-item', key: draft.id},
              e('div', {className: 'ita-item-head'},
                e('div', {className: 'ita-row', style: {alignItems: 'center', gap: '8px'}},
                  e('strong', null, draft.ruleName),
                  e('span', {className: 'ita-tag'}, draft.ruleKind),
                  e(Badge, {tone: draft.status === 'imported' ? 'ok' : 'warn'}, draft.status === 'imported' ? '已导入' : '待导入'),
                ),
                e('div', {className: 'ita-row'},
                  Btn({children: busy === `draft:${draft.id}` ? e(Spinner) : '导入', kind: 'primary', disabled: busy !== '', onClick: () => importDraft(draft.id)}),
                  Btn({children: '忽略', kind: 'ghost', disabled: busy !== '', onClick: () => act(`discard:${draft.id}`, () => post('draft.discard', {projectId: project.id, draftId: draft.id}))}),
                ),
              ),
              e('div', {className: 'ita-hint'}, `${draft.id} · ${draft.createdAt}${draft.importCount > 0 ? ` · 已导入 ${draft.importCount} 次` : ''}`),
              (draft.assumptions ?? []).length === 0 ? null : e('div', {className: 'ita-warn'}, `待确认假设：${draft.assumptions.join('；')}`),
              (draft.warnings ?? []).length === 0 ? null : e('div', {className: 'ita-hint'}, draft.warnings.join('；')),
            )),
          ),
        ),
        importNotes.length === 0 ? null : e('div', {className: 'ita-warn'}, `导入提示：${importNotes.join('；')}`),
        e(Card, {
          title: t('rule.title'),
          actions: [
            Btn({children: t('rule.new'), kind: 'primary', onClick: () => setEditing({...blankRule(), left: {sourceId: sources[0]?.id ?? '', dataset: {kind: 'table'}}, right: {sourceId: sources[1]?.id ?? '', dataset: {kind: 'table'}}})}),
            Btn({children: t('common.refresh'), kind: 'ghost', onClick: () => reload()}),
          ],
        },
          rules.length === 0 ? e(Empty, null, '还没有规则。可以用下面的模板快速生成草稿，或点「新建规则」。') : e('div', {className: 'ita-scroll'},
            e('table', {className: 'ita-table'},
              e('thead', null, e('tr', null,
                e('th', null, '选择'), e('th', null, t('rule.name')), e('th', null, t('rule.kind')), e('th', null, t('rule.version')),
                e('th', null, t('rule.status')), e('th', null, '操作'),
              )),
              e('tbody', null, rules.map((rule) => e('tr', {key: rule.ruleId},
                e('td', null, e('input', {
                  type: 'checkbox', checked: selectedRules.includes(rule.ruleId),
                  disabled: rule.status !== 'confirmed' || rule.kind === 'threshold' && false,
                  onChange: () => toggleRule(rule.ruleId),
                  'aria-label': `选择规则 ${rule.name}`,
                })),
                e('td', null, rule.name, e('div', {className: 'ita-hint'}, `${rule.ruleId} · ${rule.versions} 个版本`)),
                e('td', null, (RULE_KINDS.find(([value]) => value === rule.kind) ?? [rule.kind, rule.kind])[1]),
                e('td', null, `v${rule.version}`),
                e('td', null, e(Badge, {tone: rule.status === 'confirmed' ? 'ok' : rule.status === 'disabled' ? 'bad' : 'warn'}, rule.status)),
                e('td', null, e('div', {className: 'ita-row'},
                  Btn({children: '编辑', onClick: async () => {
                    try { setEditing(await post('rule.get', {projectId: project.id, ruleId: rule.ruleId})); } catch (failure) { setError(failure); }
                  }}),
                  Btn({children: '确认', disabled: rule.status === 'confirmed' || busy !== '', onClick: () => act(`confirm:${rule.ruleId}`, () => post('rule.status', {projectId: project.id, ruleId: rule.ruleId, status: 'confirmed', expectedVersion: rule.version, author: 'workbench'}))}),
                  Btn({children: t('rule.run'), kind: 'primary', disabled: rule.status !== 'confirmed' || busy !== '', title: rule.status !== 'confirmed' ? t('rule.needConfirm') : undefined, onClick: () => onRun(rule.ruleId)}),
                  rule.status === 'confirmed' ? Btn({children: t('rule.disable'), kind: 'ghost', onClick: () => act(`disable:${rule.ruleId}`, () => post('rule.status', {projectId: project.id, ruleId: rule.ruleId, status: 'disabled', expectedVersion: rule.version, author: 'workbench'}))}) : null,
                )),
              ))),
            ),
          ),
        ),
        e(Card, {title: '组合核对（多规则一次执行）'},
          e('p', {className: 'ita-hint'}, '勾选已确认的规则，按顺序执行。每条规则仍各自持有语句级快照；组合任务不承诺跨规则统一快照。'),
          selectedRules.length === 0
            ? e('div', {className: 'ita-empty'}, '尚未选择规则。勾选上方「已确认」的规则后可组合执行。')
            : e('div', null,
                e('div', {className: 'ita-row', style: {alignItems: 'center', gap: '8px'}},
                  e('span', null, `已选 ${selectedRules.length} 条规则`),
                  e(Input, {value: groupName, placeholder: '组合任务名称（可选）', onChange: setGroupName}),
                  Btn({children: busy === 'group' ? e(Spinner) : '执行组合核对', kind: 'primary', disabled: busy !== '', onClick: () => act('group', async () => {
                    await post('run.start-group', {projectId: project.id, ruleIds: selectedRules, name: groupName || undefined});
                    setSelectedRules([]); setGroupName('');
                  })}),
                ),
              ),
          groups.length === 0 ? null : e('div', {className: 'ita-list'},
            groups.slice(0, 5).map((group) => e('div', {className: 'ita-item', key: group.groupId},
              e('div', {className: 'ita-row', style: {justifyContent: 'space-between'}},
                e('strong', null, group.name),
                e(Badge, {tone: group.status === 'completed' ? 'ok' : group.status === 'failed' ? 'bad' : 'warn'}, group.status),
              ),
              e('div', {className: 'ita-hint'}, `${group.groupId} · 规则 ${group.stats?.rules ?? 0} · 异常事件 ${group.stats?.exceptionEvents ?? 0} · 已复核 ${group.stats?.reviewed ?? 0} / 待复核 ${group.stats?.pending ?? 0}`),
              group.stats?.uniqueRecords === null ? e('div', {className: 'ita-hint'}, group.stats?.uniqueNote) : null,
            )),
          ),
        ),
        e(Card, {title: '数据分析核对方案库'},
          e('p', {className: 'ita-hint'}, '方案是“模板 + 参数”的可复用配方，应用后生成待确认规则草稿；跨项目复用只搬核对逻辑，不搬数据、凭据或确认状态。'),
          e('div', {className: 'ita-row'},
            e(Field, {label: '方案'}, e(Select, {
              value: planId, placeholder: '选择方案',
              options: (overview.plans ?? []).map((plan) => ({value: plan.id, label: `${plan.name} · v${plan.version}${plan.protected ? '（预置）' : ''}`})),
              onChange: setPlanId,
            })),
            selectedPlan === null ? null : Btn({children: '载入参数', onClick: () => {
              setTemplateId(selectedPlan.templateId);
              setTemplateValues({...(selectedPlan.values ?? {})});
            }}),
            selectedPlan === null ? null : Btn({children: '从模板复制为自定义方案', onClick: () => act('plan-copy', async () => {
              await post('plan.copy', {planId: selectedPlan.id, name: `${selectedPlan.name}（副本）`});
            })}),
          ),
          selectedPlan === null ? null : e('div', {className: 'ita-hint'}, `${selectedPlan.category} · ${selectedPlan.description}`),
          (overview.plans ?? []).length === 0 ? e('div', {className: 'ita-empty'}, '暂无方案。') : null,
        ),
        e(Card, {title: '从专项模板生成规则草稿'},
          e('p', {className: 'ita-hint'}, '模板不写死客户字段：请填写本项目中实际使用的列名。生成的是「待确认」草稿，确认后才能正式执行。'),
          e('div', {className: 'ita-row'},
            e(Field, {label: '模板'}, e(Select, {
              value: templateId, placeholder: '选择模板',
              options: templates.map((entry) => ({value: entry.id, label: `${entry.name}（${entry.scenario}）`})),
              onChange: (value) => { setTemplateId(value); setTemplateValues({}); },
            })),
            template === null ? null : e(Field, {label: '左侧数据源'}, e(Select, {value: templateSources.left, placeholder: '选择', options: sources.map((source) => ({value: source.id, label: source.name})), onChange: (left) => setTemplateSources({...templateSources, left})})),
            template === null ? null : e(Field, {label: '右侧数据源'}, e(Select, {value: templateSources.right, placeholder: '选择', options: sources.map((source) => ({value: source.id, label: source.name})), onChange: (right) => setTemplateSources({...templateSources, right})})),
          ),
          template === null ? null : e('div', null,
            e('p', {className: 'ita-hint'}, template.description),
            e('div', {className: 'ita-grid', style: {marginTop: '4px'}},
              template.inputs.map((input) => e(Field, {key: input.key, label: input.label + (input.optional ? '（可选）' : '')},
                e(Input, {value: templateValues[input.key] ?? '', onChange: (value) => setTemplateValues({...templateValues, [input.key]: value})}),
              )),
            ),
            e('div', {className: 'ita-row', style: {marginTop: '10px'}},
              Btn({children: busy === 'template' ? e(Spinner) : '生成规则草稿', kind: 'primary', disabled: busy !== '' || templateSources.left === '', onClick: () => act('template', () => post('template.apply', {
                projectId: project.id, templateId, values: templateValues,
                leftSourceId: templateSources.left,
                rightSourceId: templateSources.right === '' ? undefined : templateSources.right,
                author: 'workbench',
              }))}),
            ),
            e('div', {className: 'ita-row', style: {marginTop: '8px'}},
              e(Input, {value: planName, placeholder: '方案名称', onChange: setPlanName}),
              Btn({children: '保存当前参数为方案', disabled: busy !== '' || planName.trim() === '', onClick: () => act('plan-save', async () => {
                await post('plan.save', {name: planName, templateId, values: templateValues});
                setPlanName('');
              })}),
            ),
          ),
        ),
        editing === null ? null : e(RuleEditor, {
          overview,
          initial: editing,
          onClose: () => setEditing(null),
          onSaved: async () => { await reload(); },
        }),
      );
    }

    /* ------------------------------------------------------------------ */
    /* Tab: tasks                                                          */
    /* ------------------------------------------------------------------ */

    function TasksTab({overview, reload, onOpenResults}) {
      const [busy, setBusy] = useState('');
      const [error, setError] = useState(null);
      const [packPath, setPackPath] = useState('');
      const project = overview.project;
      const runs = overview.runs ?? [];

      // Every action must clear the busy flag and surface failures; without this
      // helper the buttons below would throw on click and silently do nothing.
      const act = async (label, action) => {
        setBusy(label); setError(null);
        try { await action(); await reload(); return true; } catch (failure) { setError(failure); return false; } finally { setBusy(''); }
      };
      const running = runs.some((run) => run.status === 'running');

      useEffect(() => {
        if (!running) return undefined;
        const timer = window.setInterval(() => { reload(); }, 2500);
        return () => window.clearInterval(timer);
      }, [running, reload]);

      const groups = overview.groups ?? [];
      return e('div', null,
        e(ErrorLine, {error}),
        packPath === '' ? null : e('div', {className: 'ita-warn'}, `组合证据包：${packPath}`),
        groups.length === 0 ? null : e(Card, {title: '组合核对任务'},
          e('p', {className: 'ita-hint'}, '每条子规则独立执行并保留自己的状态与一致性记录；组合任务不承诺跨规则统一快照。'),
          e('div', {className: 'ita-list'},
            groups.slice(0, 10).map((group) => e('div', {className: 'ita-item', key: group.groupId},
              e('div', {className: 'ita-row', style: {justifyContent: 'space-between'}},
                e('strong', null, group.name),
                e('div', {className: 'ita-row'},
                  e(Badge, {tone: group.status === 'completed' ? 'ok' : group.status === 'failed' ? 'bad' : 'warn'}, group.status),
                  Btn({children: busy === `pack:${group.groupId}` ? e(Spinner) : '导出组合证据', disabled: busy !== '' || group.status === 'running', onClick: () => act(`pack:${group.groupId}`, async () => {
                    const pack = await post('evidence.export-group', {projectId: project.id, groupId: group.groupId});
                    setPackPath(pack.directory);
                  })}),
                  group.status === 'running' ? Btn({children: '取消', kind: 'danger', onClick: () => act(`cancel-group:${group.groupId}`, () => post('run.group-cancel', {projectId: project.id, groupId: group.groupId}))}) : null,
                ),
              ),
              e('div', {className: 'ita-hint'}, `${group.groupId} · ${group.finishedAt ?? group.createdAt}`),
              e('div', {className: 'ita-hint'}, `规则 ${group.stats?.rules ?? 0} · 异常事件 ${group.stats?.exceptionEvents ?? 0} · 已复核 ${group.stats?.reviewed ?? 0} / 待复核 ${group.stats?.pending ?? 0}`),
              group.stats?.uniqueRecords === null ? e('div', {className: 'ita-hint'}, group.stats?.uniqueNote) : null,
              e('div', {className: 'ita-scroll'},
                e('table', {className: 'ita-table'},
                  e('thead', null, e('tr', null, e('th', null, '子规则'), e('th', null, '状态'), e('th', null, '异常'), e('th', null, '一致性'), e('th', null, '操作'))),
                  e('tbody', null, (group.rules ?? []).map((child, index) => e('tr', {key: `${group.groupId}-${child.ruleId}-${index}`},
                    e('td', null, child.ruleId, child.ruleVersion === undefined ? null : e('span', {className: 'ita-hint'}, ` v${child.ruleVersion}`), child.reason === undefined ? null : e('div', {className: 'ita-warn'}, child.reason)),
                    e('td', null, statusLabel(overview.runLabels, child.status)),
                    e('td', null, String(child.exceptionCount ?? 0)),
                    e('td', null, child.readConsistency?.level ?? '—'),
                    e('td', null, child.runId === null || child.runId === undefined ? null : Btn({children: '查看结果', onClick: () => onOpenResults(child.runId)})),
                  ))),
                ),
              ),
            )),
          ),
        ),
        e(Card, {
          title: t('run.title'),
          actions: [Btn({children: t('common.refresh'), kind: 'ghost', onClick: () => reload()})],
        },
          runs.length === 0 ? e(Empty, null, t('run.empty')) : e('div', {className: 'ita-scroll'},
            e('table', {className: 'ita-table'},
              e('thead', null, e('tr', null,
                e('th', null, '任务'), e('th', null, t('run.rule')), e('th', null, t('run.status')),
                e('th', null, t('run.exceptions')), e('th', null, t('run.complete')), e('th', null, '操作'),
              )),
              e('tbody', null, runs.map((run) => e('tr', {key: run.runId},
                e('td', null, run.name, e('div', {className: 'ita-hint'}, `${run.runId} · ${run.startedAt}`)),
                e('td', null, `${run.ruleName} v${run.ruleVersion}`),
                e('td', null, e(Badge, {tone: statusTone(run.status)}, statusLabel(overview.runLabels, run.status))),
                e('td', null, String(run.exceptionCount ?? 0)),
                e('td', null, run.complete === true ? '完整' : run.complete === false ? '不完整' : '—'),
                e('td', null, e('div', {className: 'ita-row'},
                  Btn({children: '查看结果', onClick: () => onOpenResults(run.runId)}),
                  run.status === 'running' ? Btn({children: t('run.cancel'), kind: 'danger', disabled: busy !== '', onClick: async () => {
                    setBusy(run.runId); setError(null);
                    try { await post('run.cancel', {projectId: project.id, runId: run.runId}); await reload(); } catch (failure) { setError(failure); } finally { setBusy(''); }
                  }}) : null,
                )),
              ))),
            ),
          ),
        ),
      );
    }

    /* ------------------------------------------------------------------ */
    /* Tab: results                                                        */
    /* ------------------------------------------------------------------ */

    function ResultsTab({overview, initialRunId}) {
      const project = overview.project;
      const runs = (overview.runs ?? []).filter((run) => run.status !== 'running');
      const [runId, setRunId] = useState(initialRunId ?? runs[0]?.runId ?? '');
      const [run, setRun] = useState(null);
      const [error, setError] = useState(null);
      const [filters, setFilters] = useState({reviewStatus: '', kind: '', query: ''});
      const [page, setPage] = useState(null);
      const [cursor, setCursor] = useState(0);
      const [detail, setDetail] = useState(null);
      const [reviewer, setReviewer] = useState(() => readStore(REVIEWER_KEY, ''));
      const [reviewForm, setReviewForm] = useState({status: 'confirmed', note: ''});
      const [busy, setBusy] = useState('');

      useEffect(() => {
        if (runId === '') return undefined;
        let cancelled = false;
        setError(null);
        post('run.get', {projectId: project.id, runId})
          .then((value) => { if (!cancelled) setRun(value); })
          .catch((failure) => { if (!cancelled) setError(failure); });
        return () => { cancelled = true; };
      }, [runId]);

      const loadPage = useCallback(async (nextCursor) => {
        if (runId === '') return;
        setError(null);
        try {
          const result = await post('run.exceptions', {
            projectId: project.id, runId, cursor: nextCursor,
            pageSize: 50,
            reviewStatus: filters.reviewStatus || undefined,
            kind: filters.kind || undefined,
            query: filters.query || undefined,
          });
          setPage(result);
          setCursor(nextCursor);
        } catch (failure) {
          setError(failure);
        }
      }, [runId, filters]);

      useEffect(() => { loadPage(0); }, [loadPage]);

      const submitReview = async () => {
        if (detail === null) return;
        if (String(reviewer).trim() === '') { setError(new Error('复核人不能为空。')); return; }
        setBusy('review'); setError(null);
        try {
          writeStore(REVIEWER_KEY, reviewer);
          await post('run.review', {projectId: project.id, runId, exceptionId: detail.exceptionId, status: reviewForm.status, note: reviewForm.note, by: reviewer});
          setDetail(null);
          await loadPage(cursor);
          const refreshed = await post('run.get', {projectId: project.id, runId});
          setRun(refreshed);
        } catch (failure) { setError(failure); } finally { setBusy(''); }
      };

      if (runs.length === 0) return e(Empty, null, '还没有可查看的核对任务。');

      return e('div', null,
        e(ErrorLine, {error}),
        e(Card, {title: t('result.title'), actions: [
          e(Field, {label: t('result.pickRun')}, e(Select, {value: runId, onChange: (value) => { setRunId(value); setCursor(0); }, options: runs.map((entry) => ({value: entry.runId, label: `${entry.name} · ${entry.runId}`}))})),
        ]},
          run === null ? e(Empty, null, t('common.loading')) : e('div', null,
            run.complete === false ? e('p', {className: 'ita-warn'}, t('result.incomplete')) : null,
            run.status === 'failed' ? e('p', {className: 'ita-err'}, `${t('run.error')}：${run.failure?.message ?? ''}`) : null,
            e('dl', {className: 'ita-kv'},
              e('dt', null, t('run.status')), e('dd', null, e(Badge, {tone: statusTone(run.status)}, statusLabel(overview.runLabels, run.status))),
              e('dt', null, t('run.rule')), e('dd', null, `${run.ruleName}（${run.ruleId} v${run.ruleVersion}）`),
              e('dt', null, '开始 / 结束'), e('dd', null, `${run.startedAt} → ${run.finishedAt ?? '—'}（${run.durationMs ?? '—'} ms）`),
              e('dt', null, t('run.exceptions')), e('dd', null, String(run.exceptionCount ?? 0)),
              e('dt', null, '复核状态'), e('dd', null, Object.entries(run.reviewed ?? {}).map(([key, value]) => `${overview.reviewLabels?.[key] ?? key} ${value}`).join('　')),
              e('dt', null, '内容哈希'), e('dd', null, e('code', null, run.contentHash ?? '—')),
              (run.warnings ?? []).length === 0 ? null : e('dt', null, '提示'),
              (run.warnings ?? []).length === 0 ? null : e('dd', null, (run.warnings ?? []).map((warning, index) => e('div', {className: 'ita-warn', key: index}, warning))),
            ),
            e('div', {style: {marginTop: '12px'}},
              e('div', {className: 'ita-label'}, t('result.coverage')),
              e('div', {className: 'ita-grid2'},
                ['left', 'right'].map((side) => {
                  const coverage = run.coverage?.[side];
                  if (coverage === undefined || coverage === null) return null;
                  return e('div', {className: 'ita-item', key: side},
                    e('div', {className: 'ita-row', style: {justifyContent: 'space-between'}},
                      e('strong', null, `${side === 'left' ? '左侧' : '右侧'} · ${coverage.sourceName}`),
                      coverage.truncated ? e(Badge, {tone: 'bad'}, '已截断') : e(Badge, {tone: 'ok'}, '完整'),
                    ),
                    e('div', {className: 'ita-hint'}, `行数 ${coverage.rows} · 列数 ${coverage.columns} · 观测时间 ${coverage.observedAt} · 解析异常 ${coverage.parseIssues}`),
                    (coverage.statements ?? []).length === 0 ? null : e('details', null,
                      e('summary', {className: 'ita-hint'}, t('result.sql')),
                      e('pre', {className: 'ita-pre'}, coverage.statements.join(';\n\n')),
                    ),
                  );
                }),
              ),
            ),
          ),
        ),
        e(Card, {title: t('result.exceptions')},
          e('div', {className: 'ita-grid'},
            e(Field, {label: '复核状态'}, e(Select, {
              value: filters.reviewStatus, placeholder: '全部',
              options: [['pending', '待复核'], ['confirmed', '已确认'], ['excluded', '已排除'], ['insufficient', '证据不足']].map(([value, label]) => ({value, label})),
              onChange: (reviewStatus) => setFilters({...filters, reviewStatus}),
            })),
            e(Field, {label: '类型'}, e(Input, {value: filters.kind, onChange: (kind) => setFilters({...filters, kind})})),
            e(Field, {label: '搜索'}, e(Input, {value: filters.query, onChange: (query) => setFilters({...filters, query})})),
          ),
          e('div', {className: 'ita-actionbar'},
            e('div', {className: 'ita-actionbar-group'}, Btn({children: '查询', kind: 'primary', onClick: () => loadPage(0)})),
            e('span', {className: 'ita-status'}, page === null ? '尚未查询' : `共 ${page.total} 条`),
          ),
          page === null ? e(Empty, null, t('common.loading')) : e('div', null,
            e('p', {className: 'ita-hint'}, `共 ${page.total} 条，当前第 ${Math.floor(cursor / 50) + 1} 页。`),
            page.total === 0 ? e(Empty, null, t('result.noException')) : e('div', {className: 'ita-scroll'},
              e('table', {className: 'ita-table'},
                e('thead', null, e('tr', null,
                  e('th', null, '#'), e('th', null, '类型'), e('th', null, '说明'), e('th', null, '主键'),
                  e('th', null, '行号'), e('th', null, '复核'), e('th', null, ''),
                )),
                e('tbody', null, page.items.map((exception) => e('tr', {key: exception.exceptionId},
                  e('td', null, String(exception.sequence)),
                  e('td', null, exception.kind),
                  e('td', null, exception.message),
                  e('td', null, Object.entries(exception.keys ?? {}).map(([key, value]) => `${key}=${value ?? '∅'}`).join('; ')),
                  e('td', null, `L${(exception.leftRowNumbers ?? []).join(',') || '—'} / R${(exception.rightRowNumbers ?? []).join(',') || '—'}`),
                  e('td', null, e(Badge, {tone: exception.review?.status === 'confirmed' ? 'ok' : exception.review?.status === 'excluded' ? 'bad' : 'warn'}, overview.reviewLabels?.[exception.review?.status ?? 'pending'] ?? exception.review?.status)),
                  e('td', null, Btn({children: t('result.detail'), kind: 'ghost', onClick: () => { setDetail(exception); setReviewForm({status: exception.review?.status ?? 'confirmed', note: exception.review?.note ?? ''}); }})),
                ))),
              ),
            ),
            e('div', {className: 'ita-row', style: {marginTop: '8px'}},
              Btn({children: '上一页', disabled: cursor === 0, onClick: () => loadPage(Math.max(0, cursor - 50))}),
              Btn({children: '下一页', disabled: page.nextCursor === null, onClick: () => loadPage(page.nextCursor)}),
            ),
          ),
        ),
        detail === null ? null : e(Modal, {title: `异常 ${detail.exceptionId}`, onClose: () => setDetail(null)},
          e('dl', {className: 'ita-kv'},
            e('dt', null, '类型'), e('dd', null, detail.kind),
            e('dt', null, '说明'), e('dd', null, detail.message),
            e('dt', null, '主键'), e('dd', null, Object.entries(detail.keys ?? {}).map(([key, value]) => `${key}=${value ?? '∅'}`).join('; ') || '—'),
            e('dt', null, '左侧行号'), e('dd', null, (detail.leftRowNumbers ?? []).join(',') || '—'),
            e('dt', null, '右侧行号'), e('dd', null, (detail.rightRowNumbers ?? []).join(',') || '—'),
            e('dt', null, '值对比'), e('dd', null, Object.entries(detail.values ?? {}).map(([key, pair]) => `${key}：左 ${pair.left ?? '∅'} / 右 ${pair.right ?? '∅'}`).join('；') || '—'),
            e('dt', null, '复核历史'), e('dd', null, (detail.review?.history ?? []).map((entry) => `${entry.at} ${entry.by} → ${entry.status}${entry.note ? `（${entry.note}）` : ''}`).join('；') || '—'),
          ),
          e('div', {className: 'ita-row', style: {marginTop: '12px'}},
            e(Field, {label: t('result.reviewer')}, e(Input, {value: reviewer, onChange: setReviewer})),
            e(Field, {label: t('result.review')}, e(Select, {
              value: reviewForm.status,
              options: [['confirmed', '已确认'], ['excluded', '已排除'], ['insufficient', '证据不足'], ['pending', '退回待复核']].map(([value, label]) => ({value, label})),
              onChange: (status) => setReviewForm({...reviewForm, status}),
            })),
            e(Field, {label: t('result.note'), wide: true}, e(Input, {value: reviewForm.note, onChange: (note) => setReviewForm({...reviewForm, note})})),
          ),
          e('div', {className: 'ita-row', style: {marginTop: '10px'}},
            Btn({children: busy === 'review' ? e(Spinner) : t('result.mark'), kind: 'primary', disabled: busy !== '', onClick: submitReview}),
          ),
        ),
      );
    }

    /* ------------------------------------------------------------------ */
    /* Tab: evidence                                                       */
    /* ------------------------------------------------------------------ */

    function EvidenceTab({overview}) {
      const project = overview.project;
      const runs = (overview.runs ?? []).filter((run) => run.status !== 'running');
      const [runId, setRunId] = useState(runs[0]?.runId ?? '');
      const [result, setResult] = useState(null);
      const [error, setError] = useState(null);
      const [busy, setBusy] = useState('');

      const act = async (label, action) => {
        setBusy(label); setError(null);
        try { setResult({kind: label, payload: await action()}); } catch (failure) { setError(failure); } finally { setBusy(''); }
      };

      if (runs.length === 0) return e(Empty, null, '还没有可导出的核对任务。');

      return e('div', null,
        e(ErrorLine, {error}),
        e(Card, {title: t('evidence.title'), actions: [
          e(Field, {label: '任务'}, e(Select, {value: runId, onChange: setRunId, options: runs.map((run) => ({value: run.runId, label: `${run.name} · ${run.runId}`}))})),
        ]},
          e('p', {className: 'ita-hint'}, t('evidence.note')),
          e('div', {className: 'ita-row', style: {marginTop: '10px'}},
            Btn({children: busy === 'evidence' ? e(Spinner) : t('evidence.export'), kind: 'primary', disabled: busy !== '' || runId === '', onClick: () => act('evidence', () => post('evidence.export', {projectId: project.id, runId}))}),
            Btn({children: busy === 'xlsx' ? e(Spinner) : '导出 XLSX', disabled: busy !== '' || runId === '', onClick: () => act('xlsx', () => post('report.export', {projectId: project.id, runId, format: 'xlsx'}))}),
            Btn({children: busy === 'csv' ? e(Spinner) : '导出 CSV', disabled: busy !== '' || runId === '', onClick: () => act('csv', () => post('report.export', {projectId: project.id, runId, format: 'csv'}))}),
            Btn({children: busy === 'html' ? e(Spinner) : '导出 HTML', disabled: busy !== '' || runId === '', onClick: () => act('html', () => post('report.export', {projectId: project.id, runId, format: 'html'}))}),
            Btn({children: busy === 'markdown' ? e(Spinner) : '导出 Markdown', disabled: busy !== '' || runId === '', onClick: () => act('markdown', () => post('report.export', {projectId: project.id, runId, format: 'markdown'}))}),
          ),
        ),
        result === null ? null : e(Card, {title: t('evidence.lastExport')},
          result.kind === 'evidence'
            ? e('div', null,
                e('p', null, `证据包目录：${result.payload.directory}`),
                e('p', {className: 'ita-hint'}, result.payload.verified ? t('evidence.verified') : '哈希校验未通过！'),
                e('ul', null, (result.payload.files ?? []).map((file) => e('li', {key: file.path}, `${file.path}（${file.bytes} 字节）`))),
              )
            : e('div', null,
                e('p', null, `输出文件：${result.payload.path}`),
                e('p', {className: 'ita-hint'}, `${result.payload.bytes} 字节`),
              ),
        ),
      );
    }

    /* ------------------------------------------------------------------ */
    /* Page                                                                */
    /* ------------------------------------------------------------------ */

    function ProjectBar({overview, projectId, onProjectChange, reload, refresh, notice, resultTotal, bridge}) {
      const project = overview.project;
      const [editing, setEditing] = useState(null);
      const [busy, setBusy] = useState('');
      const [error, setError] = useState(null);
      useEffect(() => { setError(null); }, [projectId]);
      const openEditor = (next) => { setError(null); setEditing(next); };
      const closeEditor = () => { setError(null); setEditing(null); };
      const act = async (label, action) => {
        setBusy(label); setError(null);
        try { await action(); await reload(); return true; } catch (failure) { setError(failure); return false; } finally { setBusy(''); }
      };
      const counts = project === null
        ? ''
        : `${(overview.sources ?? []).length} 个数据源 · 结果 ${resultTotal ?? (overview.assistant?.results ?? []).length} 个`;
      return e('div', null,
        editing === null ? e(ErrorWithAsk, {error, project, bridge}) : null,
        e('div', {className: 'ita-projects'},
          e('span', {className: 'ita-projects-label'}, '项目'),
          e('div', {className: 'ita-projects-select'},
            e(Select, {
              value: projectId ?? '', placeholder: (overview.projects ?? []).length === 0 ? '还没有项目' : '选择项目',
              options: (overview.projects ?? []).map((entry) => ({value: entry.id, label: entry.name})),
              onChange: (value) => onProjectChange(value),
            }),
          ),
          notice === null ? null : e('span', {className: 'ita-chip'}, notice),
          counts === '' ? null : e('span', {className: 'ita-projects-meta'}, counts),
          e('div', {className: 'ita-projects-actions'},
            Btn({children: t('project.new'), kind: 'primary', onClick: () => openEditor({mode: 'create', name: '', description: ''})}),
            project === null ? null : Btn({children: t('project.rename'), onClick: () => openEditor({mode: 'rename', name: project.name, description: project.description ?? ''})}),
            project === null ? null : Btn({children: '删除项目', kind: 'danger', onClick: async () => {
              if (!window.confirm(tf('deleteProject', {name: project.name}))) return;
              // The route requires confirm:true; only leave the project after
              // the delete actually succeeded.
              const deleted = await act('delete', () => post('project.delete', {projectId: project.id, confirm: true}));
              if (deleted) onProjectChange(null);
            }}),
            project === null ? null : Btn({children: t('common.refresh'), kind: 'ghost', onClick: () => reload()}),
          ),
        ),
        editing === null ? null : e(Modal, {title: editing.mode === 'create' ? t('project.new') : t('project.rename'), size: 'sm', onClose: closeEditor},
          e(ErrorWithAsk, {error, project, bridge}),
          e('div', {className: 'ita-form'},
            e(Field, {label: t('project.name'), required: true, hint: '用于区分不同的数据库分析项目'}, e(Input, {value: editing.name, placeholder: '例如：2026 年备份分析', onChange: (name) => setEditing({...editing, name})})),
            e(Field, {label: t('project.desc'), hint: '可选，写一句项目说明'}, e(Input, {value: editing.description, placeholder: '例如：只读连接 app_db，分析备份失败', onChange: (description) => setEditing({...editing, description})})),
          ),
          e('div', {className: 'ita-modal-foot'},
            editing.mode === 'create' || project === null ? e('span') : Btn({children: t('common.delete'), kind: 'danger', disabled: busy !== '', onClick: async () => {
              if (!window.confirm(tf('deleteProjectWithHint', {name: project.name, hint: t('project.deleteHint')}))) return;
              const deleted = await act('delete', () => post('project.delete', {projectId: project.id, confirm: true}));
              if (deleted) { onProjectChange(null); closeEditor(); }
            }}),
            e('div', {className: 'ita-row'},
              Btn({children: t('common.cancel'), onClick: closeEditor}),
              Btn({children: busy === 'save' ? e(Spinner) : t('common.save'), kind: 'primary', disabled: busy !== '', onClick: async () => {
                if (editing.mode === 'create') {
                  setBusy('save'); setError(null);
                  try {
                    const created = await post('project.create', {name: editing.name, description: editing.description});
                    closeEditor();
                    // Switch immediately; the Page loader reacts to projectId and
                    // fetches the new project. Do not reload the old project here.
                    onProjectChange(created.id);
                  } catch (failure) {
                    setError(failure);
                  } finally {
                    setBusy('');
                  }
                  return;
                }
                await act('save', async () => {
                  await post('project.update', {projectId: project.id, name: editing.name, description: editing.description});
                  closeEditor();
                });
              }}),
            ),
          ),
        ),
      );
    }

    /**
     * Invisible binder for session-scoped slots: whenever the user picks a
     * project in the workbench, the session that hosts this component is bound
     * to the event. Binding is a no-op for sessions without analysis tools, so keeping
     * the binder automatic is safe instead of asking the user to click a button.
     *
     * @param {{sessionId?: string}} props session-scoped slot props.
     * @returns {null} renders nothing.
     */
    function AutoBinder(props) {
      const sessionId = typeof props?.sessionId === 'string' ? props.sessionId : '';
      const [projectId, setProjectId] = useState(() => readStore(STORE_KEY, ''));
      useEffect(() => {
        if (typeof window.addEventListener !== 'function') return undefined;
        const onProject = (event) => setProjectId(typeof event?.detail === 'string' ? event.detail : '');
        window.addEventListener(PROJECT_EVENT, onProject);
        return () => window.removeEventListener(PROJECT_EVENT, onProject);
      }, []);
      const bound = useRef('');
      useEffect(() => {
        if (sessionId === '' || typeof projectId !== 'string' || projectId === '') return;
        const key = `${sessionId}::${projectId}`;
        if (bound.current === key) return;
        bound.current = key;
        post('project.bind', {projectId, sessionId}).catch(() => {
          // A failed auto-bind is recoverable: the workbench still shows the
          // session id and the tool error explains how to bind manually.
          bound.current = '';
        });
      }, [sessionId, projectId]);
      return null;
    }

    /** Structured request fields persisted per project. */
    const EMPTY_REQUEST = Object.freeze({goal: '', leftSourceId: '', rightSourceId: '', keyMapping: '', concerns: [], note: ''});

    /** Anomaly classes offered as one-tap choices when describing the request. */
    const CONCERN_OPTIONS = Object.freeze([
      ['missing', '缺失记录'],
      ['duplicate', '重复记录'],
      ['field', '字段不一致'],
      ['required', '关键字段为空'],
      ['total', '总量/金额'],
      ['time', '时间/超期'],
      ['referential', '关联完整性'],
    ]);

    /**
     * Compose the message an user's filled form turns into.
     *
     * Only non-empty sections are written, so the session receives exactly what
     * the user stated instead of a wall of placeholders.
     *
     * @param {object} overview workbench overview.
     * @param {object} request form values.
     * @returns {string} prompt text.
     */
    function composeRequest(overview, request) {
      const project = overview.project;
      const sources = overview.sources ?? [];
      const describe = (id) => {
        const source = sources.find((entry) => entry.id === id);
        if (source === undefined) return '';
        const kind = source.kind === 'file' ? '文件' : (source.dialect ?? '数据库');
        const rows = typeof source.rowCount === 'number' ? `，${source.rowCount} 行` : '';
        return `${source.name}（${kind}${rows}）`;
      };
      const concerns = (request.concerns ?? [])
        .map((key) => (CONCERN_OPTIONS.find(([value]) => value === key) ?? [key, key])[1]);
      const lines = [
        '【分析项目】' + (project === null ? '' : project.name),
        '',
        '【核对需求】',
        String(request.goal ?? '').trim(),
      ];
      const left = describe(request.leftSourceId);
      const right = describe(request.rightSourceId);
      if (left !== '' || right !== '') {
        lines.push('', '【涉及数据源】');
        if (left !== '') lines.push(`- 左侧：${left}`);
        if (right !== '') lines.push(`- 右侧：${right}`);
      }
      if (String(request.keyMapping ?? '').trim() !== '') {
        lines.push('', '【关联主键】' + String(request.keyMapping).trim());
      }
      if (concerns.length > 0) lines.push('', '【关注异常】' + concerns.join('、'));
      if (String(request.note ?? '').trim() !== '') {
        lines.push('', '【补充说明】' + String(request.note).trim());
      }
      lines.push(
        '',
        '请先用 db-info / db-schema-inspect 确认数据源与字段，再给出核对规则与受控 SQL 预览；我确认规则之后再执行核对。',
      );
      return lines.join('\n');
    }

    /**
     * Create (or reuse) this project's analysis session, bind the session, send the text,
     * and navigate to the conversation.
     *
     * @param {{bridge: object, project: object, text: string}} request send request.
     * @returns {Promise<string>} the session id.
     */
    async function sendToAssistantSession({bridge, project, text}) {
      const sessionsService = bridge?.sessions;
      const remoteSession = bridge?.remoteSession;
      if (sessionsService === undefined || sessionsService === null || typeof sessionsService.create !== 'function') {
        throw new Error('会话服务不可用，请刷新页面后重试；若仍失败，请重启 DSH。');
      }
      if (remoteSession === undefined || remoteSession === null || typeof remoteSession.prompt !== 'function') {
        throw new Error('会话发送服务不可用，请刷新页面后重试；若仍失败，请重启 DSH。');
      }
      const previous = readStore(SESSION_KEY(project.id), '');
      const sessionId = await sessionsService.create({
        agentPreset: 'ai-database-assistant',
        ...(typeof previous === 'string' && previous !== '' ? {sessionId: previous} : {}),
      });
      writeStore(SESSION_KEY(project.id), sessionId);
      await post('project.bind', {projectId: project.id, sessionId});
      const requestId = `ai-database-assistant-${typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(16).slice(2)}`}`;
      const outcome = await remoteSession.prompt({
        requestId,
        sessionId,
        mode: 'queue',
        content: [{type: 'text', text}],
        clientTimeZone: timeZone(),
      });
      if (outcome?.ok !== true) throw new Error(outcome?.error?.message ?? '会话拒绝接收本次请求。');
      try {
        bridge?.uiWorkspace?.openSession?.(sessionId);
      } catch {
        bridge?.layout?.selectPanel?.('conversation');
      }
      return sessionId;
    }

    /**
     * Guided request form: several fields instead of one free-form box.
     *
     * @param {{overview: object, bridge?: object, reload?: Function}} props component props.
     * @returns {object} rendered card.
     */
    function AskForm({overview, bridge, reload}) {
      const project = overview.project;
      const storageKey = DRAFT_KEY(project.id);
      const [form, setForm] = useState(() => ({...EMPTY_REQUEST, ...readStore(storageKey, {})}));
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState(null);
      const [info, setInfo] = useState(null);
      const sources = overview.sources ?? [];

      const update = (patch) => setForm((current) => ({...current, ...patch}));
      const toggleConcern = (key) => setForm((current) => {
        const concerns = current.concerns ?? [];
        return {...current, concerns: concerns.includes(key) ? concerns.filter((entry) => entry !== key) : [...concerns, key]};
      });

      const send = async () => {
        if (busy) return;
        if (String(form.goal ?? '').trim() === '') {
          setError(new Error('请先填写「本次核对需求」。'));
          return;
        }
        setBusy(true);
        setError(null);
        setInfo(null);
        writeStore(storageKey, form);
        try {
          const text = composeRequest(overview, form);
          const sessionId = await sendToAssistantSession({bridge, project, text});
          setInfo(`已发送到会话 ${sessionId}，正在切换过去。`);
          await reload?.();
        } catch (failure) {
          setError(failure);
        } finally {
          setBusy(false);
        }
      };

      return e('section', {className: 'ita-group'},
        e('div', {className: 'ita-group-head'},
          e('span', {className: 'ita-group-index', 'aria-hidden': true}, '01'),
          e('h2', {className: 'ita-group-title'}, '向分析会话提问'),
        ),
        e('p', {className: 'ita-hint'}, '填好下面几项后点「发送到分析会话」：插件会自动用「AI 数据库助手」建会话、绑定当前项目，并把你的需求发过去。'),
        e(ErrorLine, {error}),
        e('div', {className: 'ita-grid'},
          e(Field, {label: '本次核对需求', required: true, wide: true},
            e('textarea', {
              className: 'ita-textarea',
              value: form.goal,
              placeholder: '例如：核对人事系统离职名单与 AD 账号，找出离职后仍然启用的账号',
              style: {minHeight: '78px'},
              onChange: (event) => update({goal: event.target.value}),
            }),
          ),
          e(Field, {label: '左侧数据源', hint: '可留空'},
            e(Select, {
              value: form.leftSourceId, placeholder: '不指定',
              options: sources.map((source) => ({value: source.id, label: source.name})),
              onChange: (leftSourceId) => update({leftSourceId}),
            }),
          ),
          e(Field, {label: '右侧数据源', hint: '可留空'},
            e(Select, {
              value: form.rightSourceId, placeholder: '不指定',
              options: sources.map((source) => ({value: source.id, label: source.name})),
              onChange: (rightSourceId) => update({rightSourceId}),
            }),
          ),
          e(Field, {label: '关联主键', hint: '例如 工号 ↔ user_id；多个用逗号分隔'},
            e(Input, {value: form.keyMapping, placeholder: '工号 ↔ user_id', onChange: (keyMapping) => update({keyMapping})}),
          ),
          e(Field, {label: '补充说明', hint: '例如 只看 2026 年数据；金额允许 0.01 误差'},
            e(Input, {value: form.note, placeholder: '可留空', onChange: (note) => update({note})}),
          ),
        ),
        e('div', {className: 'ita-field ita-field--wide'},
          e('span', {className: 'ita-label'}, '关注异常'),
          e('div', {className: 'ita-check-grid'},
            CONCERN_OPTIONS.map(([key, label]) => e('label', {key, className: 'ita-check-row'},
              e('input', {
                type: 'checkbox',
                className: 'ita-checkbox',
                checked: (form.concerns ?? []).includes(key),
                onChange: () => toggleConcern(key),
              }),
              e('span', {className: 'ita-check-text'}, label),
            )),
          ),
        ),
        e('div', {className: 'ita-actionbar'},
          e('div', {className: 'ita-actionbar-group'},
            Btn({children: busy ? e(Spinner) : '发送到分析会话', kind: 'primary', disabled: busy, onClick: send}),
            Btn({children: '清空', kind: 'ghost', disabled: busy, onClick: () => { setForm({...EMPTY_REQUEST}); writeStore(storageKey, EMPTY_REQUEST); setInfo(null); setError(null); }}),
          ),
          e('span', {className: 'ita-status'}, info === null ? '发送后会自动切换到该会话；核对结果仍由确定性引擎产生' : info),
        ),
      );
    }

    const DB_DIALECT_OPTIONS = Object.freeze([
      {value: 'mysql', label: 'MySQL'},
      {value: 'postgres', label: 'PostgreSQL'},
      {value: 'sqlserver', label: 'SQL Server'},
      {value: 'oracle', label: 'Oracle'},
      {value: 'sqlite', label: 'SQLite'},
    ]);

    const DB_FORM_DEFAULTS = Object.freeze({
      mysql: {port: '3306', label: 'MySQL', database: '数据库'},
      postgres: {port: '5432', label: 'PostgreSQL', database: '数据库'},
      sqlserver: {port: '1433', label: 'SQL Server', database: '数据库'},
      oracle: {port: '1521', label: 'Oracle', database: '服务名 / SID'},
      sqlite: {port: '', label: 'SQLite', database: '数据库文件路径'},
    });

    function blankDatabaseForm(dialect = 'mysql') {
      const info = DB_FORM_DEFAULTS[dialect] ?? DB_FORM_DEFAULTS.mysql;
      return {
        dialect,
        name: dialect === 'mysql' ? 'MySQL' : info.label,
        host: dialect === 'sqlite' ? '' : 'localhost',
        port: info.port,
        user: '',
        database: '',
        schema: '',
        file: '',
        passwordRef: '',
        password: '',
        rememberPassword: true,
        trustServerCertificate: false,
        command: '',
      };
    }

    function formatResultTime(value) {
      if (typeof value !== 'string' || value === '') return '';
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return value;
      const pad = (number) => String(number).padStart(2, '0');
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
    }

    function Page(props) {
      const [projectId, setProjectId] = useState(() => readStore(STORE_KEY, ''));
      const [explicitNoProject, setExplicitNoProject] = useState(false);
      const [settingsOpen, setSettingsOpen] = useState(false);
      const [busy, setBusy] = useState('');
      const [error, setError] = useState(null);
      const [notice, setNotice] = useState(null);
      const [, setLocaleTick] = useState(0);
      const localeService = props?.bridge?.locale;
      useEffect(() => {
        if (localeService === undefined || localeService === null || typeof localeService.subscribe !== 'function') return undefined;
        const readActive = () => {
          const snapshot = typeof localeService.getSnapshot === 'function' ? localeService.getSnapshot() : null;
          if (snapshot !== null && snapshot !== undefined) return normalizeLocale(snapshot.active);
          const current = localeService.current;
          return normalizeLocale(typeof current === 'function' ? current() : current);
        };
        activeLocale = readActive();
        try {
          return localeService.subscribe(() => {
            activeLocale = readActive();
            setLocaleTick((value) => value + 1);
          });
        } catch {
          return undefined;
        }
      }, [localeService]);
      const [goal, setGoal] = useState('');
      const [detail, setDetail] = useState(null);
      const [exportInfo, setExportInfo] = useState({});
      const [dirDraft, setDirDraft] = useState('');
      const [dbForm, setDbForm] = useState(() => blankDatabaseForm('mysql'));
      const [editingSourceId, setEditingSourceId] = useState(null);
      const [copyOpen, setCopyOpen] = useState(false);
      const [copyGroups, setCopyGroups] = useState(null);
      const [copyBusy, setCopyBusy] = useState('');
      const [copyLoading, setCopyLoading] = useState(false);
      const [openingResultId, setOpeningResultId] = useState(null);

      // Never call a hook conditionally. DSH may provide props.useSessions on
      // some renders only; calling it here shifted every later hook slot and
      // produced React #311 (blank panel) on project switch / session switch.
      // The workbench writes the binding when it creates or reuses a session.
      const storedSessionId = projectId === '' ? '' : readStore(SESSION_KEY(projectId), '');
      const sessionId = typeof storedSessionId === 'string' ? storedSessionId : '';

      const loader = useCallback(() => post('overview', {
        projectId: projectId || undefined,
        sessionId: sessionId || undefined,
        noProject: explicitNoProject,
      }), [projectId, sessionId, explicitNoProject]);
      const [state, reload] = useApiState(loader, [loader]);
      const overview = state.payload === null ? undefined : state.payload;
      const project = explicitNoProject ? null : (overview?.project ?? null);
      const switching = projectId !== '' && project !== null && project.id !== projectId;
      const databases = (overview?.sources ?? []).filter((source) => source.kind === 'database');
      const outputDir = overview?.assistant?.outputDir ?? '';
      // Host-computed hint (never auto-saved): the placeholder must describe the
      // machine that writes the files, not the browser's platform.
      const suggestedOutputDir = overview?.assistant?.suggestedOutputDir ?? '';
      const [resultPage, setResultPage] = useState(1);
      const [pageData, setPageData] = useState(null);
      const [resultsTick, setResultsTick] = useState(0);
      const pageResults = pageData?.items ?? overview?.assistant?.results ?? [];
      const totalResults = pageData?.total ?? (overview?.assistant?.results ?? []).length;

      useEffect(() => {
        if (project?.id === undefined) return undefined;
        setResultPage(1);
        setPageData(null);
        // A different project must not inherit the previous project's draft
        // question, directory, connection form, dialogs or errors.
        setGoal('');
        setDirDraft('');
        setDbForm(blankDatabaseForm('mysql'));
        setEditingSourceId(null);
        setSettingsOpen(false);
        setDetail(null);
        setError(null);
        setNotice(null);
        return undefined;
      }, [project?.id]);

      useEffect(() => {
        setDirDraft(outputDir);
      }, [project?.id, outputDir]);

      useEffect(() => {
        if (project?.id === undefined) return undefined;
        let alive = true;
        post('assistant.results', {projectId: project.id, page: resultPage, pageSize: 10})
          .then((page) => { if (alive) setPageData(page); })
          .catch((failure) => { if (alive) setError(failure); });
        return () => { alive = false; };
      }, [project?.id, resultPage, resultsTick]);

      useEffect(() => {
        if (project?.id !== undefined && project.id !== projectId) {
          setProjectId(project.id);
          setStoredProject(project.id);
        }
      }, [project?.id]);

      const act = async (label, action) => {
        setBusy(label); setError(null);
        try { await action(); await reload(); setResultsTick((tick) => tick + 1); } catch (failure) { setError(failure); } finally { setBusy(''); }
      };

      const refresh = (nextProjectId) => {
        if (nextProjectId === null || nextProjectId === '') {
          setProjectId('');
          setStoredProject(null);
          setExplicitNoProject(true);
          return;
        }
        setExplicitNoProject(false);
        setProjectId(nextProjectId);
        setStoredProject(nextProjectId);
      };

      const openCopyConnections = async () => {
        if (project === null) return;
        setCopyOpen(true); setCopyGroups(null); setCopyLoading(true); setError(null);
        try {
          setCopyGroups(await post('source.copy-candidates', {projectId: project.id}));
        } catch (failure) {
          // Keep null so the modal shows a retryable error, not a false
          // "no other projects" empty state.
          setCopyGroups(null);
          setError(failure);
        } finally {
          setCopyLoading(false);
        }
      };

      const copyConnection = async (group, source) => {
        setCopyBusy(source.sourceId); setError(null);
        try {
          const created = await post('source.copy', {
            projectId: project.id, fromProjectId: group.project.id, sourceId: source.sourceId,
          });
          await post('source.test', {projectId: project.id, sourceId: created.id}).catch(() => null);
          setCopyOpen(false);
          setNotice(`已复制数据库连接：${created.name}`);
          await reload();
        } catch (failure) {
          setError(failure);
        } finally {
          setCopyBusy('');
        }
      };

      const saveConnection = () => act('db-save', async () => {
        const typedPassword = typeof dbForm.password === 'string' && dbForm.password !== '';
        const typedRef = dbForm.passwordRef.trim();
        if (dbForm.dialect !== 'sqlite' && typedPassword && typedRef !== '') {
          throw new Error('密码与凭据引用只能二选一：要记住密码就清空引用名，要用已有引用就不填密码。');
        }
        let port;
        if (dbForm.dialect !== 'sqlite' && String(dbForm.port).trim() !== '') {
          port = Number(dbForm.port);
          if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('端口必须是 1-65535 之间的整数。');
        }
        const payload = {
          name: dbForm.name.trim() || DB_FORM_DEFAULTS[dbForm.dialect]?.label || '数据库',
          dialect: dbForm.dialect,
          host: dbForm.dialect === 'sqlite' ? undefined : dbForm.host,
          user: dbForm.dialect === 'sqlite' ? undefined : dbForm.user,
          database: dbForm.dialect === 'sqlite' ? undefined : dbForm.database,
          // Send '' (not undefined) so clearing a field actually clears the field on
          // the server; undefined would be dropped from the JSON body.
          schema: dbForm.dialect === 'sqlite' ? undefined : dbForm.schema.trim(),
          file: dbForm.dialect === 'sqlite' ? dbForm.file : undefined,
          passwordRef: dbForm.dialect === 'sqlite' ? undefined : typedRef,
          port,
          trustServerCertificate: dbForm.dialect === 'sqlserver' ? dbForm.trustServerCertificate === true : undefined,
          // '' clears an existing override on update; the server treats an
          // empty value as "use the client found on PATH".
          command: dbForm.command === undefined ? undefined : dbForm.command.trim(),
        };
        let sourceId = editingSourceId;
        let createdNow = false;
        if (sourceId === null) {
          const created = await post('source.create', {projectId: project.id, source: payload});
          sourceId = created.id;
          createdNow = true;
          // The source exists now. Switch the form to edit mode before saving
          // the password, so a later failure cannot turn a retry into a
          // duplicate "name already exists" create.
          setEditingSourceId(sourceId);
        } else {
          await post('source.update', {projectId: project.id, sourceId, patch: payload});
        }
        let remembered = false;
        if (dbForm.dialect !== 'sqlite' && typedPassword && dbForm.rememberPassword === true) {
          await post('source.password', {projectId: project.id, sourceId, password: dbForm.password});
          remembered = true;
        }
        let probe = null;
        let testFailure = null;
        try {
          probe = await post('source.test', {
            projectId: project.id, sourceId,
            ...(dbForm.dialect !== 'sqlite' && typedPassword && !remembered ? {password: dbForm.password} : {}),
          });
        } catch (failure) {
          testFailure = failure;
        }
        const base = createdNow ? '数据库连接已保存' : '数据库连接已更新';
        // source.test resolves even when the probe failed; a resolved
        // `{available:false,reason}` must not be reported as success.
        if (testFailure !== null || probe?.available !== true) {
          const reason = testFailure?.message ?? probe?.reason ?? '连接未通过测试';
          setNotice(null);
          setError(new Error(`${base}，但测试连接未通过：${reason}`));
          return;
        }
        setSettingsOpen(false);
        setEditingSourceId(null);
        setDbForm(blankDatabaseForm('mysql'));
        setNotice(dbForm.dialect !== 'sqlite' && typedPassword && !remembered
          ? '连接已保存，但本次密码未记住；后续查询需要改用 DSH 凭据引用。'
          : `${base}，并已通过测试连接。`);
      });

      const startEditConnection = (source) => {
        setEditingSourceId(source.id);
        setDbForm({
          dialect: source.dialect ?? 'mysql',
          name: source.name ?? '',
          host: source.host ?? 'localhost',
          port: source.port === undefined || source.port === null ? (DB_FORM_DEFAULTS[source.dialect]?.port ?? '') : String(source.port),
          user: source.user ?? '',
          database: source.database ?? '',
          schema: source.schema ?? '',
          file: source.file ?? '',
          passwordRef: source.passwordRef ?? '',
          password: '',
          rememberPassword: true,
          trustServerCertificate: source.trustServerCertificate === true,
          command: source.command ?? '',
        });
        setSettingsOpen(true);
        setError(null);
      };

      const deleteConnection = async (source) => {
        if (!window.confirm(tf('deleteConnection', {name: source.name, dialect: source.dialect}))) return;
        setBusy(`delete:${source.id}`); setError(null);
        try {
          await post('source.delete', {projectId: project.id, sourceId: source.id, confirm: true});
          setNotice(`已删除连接：${source.name}`);
          await reload();
        } catch (failure) {
          setError(failure);
        } finally {
          setBusy('');
        }
      };

      const send = async () => {
        if (busy !== '' || goal.trim() === '') return;
        setBusy('ask'); setError(null); setNotice(null);
        try {
          const text = `【项目】${project.name}\n【需求】${goal.trim()}\n\n请先用 db-info / db-schema 自行探索数据库，再编写并执行只读 SQL；口径不清时直接问我，不要猜。`;
          const created = await sendToAssistantSession({bridge: props?.bridge, project, text});
          setNotice(`已发送到会话 ${created}，正在切换过去；后续可在该会话继续追问。`);
          setGoal('');
        } catch (failure) {
          setError(failure);
        } finally {
          setBusy('');
        }
      };

      const openResult = async (resultId) => {
        if (openingResultId !== null) return;
        setOpeningResultId(resultId); setError(null);
        try { setDetail(await post('assistant.result', {projectId: project.id, resultId})); }
        catch (failure) { setError(failure); }
        finally { setOpeningResultId(null); }
      };

      const exportResult = (resultId, baseName) => act(`export:${resultId}`, async () => {
        const exported = await post('assistant.export', {projectId: project.id, resultId, baseName, formats: ['xlsx', 'csv', 'sql']});
        setExportInfo((previous) => ({...previous, [resultId]: exported}));
        setResultsTick((tick) => tick + 1);
      });

      if (state.loading && overview === undefined) {
        return e('div', {className: 'ita-page'}, e('style', null, CSS),
          e('div', {className: 'ita-wrap'}, e('p', {className: 'ita-hint'}, e(Spinner), ' ', t('common.loading'))));
      }

      return e('div', {className: 'ita-page'},
        e('style', null, CSS),
        e('div', {className: 'ita-wrap'},
          e('header', {className: 'ita-hero'},
            e('div', {className: 'ita-hero-main'},
              e('span', {className: 'ita-eyebrow'}, 'AI 数据库助手'),
              e('h1', {className: 'ita-title'}, '用自然语言查询与分析数据'),
              e('p', {className: 'ita-sub'}, '只读连接 MySQL / PostgreSQL / SQL Server / Oracle / SQLite；AI 自己查表、写 SQL、执行并解释结果。需要导出时生成 Excel、CSV 和最终 SQL。'),
            ),
            e('div', {className: 'ita-hero-side'},
              e('span', {className: 'ita-stage-pill'}, switching ? '正在切换项目…' : (project?.name ?? '未选择项目')),
              e('span', {className: 'ita-hero-note'}, `${totalResults} 条结果`),
            ),
          ),
          e(ErrorWithAsk, {error: state.error, project, bridge: props.bridge}),
          overview === undefined ? null : e('div', {className: 'ita-navcard'}, e(ProjectBar, {overview, projectId, onProjectChange: refresh, reload, refresh, notice, resultTotal: totalResults, bridge: props.bridge})),
          e(ErrorWithAsk, {error, project, bridge: props.bridge}),
          overview === undefined && state.error !== null
            ? e(Card, {title: '工作台加载失败', actions: Btn({children: '重试', kind: 'primary', onClick: () => reload()})},
                e('p', {className: 'ita-hint'}, '本地插件服务暂时没有返回数据。已有项目不会丢失；可直接重试，仍失败时请查看宿主日志。'))
            : switching
            ? e(Card, {title: '正在切换项目'}, e('p', {className: 'ita-hint'}, e(Spinner), ' 正在加载新项目的数据…'))
            : project === null
            ? e(Card, {title: '先建一个项目'}, e('p', {className: 'ita-hint'}, '项目保存数据库连接、保存目录和会话历史。点上方「新建项目」开始。'))
            : e('div', null,
              e(Card, {
                title: '数据库连接',
                actions: [
                  Btn({children: settingsOpen ? '收起设置' : '添加连接', kind: settingsOpen ? 'ghost' : 'primary', onClick: () => {
                    if (settingsOpen) {
                      setSettingsOpen(false);
                      setEditingSourceId(null);
                    } else {
                      setEditingSourceId(null);
                      setDbForm(blankDatabaseForm('mysql'));
                      setSettingsOpen(true);
                    }
                  }}),
                  Btn({children: '复制其他项目连接', kind: 'ghost', disabled: project === null, onClick: openCopyConnections}),
                  Btn({children: t('common.refresh'), kind: 'ghost', disabled: busy !== '', onClick: () => reload()}),
                ],
              },
                databases.length === 0
                  ? e('div', {className: 'ita-empty'}, '还没有数据库连接。点「添加连接」选择数据库类型（MySQL / PostgreSQL / SQL Server / Oracle / SQLite）。')
                  : e('div', {className: 'ita-list'}, databases.map((source) => e('div', {className: 'ita-item', key: source.id},
                      e('div', {className: 'ita-row', style: {justifyContent: 'space-between', alignItems: 'center'}},
                        e('div', {className: 'ita-row', style: {alignItems: 'center', gap: '8px'}},
                          e('div', {className: 'ita-db-icon', 'aria-hidden': true},
                            e('svg', {viewBox: '0 0 24 24', width: 17, height: 17, fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round'},
                              e('ellipse', {cx: 12, cy: 6, rx: 7, ry: 2.6}),
                              e('path', {d: 'M5 6v12c0 1.4 3.1 2.6 7 2.6s7-1.2 7-2.6V6'}),
                              e('path', {d: 'M5 12c0 1.4 3.1 2.6 7 2.6s7-1.2 7-2.6'}),
                            ),
                          ),
                          e('strong', null, source.name),
                          e('span', {className: 'ita-tag'}, DB_FORM_DEFAULTS[source.dialect]?.label ?? source.dialect),
                          source.status?.available === true ? e(Badge, {tone: 'ok'}, '可用') : source.status?.available === false ? e(Badge, {tone: 'bad'}, '不可用') : e(Badge, null, '未测试'),
                        ),
                        e('div', {className: 'ita-row'},
                          Btn({children: busy === `test:${source.id}` ? e(Spinner) : '测试连接', disabled: busy !== '', onClick: () => act(`test:${source.id}`, () => post('source.test', {projectId: project.id, sourceId: source.id}))}),
                          Btn({children: '编辑', kind: 'ghost', disabled: busy !== '', onClick: () => startEditConnection(source)}),
                          Btn({children: '删除连接', kind: 'danger', disabled: busy !== '', onClick: () => deleteConnection(source)}),
                        ),
                      ),
                      e('div', {className: 'ita-hint'}, source.dialect === 'sqlite' ? `${source.file ?? ''} · 只读文件` : `${source.host ?? ''}${source.port ? ':' + source.port : ''} · ${source.user ?? ''} · ${source.status?.enforcement ?? ''}`),
                      source.status?.available === false ? e('div', {className: 'ita-warn ita-warn-row'},
                        e('span', null, source.status.reason ?? '连接测试失败'),
                        e(AskAiButton, {error: new Error(source.status.reason ?? '连接测试失败'), project, bridge: props.bridge}),
                      ) : null,
                    ))),
                settingsOpen ? e('div', {className: 'ita-db-form'},
                  e('div', {className: 'ita-db-form-head'},
                    e('div', null,
                      e('strong', {className: 'ita-db-form-title'}, editingSourceId === null ? '新建数据库连接' : '编辑数据库连接'),
                      e('p', {className: 'ita-hint'}, '使用只读账号；密码保存在 DSH 凭据中，这里只填引用名。SQLite 以只读方式打开文件。'),
                    ),
                  ),
                  e('div', {className: 'ita-grid'},
                    e(Field, {label: '数据库类型'}, editingSourceId === null
                      ? e(Select, {
                          value: dbForm.dialect,
                          options: DB_DIALECT_OPTIONS,
                          onChange: (dialect) => {
                            const info = DB_FORM_DEFAULTS[dialect];
                            setDbForm({...dbForm, dialect, port: info.port, name: dbForm.name === DB_FORM_DEFAULTS[dbForm.dialect]?.label ? info.label : dbForm.name});
                          },
                        })
                      : e('div', {className: 'ita-hint'}, DB_FORM_DEFAULTS[dbForm.dialect]?.label ?? dbForm.dialect)),
                    e(Field, {label: '连接名称'}, e(Input, {value: dbForm.name, placeholder: '例如 生产库 / 本地 SQLite', onChange: (name) => setDbForm({...dbForm, name})})),
                    dbForm.dialect === 'sqlite' ? e(Field, {label: '数据库文件路径', wide: true, hint: '绝对路径；只会以只读方式打开，不会创建或修改文件'},
                      e('div', {className: 'ita-row'},
                        e(Input, {value: dbForm.file, placeholder: '本机绝对路径（按当前操作系统填写）', onChange: (file) => setDbForm({...dbForm, file})}),
                      ),
                    ) : null,
                    dbForm.dialect !== 'sqlite' ? e(Field, {label: '主机'}, e(Input, {value: dbForm.host, placeholder: 'localhost', onChange: (host) => setDbForm({...dbForm, host})})) : null,
                    dbForm.dialect !== 'sqlite' ? e(Field, {label: '端口'}, e(Input, {value: dbForm.port, placeholder: DB_FORM_DEFAULTS[dbForm.dialect]?.port ?? '3306', onChange: (port) => setDbForm({...dbForm, port})})) : null,
                    dbForm.dialect !== 'sqlite' ? e(Field, {label: '只读账号'}, e(Input, {value: dbForm.user, placeholder: 'readonly_user', onChange: (user) => setDbForm({...dbForm, user})})) : null,
                    dbForm.dialect !== 'sqlite' ? e(Field, {label: DB_FORM_DEFAULTS[dbForm.dialect]?.database ?? '数据库'}, e(Input, {value: dbForm.database, placeholder: dbForm.dialect === 'oracle' ? 'ORCLPDB1' : 'database', onChange: (database) => setDbForm({...dbForm, database})})) : null,
                    dbForm.dialect !== 'sqlite' && dbForm.dialect !== 'mysql' ? e(Field, {label: 'Schema', hint: '可选；Oracle/SQL Server/PostgreSQL 的默认 schema'}, e(Input, {value: dbForm.schema, placeholder: 'public / dbo', onChange: (schema) => setDbForm({...dbForm, schema})})) : null,
                    dbForm.dialect === 'sqlserver' ? e('label', {className: 'ita-check-row', style: {gridColumn: '1 / -1'}},
                      e('input', {type: 'checkbox', className: 'ita-checkbox', checked: dbForm.trustServerCertificate === true, onChange: (event) => setDbForm({...dbForm, trustServerCertificate: event.target.checked})}),
                      e('span', {className: 'ita-check-text'}, '信任服务器证书（仅用于自签名测试环境；默认关闭）'),
                    ) : null,
                    dbForm.dialect !== 'sqlite' ? e(Field, {label: '密码', hint: '仅用于本次保存，不会写入配置或日志'}, e(Input, {type: 'password', value: dbForm.password, placeholder: '可选；留空则使用凭据引用', onChange: (password) => setDbForm({...dbForm, password})})) : null,
                    dbForm.dialect !== 'sqlite' ? e(Field, {label: '凭据引用', hint: '只能使用字母、数字、下划线，且以字母或下划线开头；与上方密码二选一'}, e(Input, {value: dbForm.passwordRef, placeholder: 'app_db', onChange: (passwordRef) => setDbForm({...dbForm, passwordRef})})) : null,
                    dbForm.dialect !== 'sqlite' ? e('label', {className: 'ita-check-row', style: {alignSelf: 'end', paddingBottom: '8px'}},
                      e('input', {type: 'checkbox', className: 'ita-checkbox', checked: dbForm.rememberPassword !== false, onChange: (event) => setDbForm({...dbForm, rememberPassword: event.target.checked})}),
                      e('span', {className: 'ita-check-text'}, '记住密码（保存到 DSH 凭据）'),
                    ) : null,
                    dbForm.dialect === 'mysql' ? e(Field, {label: '客户端可执行文件', wide: true, hint: '可选；留空则自动从系统 PATH 查找。填写本机 MySQL 客户端可执行文件的绝对路径。'},
                      e(Input, {value: dbForm.command ?? '', placeholder: '本机 MySQL 客户端可执行文件的绝对路径', onChange: (command) => setDbForm({...dbForm, command})}),
                    ) : null,
                  ),
                  e('div', {className: 'ita-db-form-foot'},
                    editingSourceId === null ? null : Btn({children: '取消编辑', kind: 'ghost', onClick: () => { setEditingSourceId(null); setSettingsOpen(false); setDbForm(blankDatabaseForm('mysql')); }}),
                    Btn({children: busy === 'db-save' ? e(Spinner) : (editingSourceId === null ? '保存并测试' : '更新并测试'), kind: 'primary', disabled: busy !== '', onClick: saveConnection}),
                  ),
                ) : null,
              ),
              e(Card, {title: '交付设置', actions: outputDir === '' ? null : e(Badge, {tone: 'ok'}, '已授权目录')},
                e('div', {className: 'ita-dir'},
                  e('div', {className: 'ita-dir-icon', 'aria-hidden': true},
                    e('svg', {viewBox: '0 0 24 24', width: 20, height: 20, fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round'},
                      e('path', {d: 'M3.5 7.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z'}),
                      e('path', {d: 'M3.8 10.5h16.4'}),
                    ),
                  ),
                  e('div', {className: 'ita-dir-main'},
                    e('div', {className: 'ita-dir-head'},
                      e('span', {className: 'ita-dir-title'}, '结果保存目录'),
                      e('span', {className: 'ita-hint'}, 'Excel、CSV、SQL 只会写入这里'),
                    ),
                    e('div', {className: 'ita-dir-row'},
                      e(Input, {value: dirDraft, placeholder: outputDir || suggestedOutputDir || '本机绝对路径（按当前操作系统填写）', onChange: setDirDraft, 'aria-label': '结果保存目录'}),
                      e('div', {className: 'ita-dir-actions'},
                        Btn({children: '选择目录', disabled: busy !== '', onClick: async () => {
                          setError(null);
                          try {
                            const picked = await props?.bridge?.pickDirectory?.();
                            if (typeof picked === 'string' && picked !== '') {
                              setDirDraft(picked);
                              const saved = await post('assistant.set-output', {projectId: project.id, directory: picked});
                              setDirDraft(saved.outputDir);
                              setNotice(`保存目录：${saved.outputDir}`);
                              await reload();
                            }
                          } catch (failure) {
                            setError(failure);
                          }
                        }}),
                        Btn({children: busy === 'dir' ? e(Spinner) : '保存目录', kind: 'primary', disabled: busy !== '', onClick: () => act('dir', async () => {
                          const saved = await post('assistant.set-output', {projectId: project.id, directory: dirDraft === '' ? outputDir : dirDraft});
                          setDirDraft(saved.outputDir);
                          setNotice(`保存目录：${saved.outputDir}`);
                        })}),
                      ),
                    ),
                  ),
                ),
              ),
              e(Card, {title: '问 AI'},
                e('div', {className: 'ita-ask'},
                  e('p', {className: 'ita-hint'}, '直接用自然语言描述你要的数据。AI 会自己查表、写并执行只读 SQL；不清楚时会反问你，可继续补充或修改。'),
                  e('textarea', {
                    className: 'ita-textarea', value: goal,
                    placeholder: '例如：统计 2026 年各数据库备份失败的次数，按失败次数从高到低排序',
                    onChange: (event) => setGoal(event.target.value),
                    onKeyDown: (event) => {
                      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && busy === '' && goal.trim() !== '') {
                        event.preventDefault();
                        send();
                      }
                    },
                  }),
                  e('div', {className: 'ita-ask-foot'},
                    e('span', {className: 'ita-kbd'},
                      e('kbd', null, '⌘'), ' / ', e('kbd', null, 'Ctrl'), ' + ', e('kbd', null, 'Enter'), ' 发送',
                    ),
                    Btn({children: busy === 'ask' ? e(Spinner) : '发送', kind: 'primary', disabled: busy !== '' || goal.trim() === '', onClick: send}),
                  ),
                ),
              ),
              e(Card, {title: '查询结果', actions: [
                Btn({children: busy === 'clear' ? e(Spinner) : '清理历史结果', kind: 'danger', disabled: busy !== '' || totalResults === 0, onClick: async () => {
                  if (!window.confirm(tf('clearResults', {keep: 10}))) return;
                  setBusy('clear'); setError(null);
                  try {
                    const cleanup = await post('assistant.clear-results', {projectId: project.id, keep: 10, confirm: true});
                    setNotice(`已清理 ${cleanup.removed} 个历史快照，保留 ${cleanup.kept} 个；导出的文件未受影响。`);
                    setResultPage(1);
                    setResultsTick((tick) => tick + 1);
                    await reload();
                  } catch (failure) { setError(failure); } finally { setBusy(''); }
                }}),
              ]},
                e(ErrorLine, {error}),
                pageResults.length === 0 ? e('div', {className: 'ita-empty'}, '还没有结果。向 AI 提问并执行查询后，这里会列出可查看与导出的结果。')
                  : e('div', {className: 'ita-list'}, pageResults.map((item) => e('div', {className: 'ita-result', key: item.resultId},
                    e('div', {className: 'ita-result-main'},
                      e('div', {className: 'ita-result-head'},
                        e('strong', {className: 'ita-result-title'}, item.baseName || item.purpose || item.resultId),
                        item.complete ? e(Badge, {tone: 'ok'}, '完整') : e(Badge, {tone: 'bad'}, '不完整'),
                        item.exported ? e('span', {className: 'ita-result-exported'}, '已导出') : null,
                      ),
                      e('div', {className: 'ita-result-meta'},
                        e('span', {className: 'ita-mono'}, item.resultId),
                        e('span', {className: 'ita-sep'}, '·'),
                        e('span', null, `${item.rowCount} 行`),
                        e('span', {className: 'ita-sep'}, '·'),
                        e('span', null, `${item.elapsedMs} ms`),
                        e('span', {className: 'ita-sep'}, '·'),
                        e('span', null, formatResultTime(item.createdAt)),
                      ),
                      (() => {
                        const record = exportInfo[item.resultId] ?? item.exported;
                        if (record === null || record === undefined) return null;
                        const names = (record.files ?? []).map((file) => (typeof file === 'string' ? file : file.name));
                        return e('div', {className: 'ita-result-export'}, `已导出到 ${record.directory ?? ''}${names.length ? `：${names.join('、')}` : ''}`);
                      })(),
                    ),
                    e('div', {className: 'ita-result-actions'},
                      Btn({children: openingResultId === item.resultId ? e(Spinner) : '查看', kind: 'ghost', disabled: busy !== '' || openingResultId !== null, onClick: () => openResult(item.resultId)}),
                      Btn({children: busy === `export:${item.resultId}` ? e(Spinner) : '导出', kind: 'primary', title: '导出 Excel、CSV、SQL 三个文件', disabled: busy !== '' || item.complete !== true, onClick: () => exportResult(item.resultId, item.baseName)}),
                      e('span', {className: 'ita-result-formats'}, 'Excel · CSV · SQL'),
                    ),
                  ))),
                pageData === null || pageData.pageCount <= 1 ? null : e('div', {className: 'ita-pager'},
                  e('span', {className: 'ita-hint'}, `第 ${pageData.page} / ${pageData.pageCount} 页 · 共 ${pageData.total} 条`),
                  e('div', {className: 'ita-row'},
                    Btn({children: '上一页', kind: 'ghost', disabled: pageData.page <= 1, onClick: () => setResultPage((page) => Math.max(1, page - 1))}),
                    Btn({children: '下一页', kind: 'ghost', disabled: pageData.page >= pageData.pageCount, onClick: () => setResultPage((page) => page + 1)}),
                  ),
                ),
              ),
            ),
          copyOpen ? e(Modal, {title: '复制其他项目的数据库连接', size: 'md', onClose: () => setCopyOpen(false)},
            e('p', {className: 'ita-hint'}, '只复制连接配置（主机、端口、账号、库名、凭据引用），不复制查询结果、会话和保存目录。'),
            e(ErrorLine, {error}),
            copyLoading
              ? e('p', {className: 'ita-hint'}, e(Spinner), ' 正在读取其他项目的连接…')
              : copyGroups === null
                ? e('div', {className: 'ita-empty'}, '读取失败，请重试。', Btn({children: '重试', kind: 'primary', onClick: openCopyConnections}))
              : copyGroups.length === 0
                ? e('div', {className: 'ita-empty'}, '没有其他项目可复制的数据库连接。')
                : e('div', {className: 'ita-list'}, copyGroups.map((group) => e('div', {key: group.project.id},
                    e('div', {className: 'ita-copy-project'}, group.project.name),
                    e('div', {className: 'ita-list'}, group.sources.map((source) => e('div', {className: 'ita-item', key: source.sourceId},
                      e('div', {className: 'ita-copy-item'},
                        e('div', {className: 'ita-copy-main'},
                          e('span', {className: 'ita-copy-name'}, source.name),
                          e('span', {className: 'ita-hint'}, source.file ? `${source.file} · 只读文件` : `${source.host}${source.port ? `:${source.port}` : ''} · ${source.user} · ${source.database}`),
                          e('span', {className: 'ita-hint'}, source.passwordRef === '' ? '未设置凭据引用' : '凭据引用已配置'),
                        ),
                        Btn({children: copyBusy === source.sourceId ? e(Spinner) : '复制', kind: 'primary', disabled: copyBusy !== '', onClick: () => copyConnection(group, source)}),
                      ),
                    ))),
                  ))),
          ) : null,
          detail === null ? null : e(Modal, {title: `查询结果 ${detail.resultId}`, onClose: () => setDetail(null)},
            e('div', {className: 'ita-hint'}, `${detail.rowCount} 行 · 完整性：${detail.complete ? '完整' : '不完整'} · ${detail.elapsedMs} ms · ${detail.consistency?.level ?? ''}`),
            e('div', {className: 'ita-row', style: {flexWrap: 'wrap', gap: '6px', margin: '8px 0'}}, (detail.columns ?? []).map((name, index) => e('span', {className: 'ita-chip', key: `${name}-${index}`, raw: true}, name))),
            detail.cleared === true
              ? e('div', {className: 'ita-empty'}, '该结果的数据快照已清理，不能再查看预览或导出；SQL 仍保留在下方。')
              : e('div', {className: 'ita-scroll', style: {maxHeight: '320px'}},
                  e('table', {className: 'ita-table'},
                    e('thead', null, e('tr', null, (detail.columns ?? []).map((name, index) => e('th', {key: `${name}-${index}`, raw: true}, name)))),
                    e('tbody', null, (detail.preview ?? []).slice(0, 20).map((row, index) => e('tr', {key: index}, (detail.columns ?? []).map((name, columnIndex) => e('td', {key: `${name}-${columnIndex}`}, row[name] === null ? 'NULL' : String(row[name])))))),
                  ),
                ),
            e('p', {className: 'ita-hint'}, detail.cleared === true
              ? '数据快照已清理；不能导出，但仍可查看当时执行的 SQL。'
              : detail.complete === true
                ? '仅预览前 20 行；导出使用完整结果。'
                : '本次结果不完整（达到行数或字节上限），不能导出；请缩小范围或先聚合再重试。'),
            e('pre', {className: 'ita-pre'}, detail.sql),
          ),
        ),
      );
    }

    function buildRuleFromMapping(overview, mapping) {
      const sources = overview.sources ?? [];
      const left = sources.find((source) => source.id === mapping.leftSourceId);
      const right = sources.find((source) => source.id === mapping.rightSourceId);
      const datasetOf = (source, table) => source?.kind === 'file' ? {kind: 'file', fileId: source.fileId} : {kind: 'table', table};
      return {
        ...blankRule(),
        name: `${left?.name ?? '左侧'}${mapping.leftTable ? ` · ${mapping.leftTable}` : ''} 与 ${right?.name ?? '右侧'}${mapping.rightTable ? ` · ${mapping.rightTable}` : ''} 核对`,
        kind: mapping.fieldLeft === '' ? 'missing' : 'match',
        left: {sourceId: mapping.leftSourceId, dataset: datasetOf(left, mapping.leftTable)},
        right: {sourceId: mapping.rightSourceId, dataset: datasetOf(right, mapping.rightTable)},
        key: {pairs: [{left: mapping.keyLeft, right: mapping.keyRight}]},
        fields: mapping.fieldLeft === '' ? [] : [{left: mapping.fieldLeft, right: mapping.fieldRight || mapping.fieldLeft, type: 'text', label: `${mapping.fieldLeft} 与 ${mapping.fieldRight || mapping.fieldLeft}`}],
        options: {caseInsensitive: true, trim: true, nullEquals: 'equal'},
      };
    }

    function WorkbenchIcon(props) {
      const size = typeof props?.size === 'number' && props.size > 0 ? props.size : 16;
      return e('svg', {viewBox: '0 0 24 24', width: size, height: size, 'aria-hidden': true, style: {display: 'block'}},
        e('ellipse', {cx: 8.6, cy: 6.2, rx: 4.8, ry: 2.1, fill: 'none', stroke: 'currentColor', strokeWidth: 1.6}),
        e('path', {d: 'M3.8 6.2v11c0 1.16 2.15 2.1 4.8 2.1s4.8-.94 4.8-2.1V6.2', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round'}),
        e('path', {d: 'M3.8 11.2c0 1.16 2.15 2.1 4.8 2.1s4.8-.94 4.8-2.1', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round'}),
        e('path', {d: 'm14.6 14.4 1.9 1.9 3.5-4.2', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round'}),
      );
    }

    /* ------------------------------------------------------------------ */
    /* Cordis plugin                                                       */
    /* ------------------------------------------------------------------ */

    /**
     * Last-resort boundary: a plugin render error must not leave the host with a
     * blank white panel. DSH may not provide a boundary for plugin slots.
     */
    class PageBoundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = {error: null, nonce: 0};
        this.retry = this.retry.bind(this);
      }

      static getDerivedStateFromError(error) {
        return {error};
      }

      componentDidCatch(error, info) {
        try { console.error('[ai-database-assistant] render error', error, info); } catch { /* ignore */ }
      }

      retry() {
        this.setState((previous) => ({error: null, nonce: previous.nonce + 1}));
      }

      render() {
        if (this.state.error !== null) {
          const message = String(this.state.error?.message ?? this.state.error);
          const stack = String(this.state.error?.stack ?? '');
          return e('div', {className: 'ita-page'},
            e('style', null, CSS),
            e('div', {className: 'ita-wrap'},
              e(Card, {title: tr('页面渲染出错')},
                e('p', {className: 'ita-hint'}, tr('插件界面遇到一个错误，数据不会被修改。可以先点重试；若重复出现，请把下面的错误信息发给 AI 排查。')),
                e('pre', {style: {whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 11, lineHeight: '16px', maxHeight: 240, overflow: 'auto', margin: 0}}, message),
                stack === '' || stack === message ? null : e('details', null,
                  e('summary', {className: 'ita-hint'}, tr('错误详情')),
                  e('pre', {style: {whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 10, lineHeight: '15px', maxHeight: 260, overflow: 'auto', margin: '8px 0 0'}}, stack),
                ),
                e('div', {className: 'ita-row'}, Btn({children: tr('重试'), kind: 'primary', onClick: this.retry})),
              ),
            ),
          );
        }
        return h(React.Fragment, {key: this.state.nonce}, this.props.children);
      }
    }

    function PageGuarded(props) {
      return e(PageBoundary, null, e(Page, props));
    }

    function detectLocale(ctx) {
      try {
        const service = ctx?.locale ?? (typeof ctx?.get === 'function' ? ctx.get('locale') : undefined);
        const snapshot = typeof service?.getSnapshot === 'function' ? service.getSnapshot() : null;
        if (snapshot !== null && snapshot !== undefined && typeof snapshot.active === 'string') {
          return normalizeLocale(snapshot.active);
        }
        const current = typeof service?.current === 'function' ? service.current() : service?.current;
        if (typeof current === 'string') return normalizeLocale(current);
        if (current !== null && typeof current === 'object' && typeof current.active === 'string') {
          return normalizeLocale(current.active);
        }
        const language = typeof service?.language === 'function' ? service.language() : service?.language;
        if (typeof language === 'string') return normalizeLocale(language);
      } catch { /* default to Simplified Chinese */ }
      return 'zh';
    }

    function apply(ctx) {
      activeLocale = detectLocale(ctx);
      try {
        ctx.effect(() => ctx.locale.register(NS, {zh: DICT.zh, en: DICT.en, 'zh-TW': DICT['zh-TW']}), 'ai-database-assistant: locale dictionaries');
      } catch { /* dictionaries are optional; t() falls back */ }
      try {
        ctx.effect(() => {
          // Expose Traditional Chinese in DSH's own language menu. DSH has no
          // zh-TW entry by default; addLanguage registers it natively with a
          // Simplified fallback so the rest of the host still renders.
          const locale = ctx.get('locale') ?? ctx.locale;
          if (locale === undefined || locale === null || typeof locale.addLanguage !== 'function') return undefined;
          const disposers = [];
          for (const language of [
            {id: 'zh-TW', label: '繁體中文', fallback: 'zh'},
            {id: 'ko', label: '한국어', fallback: 'en'},
          ]) {
            try {
              const dispose = locale.addLanguage(language);
              if (typeof dispose === 'function') disposers.push(dispose);
            } catch {
              // already registered by the host or a previous plugin load
            }
          }
          return () => { for (const dispose of disposers) { try { dispose(); } catch { /* ignore */ } } };
        }, 'ai-database-assistant: extra languages');
      } catch { /* language registration is optional */ }
      try {
        ctx.effect(() => {
          const locale = ctx.get('locale') ?? ctx.locale;
          if (locale === undefined || locale === null || typeof locale.subscribe !== 'function') return undefined;
          // DSH's locale listeners are notified without an argument; read the
          // current snapshot instead of relying on a callback parameter.
          const readActive = () => {
            const snapshot = typeof locale.getSnapshot === 'function' ? locale.getSnapshot() : null;
            if (snapshot !== null && snapshot !== undefined) return normalizeLocale(snapshot.active);
            const current = locale.current;
            return normalizeLocale(typeof current === 'function' ? current() : current);
          };
          activeLocale = readActive();
          return locale.subscribe(() => { activeLocale = readActive(); });
        }, 'ai-database-assistant: locale subscription');
      } catch { /* locale subscription is optional */ }

      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: 6.5,
        // Re-evaluate the label when the DSH locale changes; without this the
        // sidebar kept the previous language until a full page reload.
        locale: NS,
        label: () => { activeLocale = detectLocale(ctx); return t('panel.label'); },
      }, WorkbenchIcon));

      // Client services used by the in-workbench composer: create a session
      // with the analysis preset, prompt the session, and navigate to the session.
      const uiWorkspaceService = getService(ctx, 'uiWorkspace');
      const bridge = {
        sessions: getService(ctx, 'sessions'),
        remoteSession: getService(ctx, 'remote.session'),
        uiWorkspace: uiWorkspaceService,
        layout: getService(ctx, 'layout'),
        locale: getService(ctx, 'locale'),
        // Native Desktop chooser when present, otherwise the workspace's own
        // directory picker (browse dialog). Never a free-form write capability.
        pickDirectory: async () => {
          const desktop = globalThis.__DSH_DIRECTORY_PICKER__;
          if (desktop !== undefined && typeof desktop.pick === 'function') return desktop.pick();
          if (uiWorkspaceService !== undefined && typeof uiWorkspaceService.pickDirectory === 'function') return uiWorkspaceService.pickDirectory();
          throw new Error('当前环境不支持目录选择，请手动输入本机绝对路径。');
        },
      };

      ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main',
        key: PANEL_ID,
        inject: () => ({bridge}),
      }, PageGuarded));

      // Invisible: keeps the hosting session bound to the selected project.
      ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
        name: 'conversation.input.right',
        id: 'ai-database-assistant-bind',
        order: 30,
      }, AutoBinder));
    }

    return {
      // Declared so `ctx.get(...)` resolves the services the workbench composer
      // uses; all of them are shipped client services of this DSH version.
      inject: ['slots', 'locale', 'sessions', 'remote', 'remote.session', 'uiWorkspace', 'workspaces', 'layout'],
      apply,
    };
  },
});
