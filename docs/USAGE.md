# User Guide

**English** | [简体中文](USAGE.zh-CN.md)

This guide explains how to use AI Database Assistant (DSH Plugin) to create projects, connect to databases, query data using natural language, review results, and export files.

**Applicable version:** `1.0.4`  
**Supported platforms:** Windows and macOS  
**Supported databases:** MySQL, PostgreSQL, SQL Server, Oracle, and SQLite

Before proceeding, make sure the plugin is installed and enabled in DeepSeek Harness (DSH). For initial installation or upgrades, see the [Installation Guide](INSTALL.md).

---

## 1. Performing a Database Query

### Step 1: Create a Project

Open DSH, find **AI Database Assistant** in the left sidebar, and click **New Project**.

Each project independently manages:

- Database connection configurations
- Export directories
- Query results and history
- AI conversations associated with the project

Consider creating separate projects for different business systems, analysis tasks, or actual work engagements to keep information organized.

### Step 2: Add a Database Connection

Open a project, click **Add Connection**, select a database engine, and enter the required information.

| Setting | Description |
|---|---|
| Database type | MySQL, PostgreSQL, SQL Server, Oracle, or SQLite |
| Connection name | Identifies the data source within the plugin and helps generate export filenames |
| Host and port | Network address and service port of the target database |
| Username | Account used to access the target database |
| Database name | Target database or corresponding connection identifier, depending on the database engine |
| Schema | Optional for PostgreSQL, SQL Server, and Oracle; generally unnecessary for MySQL |
| Password | Used for connection authentication; can optionally be stored through DSH credential management |
| Credential reference | References database credentials already stored in DSH, as an alternative to entering a password directly |
| Remember password | Stores the password through the DSH credential system for subsequent queries |
| Client executable | Optional absolute path to the client executable for MySQL, PostgreSQL, Oracle, or SQLite |

**Database-specific considerations:**

- **MySQL:** Uses the local `mysql` client. If you encounter an authentication plugin compatibility issue, you can configure the path to another compatible client version.
- **PostgreSQL:** Uses the local `psql` client. Specify a Schema if needed.
- **SQL Server:** Uses the built-in `tedious` native TDS driver; `sqlcmd` is not required. If the server uses a self-signed certificate, configure the server certificate trust option according to your security requirements.
- **Oracle:** Uses the local `sqlplus` client. Enter database and Schema information according to the actual connection requirements.
- **SQLite:** Primarily requires the database file path. The plugin accesses the file in read-only mode; no host, port, or network database account is required.

If the client executable path is left empty, the plugin attempts to locate the corresponding program through the system `PATH`.

On Windows, if `sqlite3.exe` is not installed, install the SQLite command-line client and specify its path if necessary.

**About database passwords**

You can enter a password directly for connection testing or use an existing DSH credential reference.

When **Remember Password** is enabled, the password is managed by the DSH credential system. Otherwise, the password is generally used only for the current operation. Configure a persistent credential reference if subsequent automated queries require authentication.

Database passwords should not be written into query results, exported files, or ordinary logs.

**About SQL Server certificates**

Enabling **Trust Server Certificate** may reduce the strictness of server certificate identity verification. Use this option only when you trust the target server and understand the security implications. Do not leave it unconditionally enabled simply to bypass a connection error.

After entering the connection information, click **Save and Test**.

Only connections that pass the test are marked as **Available** and permitted for subsequent queries.

### Step 3: Configure an Export Directory

Open the project's **Delivery Settings** and select a directory for saving exported files.

This directory is used to store files generated from query results.

Verify that:

- The directory exists or can be created according to the plugin's rules.
- The current user has the necessary write permissions.
- The directory is located within an allowed path.
- The directory does not contain important business files that should not be overwritten.

The plugin can export files only to directories authorized for the project.

### Step 4: Ask Questions in Natural Language

After configuring a database connection, you can submit analysis requests directly from the plugin workspace.

For example:

- "Summarize monthly order counts and sales revenue for 2026, sorted by month in ascending order."
- "Find employees who have left the company but still have active system accounts."
- "Compare employee IDs in two tables and list records that exist in only one table."
- "Show tasks that failed in the last 30 days and summarize their main error causes."

AI attempts to identify relevant tables, columns, and relationships using accessible database schema information, then generates and executes read-only queries.

When business requirements are ambiguous, AI may ask follow-up questions about date ranges, account status definitions, or whether amounts include tax.

**Important when using AI conversations:**

When you ask a question from the workspace, the plugin automatically creates or switches to the appropriate assistant conversation and associates it with the current project.

If you manually create an **AI Database Assistant** conversation, select the appropriate project in the left workspace before asking questions.

This helps prevent queries from being executed in the wrong project context.

### Step 5: Review Query Results

After a query finishes, its result card displays information such as:

| Item | Description |
|---|---|
| Query columns | Column names included in the result |
| Data preview | The first 20 rows are displayed by default |
| Result row count | Number of rows in the saved result |
| Executed SQL | SQL statement actually executed by the database |
| Execution time | Time taken to execute the query |
| Completeness status | Indicates whether the result is complete or a limit has been reached |

Click **View** to inspect more detailed query results.

**Note:** The preview displays only part of the data. It does not mean the complete result contains only those rows. Export eligibility depends on the result completeness status.

If a query reaches a row count, byte size, or other execution limit, the plugin marks the result as incomplete.

### Step 6: Export Query Results

After confirming that the result is complete and an export directory has been configured, click **Export**.

The plugin generates three files from the same saved query result:

| Format | Contents and Purpose |
|---|---|
| XLSX | Query data and related information, suitable for viewing, analysis, and delivery in Excel |
| CSV | Query data, suitable for data exchange and import into other systems |
| SQL | The read-only SQL statement actually executed, suitable for review or re-execution |

**Export rules:**

- All three files correspond to the same query.
- Existing files with the same name are not overwritten by default.
- Overwriting an existing file requires explicit user confirmation.
- Incomplete query results cannot be exported.
- Results that have been cleaned up cannot be exported again directly.
- An authorized, valid export directory must be configured.

The SQL file contains the query statement, not a copy of the returned data.

Re-executing the query may produce different results because of changes in database contents, permissions, or the execution environment.

Queries involving functions that return the current time, random values, or similar dynamic values are especially likely to produce different results when executed again.

---

## 2. Troubleshooting with Ask AI

When a database connection or plugin operation fails, some error messages provide an **Ask AI** button.

Clicking this button sends the relevant project context, error details, and troubleshooting information to the associated AI Database Assistant conversation and switches to that conversation.

You do not need to manually copy the entire error message.

Typical scenarios include:

- Database client not found
- Host or port unreachable
- Database authentication failure
- SQL query execution errors
- Insufficient database permissions
- File export failure

AI can suggest troubleshooting steps based on the error information. However, the actual cause still needs to be verified against the database, network, client, and DSH environment.

**Privacy notice:** Error messages may contain database hosts, database names, or other environment information. Before using **Ask AI**, confirm that your selected model service meets your data security requirements.

---

## 3. Copying Database Connections From Other Projects

If the same database has already been configured in another project, you can use **Copy Connection From Another Project**.

Follow these steps:

1. Open the target project.
2. Select **Copy Connection From Another Project** next to **Add Connection**.
3. Select the source project and an existing connection.
4. Review the copied connection information.
5. Provide credentials if needed and test the connection again.

The copied information mainly includes connection settings such as the host, port, username, and database name.

**Database passwords, query results, and project export directories are not copied.**

After copying a connection, click **Save and Test** again to confirm that the current project can access the database successfully.

---

## 4. Query Results and History Management

Each final query saves a separate result record for later viewing and review.

You can typically inspect:

- Query time
- Associated project and data source
- Executed SQL statement
- Result row counts and columns
- Query completeness
- Saved result data

Historical results are stored in the plugin data directory by default and do not automatically disappear when you close the result page.

### Cleaning Up Historical Results

If some historical data is no longer needed, use **Clean Up Historical Results** in the result list.

Before cleaning up, note that:

- Cleaned-up result snapshots cannot be used directly for another export.
- XLSX, CSV, and SQL files already exported to the project's designated directory are generally unaffected by internal history cleanup.
- Cleaning up historical results does not delete original business data from the database.

For important query results that must be retained long-term, export and back them up separately before cleanup.

---

## 5. Recommended Practices

### Use a Dedicated Read-Only Account

Create a dedicated read-only database account and grant only the minimum permissions necessary for the analysis.

Do not use a database administrator account simply because the plugin provides read-only SQL validation.

### Define Business Requirements Clearly

When asking questions, provide clear conditions whenever possible, such as:

- Query date range
- Business entities to analyze
- Definitions of relevant statuses
- Whether deleted or canceled records should be excluded
- Whether monetary amounts include tax
- Sorting and aggregation requirements

The clearer your business requirements, the more likely AI is to generate queries that match your intended analysis.

### Control Query Scope

For large databases, consider:

- Limiting the date range
- Adding appropriate filters
- Using grouping and aggregation
- Avoiding unrestricted retrieval of large datasets
- Manually reviewing the results of complex queries

### Protect Sensitive Data

AI queries may include database schema information, portions of query results, and user questions in the model context.

Before analyzing databases containing personal information, financial data, or other sensitive content, confirm the applicable model configuration, access permissions, and data usage requirements.

---

## 6. Frequently Asked Questions

### Why Does AI Need to Inspect the Database Schema First?

Table names, column names, and business meanings may differ across databases.

Inspecting the actual schema reduces the risk of referencing incorrect tables or columns. It also helps AI identify relationships between tables and determine appropriate aggregation logic.

However, AI may not automatically understand every business definition. Important conclusions still require human review.

### Why Does AI Ask Follow-Up Questions?

When a request lacks necessary conditions or has multiple reasonable interpretations, AI may ask about date ranges, business statuses, aggregation rules, or other details.

Answer according to the actual business rules rather than relying only on assumptions based on column names.

### Why Was My Query Result Truncated?

The query may have reached a row count, output byte size, or other execution limit.

Try narrowing the query period, adding filters, or performing an aggregated query first.

Results marked as incomplete cannot be exported.

### Can I Modify Database Records Through the Plugin?

No.

The plugin supports read-only queries only. Database writes, DDL operations, and stored procedure execution are not supported.

Using a database-enforced read-only account remains recommended as an additional security measure.

### Can Exported SQL Files Be Executed Directly?

SQL files contain the query statements actually executed. They can be used for review or re-execution in a compatible database environment with appropriate permissions.

However, SQL files do not preserve the original result data snapshot.

If database contents, permissions, or the execution environment change, re-execution may produce different results.

### Will Query History Be Retained Forever?

The current version does not automatically clean up historical query results by default.

However, history may still be lost through manual cleanup, deletion of the data directory, storage failures, or environment migration.

Export and independently back up results that must be retained long-term.

### Why Must I Test a Connection After Copying It?

Connection copying mainly reuses configuration information. It does not guarantee that the original password, network conditions, or database permissions remain valid.

Running another connection test confirms whether the copied connection is usable in the target project.

### Can Query Results Be Shared Across Projects?

Database connections, export directories, and result histories are isolated between projects.

If another project needs access to the same database, you can copy the connection configuration and test it again.

However, historical query results from one project cannot automatically be treated as results belonging to another project.

---

## 7. Related Documentation

- [Project Overview](../README.md)
- [Installation and Upgrade](INSTALL.md)
- [Database Support](DATABASES.md)
- [Plugin Details](DETAIL.md)
- [Changelog](../CHANGELOG.md)
