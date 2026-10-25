// 回归测试：覆盖多线程审计（4 审计员 + 1 对抗验证）发现的全部已修缺陷
// 每个用例对应一条审计发现，确保"改过的地方不会退回"
'use strict';
import fs from 'node:fs';
import vm from 'node:vm';

const SRC = fs.readFileSync(new URL('../beeline-ai-quiz.user.js', import.meta.url), 'utf8');

function extractFn(name) {
  const start = SRC.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('未找到 ' + name);
  let i = SRC.indexOf('{', start), depth = 0, end = -1;
  for (; i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  return SRC.slice(start, end);
}
function extractConst(name) {
  const m = SRC.match(new RegExp('const ' + name + ' = (\\/\\^.*?\\$\\/i);', 's'));
  if (!m) throw new Error('未找到常量 ' + name);
  return m[1];
}

// 构造 parseAnswer + isCacheable
const parseAnswer = new Function(
  'const EN_STOP = ' + extractConst('EN_STOP') + ';\n' +
  extractFn('parseAnswer') + '\nreturn parseAnswer;')();
const isCacheable = new Function('return ' + extractFn('isCacheable'))();

const checks = [];
const ok = (n, c, x) => { checks.push(c); console.log((c ? '  PASS  ' : '  FAIL  ') + n + (x ? '  → ' + x : '')); };

const mkQ = (type, n) => ({ type, options: Array.from({ length: n }, (_, i) => ({ letter: String.fromCharCode(65 + i) })) });
const q4m = mkQ('multi', 4), q4s = mkQ('single', 4), q5s = mkQ('single', 5);
const P = (input, q) => parseAnswer(input, q);

console.log('════════ 审计缺陷回归测试 ════════\n');

// ─────────────────────────────────────────────────
console.log('【audit-C／严重1】多答案必须全部收集（旧版 break 只取第一个）');
{
  const cases = [
    ['1. A  2. B  3. C', 'ABC'],
    ['1. A\n2. B', 'AB'],
    ['A. 甲  B. 乙', 'AB'],
    ['答案：A、B、C', 'ABC'],
  ];
  let pass = 0;
  for (const [inp, want] of cases) {
    const got = P(inp, q4m).letters.join('');
    if (got === want) pass++;
    else console.log('     ✗ ' + JSON.stringify(inp) + ' → ' + JSON.stringify(got) + '，期望 ' + want);
  }
  ok('多答案全部收集 ' + pass + '/' + cases.length, pass === cases.length, pass + '/' + cases.length);
}

// ─────────────────────────────────────────────────
console.log('\n【audit-C／严重2+4】英文散文不得被当成答案（旧版 He is a good boy → E）');
{
  const prose = [
    ['He is a good boy', q5s],
    ['This is a hard question', q5s],
    ['He is a good boy', q4s],
    ['A good answer is B', q4s],
    ['I think the answer should be considered carefully', q4s],
  ];
  let pass = 0;
  for (const [inp, q] of prose) {
    const got = P(inp, q).letters.join('');
    if (got === '') pass++;
    else console.log('     ✗ ' + JSON.stringify(inp) + ' → ' + JSON.stringify(got) + '，期望空');
  }
  ok('散文被保守拒绝 ' + pass + '/' + prose.length, pass === prose.length, pass + '/' + prose.length);
}

// ─────────────────────────────────────────────────
console.log('\n【audit-C／严重3】低置信度答案不得进入缓存');
{
  // 高可信 → 可缓存
  const hi = P('AC', q4m);
  ok('高可信可缓存', isCacheable(hi, q4m) === true, 'conf=' + hi.confidence);
  // 散文/无解析 → 不可缓存
  const none = P('He is a good boy', q5s);
  ok('无解析结果不可缓存', isCacheable(none, q5s) === false, 'conf=' + none.confidence);
  // 单选多字母（有猜错风险）→ 不可缓存
  const risky = P('AB', q4s);
  ok('单选多字母（低可信）不可缓存', isCacheable(risky, q4s) === false,
    'conf=' + risky.confidence + ' letters=' + risky.letters.join(''));
  // 多选单字母 → 允许（真只有一个正确项很常见）
  const multi1 = P('A', q4m);
  ok('多选单字母（medium）可缓存', isCacheable(multi1, q4m) === true, 'conf=' + multi1.confidence);
}

// ─────────────────────────────────────────────────
console.log('\n【audit-C 对照】正常输出必须仍然正确（防止修复过度）');
{
  const normal = [
    ['AC', q4m, 'AC'], ['ac', q4m, 'AC'], ['A,C', q4m, 'AC'], ['A、C', q4m, 'AC'],
    ['A 和 C', q4m, 'AC'], ['答案：AC', q4m, 'AC'], ['正确答案是B', q4s, 'B'],
    ['**B**', q4s, 'B'], ['B.', q4s, 'B'], ['答案：B', q4s, 'B'],
    ['ABCD', q4m, 'ABCD'],
  ];
  let pass = 0;
  for (const [inp, q, want] of normal) {
    const got = P(inp, q).letters.join('');
    if (got === want) pass++;
    else console.log('     ✗ ' + JSON.stringify(inp) + ' → ' + JSON.stringify(got) + '，期望 ' + want);
  }
  ok('正常输出全部正确 ' + pass + '/' + normal.length, pass === normal.length, pass + '/' + normal.length);
}

// ─────────────────────────────────────────────────
console.log('\n【audit-C 边界】空/异常输入必须安全');
{
  let pass = 0;
  for (const inp of ['', '   ', null, undefined, '。。。', '12345', '\n\n', '?']) {
    try {
      const r = P(inp, q4s);
      if (r.letters.length === 0) pass++;
      else console.log('     ✗ ' + JSON.stringify(inp) + ' → ' + JSON.stringify(r.letters.join('')));
    } catch (e) {
      console.log('     ✗ ' + JSON.stringify(inp) + ' 抛异常: ' + e.message);
    }
  }
  ok('空/异常输入安全返回空 ' + pass + '/8', pass === 8, pass + '/8');
}

// ─────────────────────────────────────────────────
console.log('\n【audit-D／P0-1】isOwnUI 必须存在且能识别面板元素');
{
  ok('源码中存在 isOwnUI', SRC.indexOf('function isOwnUI') >= 0);
  ok('clickEl 内有 isOwnUI 防线', /function clickEl[\s\S]{0,300}isOwnUI\(el\)/.test(SRC));
  ok('findNavButton 内排除自身 UI', /function findNavButton[\s\S]{0,1200}isOwnUI\(el\)/.test(SRC));
}

// ─────────────────────────────────────────────────
console.log('\n【audit-D／发现7】dryRun 必须阻止翻页');
{
  ok('goNext 内有 dryRun 判断', /async function goNext[\s\S]{0,400}cfg\.dryRun/.test(SRC));
}

// ─────────────────────────────────────────────────
console.log('\n【audit-A／高4 + 对抗验证漏报】selectedLetters 不得依赖下标换算');
{
  ok('selectedLetters 不再用 indexOf 换算', !/function selectedLetters[\s\S]{0,600}\.indexOf\(node\)/.test(SRC));
  ok('存在 letterOfOptionNode 直接取字母', SRC.indexOf('function letterOfOptionNode') >= 0);
}

// ─────────────────────────────────────────────────
console.log('\n【audit-B／B1】停止必须能中断进行中的题目');
{
  ok('存在 aborted() 中断检查', SRC.indexOf('function aborted()') >= 0);
  ok('answerCurrent 内检查中断', /async function answerCurrent[\s\S]{0,800}aborted\(\)/.test(SRC));
  ok('停顿后再次检查中断', /await sleep\(think\)[\s\S]{0,300}aborted\(\)/.test(SRC));
  ok('goNext 内检查中断', /async function goNext[\s\S]{0,600}aborted\(\)/.test(SRC));
  ok('stopLoop 会置位 stopRequested', /function stopLoop[\s\S]{0,300}stopRequested = true/.test(SRC));
}

// ─────────────────────────────────────────────────
console.log('\n【audit-B／B2】失败上限必须在 continue 之前求值');
{
  const loopBody = SRC.slice(SRC.indexOf('async function runLoop'), SRC.indexOf('function stopLoop'));
  const failsIdx = loopBody.indexOf('S.fails >= 3');
  const rateIdx = loopBody.indexOf("r.why === 'rate-limit'");
  const aiErrIdx = loopBody.indexOf("r.why === 'ai-error'");
  ok('fails>=3 检查先于 rate-limit 分支', failsIdx > 0 && failsIdx < rateIdx,
    'fails@' + failsIdx + ' rate@' + rateIdx);
  ok('fails>=3 检查先于 ai-error 分支', failsIdx > 0 && failsIdx < aiErrIdx,
    'fails@' + failsIdx + ' aiErr@' + aiErrIdx);
}

// ─────────────────────────────────────────────────
console.log('\n【audit-D／发现3 + Lead 自查】只补选不取消 必须已修');
{
  ok('存在 deselectOption', SRC.indexOf('function deselectOption') >= 0);
  ok('answerCurrent 会取消多余选项', /deselectOption\(map\[L\]\)/.test(SRC));
  ok('"有勾选就跳过"改为比对答案', /cached && picked\.join\(''\) !== cached/.test(SRC));
}

// ─────────────────────────────────────────────────
console.log('\n【audit-D／发现1】导航按钮禁用判据必须完整');
{
  ok('存在 isNavDisabled', SRC.indexOf('function isNavDisabled') >= 0);
  ok('检查 aria-disabled', /function isNavDisabled[\s\S]{0,800}aria-disabled/.test(SRC));
  ok('检查 is-loading', /function isNavDisabled[\s\S]{0,800}is-loading/.test(SRC));
  ok('检查 pointer-events', /function isNavDisabled[\s\S]{0,1200}pointerEvents/.test(SRC));
}

// ─────────────────────────────────────────────────
console.log('\n【audit-A／高1】findQuestionBox 必须排除祖先容器');
{
  // 真正的功能验证在 verify-nested.mjs（构造嵌套 DOM 实跑）。
  // 这里只做"实现存在性"检查，且必须匹配到实际代码而非泛词。
  const fn = SRC.slice(SRC.indexOf('function findQuestionBox'), SRC.indexOf('function extractOptions'));
  ok('存在"排除嵌套容器"的实现（isNestedContainer）', /isNestedContainer/.test(fn));
  ok('实际过滤了被其他候选包含的元素', /nonNested|cands\.filter/.test(fn));
}

console.log('\n════════════════════════════════════');
console.log('结果：' + checks.filter(Boolean).length + '/' + checks.length + ' 通过');
process.exitCode = checks.some((c) => !c) ? 1 : 0;
