# Troubleshooting

## Start with diagnosis

Open the “日志” tab and click “诊断结构”. Diagnostics contain page structure
and status information, but must never contain a real API key.

Before sharing a log publicly, remove:

- Question text or course names.
- Account names or URLs containing identifiers.
- Browser extensions and unrelated page content.

## API failures

### `401` or `403`

- Re-enter the DeepSeek API key.
- Confirm the key is active.
- Confirm that the key has access to the selected model.

### `402`

- Check the DeepSeek account balance and billing status.

### `404`

- Restore `https://api.deepseek.com/v1/chat/completions`.
- Click “自动探测地址”.
- Confirm that the endpoint is DeepSeek, not an unrelated service.

### Timeouts

- Increase timeout to `90000` or `120000` ms.
- Check network and proxy configuration.
- Try `deepseek-chat` before a reasoning model.

## Answer parsing failures

The parser rejects prose, invalid letters, and ambiguous outputs rather than
guessing.

- Run “测试连接”.
- Confirm the model follows the requested output format.
- Lower temperature to `0`.
- Clear the current question cache and request a new answer.

## Option selection failures

- Check whether the platform renders Element UI `radio`/`checkbox` controls.
- Use “诊断结构” to inspect the visible option nodes.
- Confirm that the page is not covered by a modal or loading mask.
- Wait for the question to finish rendering.

## Rich-text failures

The editor may be Slate, WangEditor, Quill, ProseMirror, or a plain textarea.

- Refresh the page after installing a new script version.
- Use “清本题缓存并重新思考”.
- Check the log for `slate-beforeinput`, `quill-api`, or another method name.
- If a counter such as `0/15000` remains zero, the form state is not synced.
- Do not replace the editor DOM manually; refresh to reconstruct it.

## Navigation failures

- Check the next button text and disabled state in diagnostics.
- Confirm the page has finished loading.
- If the platform auto-advances, the script should detect the changed
  fingerprint and avoid a duplicate next click.

## Privacy incident

If an API key was committed, pasted, or included in a screenshot:

1. Disable and delete it in the DeepSeek console.
2. Create a replacement key.
3. Remove the credential from repository history, not only the latest commit.
4. Review API usage and billing records.
