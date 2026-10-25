# Security Policy

## Supported versions

Security and privacy fixes are applied to the latest release.

## Reporting a vulnerability

Do not open an issue containing:

- API keys or authorization tokens.
- Browser cookies or session identifiers.
- Account names or personal course information.
- Unsanitized HAR files or screenshots.
- Local usernames or filesystem paths.

Use a private GitHub security advisory for this repository. If advisories are
unavailable, contact the repository owner privately and include only the
minimum information needed to reproduce the issue.

## Secret-handling policy

The script must keep the API key empty by default. It must not log the key,
show a key prefix in diagnostics, write the key into the repository, or include
it in test fixtures.

If a credential is exposed:

1. Revoke it at the provider immediately.
2. Create a replacement credential.
3. Remove it from the current files and repository history.
4. Review provider usage and billing.

## Scope

The userscript performs local DOM operations and direct HTTPS requests to
`api.deepseek.com`. It does not operate a telemetry server or collect account
credentials.
