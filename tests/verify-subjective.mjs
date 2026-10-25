// 主观题识别、AI 请求、富文本回填与缓存验证。
'use strict';
import fs from 'node:fs';
import vm from 'node:vm';

const SRC = fs.readFileSync(new URL('../beeline-ai-quiz.user.js', import.meta.url), 'utf8');

function matchOne(el, s) {
  let rest = s;
  const tagM = rest.match(/^[a-zA-Z][a-zA-Z0-9]*/);
  if (tagM) {
    if (el.tagName !== tagM[0].toUpperCase()) return false;
    rest = rest.slice(tagM[0].length);
  }
  const parts = rest.match(/\.[\w-]+|\[[^\]]+\]/g) || [];
  if (!parts.length) return !!tagM;
  for (const p of parts) {
    if (p.startsWith('.')) {
      if (!(el.className || '').split(/\s+/).includes(p.slice(1))) return false;
      continue;
    }
    const inner = p.slice(1, -1);
    const m = inner.match(/^([\w-]+)([*^$]?)=(?:"([^"]*)"|'([^']*)'|([^\]]*))$/);
    if (m) {
      const want = m[3] !== undefined ? m[3] : (m[4] !== undefined ? m[4] : m[5]);
      const actual = m[1] === 'class' ? (el.className || '') : (el.getAttribute(m[1]) || '');
      if (m[2] === '*') {
        if (!String(actual).includes(want)) return false;
      } else if (String(actual) !== want) return false;
    } else if (!el.getAttribute(inner)) return false;
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
    this.tagName = (tag || 'div').toUpperCase();
    this.nodeType = 1;
    this.id = o.id || '';
    this.className = o.className || '';
    this.children = [];
    this.parentElement = null;
    this._text = o.text || '';
    this._html = '';
    this.attrs = o.attrs || {};
    this.isConnected = true;
    this._rect = o.rect || { left: 10, top: 10, width: 400, height: 40 };
    this.value = o.value || '';
    this.disabled = false;
    this.readOnly = false;
    this.maxLength = -1;
    this.style = { cssText: '', setProperty() {} };
    const self = this;
    this.classList = {
      add(c) { if (!this.contains(c)) self.className = (self.className + ' ' + c).trim(); },
      remove(c) { self.className = self.className.split(/\s+/).filter((x) => x !== c).join(' '); },
      toggle(c, f) {
        if (f === undefined) f = !this.contains(c);
        if (f) this.add(c); else this.remove(c);
      },
      contains(c) { return (self.className || '').split(/\s+/).includes(c); },
    };
  }
  set innerHTML(v) { this._html = v; }
  get innerHTML() { return this._html; }
  get textContent() { return this._text + this.children.map((c) => c.textContent || '').join(''); }
  set textContent(v) { this._text = v; this.children = []; }
  get innerText() { return this.textContent; }
  appendChild(c) { c.parentElement = this; this.children.push(c); return c; }
  remove() { this.isConnected = false; }
  addEventListener(t, fn) { (this._ls = this._ls || {})[t] = ((this._ls || {})[t] || []).concat(fn); }
  removeEventListener() {}
  fire(t, ev) { ((this._ls || {})[t] || []).forEach((fn) => { try { fn(ev || { type: t, target: this }); } catch (e) {} }); }
  getAttribute(k) { return this.attrs[k] !== undefined ? this.attrs[k] : null; }
  setAttribute(k, v) { this.attrs[k] = v; }
  getBoundingClientRect() {
    const r = this._rect;
    return this.isConnected
      ? { left: r.left, top: r.top, width: r.width, height: r.height,
        right: r.left + r.width, bottom: r.top + r.height }
      : { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 };
  }
  contains(el) {
    let p = el;
    while (p) {
      if (p === this) return true;
      p = p.parentElement;
    }
    return false;
  }
  closest(sel) {
    let p = this;
    while (p) {
      if (matchSel(p, sel)) return p;
      p = p.parentElement;
    }
    return null;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  querySelectorAll(sel) {
    const out = [];
    const walk = (n) => {
      for (const c of n.children) {
        if (matchSel(c, sel)) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
  focus() {}
  click() {}
  dispatchEvent(ev) {
    this.fire(ev && ev.type, ev);
    return true;
  }
  scrollIntoView() {}
}

function buildSubjectivePage(language = 'zh') {
  const doc = new El('#document');
  doc.nodeType = 9;
  doc.readyState = 'complete';
  const html = new El('html');
  const body = new El('body');
  doc.documentElement = html;
  doc.body = body;
  doc.head = new El('head');
  html.appendChild(body);
  doc.appendChild(html);
  doc.createElement = (tag) => new El(tag);
  doc.addEventListener = () => {};
  doc.querySelectorAll = (sel) => qsaFrom(doc, sel);
  doc.querySelector = (sel) => doc.querySelectorAll(sel)[0] || null;
  doc.getElementById = (id) => doc.querySelectorAll('#' + id)[0] || null;
  doc.hasFocus = () => true;

  const box = new El('div', {
    className: 'homework-question-editor question-box',
    rect: { left: 40, top: 200, width: 1200, height: 620 },
  });
  const tag = new El('span', {
    className: 'question-type',
    text: '主观题',
    rect: { left: 60, top: 220, width: 60, height: 24 },
  });
  const score = new El('span', {
    text: '20 分',
    rect: { left: 130, top: 220, width: 50, height: 24 },
  });
  const stem = new El('div', {
    className: 'topic-title',
    text: language === 'en'
      ? '1. Discuss how digital transformation affects organizational management and propose three practical implementation measures.'
      : '1.请论述数字化转型对组织管理的影响，并提出三项实施建议。',
    rect: { left: 60, top: 260, width: 1100, height: 70 },
  });
  const editor = new El('div', {
    className: 'ql-editor',
    attrs: { contenteditable: 'true', 'data-slate-editor': 'true' },
    rect: { left: 60, top: 350, width: 1100, height: 380 },
  });
  doc.execCommand = (command, _ui, value) => {
    if (command === 'selectAll') return true;
    if (command === 'insertText') {
      editor.textContent = value;
      return true;
    }
    if (command === 'insertHTML') {
      editor.textContent = String(value || '').replace(/<[^>]+>/g, '\n');
      return true;
    }
    return false;
  };
  // 模拟 WangEditor 5 / Slate 对 beforeinput 的内部模型更新。
  editor.addEventListener('beforeinput', (event) => {
    if (event && event.inputType === 'insertText' && typeof event.data === 'string') {
      editor.textContent = event.data;
    }
  });
  box.appendChild(tag);
  box.appendChild(score);
  box.appendChild(stem);
  box.appendChild(editor);
  body.appendChild(box);
  return { doc, box, editor, language, kind: 'subjective' };
}

function buildClozePage(blankCount = 1, language = 'zh') {
  const doc = new El('#document');
  doc.nodeType = 9;
  doc.readyState = 'complete';
  const html = new El('html');
  const body = new El('body');
  doc.documentElement = html;
  doc.body = body;
  doc.head = new El('head');
  html.appendChild(body);
  doc.appendChild(html);
  doc.createElement = (tag) => new El(tag);
  doc.addEventListener = () => {};
  doc.querySelectorAll = (sel) => qsaFrom(doc, sel);
  doc.querySelector = (sel) => doc.querySelectorAll(sel)[0] || null;
  doc.getElementById = (id) => doc.querySelectorAll('#' + id)[0] || null;
  doc.hasFocus = () => true;

  const box = new El('div', {
    className: 'homework-cloze question-box',
    rect: { left: 40, top: 200, width: 1200, height: 180 },
  });
  const tag = new El('span', {
    className: 'question-type',
    text: '填空',
    rect: { left: 60, top: 220, width: 50, height: 24 },
  });
  const score = new El('span', {
    text: '10 分',
    rect: { left: 120, top: 220, width: 50, height: 24 },
  });
  const stem = new El('div', {
    className: 'topic-title',
    text: language === 'en'
      ? '1. In Python, the variable that stores the caught exception in an except clause is called the ____.'
      : '11.如果希望在except块中访问异常对象本身，可以在except后面加上一个变量名，其中e表示____。',
    rect: { left: 60, top: 260, width: 1100, height: 55 },
  });
  box.appendChild(tag);
  box.appendChild(score);
  box.appendChild(stem);
  const blanks = [];
  for (let i = 0; i < blankCount; i++) {
    const input = new El('input', {
      className: 'el-input__inner',
      attrs: { type: 'text', placeholder: language === 'en' ? 'Enter answer...' : '请输入...' },
      rect: { left: 70 + i * 180, top: 320, width: 160, height: 32 },
    });
    input.type = 'text';
    box.appendChild(input);
    blanks.push(input);
  }
  body.appendChild(box);
  return { doc, body, box, stem, blanks, language, kind: 'cloze' };
}

function qsaFrom(root, sel) {
  const out = [];
  const walk = (n) => {
    for (const c of n.children) {
      if (matchSel(c, sel)) out.push(c);
      walk(c);
    }
  };
  walk(root);
  return out;
}

function run(page, responseAnswer) {
  const timers = [];
  let now = 1_700_000_000_000;
  const store = {
    BLQ_CFG_V1: JSON.stringify({
      enabled: true, apiKey: 'test-placeholder-token', model: 'deepseek-chat',
      thinkMin: 0, thinkMax: 0, delayAfterAnswer: 0, delayAfterNext: 0,
      answerSubjective: true, autoNext: false,
    }),
  };
  const errors = [];
  const logs = [];
  const requests = [];
  const ANSWER = [
    '数字化转型首先改变了组织的决策方式。数据平台让信息从逐层汇总转向实时共享，管理者能够基于统一口径识别问题。',
    '其次，它推动组织结构由科层制走向跨部门协同。流程被数字化后，职责边界更加清晰，协作成本随之下降。',
    '再次，转型要求员工具备数据分析与持续学习能力，组织需要通过培训和激励机制形成数字文化。',
    '实施建议方面，第一，应先梳理核心流程并统一数据标准；第二，应设立由业务和技术共同负责的试点项目；第三，应建立指标看板与复盘机制，持续评估投入产出。',
    '总之，数字化转型不是单纯引入工具，而是决策、组织和能力的系统变革。只有把技术建设与管理制度同步推进，转型才能真正产生绩效。',
  ].join('\n');
  const ENGLISH_ANSWER = [
    'Digital transformation changes organizational management first by improving the speed and quality of decision-making. Integrated data platforms allow managers to identify operational problems in real time and coordinate responses around a shared set of facts.',
    'It also changes organizational structure. Digital workflows clarify responsibilities, reduce unnecessary approval layers, and make cross-functional collaboration more practical. At the same time, employees need stronger analytical skills and a culture that supports continuous learning.',
    'Implementation should begin with a focused review of core processes and a common data standard. The organization should then launch a small cross-functional pilot, define measurable outcomes, and expand only after the pilot demonstrates clear operational value.',
    'Finally, leaders should establish performance dashboards, regular reviews, and training incentives. These measures connect technology adoption with management practices and help ensure that digital transformation produces sustained performance rather than isolated technical change.',
  ].join('\n');
  let defaultAnswer = page.language === 'en' ? ENGLISH_ANSWER : ANSWER;
  if (page.kind === 'cloze') {
    if (page.language === 'en') defaultAnswer = 'caught exception';
    else defaultAnswer = page.blanks.length > 1 ? '异常对象\n异常处理' : '异常对象';
  }

  class FD extends Date {
    constructor(...a) { super(...(a.length ? a : [now])); }
    static now() { return now; }
  }

  const sb = {
    document: page.doc,
    Date: FD,
    innerWidth: 1800,
    innerHeight: 1200,
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; },
    },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    console: {
      log: (...a) => logs.push(a.join(' ')),
      error: (...a) => errors.push(a.join(' ')),
      warn: (...a) => errors.push(a.join(' ')),
    },
    setTimeout: (fn, ms) => {
      const id = timers.length + 1;
      timers.push({ id, fn, at: now + (ms || 0) });
      return id;
    },
    clearTimeout: (id) => {
      const i = timers.findIndex((t) => t.id === id);
      if (i >= 0) timers.splice(i, 1);
    },
    setInterval: () => 0,
    clearInterval: () => {},
    MutationObserver: class { observe() {} disconnect() {} },
    PointerEvent: class { constructor(t, o) { Object.assign(this, o || {}); this.type = t; } },
    MouseEvent: class { constructor(t, o) { Object.assign(this, o || {}); this.type = t; } },
    KeyboardEvent: class { constructor(t, o) { Object.assign(this, o || {}); this.type = t; } },
    Event: class { constructor(t, o) { Object.assign(this, o || {}); this.type = t; } },
    InputEvent: class { constructor(t, o) { Object.assign(this, o || {}); this.type = t; } },
    getComputedStyle: () => ({
      display: 'block', visibility: 'visible', opacity: '1', pointerEvents: 'auto',
      backgroundColor: 'rgba(0,0,0,0)', color: 'rgb(29,33,41)', cursor: 'auto',
    }),
    location: { reload() {}, hash: '' },
    navigator: { clipboard: { writeText: () => Promise.resolve() } },
    fetch: () => Promise.reject(new Error('no fetch')),
    Math, JSON, Object, Array, String, Number, Promise, isFinite, parseFloat, parseInt,
    WeakMap, Error, RegExp, Set, URL, NodeFilter: { SHOW_TEXT: 4 },
    GM_getValue: (k, d) => (k in store ? store[k] : d),
    GM_setValue: (k, v) => { store[k] = String(v); },
    GM_deleteValue: (k) => { delete store[k]; },
    GM_xmlhttpRequest: (o) => {
      requests.push({ url: o.url, body: JSON.parse(o.data || '{}') });
      sb.setTimeout(() => o.onload({
        status: 200,
        responseText: JSON.stringify({
          choices: [{ message: { content: responseAnswer || defaultAnswer }, finish_reason: 'stop' }],
        }),
      }), 5);
    },
  };
  sb.window = sb;
  sb.globalThis = sb;
  sb.top = sb;
  sb.self = sb;
  sb.window.getSelection = () => null;

  const exposed = SRC.replace('function boot() {',
    'globalThis.__api = { readQuestion, fingerprint, buildPrompt, parseAnswer, askAI, ' +
    'isEnglishSubjective, isEnglishCloze, systemPromptFor, parseClozeAnswer, fillClozeInputs, ' +
    'answerCurrent, fillSubjectiveEditor, editorText, isQuestionAnswered, bankGet, bankDelete, ' +
    'getS: () => S }; function boot() {');
  const ctx = vm.createContext(sb);
  let threw = null;
  try {
    vm.runInContext(exposed, ctx, { filename: 'blq.js' });
  } catch (e) {
    threw = e;
  }

  async function advance(ms) {
    const end = now + ms;
    let guard = 0;
    while (guard++ < 50000) {
      const due = timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at);
      if (!due.length) {
        now = end;
        break;
      }
      const t = due[0];
      now = Math.max(now, t.at);
      timers.splice(timers.indexOf(t), 1);
      try { t.fn(); } catch (e) { errors.push('timer: ' + e.message); }
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    }
    now = end;
  }

  return { sb, threw, errors, logs, requests, answer: responseAnswer || defaultAnswer, advance };
}

const checks = [];
const ok = (name, condition, extra) => {
  checks.push(condition);
  console.log((condition ? '  PASS  ' : '  FAIL  ') + name + (extra ? '  -> ' + extra : ''));
};

console.log('=== 主观题与填空题自动作答验证 ===\n');

const page = buildSubjectivePage();
const r = run(page);
const api = r.sb.__api || {};
ok('脚本加载无异常', !r.threw, r.threw ? r.threw.message : 'ok');

const q = api.readQuestion && api.readQuestion();
ok('识别为主观题', q && q.type === 'subjective', q ? q.type : 'null');
ok('提取题干与分值', q && /数字化转型/.test(q.stem) && q.score === 20,
  q ? q.stem.slice(0, 30) + ' / ' + q.score : 'null');
ok('主观题不要求选项', q && Array.isArray(q.options) && q.options.length === 0);
ok('编辑器限定在当前题块', q && q.editor === page.editor);

const prompt = q ? api.buildPrompt(q) : '';
ok('提示词要求长篇分点作答', /主观题/.test(prompt) && /4-6 个自然段/.test(prompt) &&
  /约 700 字/.test(prompt), prompt ? String(prompt.length) + ' 字' : 'null');

const englishQ = {
  type: 'subjective',
  stem: 'Discuss how digital transformation affects organizational management and propose three implementation measures.',
  score: 20,
  tag: '主观题',
};
ok('英文题干被识别为英文主观题', api.isEnglishSubjective(englishQ) === true);
ok('短英文题干也不会漏判',
  api.isEnglishSubjective({ type: 'subjective', stem: 'Explain AI.', score: 5 }) === true);
ok('要求翻译成中文时不强制英文作答',
  api.isEnglishSubjective({
    type: 'subjective',
    stem: "Try to translate the following sentence into Chinese: It's not easy to keep correspondence.",
    score: 100,
  }) === false);
const englishPrompt = api.buildPrompt(englishQ);
const englishSystem = api.systemPromptFor(englishQ);
ok('英文题使用全英文提示词',
  /entirely in English/i.test(englishPrompt) && /Write exclusively in English/i.test(englishSystem) &&
  !/[\u3400-\u9fff]/.test(englishPrompt));
ok('英文题使用更快的紧凑篇幅', /about 320 words/i.test(englishPrompt) &&
  /do not exceed 380 words/i.test(englishPrompt));
ok('中文主观题不会误判为英文', api.isEnglishSubjective(q) === false);

const judgeQ = {
  type: 'single', judge: true, stem: '该说法正确。',
  options: [{ letter: 'A', text: '正确' }, { letter: 'B', text: '错误' }],
};
const semantic = api.parseAnswer ? api.parseAnswer('正确答案：正确', judgeQ) : { letters: [] };
ok('判断题“正确”文本映射到页面选项', semantic.letters.join('') === 'A', semantic.letters.join(''));
const judgePrompt = api.buildPrompt ? api.buildPrompt(judgeQ) : '';
ok('判断题提示词强调限定词与 A/B 输出',
  /判断题/.test(judgePrompt) && /绝对化/.test(judgePrompt) && /严禁输出 T\/F/.test(judgePrompt));

const clozePage = buildClozePage(1);
const clozeRun = run(clozePage);
const clozeApi = clozeRun.sb.__api || {};
const clozeQ = clozeApi.readQuestion && clozeApi.readQuestion();
ok('截图同类题目识别为填空题',
  clozeQ && clozeQ.type === 'cloze' && clozeQ.blanks.length === 1,
  clozeQ ? clozeQ.type + '/' + clozeQ.blanks.length : 'null');
ok('填空题题干与分值正确',
  clozeQ && /except/.test(clozeQ.stem) && clozeQ.score === 10,
  clozeQ ? clozeQ.stem.slice(0, 40) + ' / ' + clozeQ.score : 'null');
const clozePrompt = clozeQ ? clozeApi.buildPrompt(clozeQ) : '';
ok('单空题提示词要求只输出一个答案',
  /空格数量：1 空/.test(clozePrompt) && /只输出一个答案/.test(clozePrompt));
const multiClozeQ = { type: 'cloze', blanks: [{}, {}], stem: '两个空', score: 10 };
const parsedMultiCloze = clozeApi.parseClozeAnswer('1. 异常对象\n2. 异常处理', multiClozeQ);
ok('多空答案按行解析并去除编号',
  parsedMultiCloze.answers.join('|') === '异常对象|异常处理',
  parsedMultiCloze.answers.join('|'));
const englishClozeQ = {
  type: 'cloze',
  blanks: [{}],
  stem: 'In Python, the caught exception is stored in the ____.',
  score: 5,
};
ok('英文填空题使用英文提示词',
  clozeApi.isEnglishCloze(englishClozeQ) === true &&
  /Question type: fill in the blank/.test(clozeApi.buildPrompt(englishClozeQ)));
const fillStart = SRC.indexOf('async function fillSubjectiveEditor');
const fillEnd = SRC.indexOf('// 统一的中断检查点', fillStart);
const fillSource = fillStart >= 0 && fillEnd > fillStart ? SRC.slice(fillStart, fillEnd) : '';
ok('主观题回填不再直接改写编辑器 DOM',
  !!fillSource && !/editor\.(?:textContent|innerHTML)\s*=/.test(fillSource));
ok('界面提供“清本题缓存并重新思考”按钮',
  /id="blq-rethink"/.test(SRC) && /bindOrSkip\('blq-rethink'/.test(SRC));

(async () => {
  let settled = false;
  let result = null;
  api.answerCurrent('manual').then((x) => { result = x; settled = true; },
    (e) => { result = { error: e.message }; settled = true; });
  for (let i = 0; i < 80 && !settled; i++) {
    await r.advance(50);
    for (let k = 0; k < 10; k++) await Promise.resolve();
  }

  ok('主观题 answerCurrent 成功', result && result.ok === true,
    JSON.stringify(result));
  ok('答案已写入富文本框', api.editorText(page.editor).length >= r.answer.length,
    api.editorText(page.editor).length + ' 字');
  ok('题目状态变为已作答', api.isQuestionAnswered(api.readQuestion()) === true);
  ok('请求使用 DeepSeek 长文本预算', r.requests.length === 1 &&
    r.requests[0].body.max_tokens >= 1024,
    r.requests[0] ? String(r.requests[0].body.max_tokens) : '无请求');
  ok('答案写入缓存', !!(q && api.bankGet(api.fingerprint(q))));
  ok('无未捕获异常', r.errors.length === 0, r.errors.join(' | '));

  const counter = new El('span', {
    className: 'editor-count',
    text: '0/15000',
    rect: { left: 1000, top: 700, width: 70, height: 20 },
  });
  page.box.appendChild(counter);
  let counterDone = false;
  let counterCheck = null;
  api.fillSubjectiveEditor(
    page.editor, '这是一段用于验证字数控件未同步时必须拒绝成功的答案。', page.box
  ).then((x) => {
    counterCheck = x;
    counterDone = true;
  }, (e) => {
    counterCheck = { error: e.message };
    counterDone = true;
  });
  for (let i = 0; i < 80 && !counterDone; i++) {
    await r.advance(50);
    for (let k = 0; k < 10; k++) await Promise.resolve();
  }
  ok('编辑器计数仍为 0 时拒绝判定回填成功',
    counterCheck && counterCheck.ok === false && counterCheck.counter === '0/15000',
    JSON.stringify(counterCheck));
  counter.remove();

  const fp = q && api.fingerprint(q);
  ok('可按题删除单条缓存', !!fp && api.bankDelete(fp) === true && api.bankGet(fp) === null);

  let forceDone = false;
  let forceResult = null;
  api.answerCurrent('manual', { force: true }).then((x) => {
    forceResult = x;
    forceDone = true;
  }, (e) => {
    forceResult = { error: e.message };
    forceDone = true;
  });
  for (let i = 0; i < 80 && !forceDone; i++) {
    await r.advance(50);
    for (let k = 0; k < 10; k++) await Promise.resolve();
  }
  ok('强制重新思考会再次请求 AI',
    forceResult && forceResult.ok === true && r.requests.length === 2,
    JSON.stringify(forceResult) + ' / requests=' + r.requests.length);

  const presets = SRC.match(/name: '[^']+', base:/g) || [];
  ok('接口预设只保留 DeepSeek', presets.length === 1, String(presets.length));
  ok('已移除其他供应商名称',
    !/(小米|MiMo|硅基流动|智谱|通义千问|Kimi|Ollama)/.test(SRC));

  const englishPage = buildSubjectivePage('en');
  const englishRun = run(englishPage);
  let englishDone = false;
  let englishResult = null;
  englishRun.sb.__api.answerCurrent('manual').then((x) => {
    englishResult = x;
    englishDone = true;
  }, (e) => {
    englishResult = { error: e.message };
    englishDone = true;
  });
  for (let i = 0; i < 80 && !englishDone; i++) {
    await englishRun.advance(50);
    for (let k = 0; k < 10; k++) await Promise.resolve();
  }
  const englishFilled = englishRun.sb.__api.editorText(englishPage.editor);
  ok('英文主观题 answerCurrent 成功', englishResult && englishResult.ok === true,
    JSON.stringify(englishResult));
  ok('英文题回填内容为纯英文',
    !/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/.test(englishFilled) &&
    /[A-Za-z]{3,}/.test(englishFilled), englishFilled.slice(0, 80));
  ok('英文请求使用纯英文消息',
    englishRun.requests.length === 1 &&
    !/[\u3400-\u9fff]/.test(JSON.stringify(englishRun.requests[0].body.messages)),
    englishRun.requests[0] ? englishRun.requests[0].body.messages[0].content.slice(0, 60) : '无请求');

  let clozeDone = false;
  let clozeResult = null;
  clozeApi.answerCurrent('manual').then((x) => {
    clozeResult = x;
    clozeDone = true;
  }, (e) => {
    clozeResult = { error: e.message };
    clozeDone = true;
  });
  for (let i = 0; i < 80 && !clozeDone; i++) {
    await clozeRun.advance(50);
    for (let k = 0; k < 10; k++) await Promise.resolve();
  }
  ok('单空填空题 answerCurrent 成功',
    clozeResult && clozeResult.ok === true, JSON.stringify(clozeResult));
  ok('单空题输入框已回填“异常对象”',
    clozePage.blanks[0].value === '异常对象', clozePage.blanks[0].value);
  const clozeCached = clozeQ && clozeApi.bankGet(clozeApi.fingerprint(clozeQ));
  ok('填空题答案进入缓存',
    !!clozeCached && Array.isArray(JSON.parse(clozeCached)) &&
    JSON.parse(clozeCached)[0] === '异常对象');

  const multiPage = buildClozePage(2);
  const multiRun = run(multiPage);
  let multiDone = false;
  let multiResult = null;
  multiRun.sb.__api.answerCurrent('manual').then((x) => {
    multiResult = x;
    multiDone = true;
  }, (e) => {
    multiResult = { error: e.message };
    multiDone = true;
  });
  for (let i = 0; i < 80 && !multiDone; i++) {
    await multiRun.advance(50);
    for (let k = 0; k < 10; k++) await Promise.resolve();
  }
  ok('双空填空题 answerCurrent 成功',
    multiResult && multiResult.ok === true, JSON.stringify(multiResult));
  ok('双空答案按顺序填入',
    multiPage.blanks[0].value === '异常对象' && multiPage.blanks[1].value === '异常处理',
    multiPage.blanks.map((x) => x.value).join(' | '));

  console.log('\n结果：' + checks.filter(Boolean).length + '/' + checks.length + ' 通过');
  process.exitCode = checks.some((c) => !c) ? 1 : 0;
})();
