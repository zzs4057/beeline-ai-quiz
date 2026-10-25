// 专项复现：判断题（input.value = "T"/"F"）勾选校验失败
//
// 用户实测：
//   诊断输出显示 [A] input value=T checked=true、[F] input value=F
//   日志报错：勾选校验未通过（期望 A，实际 ，缺 A）
//
// 根因：AI 返回 A（提示词里选项按位置编号 A/B），脚本去勾第 1 个选项，
//       但校验时读 input.value 得到 "T"，与 /^[A-H]$/ 不匹配 → 判定为空。
// 修复：字母一律以**位置序号**为准，不读平台 value。
'use strict';
import fs from 'node:fs';
import vm from 'node:vm';

const SRC = fs.readFileSync(new URL('../beeline-ai-quiz.user.js', import.meta.url), 'utf8');

function matchOne(el, s) {
  let rest = s;
  const tagM = rest.match(/^[a-zA-Z][a-zA-Z0-9]*/);
  if (tagM) { if (el.tagName !== tagM[0].toUpperCase()) return false; rest = rest.slice(tagM[0].length); }
  const parts = rest.match(/\.[\w-]+|\[[^\]]+\]/g) || [];
  if (!parts.length) return !!tagM;
  for (const p of parts) {
    if (p.startsWith('.')) { if (!(el.className || '').split(/\s+/).includes(p.slice(1))) return false; }
    else {
      const inner = p.slice(1, -1);
      const m = inner.match(/^([\w-]+)([*^$]?)=(?:"([^"]*)"|'([^']*)'|([^\]]*))$/);
      if (m) {
        const want = m[3] !== undefined ? m[3] : (m[4] !== undefined ? m[4] : m[5]);
        const actual = m[1] === 'class' ? (el.className || '') : (el.getAttribute(m[1]) || '');
        if (m[2] === '*') { if (!String(actual).includes(want)) return false; }
        else if (String(actual) !== want) return false;
      } else if (!el.getAttribute(inner)) return false;
    }
  }
  return true;
}
function matchSel(el, sel) {
  for (const s of sel.split(',').map((x) => x.trim())) {
    if (!s) continue; if (s === '*') return true; if (matchOne(el, s)) return true;
  }
  return false;
}

class El {
  constructor(tag, o = {}) {
    this.tagName = (tag || 'div').toUpperCase(); this.nodeType = 1;
    this.id = o.id || ''; this.className = o.className || '';
    this.children = []; this.parentElement = null;
    this._text = o.text || ''; this.attrs = o.attrs || {};
    this.isConnected = true;
    this._rect = o.rect || { left: 10, top: 10, width: 400, height: 40 };
    this._bg = o.bg || 'rgba(0,0,0,0)';
    this.checked = !!o.checked; this.type = o.type || ''; this.value = o.value || '';
    this.disabled = false;
    this.style = { cssText: '', setProperty() {} };
    const self = this;
    this.classList = {
      add(c) { if (!this.contains(c)) self.className = (self.className + ' ' + c).trim(); },
      remove(c) { self.className = self.className.split(/\s+/).filter((x) => x !== c).join(' '); },
      toggle(c, f) { if (f === undefined) f = !this.contains(c); if (f) this.add(c); else this.remove(c); },
      contains(c) { return (self.className || '').split(/\s+/).includes(c); },
    };
  }
  set innerHTML(v) { this._html = v; } get innerHTML() { return this._html || ''; }
  get textContent() { return this._text + this.children.map((c) => c.textContent || '').join(''); }
  set textContent(v) { this._text = v; }
  get innerText() { return this.textContent; }
  appendChild(c) { c.parentElement = this; this.children.push(c); return c; }
  remove() { this.isConnected = false; }
  addEventListener(t, fn) { (this._ls = this._ls || {})[t] = ((this._ls || {})[t] || []).concat(fn); }
  removeEventListener() {}
  fire(t, ev) { ((this._ls || {})[t] || []).forEach((fn) => { try { fn(ev || { type: t }); } catch (e) {} }); }
  getAttribute(k) { return this.attrs[k] !== undefined ? this.attrs[k] : null; }
  setAttribute(k, v) { this.attrs[k] = v; }
  getBoundingClientRect() {
    const r = this._rect;
    return this.isConnected ? { left: r.left, top: r.top, width: r.width, height: r.height,
      right: r.left + r.width, bottom: r.top + r.height } : { left: 0, top: 0, width: 0, height: 0 };
  }
  contains(el) { let p = el; while (p) { if (p === this) return true; p = p.parentElement; } return false; }
  closest(sel) { let p = this; while (p) { if (matchSel(p, sel)) return p; p = p.parentElement; } return null; }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  querySelectorAll(sel) {
    const out = []; const walk = (n) => { for (const c of n.children) { if (matchSel(c, sel)) out.push(c); walk(c); } };
    walk(this); return out;
  }
  click() { if (this._onClick) this._onClick(this); return true; }
  dispatchEvent(ev) {
    if (ev && ev.type === 'click') {
      if (this._onClick) this._onClick(this);
      let p = this.parentElement;
      while (p) { if (p._onClick) { p._onClick(p); break; } p = p.parentElement; }
    }
    return true;
  }
}

// 构造判断题页面：两个选项，value = T / F，序号不渲染字母
function buildJudgePage() {
  const doc = new El('#document');
  doc.nodeType = 9; doc.readyState = 'complete';
  const html = new El('html'); const body = new El('body');
  doc.documentElement = html; doc.body = body; doc.head = new El('head');
  html.appendChild(body); doc.appendChild(html);
  doc.createElement = (t) => new El(t);
  doc.addEventListener = () => {}; doc.hasFocus = () => true;
  doc.querySelectorAll = (sel) => { const out = []; const walk = (n) => { for (const c of n.children) { if (matchSel(c, sel)) out.push(c); walk(c); } }; walk(doc); return out; };
  doc.querySelector = (sel) => doc.querySelectorAll(sel)[0] || null;
  doc.getElementById = (id) => doc.querySelectorAll('#' + id)[0] || null;

  const box = new El('div', { className: 'question-box', rect: { left: 40, top: 400, width: 1300, height: 300 } });
  const stem = new El('div', { className: 'topic-title', text: '1.操作玻璃仪器时应先检查是否完好。（ ）',
    rect: { left: 60, top: 430, width: 1100, height: 40 } });
  box.appendChild(stem); body.appendChild(box);

  const group = [];
  const nodes = [];
  // ★ 关键：value 是 T / F（判断题），选项文字是"正确"/"错误"，没有 A./B. 序号
  [['T', '正确'], ['F', '错误']].forEach(([val, text], i) => {
    const label = new El('label', { className: 'el-radio el-radio--default',
      rect: { left: 48, top: 426 + i * 60, width: 1336, height: 55 } });
    const inp = new El('input', { type: 'radio', value: val, rect: { left: 0, top: 0, width: 16, height: 19 } });
    inp._ownerLabel = label; inp._group = group;
    group.push(inp);
    const wrap = new El('span', { className: 'el-radio__input' });
    wrap.appendChild(inp);
    // 注意：**没有** .index-name 元素（复现用户平台）
    const lbl = new El('span', { className: 'el-radio__label', text: text,
      rect: { left: 80, top: 438 + i * 60, width: 200, height: 30 } });
    label.appendChild(wrap); label.appendChild(lbl);
    const commit = () => {
      group.forEach((g) => { if (g !== inp) { g.checked = false; g._ownerLabel.classList.remove('is-checked'); } });
      inp.checked = true; label.classList.add('is-checked');
    };
    inp.click = () => { commit(); return true; };
    label.click = () => { commit(); return true; };
    inp._onClick = () => { commit(); };
    label._onClick = () => { commit(); };
    box.appendChild(label); nodes.push({ node: label, inp });
  });

  // 下一题按钮
  const nextBtn = new El('button', { className: 'el-button', rect: { left: 900, top: 900, width: 90, height: 36 } });
  nextBtn.appendChild(new El('span', { text: '下一题', rect: { left: 910, top: 905, width: 70, height: 26 } }));
  body.appendChild(nextBtn);

  doc.elementFromPoint = (x, y) => {
    let best = null, bestArea = Infinity;
    const all = []; const walk = (n) => { for (const c of n.children) { all.push(c); walk(c); } };
    walk(doc);
    for (const el of all) {
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      if (x < r.left || x > r.right || y < r.top || y > r.bottom) continue;
      const area = r.width * r.height;
      if (area < bestArea) { best = el; bestArea = area; }
    }
    return best;
  };
  return { doc, body, box, group, nodes };
}

function run(page) {
  const timers = []; let now = 1_700_000_000_000;
  class FD extends Date { constructor(...a) { super(...(a.length ? a : [now])); } static now() { return now; } }
  const store = { BLQ_CFG_V1: JSON.stringify({ enabled: true, apiKey: 'test-placeholder-token', thinkMin: 0, thinkMax: 0,
    delayAfterAnswer: 0, delayAfterNext: 0 }) };
  const errors = []; const logs = [];
  const sb = {
    document: page.doc, Date: FD, innerWidth: 2549, innerHeight: 1422,
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
    Event: class { constructor(t, o) { Object.assign(this, o || {}); this.type = t; } },
    getComputedStyle: (el) => ({
      display: 'flex', visibility: 'visible',
      opacity: (el && el.tagName === 'INPUT') ? '0' : '1',
      pointerEvents: 'auto', cursor: 'auto',
      backgroundColor: 'rgba(0,0,0,0)', color: 'rgb(29,33,41)', borderColor: 'rgba(0,0,0,0)',
    }),
    HTMLMediaElement: El,
    location: { reload() {}, hash: '' },
    navigator: { clipboard: { writeText: () => Promise.resolve() } },
    Math, JSON, Object, Array, String, Number, Promise, isFinite, parseFloat, parseInt, WeakMap, Error, RegExp, Set,
    GM_getValue: (k, d) => (k in store ? store[k] : d),
    GM_setValue: (k, v) => { store[k] = String(v); },
    GM_deleteValue: (k) => { delete store[k]; },
    GM_xmlhttpRequest: (o) => {
      sb.setTimeout(() => o.onload({ status: 200, responseText: JSON.stringify({
        choices: [{ message: { content: 'A' }, finish_reason: 'stop' }] }) }), 5);
    },
  };
  sb.window = sb; sb.globalThis = sb; sb.top = sb; sb.self = sb;
  const ctx = vm.createContext(sb);
  const exposed = SRC.replace('function boot() {',
    'globalThis.__api = { readQuestion, extractOptions, selectedLetters, selectOption, ' +
    'answerCurrent, verifySelection, letterByIndex, nativeLetterOf, fingerprint }; function boot() {');
  let threw = null;
  try { vm.runInContext(exposed, ctx, { filename: 'blq.js' }); } catch (e) { threw = e; }
  async function advance(ms) {
    const end = now + ms; let g = 0;
    while (g++ < 50000) {
      const due = timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at);
      if (!due.length) { now = end; break; }
      const t = due[0]; now = Math.max(now, t.at);
      if (t.every) { t.at = now + t.every; } else { timers.splice(timers.indexOf(t), 1); }
      try { t.fn(); } catch (e) {}
      await Promise.resolve(); await Promise.resolve();
    }
    now = end;
  }
  return { sb, threw, errors, logs, advance };
}

const checks = [];
const ok = (n, c, x) => { checks.push(c); console.log((c ? '  PASS  ' : '  FAIL  ') + n + (x ? '  → ' + x : '')); };

console.log('=== 判断题（input.value = T/F）复现与验证 ===\n');

const page = buildJudgePage();
const r = run(page);
ok('脚本加载无异常', !r.threw, r.threw ? r.threw.message : 'ok');
const api = r.sb.__api;

const q = api.readQuestion();
console.log('  [诊断] 题干 = ' + (q ? q.stem.slice(0, 40) : 'null'));
console.log('  [诊断] 选项 = ' + (q ? q.options.map((o) => o.letter + ':' + o.text).join(' | ') : 'null'));
console.log('  [诊断] 平台自带字母 = ' + (q ? q.options.map((o) => o.nativeLetter).join(', ') : 'null'));
console.log('');

ok('识别出 2 个选项', q && q.options.length === 2, q ? String(q.options.length) : 'null');
ok('脚本用位置字母 A/B（不跟随平台 T/F）',
  q && q.options.map((o) => o.letter).join('') === 'AB',
  q ? q.options.map((o) => o.letter).join('') : 'null');
ok('选项文字被正确提取',
  q && q.options[0].text === '正确' && q.options[1].text === '错误',
  q ? q.options.map((o) => o.text).join('/') : 'null');
ok('诊断能读出平台自带字母 T/F 供排查',
  q && q.options[0].nativeLetter === 'T' && q.options[1].nativeLetter === 'F',
  q ? q.options.map((o) => o.nativeLetter).join('/') : 'null');

// 核心：勾选 A 后必须能读回 A
console.log('\n【核心】勾选 A（第 1 个选项）');
{
  api.selectOption(q.options[0]);
  const sel = api.selectedLetters(q.box);
  console.log('  [诊断] 勾选后 selectedLetters = ' + JSON.stringify(sel.join('')));
  console.log('  [诊断] 底层状态: T.checked=' + page.group[0].checked +
    ' F.checked=' + page.group[1].checked);
  ok('勾选 A 后能读回 A（旧版返回空）', sel.join('') === 'A', sel.join('') || '（空）');
  ok('校验通过', api.verifySelection(q.box, ['A']) === true);
  ok('底层 input 确实被选中', page.group[0].checked === true);
}

// 端到端
console.log('\n【端到端】answerCurrent 应成功勾选并校验通过');
{
  const p2 = buildJudgePage();
  const r2 = run(p2);
  const api2 = r2.sb.__api;
  const q2 = api2.readQuestion();
  let res = null;
  const pr = api2.answerCurrent('manual').then((x) => { res = x; }, (e) => { res = { err: e.message }; });
  (async () => {
    for (let i = 0; i < 100; i++) { await r2.advance(50); }
    await pr;
    console.log('  [诊断] answerCurrent 返回 = ' + JSON.stringify(res));
    const sel = api2.selectedLetters(q2.box);
    console.log('  [诊断] 最终勾选 = ' + JSON.stringify(sel.join('')));
    console.log('  [诊断] 日志末 4 条:');
    r2.logs.slice(-4).forEach((l) => console.log('       ' + l));
    ok('answerCurrent 成功（ok=true）', res && res.ok === true, JSON.stringify(res));
    ok('最终勾选为 A', sel.join('') === 'A', sel.join('') || '（空）');
    ok('没有"校验未通过"错误', !r2.logs.some((l) => /校验未通过/.test(l)),
      r2.logs.filter((l) => /校验/.test(l)).length + ' 条校验日志');

    console.log('\n结果：' + checks.filter(Boolean).length + '/' + checks.length + ' 通过');
    process.exitCode = checks.some((c) => !c) ? 1 : 0;
  })();
}
