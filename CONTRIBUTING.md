# Contributing

## Before submitting a change

1. Run `npm run check`.
2. Run `npm test`.
3. Describe the page structure or behavior being changed.
4. Keep changes scoped to the userscript, documentation, and tests.

## Privacy requirements

Remove all sensitive data from code, tests, logs, screenshots, and issues:

- API keys, tokens, cookies, and passwords.
- Personal names, student IDs, phone numbers, and email addresses.
- Course records and account screenshots.
- Local absolute paths and usernames.
- Query strings containing signed URLs or session identifiers.

Use placeholders such as:

```text
<YOUR_DEEPSEEK_API_KEY>
<QUESTION_TEXT>
<COURSE_NAME>
```

## Credential policy

Never commit a real API key. The default `apiKey` value must remain an empty
string. Diagnostics must not reveal any key prefix.

## Code style

- Keep the userscript dependency-free.
- Preserve existing comments that document verified browser behavior.
- Avoid changing unrelated automation behavior in a bug-fix commit.
- Add or update a regression test for parser, editor, navigation, or cache
  changes.

## License

By contributing, you agree that your contribution may be distributed under the
repository's MIT License.
