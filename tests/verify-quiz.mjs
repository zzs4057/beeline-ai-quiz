// 自动答题脚本验证：
//   ① 题型识别（单选/多选）是否准确
//   ② 题干与选项提取是否正确
//   ③ 提示词构造是否合理
//   ④ AI 各种"不听话"的输出能否稳健解析
//   ⑤ 答题卡识别与"已满"判断
//   ⑥ 翻页与终止条件
'use strict';
import fs from 'node:fs';
import vm from 'node:vm';

const SRC = fs.readFileSync(new URL('../beeline-ai-quiz.user.js', import.meta.url), 'utf8');

// ---------- 通用选择器匹配 ----------
function matchOne(el, s) {
  let rest = s;
  const tagM = rest.match(/^[a-zA-Z][a-zA-Z0-9]*/);
  if (tagM) { if (el.tagName !== tagM[0].toUpperCase()) return false; rest = rest.slice(tagM[0].length); }
  const parts = rest.match(/\.[\w-]+|\[[^\]]+\]/g) || [];
  if (!parts.length) return !!tagM;
  for (const p of parts) {
    if (p.startsWith('.')) {
      if (!(el.className || '').split(/\s+/).includes(p.slice(1))) return false;
    } else {
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
    if (!s) continue;
    if (s === '*') return true;
    if (matchOne(el, s)) return true;
  }
  return false;
}

class El {
  constructor(tag, o = {}) {
    this.tagName = (tag || 'div').toUpperCase(); this.nodeType = 1;
    this.id = o.id || ''; this.className = o.className || '';
    this.children = []; this.parentElement = null;
    this._text = o.text || ''; this._html = '';
    this.attrs = o.attrs || {};
    this.isConnected = o.connected !== false;
    this._rect = o.rect || { left: 10, top: 10, width: 400, height: 40 };
    this._bg = o.bg || 'rgba(0,0,0,0)';
    this._color = o.color || 'rgb(29,33,41)';
    this.checked = !!o.checked;
    this.type = o.type || '';
    this.value = o.value !== undefined ? o.value : '';
    this.disabled = !!o.disabled;
    this.style = { cssText: '', setProperty() {} };
    const self = this;
    this.classList = {
      add(c) { if (!this.contains(c)) self.className = (self.className + ' ' + c).trim(); },
      remove(c) { self.className = self.className.split(/\s+/).filter((x) => x !== c).join(' '); },
      toggle(c, f) { if (f === undefined) f = !this.contains(c); if (f) this.add(c); else this.remove(c); },
      contains(c) { return (self.className || '').split(/\s+/).includes(c); },
    };
  }
  set innerHTML(v) { this._html = v; }
  get innerHTML() { return this._html; }
  get textContent() { return this._text + this.children.map((c) => c.textContent || '').join(''); }
  set textContent(v) { this._text = v; }
  get innerText() { return this.textContent; }
  appendChild(c) { c.parentElement = this; this.children.push(c); return c; }
  remove() { this.isConnected = false; }
  addEventListener(t, fn) { (this._ls = this._ls || {})[t] = ((this._ls || {})[t] || []).concat(fn); }
  removeEventListener() {}
  fire(t, ev) { const a = (this._ls || {})[t] || []; a.forEach((fn) => { try { fn(ev || { type: t, target: this }); } catch (e) {} }); }
  getAttribute(k) { return this.attrs[k] !== undefined ? this.attrs[k] : null; }
  setAttribute(k, v) { this.attrs[k] = v; }
  getBoundingClientRect() {
    if (!this.isConnected) return { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 };
    const r = this._rect;
    return { left: r.left, top: r.top, width: r.width, height: r.height,
      right: r.left + r.width, bottom: r.top + r.height };
  }
  closest(sel) { let p = this; while (p) { if (matchSel(p, sel)) return p; p = p.parentElement; } return null; }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  querySelectorAll(sel) { return qsaFrom(this, sel); }
  click() { CLICKS.push(this); if (this.type === 'radio' || this.type === 'checkbox') this.checked = true; return true; }
  dispatchEvent(ev) { if (ev && ev.type === 'click') { CLICKS.push(this); } return true; }
}
const CLICKS = [];
function qsaFrom(root, sel) {
  const out = [];
  const walk = (n) => { for (const c of n.children) { if (matchSel(c, sel)) out.push(c); walk(c); } };
  walk(root);
  return out;
}

// ---------- 构造一个"作业页面" ----------
// type: 'single' | 'multi'
function buildQuizPage(opts = {}) {
  CLICKS.length = 0;
  const doc = new El('#document');
  doc.nodeType = 9; doc.readyState = 'complete';
  const html = new El('html'); const body = new El('body');
  doc.documentElement = html; doc.body = body; doc.head = new El('head');
  html.appendChild(body); doc.appendChild(html);
  doc.createElement = (t) => new El(t);
  doc.addEventListener = () => {};
  doc.querySelectorAll = (sel) => qsaFrom(doc, sel);
  doc.querySelector = (sel) => doc.querySelectorAll(sel)[0] || null;
  doc.getElementById = (id) => doc.querySelectorAll('#' + id)[0] || null;
  doc.hasFocus = () => true;

  const state = { index: 0, answers: {}, total: opts.total || 5, clickedOptions: [] };
  let nowFn = () => 0;   // 由 run() 注入虚拟时钟
  let pendingRender = null;

  // --- 题目区 ---
  const qWrap = new El('div', { className: 'question-box', rect: { left: 40, top: 420, width: 1400, height: 500 } });
  const typeTag = new El('span', { className: 'question-type', text: opts.type === 'multi' ? '多选' : '单选',
    rect: { left: 60, top: 440, width: 40, height: 22 } });
  const scoreEl = new El('span', { text: (opts.score || 20) + ' 分', rect: { left: 110, top: 440, width: 50, height: 22 } });
  const stemEl = new El('div', { className: 'topic-title', rect: { left: 60, top: 470, width: 1200, height: 40 } });
  qWrap.appendChild(typeTag); qWrap.appendChild(scoreEl); qWrap.appendChild(stemEl);
  body.appendChild(qWrap);

  const optWrap = new El('div', { className: 'options', rect: { left: 60, top: 520, width: 1200, height: 300 } });
  qWrap.appendChild(optWrap);

  // --- 答题卡 ---
  const card = new El('div', { className: 'answer-card', rect: { left: 1500, top: 420, width: 400, height: 400 } });
  body.appendChild(card);
  const cardItems = [];
  for (let i = 0; i < state.total; i++) {
    const it = new El('span', {
      className: 'card-num' + (i === 0 ? ' active' : ''),
      text: String(i + 1),
      rect: { left: 1520 + (i % 6) * 40, top: 450 + Math.floor(i / 6) * 40, width: 32, height: 32 },
      bg: 'rgb(255,255,255)',
      color: 'rgb(78,89,105)',
    });
    card.appendChild(it); cardItems.push(it);
  }

  // --- 翻页按钮 ---
  const prevBtn = new El('button', { text: '上一题', rect: { left: 800, top: 1200, width: 90, height: 36 } });
  const nextBtn = new El('button', { text: '下一题', rect: { left: 900, top: 1200, width: 90, height: 36 } });
  body.appendChild(prevBtn); body.appendChild(nextBtn);

  // --- 每题的题目内容 ---
  const QUESTIONS = opts.questions || [
    { stem: '1.中国的首都是哪座城市？', opts: ['上海', '北京', '广州', '深圳'], answer: 'B', type: 'single' },
    { stem: '2.下列哪些属于编程语言？', opts: ['Python', 'HTML', 'Java', 'CSS'], answer: 'AC', type: 'multi' },
    { stem: '3.水的化学式是什么？', opts: ['CO2', 'H2O', 'O2', 'NaCl'], answer: 'B', type: 'single' },
    { stem: '4.下列属于哺乳动物的有？', opts: ['鲸鱼', '鲨鱼', '蝙蝠', '企鹅'], answer: 'AC', type: 'multi' },
    { stem: '5.一年有多少个月？', opts: ['10', '11', '12', '13'], answer: 'C', type: 'single' },
  ];
  // 每题各自的题型：opts.type 可强制统一；否则按题目定义（模拟单选多选混排）
  const typeOf = (i) => opts.type || (QUESTIONS[i] && QUESTIONS[i].type) || 'single';

  let optNodes = [];
  function renderQuestion() {
    const q = QUESTIONS[state.index];
    const qType = typeOf(state.index);
    stemEl.textContent = q.stem;
    typeTag.textContent = qType === 'multi' ? '多选' : '单选';
    // 清空选项
    optWrap.children = [];
    optNodes = [];
    q.opts.forEach((t, i) => {
      const letter = String.fromCharCode(65 + i);
      const node = new El('label', {
        className: qType === 'multi' ? 'el-checkbox' : 'el-radio',
        rect: { left: 80, top: 530 + i * 46, width: 600, height: 40 },
      });
      const idx = new El('span', { className: 'index-name', text: letter + '.',
        rect: { left: 85, top: 535 + i * 46, width: 24, height: 24 } });
      const lbl = new El('span', { className: 'el-radio__label', text: t,
        rect: { left: 115, top: 535 + i * 46, width: 500, height: 24 } });
      const inp = new El('input', { type: qType === 'multi' ? 'checkbox' : 'radio', value: letter,
        rect: { left: 0, top: 0, width: 0, height: 0 } });
      node.appendChild(inp); node.appendChild(idx); node.appendChild(lbl);
      // ★ 真实浏览器语义：状态变更 = 「改变 input.checked」+「派发 change 事件」。
      //   Element UI/Vue 的 v-model 监听 change，所以两者缺一不可。
      //   桩必须模拟这一点，否则"直接赋值 checked"和"派发 change"两种手段测不出来。
      const commit = () => {
        const prev = state.answers[state.index] || '';
        if (qType === 'multi') {
          state.answers[state.index] = prev.includes(letter)
            ? prev.replace(letter, '') : (prev + letter).split('').sort().join('');
        } else {
          state.answers[state.index] = letter;
        }
        syncSelection();
        syncCard();
      };
      // input 层面：click 会切换自身 checked 并触发 change
      inp.addEventListener('change', () => { CLICKS.push(node); commit(); });
      inp.click = () => {
        if (qType === 'multi') inp.checked = !inp.checked;
        else { state.answers[state.index] = letter; inp.checked = true; }
        inp.dispatchEvent({ type: 'change' });
      };
      inp.dispatchEvent = (ev) => {
        if (ev && ev.type === 'change') inp.fire('change', ev);
        return true;
      };
      // label 层面：原生 click 走浏览器转发（触发内部 input 的 click）
      node.dispatchEvent = (ev) => {
        if (ev && ev.type === 'click') {
          CLICKS.push(node);
          commit();
        }
        return true;
      };
      node.click = () => node.dispatchEvent({ type: 'click' });
      optWrap.appendChild(node);
      optNodes.push({ node, inp, letter, text: t });
    });
    syncSelection();
    syncCard();
  }
  function syncSelection() {
    const cur = state.answers[state.index] || '';
    optNodes.forEach((o) => {
      const on = cur.includes(o.letter);
      o.inp.checked = on;
      o.node.classList.toggle('is-checked', on);
    });
  }
  // 答题卡状态刷新（高亮 + 已答标记）
  function syncCard() {
    cardItems.forEach((it, i) => {
      it.classList.toggle('active', i === state.index);
      if (state.answers[i]) {
        it._bg = 'rgb(22,93,255)'; it._color = 'rgb(255,255,255)';
      } else {
        it._bg = 'rgb(255,255,255)'; it._color = 'rgb(78,89,105)';
      }
    });
  }

  // ★ 模拟真实平台：翻页时"先换题干、稍后才换选项控件"。
  //   这正是导致"多选被误判成单选"的真实场景。
  nextBtn.dispatchEvent = (ev) => {
    if (ev && ev.type === 'click') {
      CLICKS.push(nextBtn);
      if (state.index < state.total - 1) {
        state.index++;
        // 先立刻换题干文本（选项控件暂时还是上一题的题型）
        stemEl.textContent = QUESTIONS[state.index].stem;
        if (opts.asyncRender) {
          pendingRender = nowFn() + 300;   // 300ms 后才真正重建选项
        } else {
          renderQuestion();
        }
      }
    }
    return true;
  };
  nextBtn.click = () => nextBtn.dispatchEvent({ type: 'click' });
  prevBtn.dispatchEvent = (ev) => {
    if (ev && ev.type === 'click') { CLICKS.push(prevBtn); if (state.index > 0) { state.index--; renderQuestion(); } }
    return true;
  };
  prevBtn.click = () => prevBtn.dispatchEvent({ type: 'click' });

  renderQuestion();

  doc.elementFromPoint = (x, y) => {
    // 简化：只要坐标落在某元素矩形内就返回它（最内层）
    const all = [];
    const walk = (n) => { for (const c of n.children) { all.push(c); walk(c); } };
    walk(doc);
    let best = null, bestArea = Infinity;
    for (const el of all) {
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      if (x < r.left || x > r.right || y < r.top || y > r.bottom) continue;
      const area = r.width * r.height;
      if (area < bestArea) { best = el; bestArea = area; }
    }
    return best;
  };

  return { doc, body, state, qWrap, stemEl, optWrap, cardItems, nextBtn, prevBtn,
    QUESTIONS, renderQuestion, getOptNodes: () => optNodes,
    // 供虚拟时钟调用：到点就完成"延迟渲染"
    tickRender: (nowMs) => {
      if (pendingRender && nowMs >= pendingRender) { pendingRender = null; renderQuestion(); }
    } };
}

// ---------- 运行 ----------
function run(page, cfgOverride = {}) {
  const timers = [];
  let now = 1_700_000_000_000;
  const errors = [];
  const logs = [];
  const store = {};
  const httpCalls = [];
  let httpResponder = null;

  class FD extends Date { constructor(...a) { super(...(a.length ? a : [now])); } static now() { return now; } }

  const sb = {
    document: page.doc, Date: FD, innerWidth: 2549, innerHeight: 1422,
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; },
    },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    console: { log: (...a) => logs.push(a.join(' ')), error: (...a) => errors.push(a.join(' ')), warn: (...a) => errors.push(a.join(' ')) },
    setTimeout: (fn, ms) => { const id = timers.length + 1; timers.push({ id, fn, at: now + (ms || 0) }); return id; },
    clearTimeout: (id) => { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); },
    setInterval: (fn, ms) => { const id = timers.length + 1; timers.push({ id, fn, at: now + (ms || 1), every: ms || 1 }); return id; },
    clearInterval: (id) => { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); },
    MutationObserver: class { observe() {} disconnect() {} },
    PointerEvent: class { constructor(t, o) { Object.assign(this, o || {}); this.type = t; } },
    MouseEvent: class { constructor(t, o) { Object.assign(this, o || {}); this.type = t; } },
    KeyboardEvent: class { constructor(t, o) { Object.assign(this, o || {}); this.type = t; } },
    getComputedStyle: (el) => ({
      display: 'block', visibility: 'visible', opacity: '1', pointerEvents: 'auto',
      backgroundColor: (el && el._bg) || 'rgba(0,0,0,0)',
      color: (el && el._color) || 'rgb(29,33,41)',
      borderColor: 'rgba(0,0,0,0)', fill: '', stroke: '',
    }),
    HTMLMediaElement: El,
    location: { reload() {}, hash: '' },
    navigator: { clipboard: { writeText: () => Promise.resolve() } },
    fetch: () => Promise.reject(new Error('no fetch')),
    Math, JSON, Object, Array, String, Number, Promise, isFinite, parseFloat, parseInt, WeakMap, Error, RegExp, Set, NodeFilter: { SHOW_TEXT: 4 },
    // GM_* 桩
    GM_getValue: (k, d) => {
      if (k === 'BLQ_CFG_V1') {
        const cur = JSON.parse(store['BLQ_CFG_V1'] || '{}');
        return JSON.stringify(Object.assign({ enabled: true, apiKey: 'test-placeholder-token', dryRun: false,
          thinkMin: 0, thinkMax: 0, delayAfterAnswer: 0, delayAfterNext: 0 }, cur, cfgOverride));
      }
      return (k in store) ? store[k] : d;
    },
    GM_setValue: (k, v) => { store[k] = String(v); },
    GM_deleteValue: (k) => { delete store[k]; },
    GM_xmlhttpRequest: (o) => {
      httpCalls.push(o);
      // ★ 必须用 sandbox 的 setTimeout（虚拟定时器），用宿主 setTimeout 不会随 advance 推进
      sb.setTimeout(() => {
        const resp = httpResponder ? httpResponder(o) : { status: 200, responseText: JSON.stringify({
          choices: [{ message: { content: 'B' } }] }) };
        try {
          if (resp && resp.status >= 200 && resp.status < 300) o.onload(resp);
          else if (resp && resp.netError) o.onerror(resp.netError);
          else o.onload(resp || { status: 500, responseText: '{}' });
        } catch (e) { errors.push('GM_xmlhttpRequest 回调异常: ' + e.message); }
      }, 5);
    },
  };
  sb.window = sb; sb.globalThis = sb; sb.top = sb; sb.self = sb;

  const ctx = vm.createContext(sb);
  const exposed = SRC.replace('function boot() {',
    'globalThis.__api = { readQuestion, detectType, extractOptions, extractStem, fingerprint,' +
    ' parseAnswer, buildPrompt, cardStatus, currentIndex, findNavButton, selectedLetters,' +
    ' findQuestionBox, isNumberAnswered, bankGet, bankSet, bankCount, answerCurrent, runLoop,' +
    ' stopLoop, getCfg: () => cfg, setCfg: (o) => { cfg = Object.assign(cfg, o); }, getS: () => S,' +
    ' setHttpResponder: (f) => { httpResponder = f; }, diagnose, findCardNumbers }; function boot() {');
  let threw = null;
  try { vm.runInContext(exposed, ctx, { filename: 'blq.js' }); } catch (e) { threw = e; }

  // 异步推进：需要 flush 微任务
  async function advance(ms) {
    const end = now + ms;
    let guard = 0;
    while (guard++ < 100000) {
      page.tickRender(now);                     // 处理"延迟渲染"
      const due = timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at);
      if (!due.length) { now = end; break; }
      const t = due[0]; now = Math.max(now, t.at);
      page.tickRender(now);
      if (t.every) { t.at = now + t.every; } else { timers.splice(timers.indexOf(t), 1); }
      try { t.fn(); } catch (e) { errors.push('timer: ' + e.message); }
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    }
    now = end;
    page.tickRender(now);
  }

  return { sb, threw, errors, logs, store, httpCalls, advance,
    setResponder: (f) => { httpResponder = f; } };
}

const checks = [];
const ok = (n, c, x) => { checks.push(c); console.log((c ? '  PASS  ' : '  FAIL  ') + n + (x ? '  -> ' + x : '')); };

console.log('=== 自动答题脚本验证 ===\n');

// ===== 1. 题型识别 =====
console.log('【1】题型识别');
{
  const p1 = buildQuizPage({ type: 'single' });
  const r1 = run(p1);
  ok('脚本加载无异常', !r1.threw, r1.threw ? r1.threw.message : 'ok');
  const q1 = r1.sb.__api ? r1.sb.__api.readQuestion() : null;
  ok('单选页面 → 识别为 single', q1 && q1.type === 'single', q1 ? q1.type : 'null');

  const p2 = buildQuizPage({ type: 'multi' });
  const r2 = run(p2);
  const q2 = r2.sb.__api ? r2.sb.__api.readQuestion() : null;
  ok('多选页面 → 识别为 multi', q2 && q2.type === 'multi', q2 ? q2.type : 'null');
}

// ===== 2. 题干与选项提取 =====
console.log('\n【2】题干与选项提取');
{
  const p = buildQuizPage({ type: 'single' });
  const r = run(p);
  const q = r.sb.__api.readQuestion();
  ok('提取到题干', q && /首都是哪座城市/.test(q.stem), q ? q.stem.slice(0, 30) : 'null');
  ok('提取到 4 个选项', q && q.options.length === 4, q ? String(q.options.length) : 'null');
  ok('选项字母正确 A-D', q && q.options.map((o) => o.letter).join('') === 'ABCD',
    q ? q.options.map((o) => o.letter).join('') : 'null');
  ok('选项文本正确', q && q.options[1].text === '北京', q ? q.options[1].text : 'null');
  ok('提取到分值 20', q && q.score === 20, q ? String(q.score) : 'null');
}

// ===== 3. 提示词 =====
console.log('\n【3】提示词构造');
{
  const p = buildQuizPage({ type: 'multi' });
  const r = run(p);
  const q = r.sb.__api.readQuestion();
  const pr = r.sb.__api.buildPrompt(q);
  // 注意：多选页面用的是第 1 题（"中国的首都…"），断言要跟着题干走
  ok('提示词含题型说明', /多选题/.test(pr));
  ok('提示词含题干', /首都是哪座城市/.test(q.stem) && pr.indexOf(q.stem) !== -1,
    '题干=' + q.stem.slice(0, 20));
  ok('提示词含全部选项', q.options.every((o) => pr.indexOf(o.text) !== -1),
    q.options.map((o) => o.text).join('/'));
  ok('提示词要求只输出字母', /只输出|直接拼接|严禁输出解释/.test(pr));
  ok('多选提示词示例为 AC', /AC/.test(pr));
  const rr = run(buildQuizPage({ type: 'single' }));
  const q1 = rr.sb.__api.readQuestion();
  const pr1 = rr.sb.__api.buildPrompt(q1);
  ok('单选提示词要求单字母', /只输出那一个字母/.test(pr1));
  ok('单选提示词也含题干与选项', pr1.indexOf(q1.stem) !== -1 && q1.options.every((o) => pr1.indexOf(o.text) !== -1));
}

// ===== 4. AI 输出解析（这是最容易出问题的部分）=====
console.log('\n【4】AI 输出解析（各种不听话的输出）');
{
  const p = buildQuizPage({ type: 'single' });
  const r = run(p);
  const q = r.sb.__api.readQuestion();
  const pm = (s) => r.sb.__api.parseAnswer(s, q);
  const CASES = [
    ['B', 'B', '纯字母'],
    ['b', 'B', '小写'],
    [' B ', 'B', '带空格'],
    ['答案：B', 'B', '中文冒号'],
    ['答案: B', 'B', '英文冒号'],
    ['正确答案是B', 'B', '中文叙述'],
    ['The answer is B.', 'B', '英文叙述'],
    ['B.', 'B', '带句点'],
    ['**B**', 'B', 'Markdown 粗体'],
    ['我认为答案是 B，因为...', 'B', '带解释'],
    ['B\n', 'B', '带换行'],
  ];
  let pass = 0;
  for (const [input, want, desc] of CASES) {
    const got = pm(input).letters.join('');
    if (got === want) pass++;
    else console.log('     ✗ ' + desc + '：输入 ' + JSON.stringify(input) + ' → 得到 ' + JSON.stringify(got) + '，期望 ' + want);
  }
  ok('单选解析 ' + pass + '/' + CASES.length + ' 通过', pass === CASES.length, pass + '/' + CASES.length);
}
{
  const p = buildQuizPage({ type: 'multi' });
  const r = run(p);
  const q = r.sb.__api.readQuestion();
  const pm = (s) => r.sb.__api.parseAnswer(s, q);
  const CASES = [
    ['AC', 'AC'], ['A,C', 'AC'], ['A、C', 'AC'], ['A C', 'AC'],
    ['答案：AC', 'AC'], ['ACD', 'ACD'], ['CA', 'AC'],   // 顺序应被规整
    ['正确答案是 A 和 C', 'AC'], ['ac', 'AC'],
  ];
  let pass = 0;
  for (const [input, want] of CASES) {
    const got = pm(input).letters.join('');
    if (got === want) pass++;
    else console.log('     ✗ 多选：' + JSON.stringify(input) + ' → ' + JSON.stringify(got) + '，期望 ' + want);
  }
  ok('多选解析 ' + pass + '/' + CASES.length + ' 通过', pass === CASES.length, pass + '/' + CASES.length);

  // 越界/异常输入：必须"保守"——要么正确过滤，要么解析为空（报错让用户看到），
  // 绝不能猜出一个错误的答案。
  const r2 = pm('ZQ');
  ok('纯无效字母 → 空', r2.letters.length === 0, JSON.stringify(r2.letters));
  const r3 = pm('ABXY');
  const r3s = r3.letters.join('');
  console.log('     [diag] ABXY → ' + JSON.stringify(r3s));
  ok('含无效字母时不猜错（结果只能是 AB 或空）', r3s === 'AB' || r3s === '', JSON.stringify(r3s));
  // 严苛但明确：有效字母 + 明确分隔符必须解析对
  const r4 = pm('答案是 A 和 B');
  ok('中文叙述"A 和 B" → AB', r4.letters.join('') === 'AB', r4.letters.join(''));
}

// ===== 5. 答题卡识别 =====
console.log('\n【5】答题卡识别与"已满"判断');
{
  const p = buildQuizPage({ type: 'single', total: 5 });
  const r = run(p);
  const api = r.sb.__api;
  const st0 = api.cardStatus();
  ok('识别到 5 个题号', st0.total === 5, 'total=' + st0.total);
  ok('初始已答 0 题', st0.answered === 0, 'answered=' + st0.answered);
  ok('当前题号为第 1 题', api.currentIndex() === 0, 'index=' + api.currentIndex());

  // 模拟答完前 3 题
  p.cardItems[0]._bg = 'rgb(22,93,255)';
  p.cardItems[1]._bg = 'rgb(22,93,255)';
  p.cardItems[2]._bg = 'rgb(22,93,255)';
  const st1 = api.cardStatus();
  ok('已答 3 题被正确识别', st1.answered === 3, 'answered=' + st1.answered);

  // 全部答满
  p.cardItems.forEach((it) => { it._bg = 'rgb(22,93,255)'; });
  const st2 = api.cardStatus();
  ok('答满时 answered == total', st2.answered === st2.total, st2.answered + '/' + st2.total);
}

// ===== 6. 翻页按钮 =====
console.log('\n【6】翻页按钮');
{
  const p = buildQuizPage({ type: 'single' });
  const r = run(p);
  const api = r.sb.__api;
  ok('找到「下一题」', !!api.findNavButton('next'));
  ok('找到「上一题」', !!api.findNavButton('prev'));
}

// ===== 7. 端到端：全自动答题直到答满 =====
console.log('\n【7】端到端：自动答完 5 题并停止');

const e2ePage = buildQuizPage({ type: null, total: 5, asyncRender: true });
const e2eRun = run(e2ePage, { enabled: true, autoNext: true, thinkMin: 0, thinkMax: 0,
  delayAfterAnswer: 0, delayAfterNext: 0 });
{
  const api = e2eRun.sb.__api;
  const ANSWERS = ['B', 'AC', 'B', 'AC', 'C'];
  e2eRun.setResponder(() => ({
    status: 200,
    responseText: JSON.stringify({ choices: [{ message: { content: ANSWERS[e2ePage.state.index] } }] }),
  }));

  // ★ 关键：answerCurrent 内部 await sleep()（用虚拟定时器），
  //   所以必须"并发启动 + 边推进虚拟时间边等"，否则会死锁。
  const runAndSettle = async (promise, ms) => {
    let done = false;
    promise.then(() => { done = true; }, () => { done = true; });
    const deadline = 40;
    for (let i = 0; i < deadline && !done; i++) {
      await e2eRun.advance(Math.max(10, ms / deadline));
      for (let k = 0; k < 20; k++) await Promise.resolve();
    }
    return done;
  };

  for (let i = 0; i < 5; i++) {
    await runAndSettle(api.answerCurrent('manual'), 800);
    if (i < 4) {
      const btn = api.findNavButton('next');
      if (btn) {
        btn.dispatchEvent({ type: 'click' });
        // 异步渲染夹具必须真实推进虚拟时钟，避免在旧选项 DOM 上开始下一题。
        await e2eRun.advance(700);
      }
    }
  }
  await runAndSettle(Promise.resolve(), 300);

  const answered = Object.keys(e2ePage.state.answers).length;
  const st = api.cardStatus();
  const correct = Object.keys(e2ePage.state.answers).filter((i) => {
    const want = e2ePage.QUESTIONS[+i].answer;
    const got = e2ePage.state.answers[i] || '';
    return got.split('').sort().join('') === want.split('').sort().join('');
  }).length;
  console.log('   [diag] 已作答题数 = ' + answered + '，答题卡 = ' + st.answered + '/' + st.total);
  console.log('   [diag] 作答内容 = ' + JSON.stringify(e2ePage.state.answers));
  console.log('   [diag] 期望答案 = ' + JSON.stringify(ANSWERS));
  console.log('   [diag] 与正确答案一致 = ' + correct + '/' + answered);
  console.log('   [diag] HTTP 调用次数 = ' + e2eRun.httpCalls.length);
  console.log('   [diag] 脚本日志（末 15 条）:');
  e2eRun.logs.slice(-15).forEach((l) => console.log('      ' + l));
  ok('5 题全部作答', answered === 5, answered + ' 题');
  ok('答题卡显示 5/5', st.answered === 5 && st.total === 5, st.answered + '/' + st.total);
  ok('全部答对', correct === 5, correct + '/5');
  ok('无未捕获异常', e2eRun.errors.length === 0, e2eRun.errors.length + ' 次: ' + (e2eRun.errors[0] || ''));
}

// ===== 8. 答案缓存 =====
console.log('\n【8】答案缓存');
{
  const p = buildQuizPage({ type: 'single', total: 5 });
  const r = run(p);
  const api = r.sb.__api;
  const q = api.readQuestion();
  const fp = api.fingerprint(q);
  ok('初始缓存为空', api.bankGet(fp) === null, String(api.bankGet(fp)));
  api.bankSet(fp, 'B', q);
  ok('写入后可读出', api.bankGet(fp) === 'B', String(api.bankGet(fp)));
  ok('缓存条数 = 1', api.bankCount() === 1, String(api.bankCount()));
  // 相同题目应产生相同指纹
  const q2 = api.readQuestion();
  ok('同题指纹稳定', api.fingerprint(q2) === fp, api.fingerprint(q2));
}

console.log('\n结果：' + checks.filter(Boolean).length + '/' + checks.length + ' 通过');
process.exitCode = checks.some((c) => !c) ? 1 : 0;
