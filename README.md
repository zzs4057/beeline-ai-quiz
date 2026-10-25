# 芯位蜜线 AI 答题助手

**Beeline AI Quiz Userscript / 芯位蜜线 AI 答题油猴脚本**

![License](https://img.shields.io/badge/license-MIT-yellow.svg)
![Userscript](https://img.shields.io/badge/userscript-Tampermonkey%20%7C%20Violentmonkey-blue)
![Version](https://img.shields.io/badge/version-1.2.2-green)

一个面向 `beeline-ai.com` 芯位蜜线作业与答题页面的用户脚本，调用 DeepSeek API 辅助识别和处理单选、多选、判断、填空及主观题。

> **重要声明**
>
> 本项目仅用于个人学习效率研究、页面自动化技术研究和合法的辅助练习。请勿在明确禁止自动化工具的考试、测评、认证或作业中使用。脚本不会自动提交作业，提交前必须由使用者自行检查和确认。
>
> 本项目与芯位蜜线及其关联公司无隶属、授权或官方合作关系。使用本项目即表示你理解并自行承担账号、课程、学术规范和当地法律方面的责任。

## 功能

| 题型 | 处理方式 |
|---|---|
| 单选 | 识别单选控件，调用 AI 选择唯一答案并校验勾选结果 |
| 多选 | 逐项判断，选择全部正确项，并清理残留错误选项 |
| 判断 | 识别判断正误题，支持页面使用 `正确/错误`、`T/F` 等不同内部值 |
| 填空 | 识别单空和多空输入框，按空位顺序回填并逐空校验 |
| 中文主观题 | 生成约 300 至 700 字的分段答案并写入富文本编辑器 |
| 英文主观题 | 使用纯英文提示词快速作答；翻译成中文等题型会自动例外处理 |

其他能力：

- 只保留 DeepSeek API 接口，默认端点为 `https://api.deepseek.com/v1/chat/completions`。
- 支持答案缓存、失败重试、速率限制、拟人停顿和演练模式。
- 富文本回填兼容 `textarea`、Slate、WangEditor、Quill 和 ProseMirror 等常见结构。
- 主观题回填会同时检查编辑区文本和编辑器字数状态，避免出现“画面有字但表单值为空”。
- 提供“清本题缓存并重新思考”和“清空全部缓存”两个层级的缓存操作。
- 提供页面结构诊断、接口测试和可复制运行日志。
- API Key 只保存在油猴本地存储中，不写入源码、日志或导出文件。

## 运行要求

- Microsoft Edge、Google Chrome 或兼容 Chromium 浏览器。
- Tampermonkey 或 Violentmonkey。
- 可访问 DeepSeek API 的网络环境。
- 你自己的 DeepSeek API Key 和可用额度。

## 安装脚本

1. 安装 [Tampermonkey](https://www.tampermonkey.net/) 或 Violentmonkey。
2. 在仓库中打开 [`beeline-ai-quiz.user.js`](./beeline-ai-quiz.user.js)。
3. 点击 GitHub 页面上的 `Raw`。
4. 在油猴扩展确认安装。
5. 打开或刷新芯位蜜线课程、作业或答题页面。

脚本只匹配以下站点：

```text
https://www.beeline-ai.com/*
https://beeline-ai.com/*
```

脚本只允许连接：

```text
api.deepseek.com
```

## DeepSeek API 配置

### 第一步：创建 DeepSeek API Key

1. 登录 [DeepSeek 开放平台](https://platform.deepseek.com/)。
2. 进入 API Keys 页面：[https://platform.deepseek.com/api_keys](https://platform.deepseek.com/api_keys)。
3. 创建一个仅用于本项目的 API Key。
4. 立即把 Key 保存在自己的密码管理器中。
5. 确认账号有可用余额。余额不足时，API 通常会返回 HTTP `402`。

> API Key 等同于账号额度凭证。不要发到群聊、截图、Issue、日志或 Git 仓库。不要把它写进 `.user.js` 文件。

### 第二步：打开脚本配置面板

1. 刷新芯位蜜线答题页面。
2. 页面右下角会出现“AI 自动答题”面板。
3. 打开“接口”标签页。
4. 点击“填入 DeepSeek 默认配置”。

### 第三步：填写接口参数

| 字段 | 推荐值 | 说明 |
|---|---|---|
| DeepSeek 接口地址 | `https://api.deepseek.com/v1/chat/completions` | 也可以只填 `https://api.deepseek.com/v1`，脚本会自动补全 |
| API Key | 你的 DeepSeek API Key | 只保存到 Tampermonkey 本地存储，不进入源码 |
| 模型名 | `deepseek-chat` | 默认推荐，速度与稳定性较好 |
| temperature | `0` | 答题需要确定性，推荐保持 `0` |
| max_tokens | `2048` | 客观题用量很小；主观题会按分值动态提高预算 |
| 超时（毫秒） | `45000` | 网络较慢时可改为 `90000` 或 `120000` |

可选高阶模型：

- `deepseek-reasoner`：推理更充分，但速度更慢、Token 消耗更高。
- 如果平台提供新的 DeepSeek 模型，可点击“拉取模型列表”后选择。

### 第四步：测试连接

1. 点击“测试连接”。
2. 脚本会发送一道不含个人信息的示例题：“中国的首都是哪座城市？”
3. 成功时日志会显示接口延迟、模型原始输出和解析结果。
4. 出现 `401` 或 `403` 时检查 Key；出现 `402` 时检查余额；出现 `404` 时点击“自动探测地址”。

### 第五步：保存并试运行

1. 点击“保存配置”。
2. 先打开“演练模式（不勾选）”。
3. 点击“答当前一题”或手动开始一题，检查提示词、答案和页面识别结果。
4. 确认无误后关闭演练模式。
5. 打开“总开关”，再点击“开始自动答题”。
6. 脚本答完并通过答题卡满条件后会停止，不会自动提交作业。

## API Key 安全

- 仓库中的默认值是空字符串。
- 测试数据和文档只使用 `<YOUR_DEEPSEEK_API_KEY>` 一类占位符。
- 诊断信息只显示“已填写”或“未填写”，不会回显 Key 前缀。
- Key 通过 `GM_setValue` 存入油猴本地存储。
- 清理浏览器扩展数据、站点数据或油猴存储后，需要重新填写 Key。
- 怀疑 Key 泄露时，立即到 DeepSeek 控制台禁用并重新创建。
- 建议为自动化场景创建独立 Key，并定期检查用量。

## 数据与隐私

运行过程中可能发送给 DeepSeek API 的内容：

- 当前题干与选项。
- 题目类型、分值和空白数量。
- 为生成答案所需的系统指令。

不会发送给项目维护者的内容：

- 芯位蜜线账号、密码或 Cookie。
- 浏览器历史、设备信息或与本脚本无关的页面内容。
- API Key 以外的请求会由脚本直接发送到 `api.deepseek.com`，不经过本项目自建服务器。

保存在本地的内容：

- 面板配置，包括 API Base、模型名和 API Key。
- 题目指纹与 AI 答案缓存。
- 当前页面内存中的运行日志。

请不要在不允许第三方数据处理的环境中传输敏感题目、个人信息或受保密约束的考试内容。

## 缓存与重新思考

### 清本题缓存并重新思考

位于“答题”页控制区。点击后会：

1. 删除当前题目的单条缓存。
2. 忽略当前旧答案。
3. 重新请求 DeepSeek。
4. 重新回填当前题。

适合以下情况：

- AI 上一轮答案不理想。
- 修改了模型或提示词。
- 富文本编辑器状态异常。
- 想在不清理全部缓存的情况下重做当前题。

### 清空缓存

位于“接口”页的“答案缓存”区域，会删除全部题目缓存，但不会删除 API 配置或 API Key。

## 富文本回填说明

主观题编辑器可能由不同前端框架实现。脚本会优先使用编辑器可识别的原生命令和事件，不直接替换编辑器 DOM。

如果编辑器右下角字数仍显示 `0`，或者脚本无法确认内部表单状态，脚本会判定回填失败并停止，而不是留下一个不可编辑的假内容。

遇到旧版本已经破坏的编辑器：

1. 覆盖安装最新脚本。
2. 刷新答题页面。
3. 再使用“清本题缓存并重新思考”。

## 常见问题

| 现象 | 检查项 |
|---|---|
| 提示未配置 API Key | 在“接口”页重新填写并保存 |
| HTTP 401/403 | Key 是否有效、是否被禁用、是否有模型权限 |
| HTTP 402 | DeepSeek 账号余额 |
| HTTP 404 | 点击“自动探测地址”，确认端点为 DeepSeek |
| 请求超时 | 提高超时时间，检查网络或减少同时请求 |
| 找不到题目 | 点击“诊断结构”，确认题目容器、控件和编辑器结构 |
| 选项勾选失败 | 查看诊断日志中的 `input`、class 和可见性 |
| 主观题回填失败 | 刷新页面后清本题缓存重试，并查看日志中的回填方式与字数 |
| 页面已经自动跳题 | 脚本会重新核对题目指纹，避免重复点击下一题 |

详细排查见 [docs/troubleshooting.md](./docs/troubleshooting.md)。

## 已知限制

- 平台 DOM 更新后，选择器可能需要同步调整。
- 跨域 iframe、封闭 Shadow DOM 或浏览器安全策略可能限制访问。
- 富文本编辑器的内部状态可能因版本升级而变化。
- AI 输出不能保证 100% 正确，专业题和事实题必须人工复核。
- 脚本不会绕过平台风险控制、不会伪造学习进度，也不会自动提交作业。

## 开发与测试

环境要求：Node.js 20 或更高版本。

```bash
npm run check
npm test
```

测试集覆盖：

- 发布物脱敏、版本、网络权限和密钥默认值。
- 单选、多选、判断和填空识别。
- 中英文主观题、翻译题语言判断和富文本回填。
- WangEditor / Slate 选区事件、字数控件校验和单题缓存。
- DeepSeek 请求体、错误诊断和答案解析。
- 导航按钮、禁用态和答题卡推进逻辑。

## 目录结构

```text
.
├─ beeline-ai-quiz.user.js
├─ README.md
├─ LICENSE
├─ NOTICE.md
├─ CHANGELOG.md
├─ CONTRIBUTING.md
├─ SECURITY.md
├─ CODE_OF_CONDUCT.md
├─ docs/
│  ├─ architecture.md
│  ├─ configuration.md
│  ├─ privacy.md
│  ├─ compliance.md
│  └─ troubleshooting.md
├─ tests/
│  ├─ run-all.mjs
│  └─ verify-*.mjs
└─ .github/
   ├─ workflows/ci.yml
   └─ ISSUE_TEMPLATE/
```

## 贡献

提交代码前请阅读 [CONTRIBUTING.md](./CONTRIBUTING.md)。安全问题请按 [SECURITY.md](./SECURITY.md) 私下报告。

禁止提交以下内容：

- API Key、Token、Cookie 或登录凭据。
- 含个人姓名、学号、手机号、邮箱或课程记录的截图和日志。
- 未经脱敏的 HAR、页面快照或网络请求。
- 本机绝对路径和个人用户名。

## 开源声明

本项目使用 [MIT License](./LICENSE) 开源。

Copyright (c) 2026 Beeline AI Quiz Contributors

当前 GitHub 仓库可保持私有。MIT 许可证适用于仓库中的原创代码和文档；平台名称、界面、课程内容及相关商标不属于本项目，其权利归各自所有者。

本项目按“现状”提供，不对答题正确率、账号状态、课程成绩或平台兼容性作任何明示或默示担保。
