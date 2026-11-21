# Database Support

**English** | [简体中文](DATABASES.zh-CN.md)

This document describes the database engines supported by AI Database Assistant (DSH Plugin), their connection methods, client dependencies, access permissions, and known limitations.

**Applicable version:** `1.0.4`  
**Supported platforms:** Windows and macOS  
**Runtime:** DeepSeek Harness (DSH)  
**Node.js:** `>= 22`

This release officially supports five database engines: **MySQL, PostgreSQL, SQL Server, Oracle, and SQLite**.

Other database engines are not currently supported. Linux is also outside the officially supported platform scope.

---

## 1. Supported Databases

| Database | Connection Method | Default Port | Read-Only Mechanism |
|---|---|---|---|
| MySQL | `mysql` command-line client | 3306 | Read-only session |
| PostgreSQL | `psql` command-line client | 5432 | Read-only transaction |
| SQL Server | Built-in `tedious@20.3.9` driver | 1433 | Read-only SQL validation |
| Oracle | `sqlplus` command-line client | 1521 | SQL and client-command validation |
| SQLite | `sqlite3` command-line client | — | Read-only database access and statement validation |

**Connection methods:**

- **MySQL:** Connects using the local `mysql` client and supports read-only sessions.
- **PostgreSQL:** Executes queries in read-only transactions using the local `psql` client.
- **SQL Server:** Connects through the plugin's built-in native TDS driver without requiring `sqlcmd`.
- **Oracle:** Connects using the local `sqlplus` client, with safety checks on SQL statements and SQL*Plus commands.
- **SQLite:** Accesses database files in read-only mode using the local `sqlite3` client.

Query restrictions and client behavior may differ across database engines.

The tables, columns, and data accessible to the plugin also depend on the permissions assigned to the database account.

---

## 2. Database Accounts and Access Permissions

AI Database Assistant is designed for read-only queries. It does not provide database write operations, DDL, or stored procedure execution.

The plugin validates SQL statements before execution and restricts certain potentially dangerous operations that could affect databases or host files.

However, **application-level read-only validation does not replace database-enforced access controls**.

### Recommended Account Configuration

Follow the principle of least privilege when configuring database accounts:

1. Create a dedicated account for data analysis or auditing.
2. Grant read permissions only to the required databases, schemas, and tables.
3. Prefer `SELECT` privileges or the equivalent database-provided read-only roles.
4. Avoid granting unnecessary INSERT, UPDATE, DELETE, or DDL permissions.
5. Do not grant elevated permissions for file operations, database administration, backup, or recovery.
6. Enable appropriate database access auditing and logging according to organizational security requirements.

For production databases, a database administrator should assign permissions based on actual business requirements.

**Do not connect the plugin directly using a database administrator account.**

---

## 3. Database Client Requirements

### Client Dependencies

MySQL, PostgreSQL, Oracle, and SQLite require their corresponding command-line clients to be installed on the device running the DSH Host.

| Database | Executable | Separate Installation Required |
|---|---|---|
| MySQL | `mysql` / `mysql.exe` | Yes |
| PostgreSQL | `psql` / `psql.exe` | Yes |
| SQL Server | Built-in `tedious` driver | No |
| Oracle | `sqlplus` / `sqlplus.exe` | Yes |
| SQLite | `sqlite3` / `sqlite3.exe` | Yes |

SQL Server uses the native TDS driver `tedious@20.3.9`, which requires Node.js `>= 22`.

When the plugin is installed normally through npm, this driver is installed automatically as a runtime dependency.

If you install the plugin from a local source ZIP or source directory, first run the following command inside the plugin directory:

```bash
npm ci --omit=dev
```

For detailed instructions, see the [Installation and Upgrade Guide](INSTALL.md).

### Specifying a Client Executable Path

The plugin supports two ways to locate database clients:

- **Automatic discovery:** Leave the client executable path empty. The plugin searches the system `PATH`.
- **Manual configuration:** Specify the absolute executable path under **Edit Connection → Client Executable**.

For example, on macOS:

```text
/opt/homebrew/bin/mysql
```

On Windows:

```text
C:\Program Files\MySQL\MySQL Server 8.4\bin\mysql.exe
```

These are example paths. The actual locations depend on your installation method and system configuration.

If multiple versions of a database client are installed, specifying the intended version explicitly is recommended. This helps avoid incompatibilities caused by the order of directories in `PATH`.

---

## 4. Database-Specific Connection Details

### MySQL

MySQL connections use the local `mysql` command-line client.

A typical connection requires:

- Host
- Port
- Username
- Password
- Database name

**Authentication compatibility**

Different MySQL client versions may support different authentication plugins.

For example, you may encounter:

```text
ERROR 2059 (HY000): Authentication plugin 'mysql_native_password' cannot be loaded
```

This usually means that the current client cannot load the authentication plugin used by the server-side database account.

Some newer MySQL clients no longer provide support for `mysql_native_password`, while certain older database accounts still use this authentication method.

Recommended troubleshooting steps:

1. Identify the version of the MySQL client actually being used.
2. Check the authentication plugin configured for the server-side account.
3. Select a client compatible with the server's authentication method.
4. Specify that client's absolute executable path in the plugin connection settings.
5. Click **Save and Test** again.

For environments that still use `mysql_native_password`, check whether MySQL 8.4 or another compatible client meets the connection requirements.

On macOS, you may be able to install a compatible client through Homebrew, depending on package availability:

```bash
brew install mysql-client@8.4
```

The executable path may be:

```text
/opt/homebrew/opt/mysql-client@8.4/bin/mysql
```

Windows users can install a compatible MySQL client and specify the full path to the corresponding `mysql.exe`.

**Important:** Do not modify the authentication method of a production database account solely to resolve client compatibility issues. Server-side authentication changes should undergo appropriate security and compatibility assessments.

### PostgreSQL

PostgreSQL uses the local `psql` command-line client to execute read-only queries.

Typical connection information includes:

- Host and port
- Database name
- Username and password
- Schema, when required

The plugin uses read-only transactions to restrict query operations.

For analysis tasks, grant read permissions only to the required schemas and tables. Avoid using privileged database accounts.

### SQL Server

SQL Server connections use the plugin's built-in `tedious@20.3.9` native TDS driver.

**The SQL Server command-line tool `sqlcmd` is not required.**

Key capabilities include:

- Native SQL Server connectivity
- Distinguishing NULL values from empty strings
- Support for high-precision numeric values
- Read-only SQL validation
- Configurable server certificate trust settings

**Server certificates**

If the database uses a self-signed certificate, you may need to configure the **Trust Server Certificate** option.

Enabling this option may reduce the strictness of server certificate identity verification.

Prefer valid certificates whenever possible. Enable this option only after verifying the server's identity and assessing the associated security risks.

**Monetary and high-precision numeric values**

The plugin attempts to preserve the numeric precision of `MONEY`, `SMALLMONEY`, and high-precision `DECIMAL` values.

This helps avoid monetary rounding errors caused by conversion through ordinary floating-point numbers.

**Date and time precision**

For SQL Server data types such as `datetime2`, `time`, and `datetimeoffset`, the current driver may preserve fractional seconds only to millisecond precision.

If higher precision is required, convert the relevant date or time columns to text within the SQL query.

### Oracle

Oracle connections use the local `sqlplus` command-line client.

Provide the appropriate database connection information and account credentials according to your Oracle environment.

The plugin validates SQL statements and SQL*Plus client commands to restrict non-read-only operations and potentially dangerous commands.

**Special characters in passwords**

The plugin handles special characters in passwords according to SQL*Plus connection rules, including:

- `@`
- `/`
- Spaces
- Quotation marks

Under normal circumstances, users do not need to escape these characters manually.

If the connection still fails, first verify the account, network connectivity, and service connection details directly with `sqlplus` using the same credentials.

Then return to the plugin and run the connection test again.

A dedicated read-only account with access only to the required business tables is recommended.

### SQLite

SQLite connections use the local `sqlite3` command-line client to read database files.

Unlike network database engines, SQLite does not require a remote host or port.

The primary connection setting is the database file path.

The plugin opens the database file in read-only mode and restricts operations that could access or modify host files.

**Windows-specific considerations**

Windows does not necessarily include `sqlite3.exe` by default.

Before using SQLite, install the SQLite command-line client from a trusted source and verify that the executable runs correctly.

If the client is not available through the system `PATH`, specify the absolute path to `sqlite3.exe` in the plugin connection settings.

The current operating system user must also have appropriate read permissions for the database file.

---

## 5. Connection Testing

After adding or modifying a database connection, click **Save and Test**.

Depending on the database engine, the connection test checks conditions including:

- Availability of the required client or driver
- Correctness of host, port, and database connection information
- Network connectivity to the database
- Successful account authentication
- Availability of the necessary query permissions

Only connections that pass the test are marked as **Available** and permitted for subsequent queries.

**Saving a connection configuration does not mean the connection test has succeeded.**

If a test fails, review the displayed error message and verify the database client, authentication details, and access permissions.

---

## 6. Query and Data Safety Restrictions

To reduce accidental operations and excessive resource usage, the plugin applies restrictions to query execution and result processing.

### Read-Only Queries

The plugin restricts database writes, DDL, stored procedures, and other operations that do not meet its read-only requirements.

Read-only enforcement mechanisms differ between database engines, but all connections should use database accounts with minimum necessary permissions.

### Query Resource Limits

The plugin enforces limits on:

- Query execution time
- Result row counts
- Query output size in bytes

When a query reaches one of these limits, its result may be marked as incomplete.

**Incomplete or truncated query results cannot be exported directly.**

For large queries, narrow the date range, add filters, or perform grouping and aggregation in SQL before retrieving detailed data.

### File Exports

The plugin supports XLSX, CSV, and SQL export formats.

File exports are subject to the following restrictions:

- Files can only be written to directories authorized for the project.
- Existing files with the same name are not overwritten by default.
- Overwriting an existing file requires explicit confirmation.
- Incomplete results cannot be exported.
- Historical results that have been cleaned up cannot be exported again directly.

---

## 7. Known Limitations

| Area | Limitation | Recommendation |
|---|---|---|
| SQL Server time precision | Fractional seconds of some high-precision time types may be preserved only to milliseconds | Convert the value to text in SQL |
| Empty result set column names | Some complex queries do not allow reliable recovery of result column names | Explicitly select columns or adjust query structure |
| Large queries | Results exceeding row count, byte size, or execution limits are marked as incomplete | Narrow the query scope or aggregate first |
| Database clients | Client versions may be incompatible with server authentication methods or protocols | Use compatible client versions and configure executable paths |
| Oracle passwords with special characters | The plugin normally handles special characters, but behavior may still depend on the client and connection environment | Verify the connection using SQL*Plus |
| Windows file paths | Network shares, permissions, path formats, and filesystem rules may affect access | Check destination directories and operating system permissions |
| File exports | Only complete results can be exported, and a valid export directory is required | Check result completeness and directory settings |
| Platform support | Only Windows and macOS are officially supported | Use a verified DSH Host environment |

**About empty result sets**

For simple queries where column names can be determined reliably, the plugin may recover the result column names from the database schema.

For complex queries involving joins, expressions, or similar structures where column names cannot be reliably determined, the plugin may reject exports to avoid generating files without valid column headers.

**About query accuracy**

AI-generated SQL and analysis results may be affected by database schemas, data quality, account permissions, and business definitions.

For important financial data, audit conclusions, or business statistics, manually review query conditions, table relationships, and statistical results.

---

## 8. Frequently Asked Questions

### What Should I Do If a Database Client Cannot Be Found?

First, confirm that the required client is installed.

If the executable cannot be found through the system `PATH`, specify its full path under **Edit Connection → Client Executable**.

SQL Server does not require a separate installation of `sqlcmd`.

### Why Can AI Not Access Certain Tables Even Though the Database Connection Succeeds?

The current account may lack read permissions for the target schema or tables.

Alternatively, the relevant database schema information may not be visible to the account.

Review the account permissions, database name, and schema configuration.

Do not grant administrator privileges solely to resolve this issue.

### Why Does SQL Server Return Date and Time Values With Different Precision?

When some high-precision date and time types are retrieved through the current driver, fractional seconds may be preserved only to millisecond precision.

If full fractional-second precision is required, convert the relevant date or time columns to text in the SQL query.

### Why Can't Query Results Be Exported?

Check the following:

1. Is the query result complete?
2. Has a valid export directory been configured and authorized?
3. Does the saved result data still exist?
4. Does the export directory have the necessary write permissions?
5. Are there filename conflicts or other file operation restrictions?

### Why Is a Read-Only Database Account Recommended?

Even when the plugin restricts non-read-only SQL statements, database-level permissions remain an important security safeguard.

Using an account with minimum necessary permissions reduces the potential impact of unexpected queries, configuration mistakes, or other issues.

---

## 9. Related Documentation

- [Project Overview](../README.md)
- [Installation and Upgrade](INSTALL.md)
- [User Guide](USAGE.md)
- [Plugin Details](DETAIL.md)
- [Changelog](../CHANGELOG.md)
