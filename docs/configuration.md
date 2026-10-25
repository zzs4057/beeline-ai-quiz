# Configuration

This document describes the complete DeepSeek and runtime configuration process.

## 1. Supported provider

The distribution intentionally exposes only DeepSeek.

```text
API host: api.deepseek.com
Model: deepseek-chat
Endpoint: https://api.deepseek.com/v1/chat/completions
```

The userscript metadata grants network access only to `api.deepseek.com`. A
custom third-party OpenAI-compatible endpoint is not part of the supported
distribution.

## 2. Create a DeepSeek API key

1. Sign in at <https://platform.deepseek.com/>.
2. Open <https://platform.deepseek.com/api_keys>.
3. Create a dedicated key for this userscript.
4. Store the key in a password manager.
5. Confirm that the account has a positive balance.

Never write a real API key into a file, Git commit, screenshot, issue, or chat
message. Use the placeholder below only when discussing configuration:

```text
<YOUR_DEEPSEEK_API_KEY>
```

## 3. Install and open the panel

1. Install Tampermonkey or Violentmonkey.
2. Install `beeline-ai-quiz.user.js`.
3. Open a Beeline quiz page.
4. Refresh the page.
5. Open the “AI 自动答题” panel and select the “接口” tab.

## 4. Fill in the fields

Click “填入 DeepSeek 默认配置” first. Then review every field.

| Field | Default | Valid range / values | Recommendation |
|---|---|---|---|
| Interface URL | `https://api.deepseek.com/v1/chat/completions` | HTTPS URL | Keep the default |
| API Key | Empty | DeepSeek key | Enter locally, then save |
| Model | `deepseek-chat` | Model available to the key | Start with `deepseek-chat` |
| temperature | `0` | `0` to `2` | Keep `0` for deterministic answers |
| max_tokens | `2048` | `32` to `8192` | Use `2048` or higher |
| timeout | `45000` | `5000` to `180000` ms | Increase for slow networks |

The endpoint can also be entered as:

```text
https://api.deepseek.com
https://api.deepseek.com/v1
api.deepseek.com
```

The script normalizes these values to the full chat completions endpoint.

## 5. Test the connection

Click “测试连接”. The script sends a minimal non-personal example question to
the configured model.

Expected result:

- The log shows an HTTP success.
- The model returns a valid answer letter.
- The parsed result is shown as `B` for the built-in example.

Common failures:

| Status | Meaning | Action |
|---|---|---|
| `401` / `403` | Authentication or permission failure | Replace or enable the API key |
| `402` | Insufficient balance | Add credit in the DeepSeek console |
| `404` | Wrong endpoint | Use “自动探测地址” or restore the default endpoint |
| `429` | Rate limit | Wait, reduce concurrency, or adjust the per-minute limit |
| Timeout | Network or model latency | Raise timeout and retry |

## 6. Configure automation

Recommended first run:

1. Keep “演练模式” enabled.
2. Open the total switch.
3. Use “答当前一题”.
4. Verify the detected question type, selected answer, and prompt preview.
5. Disable dry-run only after the result is correct.

Relevant switches:

| Switch | Meaning |
|---|---|
| Total switch | Enables real page operations |
| Auto next | Advances after a verified answer |
| Auto subjective | Generates and fills subjective answers |
| Stop when full | Stops after the answer card is full |
| Dry run | Calls AI but does not modify the page |

The script does not click the final submit button.

## 7. Key storage

Configuration is stored under:

```text
BLQ_CFG_V1
```

Answer cache is stored under:

```text
BLQ_BANK_V1
```

Tampermonkey may encrypt browser extension storage according to its own
settings. The repository itself contains no user configuration.

## 8. Data sent to DeepSeek

For each uncached question, the script sends:

- System instructions.
- Current question stem.
- Options, if any.
- Question type, score, and blank count.

The script does not send Beeline credentials, cookies, browser history, or the
API key to any maintainer-operated server.

## 9. Cache management

- “清本题缓存并重新思考” removes only the current question fingerprint.
- “清空缓存” removes the full local answer cache.
- Clearing cache does not remove the API key or configuration.
- To remove the key, clear the userscript manager storage for this script or
  replace it with an empty value.

## 10. Updating

After replacing the userscript with a newer version:

1. Save the new file in the userscript manager.
2. Refresh the quiz page.
3. Check the version in the userscript header or manager.
4. Re-run “测试连接” if the endpoint or model changed.

If a rich-text editor was damaged by an older release, a page refresh is
required. Updating the script alone cannot repair an already replaced editor
DOM tree.
