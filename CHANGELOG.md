# Changelog

**English** | [简体中文](CHANGELOG.zh-CN.md)

This document records official releases, feature improvements, compatibility changes, and known limitations of AI Database Assistant (DSH Plugin).

## 1.0.3

This release focuses on improving **Windows/macOS compatibility, database read-only safety, query result accuracy, and runtime stability**, along with enhancements to installation procedures, error handling, and multilingual interfaces.

### Installation and Compatibility

- **Official support for Windows and macOS** through DeepSeek Harness (DSH). Linux is not an officially supported platform.
- **Minimum Node.js version increased to 22** to align with database driver requirements. Verified Windows/macOS DSH Host environments use Node.js 24.21.0.
- **SQL Server now uses the built-in native TDS driver** `tedious@20.3.9`, eliminating the need to install `sqlcmd`.
- **Improved runtime dependency installation guidance:** Required dependencies are installed automatically through npm. When installing from a local ZIP or source directory, run `npm ci --omit=dev` first.
- Improved connection compatibility and error reporting across database clients to make configuration, authentication, and driver issues easier to diagnose.

### Database Security

- **Strengthened read-only SQL validation** to further restrict multi-statement execution and client commands that could bypass read-only protections.
- Enhanced SQL Server multi-statement validation to prevent non-read-only operations from being combined using unusual line breaks, comments, or similar techniques.
- Strengthened Oracle SQL*Plus client-command validation to reject dangerous commands and non-read-only statements concealed by blank lines or control characters.
- Improved SQLite query restrictions to prevent related extension functions from accessing or modifying host files.
- Retained query timeout, result row count, and output size limits. Results exceeding these limits are explicitly marked as incomplete and cannot be exported.

**Security recommendation:** Always use a dedicated read-only database account with only the permissions required for the intended queries. The plugin's SQL safety checks do not replace database-level access controls.

### Query Results and Data Accuracy

- **Improved high-precision SQL Server numeric handling** to avoid precision loss when `MONEY`, `SMALLMONEY`, and high-precision `DECIMAL` values are converted through ordinary numeric representations.
- Improved query result snapshot management so previews, completeness checks, and exports use a consistent source of saved data.
- Corrected completeness checks in certain pagination and result truncation scenarios to prevent incomplete datasets from being incorrectly marked as complete.
- Improved column name preservation and display for empty result sets, helping users identify the structure of returned query data.
- Improved messages related to query truncation and `LEFT JOIN` validation.
- Enhanced XLSX, CSV, and SQL export handling to improve the accuracy and consistency of monetary and high-precision numeric values.

### Project and Data Protection

- **Strengthened project configuration file protection:** When a project configuration index is corrupted or malformed, the plugin rejects operations that could overwrite the original configuration and provides a clear error message.
- A corrupted project index is not automatically replaced with an empty configuration, and the original project data directory is preserved.
- Under normal operation, projects, database connections, export directories, and query histories are organized and isolated by project.
- Improved exception handling and error reporting to reduce the impact of configuration errors on subsequent operations.

Corrupted project configurations may still require manual repair or restoration from a backup.

### User Interface and Experience

- **Expanded and refined support for 10 interface languages:** Simplified Chinese, Traditional Chinese, English, Japanese, Korean, Spanish, French, German, Russian, and Portuguese.
- Interface language follows the DSH language settings, with improvements to selected labels, status messages, and error notifications.
- Improved database connection testing and failure feedback, preserving useful original error details where possible while handling sensitive information.
- Refined the **Ask AI** entry point and error context transfer to help users investigate connection and query failures through AI conversations.
- Improved stability when switching projects, displaying query results, and exporting files.

### Known Limitations

- **SQL Server time precision:** For `datetime2`, `time`, and `datetimeoffset`, fractional seconds with more than three digits may be retrieved at millisecond precision only. To preserve full precision, convert the relevant column to text in the SQL query.
- **Query result size:** Results exceeding row count or output byte limits are marked as incomplete and cannot be exported directly. Narrow the query scope, add filters, or aggregate data first.
- **Windows network shares:** The availability of UNC paths depends on network connectivity, share permissions, and system configuration. Directories that cannot be accessed safely will be rejected.
- **External database clients:** MySQL, PostgreSQL, Oracle, and SQLite still require their corresponding command-line clients. SQL Server uses the built-in driver.
- **Project configuration recovery:** Corrupted project configuration indexes are protected against overwriting, but automatic backup restoration is not currently provided.
- **Platform scope:** This release officially supports Windows and macOS only. Linux compatibility is not guaranteed.

---

For more information about installation, database connections, and usage, see:

- [Installation Guide](docs/INSTALL.md)
- [User Guide](docs/USAGE.md)
- [Database Support](docs/DATABASES.md)
