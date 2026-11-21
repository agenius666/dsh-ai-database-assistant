# AI Database Assistant (DSH Plugin)

**Query databases using natural language, with AI-assisted data exploration, analysis, and export.**

**English** | [简体中文](README.zh-CN.md)

AI Database Assistant is a database analysis plugin for DeepSeek Harness (DSH). Describe your requirements in natural language and let AI explore database schemas, generate and execute read-only SQL queries, explain query results, and export data to XLSX, CSV, and SQL files.

The plugin supports **MySQL, PostgreSQL, SQL Server, Oracle, and SQLite**.

> **Current version:** 1.0.3  
> **Supported platforms:** Windows and macOS  
> **Runtime:** DeepSeek Harness (DSH)  
> **Node.js:** 22 or later  
> **Database access:** Read-only queries; database write operations are not supported.

This project is a DSH plugin, not a standalone database client. Linux is not currently an officially supported platform.

---

## Key Features

### Natural-Language Queries

You do not need to write SQL in advance. Simply describe your analysis requirements in everyday language, for example:

- "Count database backup failures during the previous month."
- "Find system accounts that remain enabled after the associated employees have left."
- "Summarize order counts and sales amounts by month."

AI can use the database schemas accessible within the current project to help generate, execute, and explain queries.

### Automatic Database Exploration

AI can use the plugin's tools to inspect database tables, columns, and other structural information before constructing queries based on your requirements.

When business definitions are unclear, such as date ranges, status definitions, or calculation methods, AI can ask follow-up questions to clarify the query conditions.

### Query Result Management

Each final query can be saved as an individual result. You can review:

- The SQL statement actually executed
- Query results and a preview of the first 20 rows
- Row counts and column information
- Query execution time
- Result completeness status

Historical query results remain available within the project for subsequent analysis and review.

### XLSX, CSV, and SQL Export

A single complete query result can be exported into three file formats:

| Format | Purpose |
|---|---|
| XLSX | Analysis, organization, and delivery using Excel |
| CSV | Data exchange and import into other systems |
| SQL | Preservation of the executed query for review or re-execution |

The SQL file contains the executed query statement, not a complete snapshot of the underlying database data. Re-executing the query may produce different results if the database contents, permissions, or environment have changed.

### AI-Assisted Troubleshooting

When a connection or operation fails, use the **Ask AI** option beside the error message to bring relevant project context and error information into a conversation for AI-assisted troubleshooting.

### Multilingual Interface

The plugin follows the language settings of DSH and provides an interface in **10 languages**:

- Simplified Chinese (简体中文)
- Traditional Chinese (繁體中文)
- English
- Japanese (日本語)
- Korean (한국어)
- Spanish (Español)
- French (Français)
- German (Deutsch)
- Russian (Русский)
- Portuguese (Português)

### Read-Only Queries and Safety Controls

The plugin provides read-only SQL validation and query resource limits, including:

- Restrictions on SQL statements that modify data
- Query execution time limits
- Result row count and output size limits
- Detection of incomplete or truncated results
- Prevention of exports from incomplete results
- Restrictions on file exports to user-authorized directories

**Always use a dedicated database account with the minimum necessary read-only permissions.** Application-level SQL validation is not a substitute for database-enforced permissions.

---

## How It Works

AI Database Assistant operates through DSH conversations and the plugin workspace.

1. Create a project and configure database connections in the workspace.
2. Ask a question from the workspace or use an AI Database Assistant conversation associated with the project.
3. AI explores accessible tables and columns based on your request.
4. AI generates and executes read-only SQL that complies with the plugin's restrictions.
5. The plugin saves the final query result and related metadata.
6. Review the result and export complete data when needed.

When you start a question from the workspace, the plugin automatically creates or switches to the appropriate assistant conversation and associates it with the current project.

If you create an AI Database Assistant conversation manually, select the relevant project in the left workspace before asking questions.

---

## Use Cases

| Use Case | Example |
|---|---|
| Operations analysis | Analyze business metrics by month, region, or channel |
| Financial analysis | Summarize revenue, costs, expenses, and transaction details |
| Data reconciliation | Compare records across database tables or systems |
| IT auditing | Examine account permissions, operation logs, and anomalies |
| Troubleshooting | Analyze task execution states, error logs, and failures |
| Data exploration | Understand the structure and contents of unfamiliar databases |
| Result delivery | Export Excel data and reproducible SQL query statements |

---

## Installation

### Option 1: Install Through DSH (Recommended)

In DeepSeek Harness, open:

**Plugins → Add plugin**

Enter the npm package name:

```text
@agenius/dsh-ai-database-assistant
```

Follow the instructions to install and enable the plugin, then restart DSH.

Once installed, **AI Database Assistant** appears in the left sidebar and becomes available as an assistant preset when creating a new conversation.

### Option 2: Install Using npm

```bash
npm install @agenius/dsh-ai-database-assistant
```

This command installs the npm package and its runtime dependencies, including the `tedious` driver used for SQL Server.

**Installing the package with npm does not automatically register it as a DSH plugin.** You must still add and enable the plugin through the DSH plugin management interface.

### Option 3: Install From a Local ZIP or Source Directory

If you downloaded a source ZIP or are using a local source directory, extract the files and install the runtime dependencies inside the plugin directory:

```bash
cd /path/to/dsh-ai-database-assistant
npm ci --omit=dev
```

If the source directory does not contain `package-lock.json`, use:

```bash
npm install --omit=dev
```

Then select the local directory through **Plugins → Add plugin** and enable the plugin.

**Note:** Source ZIP archives do not include `node_modules`. Missing runtime dependencies may prevent database drivers from loading, including the `tedious` driver required for SQL Server.

For more information, see the [Installation Guide](docs/INSTALL.md).

---

## System Requirements

| Component | Requirement |
|---|---|
| Operating system | Windows or macOS |
| DSH version | 0.2.2-rc.1 or later |
| Node.js | 22 or later |
| Database connectivity | Access to the target database with appropriate read permissions |
| External clients | Required according to the selected database engine |

In verified Windows and macOS DSH Host environments, Node.js version 24.21.0 was available, typically without requiring a separate installation.

### Supported Databases

| Database | Connection Method | Default Port | Query Restrictions |
|---|---|---|---|
| MySQL | `mysql` command-line client | 3306 | Session read-only mode |
| PostgreSQL | `psql` command-line client | 5432 | Read-only transactions |
| SQL Server | Built-in `tedious` native TDS driver | 1433 | Read-only SQL validation |
| Oracle | `sqlplus` command-line client | 1521 | SQL and client-command validation |
| SQLite | `sqlite3` command-line client | — | Read-only opening and statement validation |

**SQL Server does not require `sqlcmd`.** The plugin uses the `tedious@20.3.9` runtime dependency for native TDS connections.

MySQL, PostgreSQL, Oracle, and SQLite require their corresponding command-line clients. These clients must be executable from the system PATH or explicitly configured using the full executable path in the data source settings.

Windows may not include `sqlite3` by default. Install the SQLite command-line client before using SQLite connections.

For databases using older MySQL authentication plugins, a newer MySQL client may return `ERROR 2059`. Consider using a compatible client version, such as MySQL 8.4, and review the database account's authentication settings.

For connection requirements and known limitations, see [Database Support](docs/DATABASES.md).

---

## Quick Start

### 1. Create a Project

Open AI Database Assistant from the DSH sidebar and create a new project.

Projects organize database connections, query results, and export settings.

### 2. Add a Database Connection

Select the database engine and enter the required connection details, such as:

- Host and port
- Database name
- Username
- Password or DSH credential reference
- Client executable path, when required

### 3. Test the Connection

Click **Save and Test**.

A data source can be used for queries only after its connection test succeeds.

### 4. Configure an Export Directory

In the project's delivery settings, select and authorize a directory for exported files.

The plugin allows exports only to the designated authorized directory.

### 5. Ask a Question in Natural Language

For example:

> Summarize monthly order counts and sales revenue for 2026, sorted by month in ascending order.

Or:

> Find employees who have left the company but still have active system accounts.

You can also request data reconciliation:

> Compare employee IDs in these two tables and list records that exist in only one table.

AI uses accessible database schema information to construct queries and may ask for clarification when business definitions are ambiguous.

### 6. Review Query Results

After execution, you can review:

- Query columns and returned data
- A preview of the first 20 rows
- The complete row count
- The executed SQL
- Query execution time
- Result completeness

### 7. Export Results

Click **Export** to generate:

- `.xlsx`
- `.csv`
- `.sql`

All three files are produced from the same saved complete query result.

Exports are rejected when results are incomplete, the saved data has been cleaned up, or no valid authorized export directory is configured.

---

## Data Export Details

### XLSX

Contains query data and related query information, suitable for viewing, analyzing, and organizing in Excel.

### CSV

Uses UTF-8 encoding for data exchange and importing into other systems.

The plugin applies safety handling to common prefixes that spreadsheet applications may interpret as formulas.

### SQL

Contains the read-only SQL statement actually executed, allowing review or re-execution.

Unlike XLSX and CSV, SQL exports do not contain the complete result dataset.

### Export Restrictions

- Existing files with the same name are not overwritten by default.
- Overwriting an existing file requires explicit confirmation.
- Incomplete or truncated results cannot be exported.
- Data snapshots that have been cleaned up cannot be exported again.
- Files can only be written to authorized export directories.

---

## Data and Security

### Database Permissions

The plugin is designed for read-only queries and does not provide database writes, DDL operations, or stored procedure execution.

Use dedicated read-only database accounts and follow the principle of least privilege.

### Credential Management

Connection configurations do not directly store plaintext passwords.

Database credentials can be managed through the DSH credential system or provided temporarily as needed.

Do not include real passwords in chat messages, SQL text, or publicly shared logs.

### AI and Data Processing

AI may need access to database schema information, query results, and user-provided business questions to perform analysis.

This information may be included in the model context. The specific data handling behavior depends on the DSH model configuration and the selected model provider.

**Before processing sensitive, personal, or regulated data, review your model configuration, the provider's data handling policies, and your organization's security requirements.**

### Untrusted Database Content

Database table names, column names, comments, and stored data must be treated as untrusted input.

Although the plugin restricts SQL execution, AI-generated analysis should still be reviewed by users against actual business requirements.

### Query and File Protection

The plugin limits query duration, result row counts, and output size. Results exceeding these limits are marked as incomplete and cannot be exported as complete datasets.

Export directories are subject to path and file-operation restrictions. Existing files are not overwritten by default.

---

## Frequently Asked Questions

### What should I do if a connection test fails?

Check the database client, network connectivity, host and port, credentials, and the account's read permissions.

Saving a connection configuration does not mean the connection has succeeded. The connection test must complete successfully before querying.

### Why does the plugin say the database is not connected?

Open the current project's data source settings and click **Save and Test**. Run the query after the test succeeds.

### Why is my result marked as incomplete?

The query may have exceeded row count or output size limits, or the database client's output may have been truncated.

Try narrowing the query range, adding filters, or aggregating the data before retrieving detailed records.

### Why can't I export the results?

Common reasons include:

- The query result is incomplete.
- The saved result data has been cleaned up.
- No valid export directory has been configured.
- The current project does not meet the required export conditions or permissions.

### Does SQL Server require sqlcmd?

No.

SQL Server connections use the built-in `tedious` native TDS driver. Query results distinguish NULL from empty strings and preserve high-precision DECIMAL values.

### Can the plugin modify database records?

No.

The plugin does not provide INSERT, UPDATE, DELETE, DDL, or stored procedure execution capabilities.

Always use a read-only database account rather than relying solely on application-level restrictions.

### What if an Oracle password contains special characters?

The plugin handles special characters according to SQL*Plus connection rules, including `@`, `/`, spaces, and quotation marks.

If the connection still fails, verify network connectivity and authentication using the same account directly through `sqlplus`.

### What if SQLite reports that sqlite3 is missing?

Install the SQLite command-line client and confirm that `sqlite3` can be executed.

On Windows, you can configure the full path to `sqlite3.exe` in the data source settings.

### Does uninstalling the plugin delete existing projects?

Usually not.

Uninstalling the plugin generally does not automatically remove project configurations, historical query results, or exported files.

For complete cleanup, first back up and inspect the corresponding data directory:

```text
~/.dsh/ai-database-assistant/
```

**Manually deleting the data directory may cause irreversible data loss. Proceed carefully.**

---

## Project Documentation

| Document | Description |
|---|---|
| [Installation Guide](docs/INSTALL.md) | Installation, upgrades, uninstallation, rollback, and troubleshooting |
| [User Guide](docs/USAGE.md) | Project management, natural-language queries, and result exports |
| [Database Support](docs/DATABASES.md) | Database connections, client dependencies, permissions, and limitations |
| [Plugin Details](docs/DETAIL.md) | Plugin overview and functionality |
| [Changelog](CHANGELOG.md) | Features, fixes, and updates in official releases |
| [Security Policy](SECURITY.md) | Security guidance and private vulnerability reporting |

---

## Downloads and Support

**npm package**

```text
@agenius/dsh-ai-database-assistant
```

**GitHub repository**

https://github.com/agenius666/dsh-ai-database-assistant

You can report bugs and suggest improvements through [GitHub Issues](https://github.com/agenius666/dsh-ai-database-assistant/issues).

For security vulnerabilities, follow the [Security Policy](SECURITY.md) and use private vulnerability reporting.

---

## License

This project is licensed under the **Apache License 2.0**.

For license terms and third-party attribution notices, see:

- [LICENSE](LICENSE)
- [NOTICE](NOTICE)
