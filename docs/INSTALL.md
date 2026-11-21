# Installation and Upgrade Guide

**English** | [简体中文](INSTALL.zh-CN.md)

This guide explains how to install, upgrade, uninstall, roll back, and troubleshoot AI Database Assistant (DSH Plugin).

**Applicable version:** `1.0.4`

AI Database Assistant runs as a plugin within DeepSeek Harness (DSH). It is not a standalone database client.

## 1. System Requirements

| Component | Requirement |
|---|---|
| Supported platforms | **Windows and macOS** |
| DSH version | `>= 0.2.2-rc.1` |
| Node.js | `>= 22` |
| Database account | A dedicated read-only account with only the necessary query permissions is recommended |
| Network | The device running DSH must be able to access the target database |
| External clients | Install the required command-line client for the selected database engine |

**Platform support:** This version officially supports Windows and macOS only. Linux is not officially supported.

**Runtime:** Verified Windows/macOS DSH Host environments include Node.js 24.21.0, so a separate Node.js installation is usually unnecessary. When running installation commands locally, ensure that the required Node.js and npm environment is available.

### Database Client Requirements

| Database | Required Client | Default Port |
|---|---|---|
| MySQL | `mysql` | 3306 |
| PostgreSQL | `psql` | 5432 |
| SQL Server | Built-in `tedious@20.3.9` driver | 1433 |
| Oracle | `sqlplus` | 1521 |
| SQLite | `sqlite3` | — |

SQL Server uses a native TDS driver. **You do not need to install `sqlcmd`.**

MySQL, PostgreSQL, Oracle, and SQLite require their corresponding command-line clients to be installed locally and executable.

The plugin can locate these clients through the system `PATH`. Alternatively, you can specify an absolute executable path in the database connection settings.

Windows does not necessarily include the SQLite command-line client. Before using SQLite, verify that `sqlite3.exe` is installed correctly.

For details, see [Database Support](DATABASES.md).

---

## 2. Installing the Plugin

Three installation methods are available. Using DSH's built-in plugin management feature is recommended.

### Option 1: Install Through DSH (Recommended)

1. Open DeepSeek Harness.
2. Navigate to **Plugins → Add plugin**.
3. Enter the package name:

```text
@agenius/dsh-ai-database-assistant
```

4. Follow the on-screen instructions to install and enable the plugin.
5. Restart DSH to complete plugin loading.

After installation, **AI Database Assistant** should appear in the left sidebar. You should also be able to select the corresponding assistant from the preset list when creating a new conversation.

When installing the npm package through DSH, the required runtime dependencies are installed along with the package.

### Option 2: Install Using npm

To install the package from the command line, run:

```bash
npm install @agenius/dsh-ai-database-assistant
```

npm installs the plugin and its declared runtime dependencies, including `tedious@20.3.9` for SQL Server.

**Important:** This command installs the npm package only. It does not automatically register the plugin in DSH.

After installation, you must still add and enable the plugin through **Plugins → Add plugin**.

### Option 3: Install From a Local ZIP or Source Directory

This method is suitable for offline deployment, local testing, or installation from GitHub source code.

Source archives typically do not include `node_modules`, so runtime dependencies must be installed first.

**Step 1: Download and extract**

Download the source ZIP from GitHub and extract it into the directory where you intend to install the plugin.

Project repository:

https://github.com/agenius666/dsh-ai-database-assistant

**Step 2: Install runtime dependencies**

Open a terminal and navigate to the extracted plugin directory.

macOS:

```bash
cd "/path/to/dsh-ai-database-assistant"
npm ci --omit=dev
```

Windows PowerShell:

```powershell
Set-Location "C:\path\to\dsh-ai-database-assistant"
npm ci --omit=dev
```

Replace the example path with your actual installation directory.

If the directory does not contain `package-lock.json`, use:

```bash
npm install --omit=dev
```

Using an official source package that includes `package-lock.json` is recommended so that the locked dependency versions can be installed.

**Step 3: Enable the plugin in DSH**

1. Open **Plugins → Add plugin**.
2. Select the local plugin directory where the runtime dependencies were installed.
3. Add and enable the plugin.
4. Restart DSH.

**Important notes:**

Installing from a local ZIP or source directory does not automatically generate `node_modules`.

If runtime dependencies have not been installed, SQL Server may report that the `tedious` driver is missing. Usually, you only need to return to the plugin directory and run `npm ci --omit=dev`. Modifying the plugin source code is not necessary.

External command-line clients required by other database engines must still be installed separately.

---

## 3. Verifying the Installation

Complete the following checks after the first installation.

### Verify Plugin Loading

Confirm that:

- **AI Database Assistant** appears in the DSH sidebar.
- The **AI Database Assistant** preset is available when creating a new conversation.
- The plugin workspace opens correctly.
- Project, database connection, and query result pages are displayed normally.

### Verify Database Connectivity

1. Create a test project.
2. Select a database engine.
3. Enter the database connection information.
4. Specify the client executable path if necessary.
5. Click **Save and Test**.

Run read-only queries only after the connection test succeeds.

For the initial test, use a dedicated test account with minimum read permissions. Do not use a production database administrator account.

### Verify Result Exports

If you plan to use the export feature:

1. Select an export directory in the project's delivery settings.
2. Execute a read-only query.
3. Confirm that the query result is complete.
4. Click **Export**.
5. Verify that XLSX, CSV, and SQL files are generated correctly.

The plugin may reject exports if the result is incomplete, the export directory has not been authorized, or the saved data snapshot has been cleaned up.

After installation, continue with the [User Guide](USAGE.md).

---

## 4. Upgrading the Plugin

Upgrading to a new stable release through DSH's plugin management feature is recommended.

### Before Upgrading

To reduce the risk of data loss, complete the following steps before upgrading:

1. Record the current plugin version.
2. Back up project configurations and historical query results.
3. Check the Node.js and DSH compatibility requirements of the new version.
4. Review the new release's changelog and known limitations.

Plugin data is typically stored in the user's home directory:

```text
~/.dsh/ai-database-assistant/
```

The actual location may vary depending on DSH configuration and the runtime environment. Use the actual configured data directory as the source of truth.

**Back up the entire data directory after stopping relevant plugin operations, rather than backing up individual configuration files only.**

Files previously exported to other locations should be backed up separately when necessary.

### Performing the Upgrade

Update the plugin through the DSH plugin management interface and follow the on-screen instructions.

If you installed the plugin from a local source directory, replace the source with the complete target version and reinstall the runtime dependencies according to that version's dependency declarations.

Restart DSH after the upgrade.

### After Upgrading

Verify that:

- The correct plugin version is displayed.
- Existing projects are still accessible.
- Database connection configurations remain intact.
- Historical query results are accessible.
- Export directory configurations remain valid.
- Database connection tests succeed.
- Query and export features work correctly.

A normal upgrade generally does not intentionally delete existing project data. However, retaining a pre-upgrade backup is recommended in case recovery becomes necessary.

---

## 5. Uninstalling the Plugin

Uninstalling the plugin and deleting project data are two separate operations.

### Uninstalling the Plugin Only

Uninstall or disable the plugin through the DSH Plugins management interface, then restart DSH as instructed.

Under normal circumstances, uninstalling the plugin does not automatically remove project configurations, historical query results, or previously exported files.

### Completely Removing Project Data

If you are certain that existing data is no longer required, you may manually clean up the plugin's data directory after creating a backup.

The default location is typically:

```text
~/.dsh/ai-database-assistant/
```

Verify the actual directory location and its contents before taking action. Make sure that no project configurations, historical query results, or other files need to be retained.

**Warning: Manually deleting the data directory may cause irreversible data loss. Do not proceed without verifying your backups.**

---

## 6. Rolling Back to an Earlier Version

If a new release introduces compatibility problems, consider rolling back to a previously used version.

However, **an older version may not be able to read data formats saved by a newer version**.

The recommended rollback procedure is:

1. Identify the target version and its runtime requirements.
2. Back up the current plugin data directory.
3. Check whether the target version is compatible with existing configurations and data formats.
4. Reinstall the target version through DSH plugin management or the corresponding installation package.
5. Restart DSH.
6. Verify projects, database connections, queries, and exports.

If the older version cannot recognize the current data, consider restoring a backup created before the upgrade.

Do not delete or overwrite the current data directory without a backup.

---

## 7. Troubleshooting

### The Plugin Does Not Appear After Installation

Check that:

- The plugin was installed successfully.
- The plugin is enabled in **Plugins**.
- DSH has been restarted.
- All plugin runtime dependencies are installed.

If the plugin still fails to load, inspect DSH's plugin loading error messages.

### Database Client Not Found

MySQL, PostgreSQL, Oracle, and SQLite require external command-line clients.

Verify that:

- The required client is installed.
- The client executable works correctly.
- The client version is compatible with the target database.
- The system `PATH` is configured correctly, or an absolute executable path has been provided.

You can specify the executable path under **Edit Connection → Client Executable**.

### MySQL ERROR 2059: mysql_native_password Cannot Be Loaded

This error usually indicates an incompatibility between the MySQL client and the authentication plugin used by the server-side database account.

Some newer MySQL clients no longer provide the `mysql_native_password` client authentication plugin. If the database account still uses this authentication method, the connection may fail with this error.

Follow these troubleshooting steps:

1. Check the version of the `mysql` client actually being used.
2. Identify the authentication method configured for the server-side database account.
3. Select a client compatible with that authentication method.
4. Enter the client's absolute executable path in the plugin connection settings.
5. Click **Save and Test** again.

For legacy environments that still require `mysql_native_password`, check whether a MySQL 8.4 client or another compatible client meets your requirements.

On macOS, you can select a compatible `mysql` client based on your installed Homebrew packages.

On Windows, you can specify the full path to the appropriate `mysql.exe`.

**Important:** Do not change a production database account's authentication method solely to eliminate a connection error. Any server-side modification should undergo compatibility and security assessment.

### SQL Server Reports a Missing tedious Driver

SQL Server uses the plugin's native TDS driver and does not require `sqlcmd`.

If the plugin was installed from a local ZIP or source directory, open a terminal in the plugin directory and run:

```bash
npm ci --omit=dev
```

Then restart or reload the DSH plugin.

When installed normally through npm, `tedious` should be installed automatically as a runtime dependency.

### SQLite Reports That sqlite3 Is Missing

SQLite requires an executable `sqlite3` command-line client on the local system.

Confirm that the client is installed and can run successfully.

Windows users can enter the absolute path to `sqlite3.exe` in the connection settings.

### Database Connection Test Fails

Check the following:

- Whether the database service is running normally
- Whether the host and port are correct
- Whether network and firewall settings permit connections
- Whether the username and password are correct
- Whether the account has the required database read permissions
- Whether the database client is compatible

**Saving a database connection configuration does not mean that the connection test has passed.**

The corresponding data source can only be used for queries after **Save and Test** completes successfully.

### Why Is My Query Result Incomplete?

When a query reaches a row count limit, byte size limit, or another execution restriction, the plugin marks its result as incomplete.

Try narrowing the date range, adding filters, or performing aggregation first.

Incomplete query results cannot be exported.

### Why Can't I Export Files?

Check that:

- The query result is complete.
- An export directory has been authorized for the project.
- The export directory is accessible.
- Historical result data still exists.
- No conflicting file with the same name prevents the operation.
- The requested operation complies with file safety restrictions.

### Projects Fail to Load After an Upgrade

Do not immediately delete or recreate the data directory.

Check DSH error messages and determine whether the problem involves damaged project configurations, incompatible data formats, or abnormal file permissions.

If project configuration corruption is detected, the plugin may reject further reading or writing to prevent the original data from being overwritten.

Back up the existing files before attempting repairs or restoring a historical backup.

---

## 8. Downloads and Support

**npm package**

```text
@agenius/dsh-ai-database-assistant
```

**GitHub source code and issue reporting**

https://github.com/agenius666/dsh-ai-database-assistant

When reporting an issue, include the plugin version, operating system, DSH version, database engine, steps to reproduce, and sanitized error messages.

Do not submit database passwords, API keys, connection credentials, or complete logs containing sensitive data in public GitHub Issues.

---

## 9. Related Documentation

- [Project Overview](../README.md)
- [User Guide](USAGE.md)
- [Database Support](DATABASES.md)
- [Plugin Details](DETAIL.md)
- [Changelog](../CHANGELOG.md)

## 10. License

This project is licensed under the [Apache License 2.0](../LICENSE).

For copyright information and third-party license notices, see [NOTICE](../NOTICE).
