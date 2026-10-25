import fs from 'node:fs';

const root = new URL('../', import.meta.url);
const source = fs.readFileSync(new URL('beeline-ai-quiz.user.js', root), 'utf8');
const pkg = JSON.parse(fs.readFileSync(new URL('package.json', root), 'utf8'));
const metaVersion = (source.match(/^\/\/ @version\s+(\S+)/m) || [])[1] || '';

const checks = [];
const ok = (name, condition, detail) => {
  checks.push(condition);
  console.log((condition ? '  PASS  ' : '  FAIL  ') + name + (detail ? '  -> ' + detail : ''));
};

console.log('=== 发布物脱敏与元数据验证 ===\n');
ok('UserScript 元数据版本与 package.json 一致',
  !!metaVersion && metaVersion === pkg.version, metaVersion + ' / ' + pkg.version);
ok('仅授权访问 DeepSeek API',
  /^\/\/ @connect\s+api\.deepseek\.com$/m.test(source) &&
  !/^\/\/ @connect\s+\*$/m.test(source));
ok('API Key 默认值为空', /apiKey:\s*''/.test(source));
ok('使用通用作者与项目命名空间',
  /@author\s+Beeline AI Quiz Contributors/.test(source) &&
  /@namespace\s+https:\/\/github\.com\/zzs4057\/beeline-ai-quiz/.test(source));
ok('不包含常见真实令牌格式',
  !/(?:ghp_|gho_|github_pat_|AKIA)[A-Za-z0-9_-]{10,}/.test(source) &&
  !/sk-[A-Za-z0-9]{16,}/.test(source));
ok('不包含本机绝对路径',
  !/(?:[A-Za-z]:[\\/](?:Users|Codex data|deepseek)|\\Users\\|\\Codex data\\)/.test(source));
ok('诊断信息不输出 API Key 前缀',
  !/apiKey\.slice\s*\(/.test(source));
ok('仓库包含详细 API 配置文档',
  fs.existsSync(new URL('docs/configuration.md', root)) &&
  /DeepSeek API key/i.test(fs.readFileSync(new URL('docs/configuration.md', root), 'utf8')));
ok('仓库包含安全政策与许可证',
  fs.existsSync(new URL('SECURITY.md', root)) &&
  fs.existsSync(new URL('LICENSE', root)));

console.log(`\n结果：${checks.filter(Boolean).length}/${checks.length} 通过`);
process.exitCode = checks.some((value) => !value) ? 1 : 0;
