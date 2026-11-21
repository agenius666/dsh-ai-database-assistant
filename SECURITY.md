# Security Policy

## Supported Versions

Security fixes are prioritized for the latest stable release of AI Database Assistant.

Older versions may not receive security updates. Users are encouraged to keep the plugin up to date.

## Reporting a Vulnerability

If you discover a security vulnerability, please report it privately through GitHub's vulnerability reporting feature:

https://github.com/agenius666/dsh-ai-database-assistant/security/advisories/new

Please do not disclose security vulnerabilities through public GitHub Issues, discussions, or pull requests before coordinated disclosure.

When submitting a report, please include:

- A description of the vulnerability and its potential impact.
- The affected plugin version and operating system.
- Steps to reproduce the issue.
- A proof of concept, if available and safe to share.
- Any relevant logs with sensitive information removed.

**Never include real database passwords, API keys, access tokens, production data, or other confidential information in reports.**

## Security Considerations

AI Database Assistant is designed for read-only database analysis.

Users should:

- Use dedicated database accounts with minimum necessary read permissions.
- Avoid connecting with database administrator credentials.
- Review generated SQL and AI-assisted analysis for correctness.
- Ensure that AI model providers and data handling policies meet their security requirements.
- Keep DeepSeek Harness, database clients, and plugin dependencies updated.

Application-level SQL restrictions do not replace database-level access controls.

## Responsible Disclosure

Please allow maintainers an opportunity to investigate and address reported vulnerabilities before public disclosure.

Confirmed vulnerabilities may be addressed through security updates and GitHub Security Advisories.

## Scope

This security policy applies to the AI Database Assistant plugin maintained in this repository.

Security issues affecting DeepSeek Harness itself or third-party database software should also be reported to their respective maintainers.
