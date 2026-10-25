# Privacy

## Local data

The userscript stores the following values in the userscript manager's local
storage:

- API base URL.
- Model name.
- API key.
- Runtime options.
- Question fingerprints and cached answers.

Run logs are kept only in page memory and disappear on refresh.

## Network data

Question text may be transmitted directly from the browser to
`api.deepseek.com` when the cache does not contain a matching question. The
request includes the system prompt, question stem, options, score, and type.

No maintainer-operated telemetry endpoint is used.

## Sensitive content

Do not use this script with confidential exams, personal data, or question
content that may not be sent to a third-party AI provider. Review the DeepSeek
privacy and data-processing terms before use.

## Repository hygiene

The repository must never contain:

- Real API keys.
- Browser cookies or authorization headers.
- Account identifiers or personal course records.
- Unsanitized screenshots, HAR files, or page snapshots.
- Local filesystem paths containing usernames.

The publication test suite checks for common token patterns, local paths, and
API-key prefix logging.
