// 验证 DeepSeek 请求适配：
//   ① 只发送标准 chat/completions 字段
//   ② reasoner 自动提高 max_tokens 预算
//   ③ 空 content 时给出可操作错误
'use strict';
import fs from 'node:fs';
import vm from 'node:vm';

const SRC = fs.readFileSync(new URL('../beeline-ai-quiz.user.js', import.meta.url), 'utf8');

class El {
  constructor(tag, o = {}) {
    this.tagName = (tag || 'div').toUpperCase(); this.nodeType = 1;
    this.className = o.className || ''; this.id = o.id || '';
    this.children = []; this.parentElement = null;
    this._text = o.text || ''; this.attrs = {};
    this.isConnected = true; this._rect = o.rect || { left: 0, top: 0, width: 100, height: 30 };
    this.style = { cssText: '', setProperty() {} };
    const self = this;
    this.classList = {
      contains(c) { return (self.className || '').split(/\s+/).includes(c); },
      add() {}, remove() {}, toggle() {},
    };
  }
  get textContent() { return this._text + this.children.map((c) => c.textContent || '').join(''); }
  set textContent(v) { this._text = v; }
  appendChild(c) { c.parentElement = this; this.children.push(c); return c; }
  addEventListener() {} removeEventListener() {}
  getAttribute(k) { return this.attrs[k] !== undefined ? this.attrs[k] : null; }
  setAttribute(k, v) { this.attrs[k] = v; }
  getBoundingClientRect() { return this._rect; }
  closest() { return null; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  click() {} dispatchEvent() { return true; }
}

function run(httpHandler, model) {
  const timers = []; let now = 1_700_000_000_000;
  class FD extends Date { constructor(...a) { super(...(a.length ? a : [now])); } static now() { return now; } }
  const store = {};
  const cfgStore = {
    apiKey: 'test-placeholder-token',
    apiBase: 'https://api.deepseek.com/v1',
    model: model || 'deepseek-reasoner',
    maxTokens: 512,
  };
  store['BLQ_CFG_V1'] = JSON.stringify(cfgStore);
  const errors = []; const logs = [];
  const sb = {
    document: (() => { const d = new El('#document'); d.nodeType = 9; d.readyState = 'complete';
      const html = new El('html'); const body = new El('body');
      d.documentElement = html; d.body = body; d.head = new El('head');
      html.appendChild(body); d.appendChild(html);
      d.createElement = (t) => new El(t); d.addEventListener = () => {}; d.hasFocus = () => true;
      d.querySelectorAll = () => []; d.querySelector = () => null; d.getElementById = () => null;
      return d; })(),
    Date: FD, innerWidth: 1200, innerHeight: 800,
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    console: { log: (...a) => logs.push(a.join(' ')), error: (...a) => errors.push(a.join(' ')), warn: (...a) => errors.push(a.join(' ')) },
    setTimeout: (fn, ms) => { const id = timers.length + 1; timers.push({ id, fn, at: now + (ms || 0) }); return id; },
    clearTimeout: (id) => { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); },
    setInterval: () => 0, clearInterval: () => {},
    MutationObserver: class { observe() {} disconnect() {} },
    PointerEvent: class { constructor(t, o) { Object.assign(this, o || {}); this.type = t; } },
    MouseEvent: class { constructor(t, o) { Object.assign(this, o || {}); this.type = t; } },
    KeyboardEvent: class { constructor(t, o) { Object.assign(this, o || {}); this.type = t; } },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1', pointerEvents: 'auto',
      cursor: 'auto', backgroundColor: 'rgba(0,0,0,0)', color: '#000', borderColor: 'rgba(0,0,0,0)' }),
    HTMLMediaElement: El,
    location: { reload() {}, hash: '' },
    navigator: { clipboard: { writeText: () => Promise.resolve() } },
    Math, JSON, Object, Array, String, Number, Promise, isFinite, parseFloat, WeakMap, Error, RegExp, Set,
    GM_getValue: (k, d) => (k in store ? store[k] : d),
    GM_setValue: (k, v) => { store[k] = String(v); },
    GM_deleteValue: (k) => { delete store[k]; },
    GM_xmlhttpRequest: (o) => {
      sb.setTimeout(() => {
        try { httpHandler(o); } catch (e) { errors.push('handler: ' + e.message); }
      }, 5);
    },
  };
  sb.window = sb; sb.globalThis = sb; sb.top = sb; sb.self = sb;
  const ctx = vm.createContext(sb);
  const exposed = SRC.replace('function boot() {',
    'globalThis.__api = { askAI, getSentBody: () => lastBody, getSentUrl: () => lastUrl }; ' +
    'let lastBody = null, lastUrl = ""; ' +
    'const _origGmr = GM_xmlhttpRequest; ' +
    'GM_xmlhttpRequest = function(o) { lastUrl = o.url; try { lastBody = JSON.parse(o.data); } catch (e) {} return _origGmr(o); }; ' +
    'function boot() {');
  let threw = null;
  try { vm.runInContext(exposed, ctx, { filename: 'blq.js' }); } catch (e) { threw = e; }
  async function advance(ms) {
    const end = now + ms; let g = 0;
    while (g++ < 20000) {
      const due = timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at);
      if (!due.length) { now = end; break; }
      const t = due[0]; now = Math.max(now, t.at);
      timers.splice(timers.indexOf(t), 1);
      try { t.fn(); } catch (e) {}
      await Promise.resolve(); await Promise.resolve();
    }
    now = end;
  }
  return { sb, threw, errors, logs, advance, store };
}

const Q = {
  type: 'single',
  stem: '1.测试题：下列哪个是正确答案？',
  options: [{ letter: 'A', text: '甲' }, { letter: 'B', text: '乙' },
    { letter: 'C', text: '丙' }, { letter: 'D', text: '丁' }],
};

const checks = [];
const ok = (n, c, x) => { checks.push(c); console.log((c ? '  PASS  ' : '  FAIL  ') + n + (x ? '  → ' + x : '')); };

console.log('=== 思考模型适配验证 ===\n');

// ---- ① reasoner 使用标准字段并提高预算 ----
console.log('【请求体】deepseek-reasoner 应使用标准请求体并提高预算');
{
  const r = run((o) => {
    // 模拟正常返回
    o.onload({ status: 200, responseText: JSON.stringify({
      choices: [{ message: { content: 'B' }, finish_reason: 'stop' }] }) });
  });
  const p = r.sb.__api.askAI(Q);
  (async () => {
    for (let i = 0; i < 30; i++) { await r.advance(100); }
    const body = r.sb.__api.getSentBody();
    console.log('  [诊断] body.thinking = ' + JSON.stringify(body.thinking));
    console.log('  [诊断] body.max_tokens = ' + body.max_tokens);
    console.log('  [诊断] body.reasoning_effort = ' + JSON.stringify(body.reasoning_effort));
    ok('不发送非标准 thinking 字段', body.thinking === undefined,
      JSON.stringify(body.thinking));
    ok('reasoner max_tokens 兜底加大到 >= 2048', body.max_tokens >= 2048, String(body.max_tokens));
    ok('不发送非标准 reasoning_effort 字段', body.reasoning_effort === undefined,
      JSON.stringify(body.reasoning_effort));

    // ---- ② 思考模型返回空 content + 有 reasoning_content → 可操作错误 ----
    console.log('\n【错误诊断】content 空 + reasoning_content 有值 → 提示调大 max_tokens');
    {
      const r2 = run((o) => {
        o.onload({ status: 200, responseText: JSON.stringify({
          choices: [{ message: { reasoning_content: '让我想想……甲乙丙丁……', content: '' }, finish_reason: 'length' }] }) });
      });
      let got = '';
      const p2 = r2.sb.__api.askAI(Q).catch((e) => { got = e.message; });
      for (let i = 0; i < 30; i++) { await r2.advance(100); }
      await p2;
      console.log('  [诊断] 错误信息 = ' + got.slice(0, 80));
      ok('错误提示包含 max_tokens 建议', /max_tokens/.test(got), got.slice(0, 60));
      ok('错误提示包含 finish_reason', /finish_reason/.test(got));
    }

    // ---- ③ 非思考模型不带 thinking 字段 ----
    console.log('\n【非思考模型】不应带 thinking 字段（避免不兼容）');
    {
      const r3 = run((o) => {
        o.onload({ status: 200, responseText: JSON.stringify({
          choices: [{ message: { content: 'A' }, finish_reason: 'stop' }] }) });
      }, 'deepseek-chat');
      const p3 = r3.sb.__api.askAI(Q);
      for (let i = 0; i < 30; i++) { await r3.advance(100); }
      const body3 = r3.sb.__api.getSentBody();
      console.log('  [诊断] body.thinking = ' + JSON.stringify(body3.thinking));
      ok('非思考模型不带 thinking', body3.thinking === undefined, JSON.stringify(body3.thinking));
      ok('非思考模型保留用户 max_tokens', body3.max_tokens === 512, String(body3.max_tokens));
    }

    // ---- ④ 完全空响应 → 提示检查模型名 ----
    console.log('\n【空响应】finish_reason 未知 → 提示检查模型名/拉模型列表');
    {
      const r4 = run((o) => {
        o.onload({ status: 200, responseText: JSON.stringify({ choices: [{ message: {} }] }) });
      });
      let got4 = '';
      const p4 = r4.sb.__api.askAI(Q).catch((e) => { got4 = e.message; });
      for (let i = 0; i < 30; i++) { await r4.advance(100); }
      await p4;
      console.log('  [诊断] 错误信息 = ' + got4.slice(0, 80));
      ok('提示包含检查模型名', /模型名/.test(got4), got4.slice(0, 60));
    }

    console.log('\n结果：' + checks.filter(Boolean).length + '/' + checks.length + ' 通过');
    process.exitCode = checks.some((c) => !c) ? 1 : 0;
  })();
}
