// ==UserScript==
// @name         芯位蜜线 · AI 自动答题
// @namespace    https://github.com/zzs4057/beeline-ai-quiz
// @version      1.2.2
// @description  自动识别单选/多选/判断/填空/主观题并调用 DeepSeek 作答；填空与主观题自动回填，英文主观题纯英文快速作答。
// @author       Beeline AI Quiz Contributors
// @match        https://www.beeline-ai.com/*
// @match        https://beeline-ai.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @connect      api.deepseek.com
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  if (window.top !== window.self) return;
  if (window.__BL_QUIZ_LOADED__) return;
  window.__BL_QUIZ_LOADED__ = true;

  // ==========================================================================
  //  0. 配置
  // ==========================================================================
  const DEFAULTS = {
    // ---- DeepSeek 接口（兼容 /v1/chat/completions）----
    apiBase: 'https://api.deepseek.com/v1/chat/completions',
    apiKey: '',
    model: 'deepseek-chat',
    temperature: 0,
    maxTokens: 2048,
    timeout: 45000,

    // ---- 运行开关 ----
    enabled: false,        // 总开关（默认关，避免误触发）
    autoNext: true,        // 答完自动下一题
    answerSubjective: true,// 自动作答并回填主观题
    stopWhenFull: true,    // 答题卡满则停止
    dryRun: false,         // 演练模式：只分析不勾选（首次使用建议开）

    // ---- 节奏（拟人）----
    thinkMin: 1.2,         // 每题最短停顿（秒）
    thinkMax: 3.5,         // 每题最长停顿（秒）
    delayAfterAnswer: 0.8, // 勾选后停顿
    delayAfterNext: 1.0,   // 翻页后停顿（等题目渲染）
    maxPerMinute: 12,      // 速率上限（题/分钟），防请求过密
  };

  const STORE_CFG = 'BLQ_CFG_V1';
  const STORE_BANK = 'BLQ_BANK_V1';       // 答案缓存：题目指纹 -> {ans, t}
  const LOG_MAX = 300;

  // 仅保留 DeepSeek 预设（只含地址与模型名，绝不含 API Key）。
  const PRESETS = [
    { name: 'DeepSeek', base: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  ];

  // GM_* 不可用时回退 localStorage（方便在非油猴环境调试）
  const gmGet = (k, d) => {
    try { if (typeof GM_getValue === 'function') return GM_getValue(k, d); } catch (e) {}
    try { const v = localStorage.getItem(k); return v === null ? d : v; } catch (e) { return d; }
  };
  const gmSet = (k, v) => {
    try { if (typeof GM_setValue === 'function') { GM_setValue(k, v); return; } } catch (e) {}
    try { localStorage.setItem(k, String(v)); } catch (e) {}
  };
  function loadCfg() {
    let raw = gmGet(STORE_CFG, null);
    if (typeof raw === 'string') { try { raw = JSON.parse(raw); } catch (e) { raw = null; } }
    const out = Object.assign({}, DEFAULTS, (raw && typeof raw === 'object') ? raw : {});
    // 类型与范围校正（避免脏配置导致异常行为）
    if (typeof out.apiBase !== 'string' || !/^https?:\/\//.test(out.apiBase)) out.apiBase = DEFAULTS.apiBase;
    else {
      // 地址归一化：只有域名/只填到 /v1 的，自动补全到 chat/completions
      // （实测：用户填 .../v1 会得到 openresty 的 404，错误信息完全无法定位）
      try { out.apiBase = normalizeEndpoint(out.apiBase) || out.apiBase; } catch (e) {}
    }
    if (typeof out.model !== 'string' || !out.model) out.model = DEFAULTS.model;
    if (typeof out.apiKey !== 'string') out.apiKey = '';
    ['temperature'].forEach((k) => { const n = Number(out[k]); out[k] = isFinite(n) ? Math.max(0, Math.min(2, n)) : DEFAULTS[k]; });
    ['maxTokens'].forEach((k) => { const n = Number(out[k]); out[k] = isFinite(n) ? Math.max(32, Math.min(8192, n)) : DEFAULTS[k]; });
    ['timeout'].forEach((k) => { const n = Number(out[k]); out[k] = isFinite(n) ? Math.max(5000, Math.min(180000, n)) : DEFAULTS[k]; });
    ['thinkMin', 'thinkMax', 'delayAfterAnswer', 'delayAfterNext'].forEach((k) => {
      const n = Number(out[k]); out[k] = isFinite(n) ? Math.max(0, Math.min(60, n)) : DEFAULTS[k];
    });
    const mpm = Number(out.maxPerMinute); out.maxPerMinute = isFinite(mpm) ? Math.max(1, Math.min(120, mpm)) : DEFAULTS.maxPerMinute;
    for (const k of ['enabled', 'autoNext', 'answerSubjective', 'stopWhenFull', 'dryRun']) out[k] = out[k] === true;
    if (out.thinkMax < out.thinkMin) out.thinkMax = out.thinkMin;
    return out;
  }
  let cfg = loadCfg();
  function saveCfg() { gmSet(STORE_CFG, JSON.stringify(cfg)); }

  const logs = [];
  function log(msg, kind) {
    const t = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    logs.push({ t: '[' + t + '] ' + msg, k: kind || '' });
    if (logs.length > LOG_MAX) logs.shift();
    renderLog();
    try { console.log('[自动答题]', msg); } catch (e) {}
  }

  // ==========================================================================
  //  1. 工具
  // ==========================================================================
  const rnd = (a, b) => a + Math.random() * (b - a);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const qsa = (sel, root) => {
    try { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); } catch (e) { return []; }
  };
  const txt = (el) => ((el && el.textContent) || '').replace(/\s+/g, ' ').trim();
  function visible(el) {
    if (!el || !el.isConnected) return false;
    let r; try { r = el.getBoundingClientRect(); } catch (e) { return false; }
    if (r.width <= 0 || r.height <= 0) return false;
    let st; try { st = getComputedStyle(el); } catch (e) { return true; }
    if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) === 0) return false;
    // 祖先链也检查（弹窗淡出时元素自身尺寸仍在，只是父级 opacity:0）
    let p = el.parentElement, d = 0;
    while (p && d++ < 30) {
      let ps; try { ps = getComputedStyle(p); } catch (e) { ps = null; }
      if (ps) {
        if (ps.display === 'none' || ps.visibility === 'hidden') return false;
        if (Number(ps.opacity) === 0) return false;
      }
      p = p.parentElement;
    }
    return true;
  }
  // 判断元素是否属于脚本自己的 UI（面板 / 悬浮球 / 注入样式）。
  //
  // ⚠️ audit-D 发现2：本脚本原本**一处 isOwnUI 都没有**，而参考项目
  //    beeline-autocourse.user.js 曾因此出过"脚本点到自己的面板开关"的真实事故。
  //    这里的面板有 16 个 <button>，z-index 最高，一旦有控件文案落进
  //    导航按钮的正则，就会被优先判为"可点"。必须显式排除。
  function isOwnUI(el) {
    try {
      let p = el, d = 0;
      while (p && d++ < 30) {
        if (p.id === 'blq' || p.id === 'blq-mini' || p.id === 'blq-style') return true;
        p = p.parentElement;
      }
    } catch (e) {}
    return false;
  }

  // 屏幕命中测试：确认元素真的在屏幕上（不是淡出/被遮挡的幽灵元素）
  function reallyClickable(el) {
    if (!el || !el.isConnected || !visible(el)) return false;
    if (typeof document.elementFromPoint !== 'function') return true;
    let r; try { r = el.getBoundingClientRect(); } catch (e) { return false; }
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    let hit = null;
    try { hit = document.elementFromPoint(x, y); } catch (e) { hit = null; }
    if (!hit) return false;
    if (hit === el) return true;
    try { if (el.contains(hit)) return true; } catch (e) {}
    try { let q = hit, d = 0; while (q && d++ < 8) { if (q === el) return true; q = q.parentElement; } } catch (e) {}
    return false;
  }
  // 通用点击。返回 true 表示"事件已派发/已调用 click()"，不代表业务生效。
  //
  // ⚠️ 实测坑（用户日志"点击「下一题」失败"，但按钮明明在页面上）：
  //   旧版在 catch 分支里只对 BUTTON/A/role=button 调 el.click()，
  //    其它标签直接 return false —— 而且**什么都不打印**。
  //    真实页面上导航按钮常是 <span>/<div>，或 PointerEvent 构造失败，
  //    就会静默返回 false，排查时毫无线索。
  //   现在：① 逐事件独立 try（一个失败不连累后续）
  //        ② 兜底对所有标签都试一次原生 click()
  //        ③ 失败时把真实异常记进日志
  function clickEl(el) {
    if (!el) return false;
    // 最后一道防线：任何情况下都不点击自己的 UI
    if (isOwnUI(el)) { try { log('拒绝点击自身面板元素', 'warn'); } catch (e) {} return false; }
    try { el.scrollIntoView({ block: 'center', behavior: 'instant' }); } catch (e) {}
    let r; try { r = el.getBoundingClientRect(); } catch (e) { r = null; }
    const o = { bubbles: true, cancelable: true, view: window,
      clientX: r ? r.left + r.width / 2 : 0, clientY: r ? r.top + r.height / 2 : 0, button: 0 };

    // ① 合成事件序列（逐条独立 try —— 例如 PointerEvent 不受支持时不影响 MouseEvent）
    let fired = 0;
    const seq = [
      () => { if (typeof PointerEvent === 'function') el.dispatchEvent(new PointerEvent('pointerdown', o)); },
      () => el.dispatchEvent(new MouseEvent('mousedown', o)),
      () => { if (typeof PointerEvent === 'function') el.dispatchEvent(new PointerEvent('pointerup', o)); },
      () => el.dispatchEvent(new MouseEvent('mouseup', o)),
      () => el.dispatchEvent(new MouseEvent('click', o)),
    ];
    for (const fn of seq) { try { fn(); fired++; } catch (e) {} }
    if (fired >= 4) return true;         // 基本都发出去了 → 视为成功

    // ② 兜底：对所有标签都试一次原生 click()（旧版只对语义按钮试）
    try {
      if (typeof el.click === 'function') { el.click(); return true; }
    } catch (e2) {
      try { log('点击失败：' + el.tagName + ' — ' + (e2 && e2.message), 'err'); } catch (e) {}
    }
    return false;
  }

  // ==========================================================================
  //  forceClick —— 对一个元素"把所有能用的点击手段都打一遍"
  //
  //  方案取自 example.txt（芯位网课辅助 v3.1.0）的 forceClick。
  //  但**必须区分 radio / checkbox**，否则会把 checkbox 点成未选中：
  //    · radio 的 click 是"置为选中" → 赋值 + click 无害
  //    · checkbox 的 click 是"翻转" → 先赋值 true 再 click 会被翻回 false
  //
  //  ⚠️ 实测（_dbg-forceclick）：对 checkbox 用 forceClick(label) 最终得到
  //     checked=false，勾选失败。所以：
  //       · 多选 → 只用 input.click()，不调 forceClick（见 reallyClickOption）
  //       · 单选 → 用本函数（radio 无翻转问题）
  //
  //  两个关键手段：
  //    ① 直接改 DOM 属性（绕过浏览器事件转发）
  //    ② 手动派发 change/input（Vue/Element UI 的 v-model 靠它同步内部状态）
  // ==========================================================================
  function forceClick(el) {
    if (!el) return false;
    let did = false;

    // ① 元素自身的点击 + change
    try { el.click(); did = true; } catch (e) {}
    try { el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); did = true; } catch (e) {}
    try { el.dispatchEvent(new Event('change', { bubbles: true })); } catch (e) {}

    // ② 找到内部的原生 input —— 它才真正承载状态
    let input = null;
    try {
      input = (el.querySelector && el.querySelector('input[type="radio"], input[type="checkbox"]')) || null;
      if (!input && (el.type === 'radio' || el.type === 'checkbox')) input = el;
    } catch (e) {}

    if (input) {
      const isCheckbox = input.type === 'checkbox';
      if (isCheckbox) {
        // ★ checkbox 的 click 是**翻转**语义：
        //   顺序必须是「先 click（必要时），再不做任何多余的 click」。
        //   若先赋值 true 再 click → 被翻回 false（实测踩坑）。
        try { if (!input.checked) input.click(); } catch (e) {}
      } else {
        // ★ radio：**先 click**（原生 click 会清除同组其他选项，直接赋值不会），
        //    click 无效时再补赋值。
        try {
          if (!input.checked) input.click();
          if (!input.checked) input.checked = true;
        } catch (e) {
          try { input.checked = true; } catch (e2) {}
        }
      }
      try { input.dispatchEvent(new Event('change', { bubbles: true })); } catch (e) {}
      try { input.dispatchEvent(new Event('input', { bubbles: true })); } catch (e) {}

      // ③ 通知外层 radio-group / checkbox-group 组件
      try {
        const group = el.closest && el.closest('.el-radio-group, .el-checkbox-group, [role="radiogroup"], [role="group"]');
        if (group) {
          group.dispatchEvent(new Event('input', { bubbles: true }));
          group.dispatchEvent(new Event('change', { bubbles: true }));
        }
      } catch (e) {}
    }
    return did;
  }

  // 取消勾选（**多选专用**）。
  // forceClick 只会把 checked 置 true，取消必须单独处理；
  // radio 语义上无法"取消"，只能改选别的选项。
  function forceUncheck(el) {
    if (!el) return false;
    let input = null;
    try {
      input = (el.querySelector && el.querySelector('input[type="radio"], input[type="checkbox"]')) || null;
      if (!input && (el.type === 'radio' || el.type === 'checkbox')) input = el;
    } catch (e) {}
    if (!input) return false;
    if (input.type !== 'checkbox') return false;    // radio 不支持取消
    // ⚠️ 与 forceClick 同理：checkbox 的 click 是**翻转**语义。
    //    先 checked=false 再 click 会被翻回 true —— 取消失败（实测踩坑）。
    //    正确顺序：先 click（此刻是选中态，翻转即取消），再按需兜底赋值。
    try {
      if (input.checked) input.click();                  // 选中 → 翻转 → 取消
      if (input.checked) input.checked = false;          // click 无效时兜底
    } catch (e) {
      try { input.checked = false; } catch (e2) {}
    }
    try { input.dispatchEvent(new Event('change', { bubbles: true })); } catch (e) {}
    try { input.dispatchEvent(new Event('input', { bubbles: true })); } catch (e) {}
    try {
      const group = el.closest && el.closest('.el-checkbox-group, [role="group"]');
      if (group) {
        group.dispatchEvent(new Event('input', { bubbles: true }));
        group.dispatchEvent(new Event('change', { bubbles: true }));
      }
    } catch (e) {}
    return true;
  }

  // ==========================================================================
  //  2. 题目解析
  // ==========================================================================
  const EDITOR_SELECTOR = '[contenteditable], [data-slate-editor], .ql-editor, .ProseMirror, textarea';
  const NON_BLANK_INPUT_TYPES = /^(radio|checkbox|hidden|file|button|submit|reset|image|range|color|date|time|datetime-local|month|week)$/i;

  function isBlankInput(el) {
    if (!el || el.tagName !== 'INPUT') return false;
    try {
      if (!visible(el) || el.disabled || el.readOnly) return false;
      if (NON_BLANK_INPUT_TYPES.test(String(el.type || 'text'))) return false;
      const cls = (typeof el.className === 'string') ? el.className : '';
      if (/search|login|password|captcha|verify/i.test(cls)) return false;
      return true;
    } catch (e) {
      return false;
    }
  }

  function findBlankInputs(box) {
    if (!box) return [];
    return qsa('input', box).filter(isBlankInput);
  }

  function editorText(editor) {
    if (!editor) return '';
    try {
      if (editor.tagName === 'TEXTAREA' || editor.tagName === 'INPUT') {
        return String(editor.value || '').trim();
      }
      return String(editor.innerText || editor.textContent || '').replace(/\u00a0/g, ' ').trim();
    } catch (e) {
      return '';
    }
  }

  // 编辑器只允许从当前题目块内部查找，避免误填页面上的搜索框/笔记框。
  function findSubjectiveEditor(box) {
    if (!box) return null;
    const ownMatch = (() => {
      try {
        const ce = box.getAttribute && box.getAttribute('contenteditable');
        return box.tagName === 'TEXTAREA' ||
          (ce !== null && ce !== 'false') ||
          (box.classList && (box.classList.contains('ql-editor') ||
            box.classList.contains('ProseMirror')));
      } catch (e) { return false; }
    })();
    if (ownMatch && visible(box)) return box;

    const local = qsa(EDITOR_SELECTOR, box).filter((el) => {
      if (!visible(el)) return false;
      if (el.tagName === 'TEXTAREA') return !el.disabled && !el.readOnly;
      const ce = el.getAttribute && el.getAttribute('contenteditable');
      return ce !== 'false';
    });
    if (local.length) {
      local.sort((a, b) => {
        const ar = a.getBoundingClientRect(), br = b.getBoundingClientRect();
        const ae = a.tagName === 'TEXTAREA' || (a.getAttribute && a.getAttribute('contenteditable') !== null);
        const be = b.tagName === 'TEXTAREA' || (b.getAttribute && b.getAttribute('contenteditable') !== null);
        return ((be ? 1 : 0) - (ae ? 1 : 0)) || ((br.width * br.height) - (ar.width * ar.height));
      });
      return local[0];
    }

    // 兼容同源 iframe 型富文本编辑器。
    for (const frame of qsa('iframe', box)) {
      if (!visible(frame)) continue;
      try {
        const inner = frame.contentDocument && frame.contentDocument.querySelector(EDITOR_SELECTOR);
        if (inner && visible(inner)) return inner;
      } catch (e) {}
    }
    return null;
  }

  // 题型判据（按可靠性排序）：
  //   ① 题目块内的控件类型：el-checkbox → 多选；el-radio → 单选
  //   ② 题型标签文本："多选" / "单选"
  //   ③ 题干里的提示词（"（多选）"）
  function detectType(box) {
    if (!box) return 'unknown';
    const cbs = qsa('.el-checkbox, input[type="checkbox"]', box).filter(visible);
    const rbs = qsa('.el-radio, input[type="radio"]', box).filter(visible);
    if (cbs.length && !rbs.length) return 'multi';
    if (rbs.length && !cbs.length) return 'single';
    if (findSubjectiveEditor(box)) return 'subjective';
    const blanks = findBlankInputs(box);
    const boxClass = (typeof box.className === 'string') ? box.className : '';
    if (blanks.length || /homework-cloze/i.test(boxClass)) return 'cloze';

    const tag = findTypeTag(box);
    if (tag === '多选') return 'multi';
    if (/^(单选|判断|判断正误|是非题?|单选题|判断题)$/.test(tag)) return 'single';
    if (/^(填空|填空题)$/.test(tag)) return 'cloze';
    if (/^(主观|主观题|简答|简答题|论述|论述题|问答|问答题)$/.test(tag)) return 'subjective';

    const t = txt(box);
    if (/（\s*多选\s*）|\(\s*多选\s*\)|【多选】|多选题/.test(t)) return 'multi';
    if (/（\s*单选\s*）|\(\s*单选\s*\)|【单选】|单选题|判断题/.test(t)) return 'single';
    if (/（\s*主观题?\s*）|\(\s*主观题?\s*\)|【主观题?】|简答题|论述题|问答题/.test(t)) return 'subjective';
    return cbs.length ? 'multi' : (rbs.length ? 'single' : 'unknown');
  }

  function findTypeTag(box) {
    const scope = box || document;
    for (const el of qsa('span, i, em, b, label, div', scope)) {
      const t = txt(el);
      if (!t || t.length > 4) continue;
      if (/^(单选|多选|判断|判断正误|是非|是非题|填空|填空题|主观|主观题|简答|简答题|论述|论述题|问答|问答题)$/.test(t)) return t;
    }
    return '';
  }

  // 题目块：兼容多种实现，宁可多找几个再挑最合适的
  function findQuestionBox() {
    const cands = [];
    const sels = [
      '.question-box', '.homework-single-selected', '.homework-multiple-selected',
      '.homework-true-or-false', '.homework-cloze', '.homework-question-editor',
      '[class*="question-box"]', '[class*="questionBox"]', '[class*="question-editor"]',
      '[class*="topic-box"]', '[class*="subject-box"]', '[class*="question-item"]',
      '[class*="homework"][class*="item"]',
    ];
    for (const s of sels) {
      for (const el of qsa(s)) {
        if (!visible(el)) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 200 || r.height < 50) continue;
        const hasEditor = !!findSubjectiveEditor(el);
        if (r.height > window.innerHeight * 1.8 && !hasEditor) continue;   // 整页容器不算
        // 必须含选项控件或题干序号
        const hasCtrl = qsa('.el-radio, .el-checkbox, input[type="radio"], input[type="checkbox"]', el).length > 0;
        const hasBlank = findBlankInputs(el).length > 0;
        const t = txt(el);
        const hasNum = /^\s*\d{1,3}\s*[\.、．]/.test(t);
        if (!hasCtrl && !hasEditor && !hasBlank && !hasNum) continue;
        cands.push({ el, area: r.width * r.height,
          hasCtrl: hasCtrl ? 1 : 0, hasEditor: hasEditor ? 1 : 0, hasBlank: hasBlank ? 1 : 0 });
      }
    }
    if (!cands.length) {
      // 兜底：从任意一个可见选项控件/主观题编辑器往上找最近的题目祖先
      const firstCtrl = qsa('.el-radio, .el-checkbox').filter(visible)[0];
      if (firstCtrl) {
        let p = firstCtrl.parentElement, d = 0;
        while (p && d++ < 12) {
          const t = txt(p);
          if (t.length > 20 && /\d\s*[\.、．]/.test(t)) return p;
          p = p.parentElement;
        }
      }
      const firstEditor = qsa(EDITOR_SELECTOR).filter(visible)[0];
      if (firstEditor) {
        let p = firstEditor.parentElement, d = 0;
        while (p && d++ < 12) {
          const t = txt(p);
          if (t.length > 10) return p;
          p = p.parentElement;
        }
      }
      const firstBlank = qsa('input').filter(isBlankInput)[0];
      if (firstBlank) {
        let p = firstBlank.parentElement, d = 0;
        while (p && d++ < 12) {
          const t = txt(p);
          if (t.length > 20 && (/^\s*\d{1,3}\s*[\.、．]/.test(t) || /\d{1,3}\s*分/.test(t))) return p;
          p = p.parentElement;
        }
      }
      return null;
    }
    // ★ audit-A 高1：必须排除"跨题容器"。
    //   若候选 A 内部还包含另一个候选 B，说明 A 是外层答题区而非单题容器 ——
    //   把它当成一道题会让 extractOptions 跨题收集全部选项并连续重编号，
    //   再叠加"第1题已答就跳过"的逻辑 → 答完第1题就静默跳过后面所有题。
    const candSet = new Set(cands.map((c) => c.el));
    const isNestedContainer = (el) => {
      for (const other of candSet) {
        if (other === el) continue;
        try { if (el.contains(other)) return true; } catch (e) {}
      }
      return false;
    };
    const nonNested = cands.filter((c) => !isNestedContainer(c.el));
    const pool = nonNested.length ? nonNested : cands;
    // 优先"含选项控件/编辑器"且面积适中（越贴近题目越好）
    pool.sort((a, b) => {
      const bodyDelta = (b.hasCtrl + b.hasEditor + b.hasBlank) - (a.hasCtrl + a.hasEditor + a.hasBlank);
      return bodyDelta || (a.area - b.area);
    });
    return pool[0].el;
  }

  // 选项：返回 [{letter, text, node, input}]
  //
  // ⚠️ 字母一律用**位置序号**（第 1 个 = A），与 selectedLetters 完全一致。
  //    不要读平台自己的 value —— 实测用户平台判断题 value 是 "T"/"F"，
  //    与提示词里的 A/B 属于两套体系，混用必然错位。
  function extractOptions(box) {
    if (!box) return [];
    const out = [];
    const nodes = optionNodesIn(box);
    nodes.forEach((node, i) => {
      const letter = letterByIndex(i);                 // ★ 位置序号，唯一基准
      const inp = node.querySelector('input[type="radio"], input[type="checkbox"]');
      // 选项正文
      let body = '';
      const bodyEl = node.querySelector('.label, .el-radio__label, .el-checkbox__label, [class*="label"]');
      body = bodyEl ? txt(bodyEl) : txt(node);
      // 去掉开头可能残留的序号（A. / T. / 1. 等）
      body = body.replace(/^\s*(?:[A-Ha-hTtFf]|[0-9]{1,2})\s*[\.、．:：)）]\s*/, '').trim();
      out.push({
        letter,
        text: body.slice(0, 300) || '(空)',
        node,
        input: inp || null,
        nativeLetter: nativeLetterOf(node),            // 仅供诊断显示
      });
    });
    return out;
  }

  // 题干
  function extractStem(box, stopEl) {
    if (!box) return '';
    const sels = ['.topic-title', '.subject-title', '[class*="topic-title"]', '[class*="subject-title"]',
      '[class*="stem"]', '[class*="title"]'];
    for (const s of sels) {
      for (const el of qsa(s, box)) {
        const t = txt(el);
        if (t && t.length >= 4 && !/^(单选|多选|判断)$/.test(t)) return t.slice(0, 600);
      }
    }
    // 兜底：取题目块里、第一个选项控件/主观题编辑器之前的那段文本
    const firstCtrl = qsa('.el-radio, .el-checkbox', box)[0];
    const stop = stopEl || firstCtrl;
    if (stop) {
      const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT, null);
      const parts = [];
      let n;
      while ((n = walker.nextNode())) {
        if (stop.contains(n)) break;
        const t = (n.textContent || '').replace(/\s+/g, ' ').trim();
        if (t) parts.push(t);
      }
      const joined = parts.join(' ').trim();
      if (joined) return joined.slice(0, 600);
    }
    return txt(box).slice(0, 600);
  }

  function isJudgeQuestion(box, tag, stem, options) {
    try {
      const c = (typeof box.className === 'string') ? box.className : '';
      if (/homework-true-or-false|true-or-false|judge-question/i.test(c)) return true;
    } catch (e) {}
    if (/判断|正误|是非/.test(tag || '') || /判断题|判断正误|是非题/.test(stem || '')) return true;
    if (!options || options.length !== 2) return false;
    const texts = options.map((o) => String(o.text || '').replace(/[\s.。,:：;；]/g, ''));
    const yes = /^(正确|对|是|成立|true|t|√|✓)$/i;
    const no = /^(错误|错|否|不成立|false|f|×|✗)$/i;
    return (yes.test(texts[0]) || no.test(texts[0])) && (yes.test(texts[1]) || no.test(texts[1]));
  }

  // 填空题常把 input 夹在句子中间。这里按 DOM 顺序把输入框替换成【空N】，
  // 以免只截取第一个输入框之前的文字，丢掉后半句语境。
  function extractClozeStem(box, inputs) {
    if (!box) return '';
    const parts = [];
    const wanted = inputs || [];
    const walk = (node) => {
      if (!node) return;
      if (node.nodeType === 3) {
        parts.push(node.nodeValue || node.textContent || '');
        return;
      }
      if (node.nodeType !== 1 && node.nodeType !== 9) return;
      const tag = String(node.tagName || '').toUpperCase();
      if (/SCRIPT|STYLE|BUTTON|SVG|IFRAME/.test(tag)) return;
      const blankIndex = wanted.indexOf(node);
      if (blankIndex !== -1) {
        parts.push(' 【空' + (blankIndex + 1) + '】 ');
        return;
      }
      const kids = (node.childNodes && node.childNodes.length)
        ? Array.from(node.childNodes)
        : (node.children && node.children.length ? node.children : []);
      if (kids.length) {
        for (const child of kids) walk(child);
      } else if (node._text) {
        parts.push(node._text);
      } else {
        const t = node.textContent || '';
        if (t) parts.push(t);
      }
    };
    walk(box);
    let s = parts.join(' ').replace(/\s+/g, ' ').trim();
    s = s.replace(/^(?:(?:填空(?:题)?|\d{1,3}\s*分)\s*)+/i, '').trim();
    return s.slice(0, 800);
  }

  // 分数（提示词里带上，帮助 AI 判断是否需要多选）
  function extractScore(box) {
    const t = txt(box);
    const m = t.match(/(\d{1,3})\s*分/);
    return m ? parseInt(m[1], 10) : 0;
  }

  function readQuestion() {
    const box = findQuestionBox();
    if (!box) return null;
    const tag = findTypeTag(box);
    const editor = findSubjectiveEditor(box);
    if (editor) {
      const stem = extractStem(box, editor);
      if (!stem || stem.length < 4) return null;
      return {
        box, type: 'subjective', stem,
        options: [], editor,
        score: extractScore(box),
        tag: tag || '主观题',
        judge: false,
      };
    }
    const blanks = findBlankInputs(box);
    const hasChoiceControls = qsa('.el-radio, .el-checkbox, input[type="radio"], input[type="checkbox"]', box)
      .filter(visible).length > 0;
    if (blanks.length && !hasChoiceControls) {
      const stem = extractClozeStem(box, blanks) || extractStem(box, blanks[0]);
      if (!stem || stem.length < 4) return null;
      return {
        box, type: 'cloze', stem,
        options: [], blanks,
        editor: null,
        score: extractScore(box),
        tag: tag || '填空',
        judge: false,
      };
    }
    const options = extractOptions(box);
    if (!options.length) return null;
    const stem = extractStem(box);
    if (!stem || stem.length < 4) return null;
    const type = detectType(box);
    return {
      box, type, stem,
      options,
      score: extractScore(box),
      tag,
      judge: type === 'single' && isJudgeQuestion(box, tag, stem, options),
    };
  }

  // 题目指纹：用于答案缓存（题干 + 选项文本 + 题型）
  function fingerprint(q) {
    const s = [q.type, q.stem, q.options.map((o) => o.letter + ':' + o.text).join('|')].join('||');
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
    return 'q' + h.toString(36);
  }

  // 当前是否已作答 / 已选中的选项
  // 读取当前已选中的选项字母。
  //
  // ⚠️ 旧实现的下标错位缺陷（经对抗验证发现并实测复现）：
  //     它遍历未过滤的节点列表取 idx，却用 idx 去索引"已过滤可见性"的
  //     extractOptions 结果 —— 只要有任一选项隐藏，两个列表长度就不同，
  //     opts[idx] 会指向**另一个选项**。实测：实际勾选 C，却返回 "D"。
  //     后果是 verifySelection 用错字母校验 → 静默答错。
  //   现在改为：**逐个选中节点直接从自身解析字母**，不依赖任何下标对应关系。
  // ==========================================================================
  //  选项字母的**统一基准**：位置序号（第 1 个选项 = A，第 2 个 = B …）
  //
  //  为什么不用平台自己的 value / index-name？
  //  实测踩坑：用户平台的判断题 input.value = "T"/"F"，而提示词里选项编号是 A/B。
  //    两套体系混用 → AI 返回 A，脚本去勾"第 1 个"（value=T），
  //    校验时按 value 读字母读不到 → 报"期望 A、实际空" → 反复重试后停止。
  //
  //  位置序号是唯一**两端一致**的基准：
  //    · 发给 AI 的提示词用 A/B（按位置生成）
  //    · 勾选时按位置找第 N 个选项
  //    · 校验时也按位置读第 N 个
  //  这样无论平台内部用什么 value，都不会错位。
  // ==========================================================================
  function optionNodesIn(box) {
    if (!box) return [];
    try { return qsa('.el-radio, .el-checkbox', box).filter(visible); } catch (e) { return []; }
  }

  // 按位置取字母：下标 0 → 'A'
  function letterByIndex(i) { return String.fromCharCode(65 + i); }

  // 校验用的"已选字母"：**纯按位置**，不读平台 value
  function selectedLetters(box) {
    const out = [];
    const nodes = optionNodesIn(box);
    nodes.forEach((node, i) => {
      let checked = false;
      try {
        const inp = node.querySelector('input[type="radio"], input[type="checkbox"]');
        checked = node.classList.contains('is-checked') || !!(inp && inp.checked);
      } catch (e) { return; }
      if (!checked) return;
      out.push(letterByIndex(i));
    });
    out.sort();
    return out;
  }

  // 解析平台自带的字母/值（仅用于诊断展示，**不参与勾选与校验**）
  function nativeLetterOf(node) {
    if (!node) return '';
    // ① 序号元素
    try {
      const idxEl = node.querySelector('.index-name, [class*="index"]');
      if (idxEl) {
        const m = txt(idxEl).match(/[A-Ha-hTtFf]/);
        if (m) return m[0].toUpperCase();
      }
    } catch (e) {}
    // ② 内部 input 的 value（兼容 node 自身就是 input，或在子孙层）
    try {
      let inp = null;
      if (node.tagName === 'INPUT') inp = node;
      else if (node.querySelector) inp = node.querySelector('input');
      if (inp && inp.value !== undefined && inp.value !== null && String(inp.value) !== '') {
        return String(inp.value).trim().slice(0, 8);
      }
    } catch (e) {}
    return '';
  }

  // 兼容旧调用名（诊断里会用到）
  function letterOfOptionNode(node) { return nativeLetterOf(node); }

  // ==========================================================================
  //  3. AI 调用
  // ==========================================================================
  const SYSTEM_PROMPT =
    '你是严谨的考试答题助手。先独立核验题干、限定词和每一个选项，再给出答案。' +
    '客观题唯一允许的输出是选项字母，不输出分析、解释、标点或空格。';
  const SUBJECTIVE_SYSTEM_PROMPT =
    '你是严谨的考试阅卷与作答专家。答案必须直接回应题干，观点明确、层次完整、论证具体。' +
    '只输出可以填入答题框的正文，不要开场白、免责声明、Markdown 标题或代码块。';
  const SUBJECTIVE_SYSTEM_PROMPT_EN =
    'You are a rigorous exam-writing expert. Answer the question directly and substantively. ' +
    'Write exclusively in English, with no Chinese characters, translation notes, greetings, ' +
    'disclaimers, Markdown headings, or code blocks.';
  const CLOZE_SYSTEM_PROMPT =
    '你是严谨的填空题答题助手。只输出每个空应填的内容，按题目顺序每空一行；' +
    '不要输出序号、解释、引号、Markdown 或任何额外文字。';
  const CLOZE_SYSTEM_PROMPT_EN =
    'You are a rigorous fill-in-the-blank assistant. Output only the missing content for each blank, ' +
    'one blank per line, in order. Do not include numbering, explanations, quotation marks, or Markdown.';

  function isEnglishText(text) {
    const value = String(text || '');
    if (/(?:translate|render)[^.!?\n]{0,100}\b(?:into|to)\s+(?:simplified\s+)?chinese\b/i.test(value) ||
      /(?:翻译|译)(?:成|为)[^。！？\n]{0,30}(?:中文|汉语)/i.test(value) ||
      /(?:用|以)中文(?:回答|作答)|answer\s+in\s+chinese/i.test(value)) return false;
    if (/answer\s+(?:only\s+)?in\s+english|respond\s+in\s+english/i.test(value)) return true;
    if (/(?:用|使用|以)\s*(?:纯)?(?:英文|英语)[^。！？\n]{0,12}(?:回答|作答)|(?:回答|作答)[^。！？\n]{0,8}(?:用|使用|以)?\s*(?:纯)?(?:英文|英语)/i.test(value)) return true;
    const cjkCount = (value.match(/[\u3400-\u9fff]/g) || []).length;
    const words = value.match(/\b[A-Za-z][A-Za-z'-]*\b/g) || [];
    const latinChars = (value.match(/[A-Za-z]/g) || []).length;
    if (!latinChars) return false;
    if (cjkCount === 0) return latinChars >= 3;
    // 英文题干里偶尔夹有中文页签字符；只要英文主体足够长，仍按英文题处理。
    return words.length >= 15 && words.length >= cjkCount / 2;
  }

  function isEnglishSubjective(q) {
    if (!q || q.type !== 'subjective') return false;
    if (q.english === true || /英语|英文|english/i.test(q.tag || '')) return true;
    return isEnglishText(q.stem);
  }

  function isEnglishCloze(q) {
    if (!q || q.type !== 'cloze') return false;
    if (q.english === true || /英语|英文|english/i.test(q.tag || '')) return true;
    return isEnglishText(q.stem);
  }

  function hasNonEnglishScript(text) {
    return /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/.test(String(text || ''));
  }

  function systemPromptFor(q) {
    if (q && q.type === 'subjective') {
      return isEnglishSubjective(q) ? SUBJECTIVE_SYSTEM_PROMPT_EN : SUBJECTIVE_SYSTEM_PROMPT;
    }
    if (q && q.type === 'cloze') {
      return isEnglishCloze(q) ? CLOZE_SYSTEM_PROMPT_EN : CLOZE_SYSTEM_PROMPT;
    }
    return SYSTEM_PROMPT;
  }

  function subjectiveTargetChars(score) {
    const n = Number(score) || 0;
    if (n >= 20) return 700;
    if (n >= 10) return 500;
    if (n >= 5) return 350;
    return 300;
  }

  function subjectiveTargetWords(score) {
    const n = Number(score) || 0;
    if (n >= 20) return 320;
    if (n >= 10) return 260;
    return 200;
  }

  function buildPrompt(q) {
    if (q.type === 'subjective') {
      if (isEnglishSubjective(q)) {
        const targetWords = subjectiveTargetWords(q.score);
        return [
          'Question type: subjective long-answer question',
          q.score ? 'Score: ' + q.score : '',
          '',
          'Question: ' + q.stem,
          '',
          'Response requirements:',
          '1. Answer entirely in English. Do not use any Chinese characters or provide a Chinese translation.',
          '2. Start directly with your answer. Do not write introductions such as "Here is the answer."',
          '3. Write 3-4 focused paragraphs totaling about ' + targetWords + ' words (do not exceed ' + (targetWords + 60) + ' words).',
          '4. State a clear main position, support it with specific reasons or examples, and finish with a brief conclusion.',
          '5. Use precise academic English, but keep the wording efficient to avoid unnecessary delay.',
          '6. Do not use Markdown headings, bullet symbols, bold markers, or code blocks.',
        ].filter((x) => x !== '').join('\n');
      }
      const target = subjectiveTargetChars(q.score);
      return [
        '题目类型：主观题',
        q.tag ? '卷面标注：' + q.tag : '',
        q.score ? '本题分值：' + q.score + ' 分' : '',
        '',
        '题目：' + q.stem,
        '',
        '作答要求：',
        '1. 直接输出完整答案正文，不要写“以下是答案”等开场白。',
        '2. 用 4-6 个自然段作答，先总述，再分点论证，最后总结。',
        '3. 篇幅约 ' + target + ' 字；每个核心观点都要给出原因、事实、案例或具体举措。',
        '4. 使用“首先、其次、再次、最后”等自然衔接，不要用 Markdown 标题、星号或代码块。',
        '5. 内容必须紧扣题干，不堆砌空话；分点清晰，术语准确。',
      ].filter((x) => x !== '').join('\n');
    }
    if (q.type === 'cloze') {
      const count = q.blanks.length;
      if (isEnglishCloze(q)) {
        return [
          'Question type: fill in the blank',
          'Number of blanks: ' + count,
          q.score ? 'Score: ' + q.score : '',
          '',
          'Question with blanks: ' + q.stem,
          '',
          'Requirements:',
          '1. Give the exact missing content for each blank in order.',
          count === 1
            ? '2. Output one answer only, on one line, with no label or explanation.'
            : '2. Output exactly ' + count + ' lines, one answer per line, with no numbering.',
          '3. Keep each answer concise and use English when the question requires English.',
          '4. Do not repeat the question, add quotation marks, or use Markdown.',
        ].filter((x) => x !== '').join('\n');
      }
      return [
        '题目类型：填空题',
        '空格数量：' + count + ' 空',
        q.score ? '本题分值：' + q.score + ' 分' : '',
        '',
        '题目：' + q.stem,
        '',
        '作答要求：',
        '1. 按空格顺序给出每个空应填的准确内容。',
        count === 1
          ? '2. 只输出一个答案，占一行，不要写“答案：”、序号或解释。'
          : '2. 必须输出 ' + count + ' 行，每行只写一个空的答案，不要编号。',
        '3. 答案尽量简短，保留必要的大小写、符号和专业术语。',
        '4. 不要重复题干，不要加引号、Markdown 或额外说明。',
      ].filter((x) => x !== '').join('\n');
    }
    const lines = [];
    const judge = !!q.judge;
    lines.push('题目类型：' + (judge ? '判断题（两个选项中只有一个正确）' :
      (q.type === 'multi' ? '多选题（可能有多个正确答案）' : '单选题（只有一个正确答案）')));
    if (q.tag) lines.push('卷面标注：' + q.tag);
    if (q.score) lines.push('本题分值：' + q.score + ' 分');
    lines.push('');
    lines.push('题目：' + q.stem);
    lines.push('');
    lines.push('选项：');
    q.options.forEach((o) => lines.push(o.letter + '. ' + o.text));
    lines.push('');
    if (judge) {
      lines.push('作答规则：');
      lines.push('1. 先把题干拆成主体、条件、范围和结论，判断整句命题是否成立。');
      lines.push('2. 特别注意“必须、所有、只有、一定、立即”等绝对化措辞，以及否定词和条件限制。');
      lines.push('3. 在“正确”和“错误”两个选项中只选一个，按页面位置对应的字母输出。');
      lines.push('请判断唯一正确的选项，只输出那一个字母。');
      lines.push('例如对应“正确”的选项是 B，就输出：B');
      lines.push('严禁输出 T/F、解释、标点、空格或任何其他文字。');
    } else if (q.type === 'multi') {
      lines.push('作答规则：');
      lines.push('1. 把每个选项当作独立命题逐项核验，不要找到一个正确项就停止。');
      lines.push('2. 漏选和多选都会答错；只选能够被题干直接支持的选项。');
      lines.push('3. 注意题干中的“不属于、错误、除外、至少、全部”等否定或限定条件。');
      lines.push('请判断所有正确的选项，并把它们的字母按从小到大直接拼接输出。');
      lines.push('例如正确答案是 A 和 C，就输出：AC');
      lines.push('严禁输出解释、标点、空格或任何其他文字。');
    } else {
      lines.push('作答规则：');
      lines.push('1. 先独立判断每个选项，排除偷换概念、范围扩大、因果倒置和无关项。');
      lines.push('2. 注意题干中的否定词、限定词和“最/主要/首先”等要求。');
      lines.push('3. 不要根据选项顺序、长度或字母偏好猜测，只选择与题干完全一致的选项。');
      lines.push('请判断唯一正确的选项，只输出那一个字母。');
      lines.push('例如正确答案是 B，就输出：B');
      lines.push('严禁输出解释、标点、空格或任何其他文字。');
    }
    return lines.join('\n');
  }

  function httpGet(url, headers, timeoutMs) {
    return new Promise((resolve, reject) => {
      if (typeof GM_xmlhttpRequest === 'function') {
        GM_xmlhttpRequest({
          method: 'GET', url, headers, timeout: timeoutMs,
          onload: (r) => resolve({ status: r.status, text: r.responseText }),
          onerror: () => reject(new Error('网络错误（检查 apiBase 与 @connect）')),
          ontimeout: () => reject(new Error('请求超时')),
        });
        return;
      }
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), timeoutMs);
      fetch(url, { method: 'GET', headers, signal: ctl.signal })
        .then((r) => r.text().then((t) => ({ status: r.status, text: t })))
        .then((x) => { clearTimeout(timer); resolve(x); })
        .catch((e) => { clearTimeout(timer); reject(e); });
    });
  }

  function httpPost(url, headers, body, timeoutMs) {
    return new Promise((resolve, reject) => {
      const payload = JSON.stringify(body);
      if (typeof GM_xmlhttpRequest === 'function') {
        GM_xmlhttpRequest({
          method: 'POST', url, headers, data: payload, timeout: timeoutMs,
          onload: (r) => resolve({ status: r.status, text: r.responseText }),
          onerror: () => reject(new Error('网络错误（检查 apiBase 与 @connect）')),
          ontimeout: () => reject(new Error('请求超时（' + Math.round(timeoutMs / 1000) + 's）')),
        });
        return;
      }
      // 回退到 fetch（可能受 CORS 限制）
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), timeoutMs);
      fetch(url, { method: 'POST', headers, body: payload, signal: ctl.signal })
        .then((r) => r.text().then((t) => ({ status: r.status, text: t })))
        .then((x) => { clearTimeout(timer); resolve(x); })
        .catch((e) => { clearTimeout(timer); reject(e); });
    });
  }

  // ==========================================================================
  //  接口地址归一化与候选生成
  //
  //  实测问题：用户填 "https://xxx/v1" 或 "https://xxx" 会得到 openresty 的 404，
  //  但错误信息只有一串 HTML，完全无法定位到底该填什么路径。
  //  这里做两件事：
  //    ① 把用户填的地址**归一化**成完整的 chat/completions 端点
  //    ② 生成一组**候选地址**，按顺序自动探测，找到能用的就记住
  // ==========================================================================
  function normalizeEndpoint(input) {
    let s = String(input || '').trim();
    if (!s) return '';
    s = s.replace(/\s+/g, '');
    if (!/^https?:\/\//i.test(s)) s = 'https://' + s;       // 补协议
    s = s.replace(/\/+$/, '');                              // 去尾斜杠

    // 已经是完整端点了
    if (/\/chat\/completions$/i.test(s)) return s;
    if (/\/completions$/i.test(s)) return s;

    // 常见情况：填了 .../v1 或 .../v1/ → 补 /chat/completions
    if (/\/v\d+$/i.test(s)) return s + '/chat/completions';
    // 填了裸域名 → 补 /v1/chat/completions
    try {
      const u = new URL(s);
      if (!u.pathname || u.pathname === '/' || u.pathname === '') {
        return s + '/v1/chat/completions';
      }
    } catch (e) {}
    // 其它未知路径：原样返回（用户可能是自建网关，路径就是自定义的）
    return s;
  }

  // 生成候选地址（用于自动探测）
  //
  // 当前只提供 DeepSeek 预设，自动探测限制为 DeepSeek 官方兼容路径；
  // 用户手动填写的完整自定义端点仍会作为第一个候选保留。
  function endpointCandidates(input) {
    const norm = normalizeEndpoint(input);
    const set = [];
    const add = (u) => {
      if (u && /^https?:\/\//i.test(u) && set.indexOf(u) === -1) set.push(u);
    };
    add(norm);
    try {
      const u = new URL(norm);
      const origin = u.origin;
      add(origin + '/v1/chat/completions');
      if (/(^|\.)deepseek\.com$/i.test(u.hostname)) add(origin + '/chat/completions');
    } catch (e) {}
    return set;
  }

  // 探测：对候选地址逐个发一个最小请求，返回第一个可用的
  async function probeEndpoint() {
    const cands = endpointCandidates(cfg.apiBase);
    log('准备探测 ' + cands.length + ' 个候选地址…', 'info');
    for (const url of cands) {
      log('  尝试 ' + url, 'info');
      try {
        const body = {
          model: cfg.model,
          messages: [{ role: 'user', content: 'hi' }],
          max_tokens: 1,
          stream: false,
        };
        const headers = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + cfg.apiKey };
        const res = await httpPost(url, headers, body, Math.min(cfg.timeout, 15000));
        if (res.status >= 200 && res.status < 300) {
          log('✅ 可用地址：' + url, 'ok');
          return { ok: true, url };
        }
        // 401/403 说明路径对了但鉴权有问题 —— 也是"路径可用"的信号
        if (res.status === 401 || res.status === 403) {
          log('  → ' + res.status + '（路径存在，但鉴权失败，请检查 API Key）', 'warn');
          return { ok: false, url, reason: 'auth', status: res.status, text: res.text };
        }
        if (res.status === 404) { log('  → 404（路径不存在）', 'warn'); continue; }
        // 其他错误（400/429/5xx）说明路径基本对
        let detail = '';
        try { const j = JSON.parse(res.text); detail = (j.error && j.error.message) || ''; } catch (e) {}
        log('  → ' + res.status + (detail ? '：' + String(detail).slice(0, 60) : '（路径可能可用，是请求参数问题）'), 'warn');
        if (res.status === 400 || res.status === 429) return { ok: true, url };
      } catch (e) {
        log('  → 网络失败：' + (e && e.message), 'warn');
      }
    }
    return { ok: false, reason: 'all-failed' };
  }

  async function askAI(q) {
    if (!cfg.apiKey) throw new Error('未填写 API Key（面板「接口」页填写）');
    const subjective = q.type === 'subjective';
    const cloze = q.type === 'cloze';
    const englishSubjective = subjective && isEnglishSubjective(q);
    // deepseek-reasoner 会先把预算用于内部推理，再生成正式 content。
    // 只发送标准 chat/completions 字段，避免第三方兼容层因未知参数报 400。
    const isReasoningModel = /reasoner/i.test(cfg.model || '');
    const body = {
      model: cfg.model,
      messages: [
        { role: 'system', content: systemPromptFor(q) },
        { role: 'user', content: buildPrompt(q) },
      ],
      temperature: cfg.temperature,
      // 思考模型给足预算兜底（万一服务不支持关闭思考）
      max_tokens: subjective
        ? (englishSubjective
          ? Math.max(cfg.maxTokens, Math.min(2048, subjectiveTargetWords(q.score) * 2 + 256))
          : Math.max(cfg.maxTokens, Math.min(4096, subjectiveTargetChars(q.score) * 2 + 512)))
        : (cloze
          ? (isReasoningModel ? Math.max(2048, q.blanks.length * 160 + 256)
            : Math.min(1024, Math.max(256, q.blanks.length * 160 + 128)))
          : (isReasoningModel ? Math.max(cfg.maxTokens, 2048) : cfg.maxTokens)),
      stream: false,
    };
    const headers = {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + cfg.apiKey,
    };
    // 用归一化后的地址
    const url = normalizeEndpoint(cfg.apiBase);
    const res = await httpPost(url, headers, body, cfg.timeout);
    if (res.status < 200 || res.status >= 300) {
      let detail = (res.text || '').slice(0, 200);
      try { const j = JSON.parse(res.text); detail = (j.error && (j.error.message || j.error.type)) || detail; } catch (e) {}
      // 404 时给出可操作的提示（实测：用户会盲试 URL）
      if (res.status === 404) {
        detail = '路径不存在。当前请求：' + url +
          '。请点「自动探测地址」按钮，或手动填完整端点（如 https://api.deepseek.com/v1/chat/completions）';
      } else if (res.status === 401 || res.status === 403) {
        detail = '鉴权失败，请检查 API Key 是否正确/是否有该模型的权限。原始信息：' + detail;
      } else if (res.status === 402) {
        detail = '余额不足（402），请充值。原始信息：' + detail;
      } else if (res.status === 400 && /model/i.test(detail)) {
        detail = '模型名 "' + cfg.model + '" 可能无效：' + detail;
      }
      throw new Error('接口返回 ' + res.status + '：' + detail);
    }
    let data = null;
    try { data = JSON.parse(res.text); } catch (e) { throw new Error('接口返回不是 JSON：' + (res.text || '').slice(0, 120)); }
    const msg = data && data.choices && data.choices[0] && data.choices[0].message;
    // 思考模型：content 为空但 reasoning_content 有值 → 说明 max_tokens 被思考烧光，
    // 答案没来得及生成。给出可操作的错误而不是笼统的"未返回内容"。
    const choice = data && data.choices && data.choices[0];
    const content = (msg && msg.content) || (choice && choice.text);
    if (!content) {
      const finish = choice && choice.finish_reason;
      const hasReasoning = !!(msg && msg.reasoning_content);
      if (hasReasoning) {
        throw new Error('模型只输出了思考过程，正式答案为空（finish_reason=' + finish +
          '）→ 思考耗尽了 max_tokens。请把「接口」页 max_tokens 调大（如 4096），或换用非思考模型');
      }
      throw new Error('接口未返回内容（finish_reason=' + (finish || '未知') +
        '）。若反复出现：① 检查模型名是否正确 ② 点「拉取模型列表」看支持哪些模型');
    }
    if (subjective) {
      const text = cleanSubjectiveAnswer(content);
      if (!text || text.length < 20) {
        throw new Error('主观题回答过短或为空，未写入答题框');
      }
      if (englishSubjective) {
        const wordCount = (text.match(/\b[A-Za-z][A-Za-z'-]*\b/g) || []).length;
        if (hasNonEnglishScript(text)) {
          throw new Error('英文主观题返回了中文或非英文内容，未写入答题框');
        }
        if (wordCount < 40) {
          throw new Error('英文主观题回答过短（' + wordCount + ' words），未写入答题框');
        }
      }
      if (choice && choice.finish_reason === 'length') {
        throw new Error('主观题回答达到 max_tokens 上限而被截断，请调大 max_tokens 后重试');
      }
      return { raw: String(content), text };
    }
    if (cloze) {
      const parsed = parseClozeAnswer(content, q);
      if (!parsed.answers.length || parsed.answers.length !== q.blanks.length) {
        throw new Error('填空题答案数量不匹配：' + (parsed.note || '未解析出答案'));
      }
      return parsed;
    }
    return parseAnswer(content, q);
  }

  // ==========================================================================
  //  从模型输出里抽取选项字母
  //
  //  设计原则（经 5 轮独立审计 + 对抗验证后重写）：
  //    ① 宁可返回空（外层会报错重试/停止），也绝不猜一个错误答案
  //    ② 只接受"看起来像答案"的片段，不拿英文散文里的字母凑数
  //    ③ 多答案必须**全部收集**，不能遇到第一个就 break
  //    ④ 返回置信度，外层据此决定"是否写入缓存"
  //       （实测教训：解析错 + 无 TTL 缓存 = 该题永久答错）
  // ==========================================================================

  // 常见英文停用词（若被当成"选项字母串"提取出来，说明是散文而非答案）
  const EN_STOP = /^(the|this|that|is|are|was|were|and|or|not|no|yes|ok|all|answer|option|correct|good|bad|hard|easy|question|choose|select|because|since|which|what|who|when|where|how|it|he|she|they|we|you|i|a|an|of|to|in|on|at|for|by|with|from|as|be|do|does|did|can|could|will|would|shall|should|may|might|must|have|has|had)$/i;

  function parseAnswer(content, q) {
    const raw = String(content || '').trim();
    const valid = new Set(q.options.map((o) => o.letter));
    const nOpts = q.options.length || 4;

    // 归一化：全角→半角，去掉 markdown 强调符与不可见字符
    const norm = raw
      .replace(/[\u200b-\u200f\ufeff]/g, '')
      .replace(/[Ａ-Ｚａ-ｚ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
      .replace(/[*_`~]/g, '')
      .replace(/\s+/g, ' ')
      .trim();

    let letters = '';
    let confidence = 'none';   // none | low | medium | high

    // ---------- 散文判据（关键防线）----------
    // 实测事故：把 "He is a good boy" 当答案 → 取到冠词 "a" → 勾错选项。
    // 判据：输出里若出现 2 个以上"长度≥3 的英文单词"，说明这是自然语言
    // （解释、思考过程、英文题干回显），**不是纯答案**。
    // 此时只接受 ① 轮（显式"答案："前缀）的结果，②③ 轮一律拒绝。
    const enWords = (norm.match(/[A-Za-z]{3,}/g) || [])
      .filter((w) => !/^(the|and|or|not|you|are|was|were|has|had|can|may|all|any|but|for|with|from|this|that|these|those)$/i.test(w));
    const looksLikeProse = enWords.length >= 2;

    const uniqueSort = (s) => {
      const seen = [];
      for (const ch of String(s).toUpperCase()) {
        if (!/[A-H]/.test(ch)) continue;
        if (!valid.has(ch)) continue;          // 只保留本题真实存在的选项
        if (seen.indexOf(ch) === -1) seen.push(ch);
      }
      seen.sort();
      return seen.join('');
    };

    // ---------- ① 最高可信：显式的"答案"标记 ----------
    // 支持：答案：B / 答案 A、B、C / 正确答案是 AC / answer: A,C / 答案为A和B
    // 也兼容 {"answer":"AC"} 这种 JSON 形式的模型输出。
    const jsonAnswer = norm.match(/["']?(?:answer|答案|correct\s*answer)["']?\s*[:：]\s*["']?([A-Ha-h](?:\s*[,，、/|.．和与及]?\s*[A-Ha-h]){0,7})/i);
    if (jsonAnswer && jsonAnswer[1]) {
      const uniq = uniqueSort(jsonAnswer[1]);
      if (uniq) { letters = uniq; confidence = 'high'; }
    }
    const PREFIX = /(?:答案|正确答案|正确选项|应选|answer|correct\s*answer|ans)\s*(?:是|为|:|：|=)?\s*[「『"'（(\[]*/i;
    const pm = norm.match(new RegExp(PREFIX.source + '((?:[A-Ha-h]\\s*[\\s,，、/|.．和与及]*\\s*){1,8})'));
    if (!letters && pm && pm[1]) {
      const got = (pm[1].match(/[A-Ha-h]/g) || []).join('');
      const uniq = uniqueSort(got);
      if (uniq) { letters = uniq; confidence = 'high'; }
    }

    // ---------- ② 次高可信：整串"像答案"的字母序列 ----------
    // ⚠️ 散文输出直接跳过这一轮（否则 "a good" 的冠词 a 会被当成选项）
    if (!letters && !looksLikeProse) {
      const SEP = '[\\s,，、/|.．:：;；\\-和与及或者]*';
      const re = new RegExp('(?:^|[^A-Za-z0-9])(?:[（(]?\\d{1,2}[)）.．、]?\\s*)?([A-Ha-h](?:' + SEP + '[A-Ha-h]){0,7})(?![A-Za-z])', 'g');
      const segs = [];
      let mm;
      while ((mm = re.exec(norm)) !== null) {
        const s = mm[1].replace(/[^A-Ha-h]/g, '');
        if (!s) continue;
        if (s.length > nOpts) continue;
        if (s.length > 1 && EN_STOP.test(s)) continue;
        segs.push(s);
      }
      if (segs.length) {
        const joined = uniqueSort(segs.join(''));
        if (joined) {
          letters = joined;
          confidence = (segs.length === 1) ? 'high' : 'low';
        }
      }
    }

    // ---------- ③ 低可信兜底：整段就是几个独立字母 ----------
    if (!letters && !looksLikeProse) {
      const stripped = norm.replace(/[^A-Za-z\u4e00-\u9fa5]/g, ' ').trim();
      const words = stripped.split(/\s+/).filter(Boolean);
      const onlyLetters = words.length > 0 && words.every((w) => /^[A-Ha-h]$/.test(w));
      const isShort = norm.length <= Math.max(20, nOpts * 4);
      if (onlyLetters && isShort) {
        const uniq = uniqueSort(words.join(''));
        if (uniq) { letters = uniq; confidence = 'low'; }
      }
    }

    // ---------- 判断题语义兜底：模型偶尔无视“只输出字母” ----------
    if (!letters && q.judge) {
      const semantic = norm
        .replace(PREFIX, '')
        .replace(/[。.!！,，;；:：\s]/g, '')
        .trim();
      let wantSemantic = '';
      if (/^(正确|对|是|成立|true|t|√|✓)$/i.test(semantic)) wantSemantic = 'yes';
      if (/^(错误|错|否|不成立|false|f|×|✗)$/i.test(semantic)) wantSemantic = 'no';
      if (wantSemantic) {
        const yes = /^(正确|对|是|成立|true|t|√|✓)$/i;
        const no = /^(错误|错|否|不成立|false|f|×|✗)$/i;
        const hit = q.options.find((o) => {
          const t = String(o.text || '').replace(/[\s.。,:：;；]/g, '');
          return wantSemantic === 'yes' ? yes.test(t) : no.test(t);
        });
        if (hit) { letters = hit.letter; confidence = 'high'; }
      }
    }

    const picks = (q.type === 'multi') ? letters.split('') : letters.split('').slice(0, 1);

    // ---------- 一致性校验：降低"猜错"的可信度 ----------
    let note = '';
    if (!picks.length) {
      confidence = 'none';
    } else if (q.type === 'single' && letters.length > 1) {
      // 单选却给了多个 → 说明模型没按格式输出，只取第一个有猜错风险
      confidence = 'low';
      note = '单选但模型给了多个字母';
    } else if (q.type === 'multi' && picks.length === 1) {
      // 多选只给一个 —— 可能是真的只有一个正确项，也可能是模型漏了
      confidence = confidence === 'high' ? 'medium' : confidence;
      note = '多选但只给出一个选项';
    }
    if (confidence === 'medium') { /* 保留，外层按 high 处理 */ }

    return { raw, letters: picks, rawLetters: letters, confidence, note };
  }

  function cleanClozeLine(line) {
    let s = String(line || '').trim();
    s = s.replace(/^```(?:text|txt)?\s*/i, '').replace(/\s*```$/i, '').trim();
    s = s.replace(/^(?:答案|参考答案)\s*[:：]\s*/i, '');
    s = s.replace(/^(?:第\s*)?\d{1,2}\s*空\s*[:：]\s*/i, '');
    s = s.replace(/^空\s*\d{1,2}\s*[:：]\s*/i, '');
    s = s.replace(/^\d{1,2}\s*[.、．:：)）]\s*/, '');
    s = s.replace(/^[“”"'`](.*)[“”"'`]$/, '$1').trim();
    return s;
  }

  function parseClozeAnswer(content, q) {
    const raw = String(content || '').trim();
    if (!raw) return { raw, answers: [], confidence: 'none' };
    let normalized = raw.replace(/\r\n?/g, '\n').trim();
    normalized = normalized.replace(/^```(?:text|txt)?\s*/i, '').replace(/\s*```$/i, '').trim();

    let lines = normalized.split(/\n+/).map(cleanClozeLine).filter(Boolean);
    const need = q.blanks.length;
    if (need > 1 && lines.length < need) {
      const separated = normalized.split(/\t+|\s*\|\s*|\s*[；;]\s*/).map(cleanClozeLine).filter(Boolean);
      if (separated.length > lines.length) lines = separated;
    }
    if (need === 1 && !lines.length) lines = [cleanClozeLine(normalized)];
    if (lines.length > need) lines = lines.slice(0, need);

    return {
      raw,
      answers: lines,
      confidence: lines.length === need ? 'high' : 'low',
      note: lines.length === need ? '' : '模型给出的空格答案数量不足（需要 ' + need + '，实际 ' + lines.length + '）',
    };
  }

  // 解析结果是否足够可信到可以写入缓存？
  // 实测教训：把低可信答案写进缓存会让该题"持续答错"，所以只缓存高可信结果。
  function isCacheable(res, q) {
    if (!res || !res.letters || !res.letters.length) return false;
    if (res.confidence === 'high') return true;
    // 多选只给一个字母时是 medium，也允许缓存（真只有一个正确项的情况很常见）
    if (res.confidence === 'medium' && q && q.type === 'multi' && res.letters.length === 1) return true;
    return false;
  }

  // ==========================================================================
  //  4. 答案缓存
  // ==========================================================================
  let bank = null;
  function loadBank() {
    if (bank) return bank;
    let raw = gmGet(STORE_BANK, null);
    if (typeof raw === 'string') { try { raw = JSON.parse(raw); } catch (e) { raw = null; } }
    bank = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
    return bank;
  }
  function bankGet(fp) {
    const b = loadBank();
    const hit = b[fp];
    return (hit && typeof hit.ans === 'string') ? hit.ans : null;
  }
  function bankSet(fp, ans, meta) {
    const b = loadBank();
    b[fp] = { ans, t: Date.now(), q: (meta && meta.stem || '').slice(0, 80) };
    // 容量控制：超过 800 条淘汰最早的
    const keys = Object.keys(b);
    if (keys.length > 800) {
      keys.sort((x, y) => (b[x].t || 0) - (b[y].t || 0));
      keys.slice(0, keys.length - 800).forEach((k) => delete b[k]);
    }
    gmSet(STORE_BANK, JSON.stringify(b));
  }
  function bankDelete(fp) {
    const b = loadBank();
    if (!Object.prototype.hasOwnProperty.call(b, fp)) return false;
    delete b[fp];
    gmSet(STORE_BANK, JSON.stringify(b));
    return true;
  }
  function bankCount() { return Object.keys(loadBank()).length; }

  // ==========================================================================
  //  5. 答题卡 / 翻页
  // ==========================================================================
  // 答题卡题号：找一串"纯数字的、尺寸相近的"小元素
  function findCardNumbers() {
    const cands = [];
    for (const el of qsa('li, span, div, a, button')) {
      const t = txt(el);
      if (!/^\d{1,3}$/.test(t)) continue;
      if (!visible(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 12 || r.width > 70 || r.height < 12 || r.height > 70) continue;
      cands.push({ el, n: parseInt(t, 10), r });
    }
    if (cands.length < 2) return [];
    // 同一行/列的题号通常尺寸相近、位置连续 → 用尺寸聚类筛掉杂项
    const bySize = {};
    for (const c of cands) {
      const key = Math.round(c.r.width) + 'x' + Math.round(c.r.height);
      (bySize[key] = bySize[key] || []).push(c);
    }
    let best = [];
    for (const k of Object.keys(bySize)) if (bySize[k].length > best.length) best = bySize[k];
    best.sort((a, b) => a.n - b.n);
    return best;
  }

  // 判断某个题号是否"已作答"。
  // ⚠️ 关键区分：active/current/cur 表示"当前正在看哪一题"，**不是"已作答"**！
  //    把它们当已作答会导致初始状态就误判（实测 answered=1）。
  //    但反过来也不能"见到 active 就判未作答"——当前题也可能是已答的。
  //    所以：明确的"已完成"类名 > 颜色判据 > "进行中"类名不参与否决。
  function isNumberAnswered(item) {
    const el = item.el;
    const c = (typeof el.className === 'string') ? el.className : '';

    // ① 明确的"已完成"类名 → 直接判已答
    if (/done|finished|answered|complete|success|right|correct/i.test(c)) return true;
    // ② 明确的"未作答"类名 → 直接判未答
    if (/unanswered|todo|undone|not-?answer/i.test(c)) return false;

    // ③ 元素内有对勾图标
    try {
      if (el.querySelector && el.querySelector('.done-icon, .is-done, [class*="check"], [class*="tick"]')) return true;
    } catch (e) {}

    // ④ 颜色判据（最可靠：已答题号通常被填成蓝色/绿色实心）
    try {
      const st = getComputedStyle(el);
      const bg = st.backgroundColor || '';
      const m = bg.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?/);
      if (m) {
        const a = m[4] === undefined ? 1 : +m[4];
        const r = +m[1], g = +m[2], b = +m[3];
        if (a > 0.3 && !(r > 240 && g > 240 && b > 240)) return true;   // 有颜色的实心背景
      }
      const col = st.color || '';
      const mc = col.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
      if (mc) {
        const r = +mc[1], g = +mc[2], b = +mc[3];
        const isBlue = b > r + 30 && b > 100;
        const isGreen = g > r + 20 && g > b + 20;
        if (isBlue || isGreen) return true;
      }
    } catch (e) {}

    // ⑤ active/current 只影响"当前题"判断，不影响"是否已答" → 默认未答
    return false;
  }

  function cardStatus() {
    const items = findCardNumbers();
    if (!items.length) return { total: 0, answered: 0, items: [], reliable: false };
    let answered = 0;
    for (const it of items) if (isNumberAnswered(it)) answered++;
    return { total: items.length, answered, items, reliable: true };
  }

  // 当前是第几题（按答题卡高亮判断；失败则按题干序号）
  function currentIndex() {
    const st = cardStatus();
    if (st.reliable) {
      for (let i = 0; i < st.items.length; i++) {
        const c = (typeof st.items[i].el.className === 'string') ? st.items[i].el.className : '';
        if (/active|current|cur/i.test(c)) return i;
      }
      // 答题卡里没有高亮标记时，用"已答数量"推断不了当前题，
      // 退到题干序号（下面兜底）
    }
    // 兜底：题干开头的数字
    // 实测坑：题干常是 "1.xxx" / "1、xxx" / "1 xxx" / "（1）xxx"，
    //        旧版只认 ^\d+[.、．] 且要求紧贴开头，稍微多个空格就失败 → 返回 -1
    const box = findQuestionBox();
    if (box) {
      const t = txt(box).replace(/^[\s\u3000]+/, '');
      let m = t.match(/^[（(]?\s*(\d{1,3})\s*[)）]?\s*[.、．,:：]?\s*\S/);
      if (m) {
        const n = parseInt(m[1], 10);
        if (n >= 1 && n <= 999) return n - 1;
      }
    }
    return -1;
  }

  // 供显示用：题号（1 起）。识别不到时返回 0，调用方显示"?"而不是"0"
  function questionNo() {
    const i = currentIndex();
    return i >= 0 ? i + 1 : 0;
  }

  // 判断导航按钮是否"不可用"。
  // ⚠️ audit-D 发现1：旧版只查 btn.disabled（对 span/div/a 恒为 undefined）
  //    和 className 含 disabled —— 会漏掉 Element UI 的 is-loading、
  //    aria-disabled、父容器 disabled、pointer-events:none 这几种真实禁用态。
  function isNavDisabled(btn) {
    if (!btn) return true;
    try {
      if (btn.disabled === true) return true;
      if (btn.getAttribute && btn.getAttribute('aria-disabled') === 'true') return true;
      const c = (typeof btn.className === 'string') ? btn.className : '';
      if (/disabled|is-loading|loading/i.test(c)) return true;
      // 祖先容器被禁用
      let p = btn, d = 0;
      while (p && d++ < 5) {
        const pc = (typeof p.className === 'string') ? p.className : '';
        if (/disabled/i.test(pc) || p.getAttribute && p.getAttribute('aria-disabled') === 'true') return true;
        p = p.parentElement;
      }
      // pointer-events:none —— 合成事件会穿透它，点等于没点
      let q = btn, d2 = 0;
      while (q && d2++ < 6) {
        let st; try { st = getComputedStyle(q); } catch (e) { st = null; }
        if (st && st.pointerEvents === 'none') return true;
        q = q.parentElement;
      }
    } catch (e) {}
    return false;
  }

  // 找翻页按钮。
  //
  // ⚠️ audit-D 发现的真实风险：旧版用 qsa('button,[role=button],a,span,div') 全文档扫描，
  //    没有 isOwnUI 排除、没有歧义放弃，而排序又优先选 <button> ——
  //    面板那 16 个按钮恰好全是 <button> 且 z-index 最高，一旦文案撞车就可能点到自己面板。
  //    旧版"安全"只是因为 ^...$ 锚定恰好挡住了面板文案，属于巧合。
  //    现在：① 排除自身 UI ② 同分多个候选择放弃（歧义即放弃，不猜）
  // 翻页按钮查找的诊断信息（失败时打进日志，避免"找不到却不知道为什么"）
  let lastNavDiag = '';

  // 向上找"真正的可点按钮"。
  // Element UI 的结构是 <button class="el-button"><span>下一题</span></button>，
  // 文字在内层 span 上。若只点 span，某些实现不生效（span 可能 pointer-events:none）。
  // 这里从文字元素向上找最近的语义按钮 / 带 cursor:pointer 的祖先。
  function resolveNavTarget(el) {
    if (!el) return el;
    const isSemantic = (n) => n && (n.tagName === 'BUTTON' || n.tagName === 'A' ||
      (n.getAttribute && n.getAttribute('role') === 'button'));
    if (isSemantic(el)) return el;
    let p = el.parentElement, d = 0;
    let fallback = el;
    while (p && d++ < 6) {
      if (isSemantic(p)) return p;
      // 带 cursor:pointer 且可见 → 认为是可点容器
      try {
        const st = getComputedStyle(p);
        if (st && st.cursor === 'pointer' && visible(p)) {
          if (p.className && /btn|button|nav|page/i.test(String(p.className))) return p;
          fallback = p;
        }
      } catch (e) {}
      p = p.parentElement;
    }
    return fallback;
  }

  // 找翻页按钮。
  //
  // ⚠️ 实测坑（用户日志"点击「下一题」失败"，但按钮就在页面上）：
  //    Element UI 把文字放在内层 <span>，旧版选到了这个 span 而非外层 <button>，
  //    加上 clickEl 的静默失败路径 → 报"点击失败"却毫无线索。
  //
  //  现在的匹配策略改为 **包含 + 排除**（方案取自 example.txt）：
  //    · 包含：/下一题|下一个|下一页/ —— 不再要求全等，容得下"下一题（3/5）"这类带后缀的
  //    · 排除：/上一题|提交|交卷|作业|保存|返回/ —— 防止把危险按钮误判进来
  //    这比锚定 ^...$ 宽松得多，又比纯包含安全。
  function findNavButton(kind) {
    const isNext = kind === 'next';
    const INC = isNext
      ? /下一题|下一个|下一页|下一节|下一步/i
      : /上一题|上一个|上一页|上一节|上一步/i;
    // 排除词是安全底线：宁可找不到，也不能点到提交/交卷。
    // ⚠️ 注意：排除的是"对立方向 + 危险动作"，**不能**把自己那个方向也排掉
    //    （曾经把"上一题"写进排除词，导致上一题按钮永远找不到）。
    const OPPOSITE = isNext
      ? /上一题|上一个|上一页|上一节|上一步/i
      : /下一题|下一个|下一页|下一节|下一步/i;
    const DANGER = /提交|交卷|保存|返回|退出|删除|清空|重置|作业|考试|开始/i;
    const hit = (el) => {
      let label = '';
      try {
        label = [el.getAttribute && el.getAttribute('aria-label'), el.getAttribute && el.getAttribute('title')]
          .filter(Boolean).join(' ');
      } catch (e) {}
      const t = (txt(el) + ' ' + label).trim();
      if (!t) return false;
      if (!INC.test(t)) return false;
      if (OPPOSITE.test(t)) return false;
      if (DANGER.test(t)) return false;
      return true;
    };

    const raw = [];        // 文字命中的原始元素
    const rejected = [];   // 被过滤的原因（用于诊断）
    for (const el of qsa('button, [role="button"], a, li, span, div')) {
      const t = txt(el);
      if (t.length > 20) continue;            // 容得下图标按钮的 aria-label
      if (!hit(el)) continue;
      if (isOwnUI(el)) { rejected.push('自身UI'); continue; }
      if (!visible(el)) { rejected.push('不可见'); continue; }
      raw.push(el);
    }
    if (!raw.length) {
      try {
        lastNavDiag = '页面上没有文字为「' + (kind === 'next' ? '下一题' : '上一题') + '」的可见元素';
      } catch (e) {}
      return null;
    }

    // 只保留"最内层"的（避免 button 与其内部 span 重复计数）
    const inner = raw.filter((el) => !raw.some((o) => o !== el && el.contains(o)));
    const pool = inner.length ? inner : raw;

    // 向上解析成真正的可点目标
    const targets = [];
    for (const el of pool) {
      const tgt = resolveNavTarget(el);
      if (isOwnUI(tgt)) { rejected.push('解析到自身UI'); continue; }
      if (tgt.querySelector && tgt.querySelector('#blq, #blq-mini')) { rejected.push('解析到自身UI'); continue; }
      if (!targets.includes(tgt)) targets.push(tgt);
    }
    if (!targets.length) {
      try { lastNavDiag = '候选被过滤：' + rejected.join('/'); } catch (e) {}
      return null;
    }

    // 按"语义强度 + 可见性"排序，取最优
    const rank = (el) => {
      let s = 0;
      if (el.tagName === 'BUTTON') s += 8;
      if (el.getAttribute && el.getAttribute('role') === 'button') s += 4;
      if (el.tagName === 'A') s += 2;
      try {
        const st = getComputedStyle(el);
        if (st && st.cursor === 'pointer') s += 1;
      } catch (e) {}
      if (visible(el)) s += 1;
      return s;
    };
    targets.sort((a, b) => rank(b) - rank(a));

    // 不再"歧义即放弃"——那会让唯一按钮因同分而失败。
    // 改成：取排名最高的；若同名次有多个，优先第一个可见的（页面上通常只有一个）。
    const top = targets.filter((el) => rank(el) === rank(targets[0]));
    const chosen = top[0];
    try {
      lastNavDiag = '选中 <' + chosen.tagName.toLowerCase() + '> class="' +
        String(chosen.className || '').slice(0, 40) + '"' +
        (top.length > 1 ? '（同分 ' + top.length + ' 个，取第一个）' : '');
    } catch (e) {}
    return chosen;
  }

  // ==========================================================================
  //  6. 核心流程
  // ==========================================================================
  const S = {
    running: false,
    busy: false,
    stopRequested: false,   // ★ 是否收到过"停止"指令（用于中断进行中的题目）
    answeredCount: 0,
    aiCalls: 0,
    cacheHits: 0,
    fails: 0,
    lastRun: 0,
    currentFp: '',
    stopReason: '',
    recentTimes: [],   // 速率限制
  };

  function rateLimitOk() {
    const now = Date.now();
    S.recentTimes = S.recentTimes.filter((t) => now - t < 60000);
    return S.recentTimes.length < cfg.maxPerMinute;
  }

  // 点击选项节点（selectOption / deselectOption 共用）
  //
  // ⚠️ 实测事故（用户日志：勾选校验未通过，期望 B 实际为空）：
  //    Element UI 的结构是
  //      <label class="el-radio">
  //        <span class="el-radio__input"><input type="radio"></span>
  //        <span class="el-radio__label">A.xxx</span>
  //      </label>
  //    往 <label> 派发**合成事件**时，浏览器不会执行"label → input"的原生转发
  //    （那只对真实用户点击或 label.click() 生效），于是 input 永远不勾选。
  //    旧版只在 clickEl 的 catch 分支里调 el.click()，正常路径下永远走不到。
  //
  //  现在的策略改为 **forceClick 全打一遍**（方案取自 example.txt，实测有效）：
  //    不再"逐层试、成功就停"，而是把**所有能用的事件一次性全发**。
  //    原因：Element UI 的 radio 需要同时满足两件事才认账 ——
  //      · DOM 上 input.checked 变成 true
  //      · 框架内部状态同步（靠 change/input 事件）
  //    任何"只做一半"的策略都可能出现"看起来选中了但提交时是空的"。
  //
  //  另外区分单选/多选的点击目标（也来自 example.txt）：
  //    · 多选：只点**未选中**的（再点已选的会取消），且直接点 input
  //    · 单选：先点视觉小圆圈 .el-radio__inner（Element UI 真正响应点击的地方），
  //            再 forceClick 整个 label 兜底
  function reallyClickOption(opt) {
    if (!opt || !opt.node) return false;
    const node = opt.node;

    // 找内部原生 input（可能在 node 自身、或 .el-radio__input 等包裹层里）
    const inp = (() => {
      try {
        return opt.input ||
          (node.querySelector && node.querySelector('input[type="radio"], input[type="checkbox"]')) ||
          (node.parentElement && node.parentElement.querySelector &&
            node.parentElement.querySelector('input[type="radio"], input[type="checkbox"]')) || null;
      } catch (e) { return null; }
    })();

    const isMulti = (inp && inp.type === 'checkbox') ||
      (node.classList && node.classList.contains('el-checkbox'));

    if (isMulti) {
      // ★ 多选：**严格只调 input.click()**，绝不走 forceClick。
      //   ⚠️ 实测（_dbg-forceclick）：forceClick 对 checkbox 是**破坏性**的 ——
      //      它先 `input.checked = true` 再 `input.click()`，而 checkbox 的 click
      //      是翻转语义 → 最终被翻回 false，勾选失败。
      //      （radio 没有这个问题，所以单选可以放心用 forceClick。）
      //   这正对应 example.txt 的做法：多选只 input.click()，单选才 forceClick。
      const already = inp ? !!inp.checked : false;
      if (already) return true;                 // 已选中，不做任何操作
      if (inp) {
        try { inp.click(); } catch (e) {
          // input.click() 都失败了，才退回"赋值 + 事件"路线（不调 click，避免翻转）
          try { inp.checked = true; } catch (e2) {}
          try { inp.dispatchEvent(new Event('change', { bubbles: true })); } catch (e2) {}
          try { inp.dispatchEvent(new Event('input', { bubbles: true })); } catch (e2) {}
        }
      } else {
        // 找不到原生 input：只能对整个 label 派发事件（这条路对 checkbox 有翻转风险，
        // 但没有 input 时别无选择；调用方会做最终校验）
        try { node.click(); } catch (e) {}
      }
    } else {
      // ★ 单选：先点视觉小圆圈，再 forceClick 整个 label
      try {
        const inner = node.querySelector('.el-radio__inner, .el-checkbox__inner');
        if (inner) forceClick(inner);
      } catch (e) {}
      forceClick(node);
    }

    // 最终确认一次
    if (cfg.dryRun) return true;
    return isOptionChecked(opt);
  }

  // 兼容旧调用名
  function clickOptionNode(opt) {
    if (!opt || !opt.node) return false;
    if (cfg.dryRun) return true;
    // 不再要求 reallyClickable —— Element UI 的原生 input 是 opacity:0 的隐藏元素，
    // elementFromPoint 命中测试必然失败，但它才是真正承载状态的目标。
    // 只要 label 在页面上可见即可。
    let okVis = false;
    try {
      const node = opt.node;
      okVis = visible(node) ||
        (node.querySelector && (visible(node.querySelector('label')) ||
          visible(node.querySelector('.el-radio__label, .el-checkbox__label'))));
    } catch (e) { okVis = false; }
    if (!okVis) return false;
    return reallyClickOption(opt);
  }

  function isOptionChecked(opt) {
    if (!opt || !opt.node) return false;
    try {
      const inp = opt.input || opt.node.querySelector('input[type="radio"], input[type="checkbox"]');
      return opt.node.classList.contains('is-checked') || !!(inp && inp.checked);
    } catch (e) { return false; }
  }

  function selectOption(opt) {
    if (!opt || !opt.node) return false;
    if (isOptionChecked(opt)) return true;      // 已选中，不重复点（checkbox 再点会取消）
    return clickOptionNode(opt);
  }

  // 取消勾选。
  // ⚠️ 只有 checkbox（多选）支持取消；radio（单选）点已选项不会取消，
  //    单选要"改答案"必须点**另一个**选项，由 selectOption 完成。
  function deselectOption(opt) {
    if (!opt || !opt.node) return false;
    if (!isOptionChecked(opt)) return true;     // 本来就没选，无需操作
    const inp = opt.input || opt.node.querySelector('input[type="radio"], input[type="checkbox"]');
    const isCheckbox = (inp && inp.type === 'checkbox') ||
      (opt.node.classList && opt.node.classList.contains('el-checkbox'));
    if (!isCheckbox) return false;              // radio 不支持取消
    if (cfg.dryRun) return true;
    // 用 forceUncheck：直接置 false 并通知框架（forceClick 只会置 true）
    return forceUncheck(opt.node);
  }

  // 校验：勾选后复查选中状态
  function verifySelection(box, wantLetters) {
    const now = selectedLetters(box);
    const want = wantLetters.slice().sort();
    const got = now.slice().sort();
    return want.length === got.length && want.every((x, i) => x === got[i]);
  }

  function isQuestionAnswered(q) {
    if (!q) return false;
    if (q.type === 'subjective') return editorText(q.editor).length > 0;
    if (q.type === 'cloze') {
      return !!q.blanks.length && q.blanks.every((input) => String(input.value || '').trim().length > 0);
    }
    return selectedLetters(q.box).length > 0;
  }

  function cachedClozeAnswers(raw) {
    try {
      const parsed = JSON.parse(String(raw || ''));
      if (Array.isArray(parsed) && parsed.every((x) => typeof x === 'string')) return parsed;
    } catch (e) {}
    return String(raw || '').split('\u001f').filter(Boolean);
  }

  function clozeCacheValue(answers) {
    return JSON.stringify(answers.map((x) => String(x || '').trim()));
  }

  async function fillClozeInputs(inputs, answers) {
    if (!inputs || !inputs.length || !answers || answers.length !== inputs.length) {
      return { ok: false, filled: 0, expected: inputs ? inputs.length : 0, mismatches: [] };
    }
    for (let i = 0; i < inputs.length; i++) {
      const input = inputs[i];
      const answer = String(answers[i] || '').trim();
      try { input.scrollIntoView({ block: 'center', behavior: 'instant' }); } catch (e) {}
      try { input.focus({ preventScroll: true }); } catch (e) { try { input.focus(); } catch (e2) {} }
      try { input.click(); } catch (e) {}
      try {
        const ownerDoc = input.ownerDocument || document;
        const win = ownerDoc.defaultView || window;
        const Ctor = win && win.HTMLInputElement;
        const proto = Ctor && Ctor.prototype;
        const setter = proto ? Object.getOwnPropertyDescriptor(proto, 'value') : null;
        if (setter && setter.set) setter.set.call(input, answer);
        else input.value = answer;
      } catch (e) {
        try { input.value = answer; } catch (e2) {}
      }
      dispatchEditorInput(input, answer);
      await sleep(90);
    }

    try {
      const last = inputs[inputs.length - 1];
      if (typeof FocusEvent !== 'undefined') last.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
      if (typeof last.blur === 'function') last.blur();
    } catch (e) {}
    await sleep(160);
    let mismatches = [];
    inputs.forEach((input, i) => {
      if (String(input.value || '').trim() !== String(answers[i] || '').trim()) mismatches.push(i + 1);
    });
    if (mismatches.length) {
      // 部分表单组件会把第一次写入延迟到下一帧，或忽略未聚焦时的 input。
      for (const emptyNo of mismatches) {
        const input = inputs[emptyNo - 1];
        const answer = String(answers[emptyNo - 1] || '').trim();
        try { input.focus(); } catch (e) {}
        try { input.click(); } catch (e) {}
        try {
          const ownerDoc = input.ownerDocument || document;
          const win = ownerDoc.defaultView || window;
          const Ctor = win && win.HTMLInputElement;
          const proto = Ctor && Ctor.prototype;
          const setter = proto ? Object.getOwnPropertyDescriptor(proto, 'value') : null;
          if (setter && setter.set) setter.set.call(input, answer);
          else input.value = answer;
        } catch (e) {
          try { input.value = answer; } catch (e2) {}
        }
        dispatchEditorInput(input, answer);
      }
      await sleep(220);
      mismatches = [];
      inputs.forEach((input, i) => {
        if (String(input.value || '').trim() !== String(answers[i] || '').trim()) mismatches.push(i + 1);
      });
    }
    return {
      ok: mismatches.length === 0,
      filled: inputs.length - mismatches.length,
      expected: inputs.length,
      mismatches,
    };
  }

  function cleanSubjectiveAnswer(raw) {
    let s = String(raw || '').replace(/\r\n?/g, '\n').trim();
    s = s.replace(/^```(?:markdown|text|txt)?\s*/i, '').replace(/\s*```$/i, '').trim();
    s = s.replace(/^(?:以下是|下面是)(?:对)?(?:本题|该题|这道题)?的?(?:参考)?答案[：:]\s*/i, '');
    s = s.replace(/^(?:参考)?答案[：:]\s*/i, '');
    s = s.replace(/^#{1,6}\s*/gm, '').replace(/\*\*|__/g, '');
    s = s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    return s.slice(0, 8000);
  }

  function dispatchEditorInput(editor, text) {
    const opts = { bubbles: true, cancelable: false, inputType: 'insertText', data: text };
    try { editor.dispatchEvent(new InputEvent('input', opts)); }
    catch (e) { try { editor.dispatchEvent(new Event('input', { bubbles: true })); } catch (e2) {} }
    try { editor.dispatchEvent(new Event('change', { bubbles: true })); } catch (e) {}
    try { editor.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Process' })); } catch (e) {}
  }

  function findEditorCounter(editor, box) {
    const roots = [];
    if (box) roots.push(box);
    let p = editor && editor.parentElement;
    for (let i = 0; p && i < 5; i++, p = p.parentElement) roots.push(p);
    const seen = new Set();
    for (const root of roots) {
      for (const el of qsa('[class*="count"], [class*="word"], [class*="limit"], [class*="num"], span, div', root)) {
        if (seen.has(el) || !visible(el)) continue;
        seen.add(el);
        const value = txt(el);
        if (value.length > 30) continue;
        const m = value.match(/(\d{1,6})\s*\/\s*(\d{1,6})\s*(?:字|词|words?)?/i);
        if (m && Number(m[2]) >= 100) {
          return { el, current: Number(m[1]), max: Number(m[2]), text: value };
        }
      }
    }
    return null;
  }

  async function fillSubjectiveEditor(editor, rawAnswer, box) {
    if (!editor) return { ok: false, actual: 0, expected: 0, method: 'none' };
    let answer = cleanSubjectiveAnswer(rawAnswer);
    const maxLen = Number(editor.maxLength);
    if (isFinite(maxLen) && maxLen > 0) answer = answer.slice(0, maxLen);
    const expectedCompressed = answer
      .replace(/[\u200b-\u200f\ufeff]/g, '')
      .replace(/\s+/g, '');
    if (!answer || !expectedCompressed) {
      return { ok: false, actual: 0, expected: 0, method: 'none' };
    }

    let method = 'native-value';
    if (editor.tagName === 'TEXTAREA' || editor.tagName === 'INPUT') {
      try {
        const ownerDoc = editor.ownerDocument || document;
        const win = ownerDoc.defaultView || window;
        const Ctor = editor.tagName === 'TEXTAREA' ? win.HTMLTextAreaElement : win.HTMLInputElement;
        const proto = Ctor && Ctor.prototype;
        const setter = proto ? Object.getOwnPropertyDescriptor(proto, 'value') : null;
        if (setter && setter.set) setter.set.call(editor, answer);
        else editor.value = answer;
      } catch (e) {
        try { editor.value = answer; } catch (e2) {}
      }
      try { editor.focus(); } catch (e) {}
      dispatchEditorInput(editor, answer);
    } else {
      const ownerDoc = editor.ownerDocument || document;
      const ownerWin = ownerDoc.defaultView || window;
      const beforeNorm = editorText(editor).replace(/\s+/g, '');
      const selectAll = () => {
        let selectedRange = null;
        try { editor.focus({ preventScroll: true }); } catch (e) { try { editor.focus(); } catch (e2) {} }
        try { editor.click(); } catch (e) {}
        try {
          const sel = ownerWin.getSelection && ownerWin.getSelection();
          if (sel && ownerDoc.createRange) {
            const range = ownerDoc.createRange();
            range.selectNodeContents(editor);
            sel.removeAllRanges();
            sel.addRange(range);
            selectedRange = range;
          }
        } catch (e) {}
        return selectedRange;
      };
      const currentText = () => editorText(editor).replace(/[\u200b-\u200f\ufeff]/g, '').replace(/\s+/g, '');
      const insertedEnough = () => {
        const now = currentText();
        return now.indexOf(expectedCompressed) !== -1 && now.length >= expectedCompressed.length;
      };
      const counterSynced = () => {
        const c = findEditorCounter(editor, box || (editor.closest && editor.closest('.question-box')));
        return !c || c.current > 0;
      };
      const stageComplete = () => insertedEnough() && counterSynced();
      const isSlateEditor = (() => {
        try {
          return !!(editor.matches && editor.matches('[data-slate-editor]')) ||
            !!(editor.closest && editor.closest('[data-slate-editor]')) ||
            !!(editor.parentElement && editor.parentElement.querySelector &&
              editor.parentElement.querySelector('[data-slate-editor]'));
        } catch (e) { return false; }
      })();

      selectAll();

      // Quill 暴露官方实例时优先走 API，内部模型与 DOM 会一起更新。
      try {
        const ql = editor.closest && editor.closest('.ql-container');
        const quill = ql && ql.__quill;
        if (quill && typeof quill.setText === 'function') {
          quill.setText(answer, 'user');
          method = 'quill-api';
        }
      } catch (e) {}

      if (!stageComplete()) {
        const targetRange = selectAll();
        try {
          const EventCtor = ownerWin.InputEvent || InputEvent;
          let ev;
          try {
            ev = new (class extends EventCtor {
              getTargetRanges() { return targetRange ? [targetRange] : []; }
            })('beforeinput', {
              bubbles: true, cancelable: true, inputType: 'insertText', data: answer,
            });
          } catch (e) {
            ev = new EventCtor('beforeinput', {
              bubbles: true, cancelable: true, inputType: 'insertText', data: answer,
            });
            try {
              Object.defineProperty(ev, 'getTargetRanges', {
                value: () => (targetRange ? [targetRange] : []),
              });
            } catch (e2) {}
          }
          // Slate/WangEditor 会读取 getTargetRanges() 来同步内部 selection。
          editor.dispatchEvent(ev);
          method = isSlateEditor ? 'slate-beforeinput' : 'beforeinput';
        } catch (e) {}
        await sleep(300);
      }

      if (!stageComplete() && !isSlateEditor && ownerDoc.execCommand) {
        selectAll();
        try { ownerDoc.execCommand('insertText', false, answer); method = 'exec-insert-text'; } catch (e) {}
        await sleep(180);
      }

      if (!stageComplete()) {
        try {
          const win = ownerDoc.defaultView || window;
          const dt = new win.DataTransfer();
          dt.setData('text/plain', answer);
          const paste = new win.ClipboardEvent('paste', {
            bubbles: true, cancelable: true, clipboardData: dt,
          });
          selectAll();
          editor.dispatchEvent(paste);
          method = isSlateEditor ? 'slate-paste' : 'paste-event';
          await sleep(220);
        } catch (e) {}
      }

      if (!stageComplete() && !isSlateEditor && ownerDoc.execCommand) {
        const escaped = answer
          .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
          .split(/\n+/).map((p) => '<p>' + p.replace(/\n/g, '<br>') + '</p>').join('');
        selectAll();
        try { ownerDoc.execCommand('insertHTML', false, escaped); method = 'exec-insert-html'; } catch (e) {}
        await sleep(220);
      }

      // 只发送事件，不再改写 textContent/innerHTML；否则会破坏富文本内部模型。
      dispatchEditorInput(editor, answer);
      if (currentText() === beforeNorm && !insertedEnough()) method = 'not-inserted';
    }

    await sleep(260);
    try {
      if (typeof FocusEvent !== 'undefined') editor.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
      if (typeof editor.blur === 'function') editor.blur();
    } catch (e) {}
    await sleep(140);

    let actualCompressed = '';
    let textOk = false;
    let counter = null;
    for (let i = 0; i < 6; i++) {
      actualCompressed = editorText(editor)
        .replace(/[\u200b-\u200f\ufeff]/g, '').replace(/\s+/g, '');
      textOk = actualCompressed === expectedCompressed ||
        (actualCompressed.indexOf(expectedCompressed) !== -1 &&
          actualCompressed.length <= expectedCompressed.length * 1.08);
      counter = findEditorCounter(editor, box || (editor.closest && editor.closest('.question-box')));
      if (textOk && (!counter || counter.current > 0)) break;
      if (i < 5) await sleep(150);
    }
    const counterOk = !counter || counter.current > 0;
    return {
      ok: textOk && counterOk,
      actual: actualCompressed.length,
      expected: expectedCompressed.length,
      method,
      counter: counter ? counter.text : '',
    };
  }

  // 统一的中断检查点。
  // ⚠️ 实测教训（audit-B 的 B1）：old 版 answerCurrent/goNext 全文**从未读取 S.running**，
  //    于是"点停止"只让 runLoop 退出，正在进行中的这道题仍会走完流程真实勾选。
  //    现在在每个可能耗时/有副作用的位置之前都插检查点。
  function aborted() { return !S.running && S.stopRequested; }

  async function answerCurrent(reason, options) {
    const force = !!(options && options.force);
    if (S.busy) return { ok: false, why: '上一题还在处理中' };
    if (aborted()) return { ok: false, why: 'aborted' };
    S.busy = true;
    try {
      const q = readQuestion();
      if (!q) { log('未识别到题目（可能不在答题页，或页面结构变了 → 点「诊断」看看）', 'err'); S.fails++; return { ok: false, why: 'no-question' }; }
      if (q.type === 'unknown') { log('无法判断题型（未找到选项控件）→ 跳过', 'err'); S.fails++; return { ok: false, why: 'no-type' }; }

      const fp = fingerprint(q);
      S.currentFp = fp;
      const typeName = q.type === 'subjective' ? '主观题' :
        (q.type === 'cloze' ? '填空题' :
          (q.judge ? '判断题' : (q.type === 'multi' ? '多选' : '单选')));
      log('—— 第 ' + (questionNo() || '?') + ' 题 · ' + typeName +
        (q.score ? ' · ' + q.score + '分' : '') + ' ——', 'info');
      log('题干：' + q.stem.slice(0, 70) + (q.stem.length > 70 ? '…' : ''));
      if (q.type === 'cloze') {
        log('空格 ' + q.blanks.length + ' 个');
      } else if (q.type !== 'subjective') {
        log('选项 ' + q.options.length + ' 个：' + q.options.map((o) => o.letter).join(' '));
      }

      // ---------- 主观题：生成正文并回填当前题目的编辑器 ----------
      if (q.type === 'subjective') {
        if (isQuestionAnswered(q) && !force) {
          log('本题主观题已作答 → 直接继续', 'ok');
          if (cfg.autoNext && reason !== 'manual') await goNext();
          return { ok: true, why: 'already', type: 'subjective' };
        }
        if (!cfg.answerSubjective) {
          S.stopReason = '主观题自动作答已关闭';
          log('检测到未作答的主观题，但「主观题自动作答」开关已关闭 → 停止', 'warn');
          return { ok: false, why: 'subjective-off' };
        }

        let answer = bankGet(fp);
        let from = 'cache';
        if (answer) {
          S.cacheHits++;
          log('命中主观题答案缓存 → ' + answer.length + ' 字', 'ok');
        } else {
          if (!cfg.apiKey) {
            log('未配置 API Key：请在面板「接口」页填写', 'err');
            S.fails++;
            return { ok: false, why: 'no-key' };
          }
          if (!rateLimitOk()) {
            log('触发速率上限（' + cfg.maxPerMinute + ' 题/分钟）→ 稍后重试', 'warn');
            S.fails++;
            return { ok: false, why: 'rate-limit' };
          }
          const englishQuestion = isEnglishSubjective(q);
          const targetLabel = englishQuestion
            ? '约 ' + subjectiveTargetWords(q.score) + ' words（纯英文快速模式）'
            : '约 ' + subjectiveTargetChars(q.score) + ' 字';
          log('调用 AI 生成主观题答案（目标' + targetLabel + '）…', 'info');
          const t0 = Date.now();
          S.aiCalls++; S.recentTimes.push(Date.now());
          let res;
          try {
            res = await askAI(q);
          } catch (e) {
            log('AI 调用失败：' + (e && e.message), 'err');
            S.fails++;
            return { ok: false, why: 'ai-error' };
          }
          answer = res.text;
          from = 'ai';
          log('AI 生成 ' + answer.length + ' 字，用时 ' + (Date.now() - t0) + 'ms → ' +
            answer.slice(0, 50).replace(/\s+/g, ' ') + (answer.length > 50 ? '…' : ''), 'ok');
        }

        // 英文题走短停顿，避免在模型已经直接英文输出后再额外等待数秒。
        const thinkMax = isEnglishSubjective(q) ? Math.min(cfg.thinkMax, 1.2) : cfg.thinkMax;
        const thinkMin = Math.min(cfg.thinkMin, thinkMax);
        const think = rnd(thinkMin, thinkMax) * 1000;
        log('停顿 ' + (think / 1000).toFixed(1) + 's 后写入答题框…', 'info');
        await sleep(think);
        if (aborted()) {
          log('已收到停止指令 → 放弃回填主观题', 'warn');
          return { ok: false, why: 'aborted' };
        }
        if (!cfg.enabled) {
          log('总开关已关闭 → 放弃回填主观题', 'warn');
          return { ok: false, why: 'aborted' };
        }

        let q2;
        try {
          q2 = readQuestion();
          if (!q2 || q2.type !== 'subjective' || fingerprint(q2) !== fp) {
            log('停顿期间题目已变化 → 放弃回填主观题', 'warn');
            return { ok: false, why: 'question-changed' };
          }
        } catch (e) {
          return { ok: false, why: 'question-changed' };
        }
        if (cfg.dryRun) {
          log('【演练模式】本应回填主观题 ' + answer.length + ' 字，实际未操作', 'warn');
          return { ok: true, why: 'dry-run', type: 'subjective', text: answer };
        }

        const fill = await fillSubjectiveEditor(q2.editor, answer, q2.box);
        if (!fill.ok) {
          S.fails++;
          S.stopRequested = false;
          S.running = false;
          S.stopReason = '主观题回填失败（编辑器未接受内容）';
          log('主观题回填校验未通过（目标约 ' + fill.expected + ' 字，实际 ' +
            fill.actual + ' 字，方式 ' + fill.method +
            (fill.counter ? '，编辑器计数 ' + fill.counter : '') +
            '）→ 停止，答题框未被直接改写，可继续手动编辑', 'err');
          return { ok: false, why: 'subjective-fill-failed' };
        }

        bankSet(fp, answer, q);
        S.answeredCount++;
        log('✅ 主观题已回填（' + fill.actual + ' 字，' + from + '，' +
          fill.method + (fill.counter ? '，计数 ' + fill.counter : '') + '）', 'ok');
        updateStats();
        if (cfg.autoNext && reason !== 'manual') {
          await sleep(rnd(300, 800));
          await goNextAfterAnswer(fp);
        }
        return { ok: true, why: 'subjective-filled', type: 'subjective', text: answer };
      }

      // ---------- 填空题：按输入框顺序回填 ----------
      if (q.type === 'cloze') {
        if (isQuestionAnswered(q) && !force) {
          log('本题填空题已作答 → 直接继续', 'ok');
          if (cfg.autoNext && reason !== 'manual') await goNext();
          return { ok: true, why: 'already', type: 'cloze' };
        }

        let answers = null;
        let from = 'cache';
        const cached = bankGet(fp);
        if (cached) {
          const parsed = cachedClozeAnswers(cached);
          if (parsed.length === q.blanks.length) {
            answers = parsed;
            S.cacheHits++;
            log('命中填空题答案缓存 → ' + answers.join(' | '), 'ok');
          }
        }

        if (!answers) {
          if (!cfg.apiKey) {
            log('未配置 API Key：请在面板「接口」页填写', 'err');
            S.fails++;
            return { ok: false, why: 'no-key' };
          }
          if (!rateLimitOk()) {
            log('触发速率上限（' + cfg.maxPerMinute + ' 题/分钟）→ 稍后重试', 'warn');
            S.fails++;
            return { ok: false, why: 'rate-limit' };
          }
          log('调用 AI 作答填空题（' + q.blanks.length + ' 空）…', 'info');
          const t0 = Date.now();
          S.aiCalls++; S.recentTimes.push(Date.now());
          let res;
          try {
            res = await askAI(q);
          } catch (e) {
            log('AI 调用失败：' + (e && e.message), 'err');
            S.fails++;
            return { ok: false, why: 'ai-error' };
          }
          answers = res.answers;
          from = 'ai';
          log('AI 返回 ' + answers.length + ' 空，用时 ' + (Date.now() - t0) + 'ms → ' +
            answers.join(' | ').slice(0, 100), 'ok');
        }

        const thinkMax = Math.min(cfg.thinkMax, 1.2);
        const thinkMin = Math.min(cfg.thinkMin, thinkMax);
        const think = rnd(thinkMin, thinkMax) * 1000;
        log('停顿 ' + (think / 1000).toFixed(1) + 's 后填写…', 'info');
        await sleep(think);
        if (aborted()) {
          log('已收到停止指令 → 放弃填写填空题', 'warn');
          return { ok: false, why: 'aborted' };
        }
        if (!cfg.enabled) {
          log('总开关已关闭 → 放弃填写填空题', 'warn');
          return { ok: false, why: 'aborted' };
        }

        let q2;
        try {
          q2 = readQuestion();
          if (!q2 || q2.type !== 'cloze' || fingerprint(q2) !== fp ||
            q2.blanks.length !== answers.length) {
            log('停顿期间题目已变化 → 放弃填写填空题', 'warn');
            return { ok: false, why: 'question-changed' };
          }
        } catch (e) {
          return { ok: false, why: 'question-changed' };
        }
        if (cfg.dryRun) {
          log('【演练模式】本应填写 ' + answers.join(' | ') + '，实际未操作', 'warn');
          return { ok: true, why: 'dry-run', type: 'cloze', answers };
        }

        const fill = await fillClozeInputs(q2.blanks, answers);
        if (!fill.ok) {
          S.fails++;
          S.stopRequested = false;
          S.running = false;
          S.stopReason = '填空题回填失败（输入框未接受内容）';
          log('填空题回填校验未通过（' + fill.filled + '/' + fill.expected +
            ' 空成功，失败空号：' + (fill.mismatches.join('、') || '未知') + '）→ 停止', 'err');
          return { ok: false, why: 'cloze-fill-failed' };
        }

        bankSet(fp, clozeCacheValue(answers), q);
        S.answeredCount++;
        log('✅ 填空题已填 ' + fill.filled + '/' + fill.expected + ' 空（' + from + '）', 'ok');
        updateStats();
        if (cfg.autoNext && reason !== 'manual') {
          await sleep(rnd(300, 700));
          await goNextAfterAnswer(fp);
        }
        return { ok: true, why: 'cloze-filled', type: 'cloze', answers };
      }

      // 已作答过 → 直接下一题（避免重复消耗 AI）
      const picked = selectedLetters(q.box);
      if (picked.length && force) {
        log('强制重答本题：将按新答案纠正已有勾选', 'info');
      }
      if (picked.length && !force) {
        // ★ 关键修复（audit-B 的 B3）：不能"有勾选就跳过"。
        //   若缓存里有该题的答案，就比对一下；不一致说明勾选是**残留的错误选项**，
        //   必须纠正而不是跳过（旧版会带着错误选项一路跳过，永久答错）。
        const cached = bankGet(fp);
        if (cached && picked.join('') !== cached.split('').sort().join('')) {
          log('⚠️ 已勾选 ' + picked.join('') + ' 与已知答案 ' + cached + ' 不一致 → 将按答案纠正', 'warn');
          // 落到下面正常流程，selectOption 会处理"取消多余项 + 补选缺失项"
        } else {
          log('本题已作答（' + picked.join('') + '）→ 直接继续', 'ok');
          if (cfg.autoNext && reason !== 'manual') await goNext();
          return { ok: true, why: 'already', letters: picked };
        }
      }

      // 取答案：缓存优先
      let letters = bankGet(fp);
      let from = 'cache';
      if (letters) {
        S.cacheHits++;
        log('命中答案缓存 → ' + letters, 'ok');
      } else {
        if (!cfg.apiKey) {
          log('未配置 API Key：请在面板「接口」页填写（apiBase / apiKey / model）', 'err');
          S.fails++;
          return { ok: false, why: 'no-key' };
        }
        if (!rateLimitOk()) {
          log('触发速率上限（' + cfg.maxPerMinute + ' 题/分钟）→ 稍后重试', 'warn');
          S.fails++;
          return { ok: false, why: 'rate-limit' };
        }
        log('调用 AI（' + cfg.model + '）…', 'info');
        const t0 = Date.now();
        S.aiCalls++; S.recentTimes.push(Date.now());
        let res;
        try {
          res = await askAI(q);
        } catch (e) {
          log('AI 调用失败：' + (e && e.message), 'err');
          S.fails++;
          return { ok: false, why: 'ai-error' };
        }
        const dt = Date.now() - t0;
        if (!res.letters.length) {
          log('AI 输出无法解析为选项：' + JSON.stringify(res.raw.slice(0, 80)) +
            '（原始字母=' + (res.rawLetters || '空') + '）', 'err');
          S.fails++;
          return { ok: false, why: 'unparsable' };
        }
        letters = res.letters.join('');
        from = 'ai';
        log('AI 返回 ' + dt + 'ms → ' + letters +
          '（置信度 ' + res.confidence + (res.note ? '，' + res.note : '') +
          '；原始："' + res.raw.trim().slice(0, 30) + '"）', 'ok');
        // 多选题只给一个字母 → 存疑但先记录
        if (q.type === 'multi' && letters.length === 1) {
          log('注意：多选题但 AI 只给了 1 个选项，请留意', 'warn');
        }
        // ★ 只缓存"可信"的答案。
        //   实测教训：低可信度答案一旦写进缓存，该题会**持续答错**
        //   （bankGet 无 TTL、无模型维度，缓存命中就不调 AI 了）。
        //   宁可这题下次再问一次 AI，也不要固化一个可能错的答案。
        if (isCacheable(res, q)) {
          bankSet(fp, letters, q);
        } else {
          log('本次结果置信度不足（' + res.confidence + '）→ 不写入答案缓存，下次仍会询问 AI', 'warn');
        }
      }

      // 拟人停顿
      const think = rnd(cfg.thinkMin, cfg.thinkMax) * 1000;
      log('停顿 ' + (think / 1000).toFixed(1) + 's 后勾选…', 'info');
      await sleep(think);
      // ★ 中断检查点：停顿期间用户可能点了停止（实测旧版此处会继续勾选）
      if (aborted()) {
        log('已收到停止指令 → 放弃勾选本题', 'warn');
        return { ok: false, why: 'aborted' };
      }
      if (!cfg.enabled) {
        log('总开关已关闭 → 放弃勾选本题', 'warn');
        return { ok: false, why: 'aborted' };
      }
      // 停顿期间页面可能已经翻页/被用户手动改选 → 复查题目指纹
      try {
        const q2 = readQuestion();
        if (!q2 || fingerprint(q2) !== fp) {
          log('停顿期间题目已变化 → 放弃本题（避免误勾到新题上）', 'warn');
          return { ok: false, why: 'question-changed' };
        }
      } catch (e) {}

      // 勾选
      const wantLetters = letters.split('');
      const map = {};
      q.options.forEach((o) => { map[o.letter] = o; });
      const missing = wantLetters.filter((L) => !map[L]);
      if (missing.length) {
        log('AI 给出的选项 ' + missing.join('') + ' 不在本题选项中 → 放弃本题', 'err');
        S.fails++;
        return { ok: false, why: 'letter-not-exist' };
      }

      if (cfg.dryRun) {
        log('【演练模式】本应勾选 ' + letters + '，实际未操作', 'warn');
        return { ok: true, why: 'dry-run', letters };
      }

      // ★ 关键修复（audit-D 发现3 + Lead 自查）：
      //   旧版"只补选、不取消"，导致**残留的错误选项被保留**，
      //   最终答案 = AI答案 ∪ 错误残留 → 直接答错。
      //   现在：先取消多余的，再补选缺的。
      let cancelled = 0;
      const curBefore = selectedLetters(q.box);
      // ① 取消不在目标内的已选项
      for (const L of curBefore) {
        if (wantLetters.indexOf(L) !== -1) continue;
        if (map[L] && deselectOption(map[L])) cancelled++;
        await sleep(rnd(150, 350));
      }
      // ② 补选缺失项
      // ⚠️ 实测坑：不能拿 selectOption 的**同步返回值**判断成败。
      //    Vue/Element UI 更新 DOM 是异步的（nextTick），点完立刻读状态
      //    往往还是旧值 —— 于是 B 明明勾上了，却报"点击未能生效"。
      //    正确做法：点完只有按**最终实际状态**判定。
      for (const L of wantLetters) {
        const cur = selectedLetters(q.box);
        if (cur.indexOf(L) !== -1) continue;
        selectOption(map[L]);           // 返回值仅供参考，不作为判据
        await sleep(rnd(180, 420));     // 选项之间留间隔
      }
      if (cancelled) log('已取消 ' + cancelled + ' 个多余选项', 'info');
      await sleep(cfg.delayAfterAnswer * 1000);

      // 校验
      const okSel = verifySelection(q.box, wantLetters);
      if (!okSel) {
        const missing0 = wantLetters.filter((L) => selectedLetters(q.box).indexOf(L) === -1);
        log('勾选校验未通过（期望 ' + wantLetters.join('') + '，实际 ' +
          selectedLetters(q.box).join('') + '，缺 ' + (missing0.join('') || '无') + '）→ 重试一次', 'warn');
        // ⚠️ 重试也要"先取消多余的"——只补选的话，多余项会一直留着
        for (const L of selectedLetters(q.box)) {
          if (wantLetters.indexOf(L) === -1 && map[L]) {
            deselectOption(map[L]);
            await sleep(rnd(150, 350));
          }
        }
        for (const L of wantLetters) {
          if (selectedLetters(q.box).indexOf(L) === -1) selectOption(map[L]);
          await sleep(rnd(150, 350));
        }
        await sleep(500);
        if (!verifySelection(q.box, wantLetters)) {
          log('二次校验仍失败 → 停止，请检查选项结构（点「诊断」）', 'err');
          S.fails++;
          S.stopRequested = false;
          S.running = false;
          S.stopReason = '选项勾选失败（结构可能不兼容）';
          return { ok: false, why: 'select-failed' };
        }
      }
      S.answeredCount++;
      log('✅ 已勾选 ' + wantLetters.join('') + '（' + from + '）', 'ok');
      updateStats();

      // 下一题
      if (cfg.autoNext && reason !== 'manual') {
        await sleep(rnd(300, 800));
        await goNextAfterAnswer(fp);
      }
      return { ok: true, letters, from };
    } finally {
      S.busy = false;
    }
  }

  async function waitForQuestionChange(before, rounds) {
    let lastSig = before;
    let stableCount = 0;
    for (let i = 0; i < rounds; i++) {
      if (aborted()) return false;
      const q = readQuestion();
      const sig = q ? fingerprint(q) : '';
      if (sig && sig !== before) {
        if (sig === lastSig) {
          stableCount++;
          if (stableCount >= 2) return true;
        } else {
          stableCount = 0;
        }
        lastSig = sig;
      }
      // 点击后题目没变，且下一题按钮已消失/禁用：不必继续空等。
      if (i >= 6 && stableCount === 0) {
        const nb = findNavButton('next');
        if (!nb || isNavDisabled(nb)) return false;
      }
      await sleep(450);
    }
    return false;
  }

  async function goNextAfterAnswer(answeredFp) {
    try {
      const current = readQuestion();
      if (current && fingerprint(current) !== answeredFp) {
        log('页面已自动跳到下一题 → 不重复点击「下一题」', 'info');
        return true;
      }
    } catch (e) {}
    return goNext();
  }

  async function goNext() {
    if (cfg.dryRun) { log('【演练模式】不翻页', 'info'); return false; }
    if (aborted()) { log('已收到停止指令 → 不翻页', 'warn'); return false; }

    // 以按钮实际状态为准，不再用容易失真的答题卡高亮序号推断最后一题。
    const btn = findNavButton('next');
    if (!btn) {
      const st0 = cardStatus();
      log('未找到「下一题」按钮' + (lastNavDiag ? '（' + lastNavDiag + '）' : '') +
        (st0.reliable ? '［答题卡 ' + st0.answered + '/' + st0.total + '］' : '') +
        ' → 若确实还有下一题，请点「诊断」查看页面结构', 'err');
      return false;
    }
    if (isNavDisabled(btn)) {
      const st0 = cardStatus();
      log('「下一题」按钮不可用（可能已是最后一题）' +
        (st0.reliable ? '［答题卡 ' + st0.answered + '/' + st0.total + '］' : ''), 'warn');
      return false;
    }

    const before = currentSignature();
    let clicked = false;
    try { btn.click(); clicked = true; } catch (e) {}
    if (!clicked) {
      log('点击「下一题」失败（<' + String(btn.tagName || '').toLowerCase() + '> class="' +
        String(btn.className || '').slice(0, 40) + '"）→ 点「诊断」查看', 'err');
      return false;
    }
    log('→ 已点击「下一题」', 'info');

    // 客观题和主观题共用“题目指纹变化 + 连续稳定”判据。这样新题即使只有
    // 富文本编辑器、没有 radio/checkbox，也能被正确识别为已翻页。
    await sleep(Math.max(200, cfg.delayAfterNext * 1000 * 0.5));
    if (await waitForQuestionChange(before, 24)) return true;
    if (aborted()) return false;

    // 有些平台首次原生 click 只触发动画，不真正切题。仅在题目确实未变化时
    // 追加一次完整事件序列，避免在已成功翻页的新题上重复点击。
    const retryBtn = findNavButton('next');
    if (retryBtn && !isNavDisabled(retryBtn) && currentSignature() === before) {
      log('首次翻页未生效 → 追加一次完整点击重试', 'warn');
      try { clickEl(retryBtn); } catch (e) {}
      await sleep(250);
      if (await waitForQuestionChange(before, 18)) return true;
    }
    if (aborted()) return false;
    log('翻页后题目未变化（可能已是最后一题）', 'warn');
    return false;
  }

  function currentSignature() {
    const q = readQuestion();
    if (q) return fingerprint(q);
    const box = findQuestionBox();
    return box ? txt(box).slice(0, 160) : '';
  }

  // 主循环：每题做一次，直到答题卡满 / 用户停 / 出错
  async function runLoop() {
    if (S.running) return;
    if (!cfg.enabled) { log('总开关未开，先在面板打开', 'warn'); return; }
    if (!cfg.apiKey && !cfg.dryRun) { log('未配置 API Key', 'err'); return; }
    S.running = true;
    S.stopRequested = false;
    S.stopReason = '';
    S.fails = 0;
    updateStats();
    log('▶ 开始自动答题' + (cfg.dryRun ? '（演练模式）' : ''), 'ok');

    let guard = 0;
    while (S.running && cfg.enabled) {
      if (++guard > 500) { log('循环次数超限，已停止（防意外死循环）', 'err'); break; }
      if (S.stopRequested) break;

      // 终止条件①：答题卡已满
      const st = cardStatus();
      if (cfg.stopWhenFull && st.reliable && st.total > 0 && st.answered >= st.total) {
        S.stopReason = '答题卡已满（' + st.answered + '/' + st.total + '）';
        log('🏁 ' + S.stopReason + ' → 已停止，请自行检查后提交', 'ok');
        break;
      }

      // 终止条件②：已作答 + 确实没有下一题了
      //
      // ⚠️ 旧版用「答题卡序号 + currentIndex()」判断是否最后一题：
      //      if (st.reliable && idx >= 0 && idx >= st.total - 1) { 停止 }
      //    currentIndex() 依赖答题卡高亮类名（用户平台读不到 → 恒 0），
      //    st.total 一旦被识别成 1，就变成"第一题答完就停"。
      //
      //    改为**以「下一题」按钮的实际状态为准**：
      //      按钮存在且可用 → 还有下一题，继续（不靠序号推断）
      //      按钮不存在/不可用 → 才是真的到末尾
      const qHere = readQuestion();
      const answeredHere = isQuestionAnswered(qHere);
      if (answeredHere) {
        const nextB = findNavButton('next');
        const noNext = !nextB || isNavDisabled(nextB);
        if (noNext) {
          S.stopReason = '已到最后一题且已作答';
          log('🏁 ' + S.stopReason + ' → 已停止，请自行检查后提交', 'ok');
          break;
        }
      }

      // 记录本轮开始时的题目指纹（用于推进判断，见循环末尾）
      const beforeFp = (() => { try { const q = readQuestion(); return q ? fingerprint(q) : ''; } catch (e) { return ''; } })();

      const r = await answerCurrent('loop');
      if (S.stopRequested) break;
      if (!r.ok) {
        // ★ 修复 audit-B 的 B2：失败上限检查必须放在"跳过等待"之前，
        //   否则 ai-error / rate-limit 会无限 continue，刹车永远不求值
        //   （实测：10 分钟内重试 100 次，界面毫无停止迹象）。
        if (S.fails >= 3) {
          S.stopReason = '连续失败 ' + S.fails + ' 次（' + (r.why || '') + '）';
          log('🏁 ' + S.stopReason + ' → 已停止', 'err');
          break;
        }
        if (r.why === 'aborted') break;
        if (r.why === 'unparsable') {
          // 解析不出答案：不是网络问题，多试无益，直接计入失败
          await sleep(500);
          continue;
        }
        if (r.why === 'rate-limit') { await sleep(6000); continue; }
        if (r.why === 'ai-error') { await sleep(4000); continue; }
        if (r.why === 'no-key' || r.why === 'subjective-off' ||
          r.why === 'subjective-fill-failed' || r.why === 'cloze-fill-failed') break;
        await sleep(1500);
        continue;
      }
      S.fails = 0;   // 成功后清零

      // 如果 answerCurrent 没能前进（例如没有下一题按钮），避免死循环。
      //
      // ⚠️ 实测坑（用户日志）：
      //    [16:59:48] → 已点击「下一题」        ← goNext 内部已确认切换成功
      //    [16:59:50] 题目未推进（第 1 题）→ 停止  ← 这里却误判未推进
      //  旧版用 currentIndex() 判断推进，而它依赖答题卡的高亮类名（active/current）——
  //    用户平台的高亮方式不匹配时恒返回 0 → 永远"等于"推进前的题号 → 误停。
      //  改用**题目指纹**（题干+选项哈希）对比，和 goNext 内部同一套可靠信号。
      await sleep(300);
      try {
        const qNow = readQuestion();
        const fpNow = qNow ? fingerprint(qNow) : '';
        if (cfg.autoNext && fpNow && fpNow === beforeFp) {
          // 指纹没变 —— 先判断是不是"当前题已答完且确实没有下一题"（最后一题的正常收尾）。
          // ⚠️ 判据只用「下一题按钮的实际状态」，不再用 currentIndex()/答题卡序号推断
          //    （那套依赖高亮类名，用户平台读不到 → 恒 0 → 会误判"已是最后一题"而不翻页）。
          const already = isQuestionAnswered(qNow);
          const nextB = findNavButton('next');
          const noNext = !nextB || isNavDisabled(nextB);
          if (already && noNext) {
            S.stopReason = '已到最后一题且已作答';
            log('🏁 ' + S.stopReason + ' → 已停止，请自行检查后提交', 'ok');
            break;
          }
          // 再给一次渲染时间并复查（翻页动画/慢加载）
          await sleep(1200);
          const q2 = readQuestion();
          const fp2 = q2 ? fingerprint(q2) : '';
          if (fp2 && fp2 === beforeFp) {
            const nextB2 = findNavButton('next');
            const noNext2 = !nextB2 || isNavDisabled(nextB2);
            if (already && noNext2) {
              S.stopReason = '已到最后一题且已作答';
              log('🏁 ' + S.stopReason + ' → 已停止，请自行检查后提交', 'ok');
            } else if (nextB2) {
              // 按钮还在却不推进 —— 两种情况：
              //   ① 这已经是最后一题，但平台没隐藏/没禁用「下一题」（点了不动）
              //   ② 点击真的没生效
              // 先重试一次；仍不动且本题已答完 → 判定为"已到最后一题"（正常收尾），
              // 而不是报"点击无效"（实测会误导用户以为出错了）。
              log('题目未推进但「下一题」按钮仍在 → 重试点击一次', 'warn');
              try { nextB2.click(); } catch (e) {}
              await sleep(1500);
              const q3 = readQuestion();
              const fp3 = q3 ? fingerprint(q3) : '';
              if (fp3 && fp3 !== beforeFp) continue;      // 这次成功了，继续
              // 仍不动：已答完就按"最后一题"收尾（这是最常见的情况）
              if (already) {
                S.stopReason = '已到最后一题且已作答';
                log('🏁 ' + S.stopReason + '（「下一题」已无响应）→ 已停止，请自行检查后提交', 'ok');
              } else {
                S.stopReason = '题目无法推进（点击「下一题」无效）';
                log('🏁 ' + S.stopReason + ' → 已停止', 'warn');
              }
            } else {
              // 没找到按钮
              if (already) {
                S.stopReason = '已到最后一题且已作答';
                log('🏁 ' + S.stopReason + ' → 已停止，请自行检查后提交', 'ok');
              } else {
                S.stopReason = '题目无法推进（找不到「下一题」按钮）';
                log('题目未推进且找不到「下一题」按钮 → 停止', 'warn');
              }
            }
            break;
          }
        }
      } catch (e) {}
    }
    S.running = false;
    updateStats();
    log('■ 已停止' + (S.stopReason ? '：' + S.stopReason : ''), 'info');
  }

  function stopLoop(why) {
    // ★ 即使当前没有在跑主循环，也要置位：可能是"答当前一题"正在进行中。
    //   answerCurrent 会在关键动作前检查 S.stopRequested 并主动中断。
    S.stopRequested = true;
    const wasRunning = S.running;
    S.running = false;
    log('■ 已请求停止' + (why ? '：' + why : '') + (S.busy ? '（正在收尾当前动作…）' : ''), 'warn');
    updateStats();
    return wasRunning;
  }

  // ==========================================================================
  //  7. 面板
  // ==========================================================================
  const CSS =
    '#blq,#blq *{box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif}' +
    '#blq{position:fixed;right:16px;bottom:16px;z-index:2147483647;width:330px;background:#fff;color:#1D2129;' +
    'border-radius:14px;overflow:hidden;box-shadow:0 12px 32px rgba(0,0,0,.14),0 2px 8px rgba(0,0,0,.06);' +
    'border:1px solid #E5E6EB}' +
    '.blq-head{display:flex;align-items:center;justify-content:space-between;padding:11px 14px;' +
    'background:linear-gradient(135deg,#165DFF,#4080FF);color:#fff;cursor:move}' +
    '.blq-title{display:flex;align-items:center;gap:7px;font-size:13.5px;font-weight:600}' +
    '.blq-dot{width:7px;height:7px;border-radius:50%;background:#B7E5C4;box-shadow:0 0 0 3px rgba(183,229,196,.28)}' +
    '.blq-dot.run{background:#FFE08A;box-shadow:0 0 0 3px rgba(255,224,138,.3);animation:blq-p 1.1s infinite}' +
    '.blq-dot.off{background:#FFB4A0;box-shadow:0 0 0 3px rgba(255,180,160,.28)}' +
    '@keyframes blq-p{0%,100%{opacity:1}50%{opacity:.35}}' +
    '.blq-hb{all:unset;width:22px;height:22px;display:flex;align-items:center;justify-content:center;' +
    'border-radius:6px;cursor:pointer;color:#fff;font-size:13px}' +
    '.blq-hb:hover{background:rgba(255,255,255,.22)}' +
    '.blq-tabs{display:flex;padding:0 8px;border-bottom:1px solid #F2F3F5}' +
    '.blq-tab{flex:1;text-align:center;padding:10px 0 9px;font-size:12.5px;color:#86909C;cursor:pointer;' +
    'border-bottom:2px solid transparent;font-weight:500}' +
    '.blq-tab.on{color:#165DFF;border-bottom-color:#165DFF;font-weight:600}' +
    '.blq-pane{display:none;padding:12px 14px;max-height:min(64vh,540px);overflow-y:auto}' +
    '.blq-pane.on{display:block}' +
    '.blq-card{display:flex;align-items:center;gap:9px;padding:9px 11px;border-radius:10px;background:#F7F8FA;margin-bottom:11px}' +
    '.blq-l1{font-size:12.5px;font-weight:600}.blq-l2{font-size:11px;color:#86909C;margin-top:2px}' +
    '.blq-sec{font-size:10.5px;font-weight:700;color:#86909C;letter-spacing:.8px;margin:13px 0 5px;' +
    'display:flex;align-items:center;gap:6px}.blq-sec:first-child{margin-top:0}' +
    '.blq-sec::after{content:"";flex:1;height:1px;background:#F2F3F5}' +
    '.blq-sw{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:7px 0;cursor:pointer}' +
    '.blq-sw .n{font-size:12.5px}.blq-sw .d{font-size:10.5px;color:#A9AEB8;margin-top:1px}' +
    '.blq-sw input{display:none}' +
    '.blq-sl{width:34px;height:19px;border-radius:10px;background:#D8DBE0;position:relative;flex-shrink:0;transition:background .2s}' +
    '.blq-sl::after{content:"";position:absolute;top:2px;left:2px;width:15px;height:15px;border-radius:50%;' +
    'background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.18);transition:transform .2s}' +
    '.blq-sw input:checked+.blq-sl{background:#165DFF}.blq-sw input:checked+.blq-sl::after{transform:translateX(15px)}' +
    '.blq-f{margin-bottom:9px}.blq-f label{display:block;font-size:11.5px;color:#4E5969;margin-bottom:3px}' +
    '.blq-f input{width:100%;padding:7px 9px;font-size:12px;color:#1D2129;background:#F7F8FA;' +
    'border:1px solid #E5E6EB;border-radius:8px;outline:none;font-family:inherit}' +
    '.blq-f input:focus{border-color:#165DFF;background:#fff;box-shadow:0 0 0 3px rgba(22,93,255,.1)}' +
    '.blq-btn{display:flex;align-items:center;justify-content:center;gap:6px;width:100%;padding:9px 0;' +
    'font-size:12.5px;font-weight:600;border-radius:9px;border:1px solid transparent;cursor:pointer;font-family:inherit}' +
    '.blq-pri{background:#165DFF;color:#fff}.blq-pri:hover{background:#0E4BD8}' +
    '.blq-sec2{background:#fff;color:#4E5969;border-color:#E5E6EB}.blq-sec2:hover{color:#165DFF;border-color:#B8D0FF;background:#F5F9FF}' +
    '.blq-dan{background:#fff;color:#F53F3F;border-color:#FFD2D2}.blq-dan:hover{background:#FFF5F5}' +
    '.blq-g2{display:grid;grid-template-columns:1fr 1fr;gap:7px;margin-top:9px}' +
    '.blq-log{height:min(42vh,320px);overflow-y:auto;padding:10px 11px;border-radius:9px;background:#1D2129;' +
    'color:#C9CDD4;font:11px/1.6 Consolas,"Courier New",monospace;white-space:pre-wrap;word-break:break-word}' +
    '.blq-log .ok{color:#7BD88F}.blq-log .err{color:#FF8A8A}.blq-log .warn{color:#FFD666}.blq-log .info{color:#9CC7FF}' +
    '.blq-stats{font-size:11px;color:#4E5969;background:#F7F8FA;border-radius:8px;padding:7px 9px;margin-bottom:9px;' +
    'white-space:nowrap;overflow:hidden;text-overflow:ellipsis}';

  let panel = null, mini = null;

  function row(label, id, checked, desc) {
    return '<label class="blq-sw"><span><span class="n">' + label + '</span>' +
      (desc ? '<div class="d">' + desc + '</div>' : '') + '</span>' +
      '<input type="checkbox" id="' + id + '"' + (checked ? ' checked' : '') + '><span class="blq-sl"></span></label>';
  }
  function field(label, id, val, type, ph) {
    return '<div class="blq-f"><label>' + label + '</label>' +
      '<input id="' + id + '" type="' + (type || 'text') + '" value="' + String(val == null ? '' : val)
        .replace(/"/g, '&quot;') + '" placeholder="' + (ph || '') + '"></div>';
  }

  function buildPanel() {
    if (panel) return;
    if (!document.getElementById('blq-style')) {
      const st = document.createElement('style');
      st.id = 'blq-style'; st.textContent = CSS;
      (document.head || document.documentElement).appendChild(st);
    }
    panel = document.createElement('div');
    panel.id = 'blq';
    panel.innerHTML =
      '<div class="blq-head" id="blq-head">' +
      '<span class="blq-title"><span class="blq-dot off" id="blq-dot"></span>AI 自动答题</span>' +
      '<span><button class="blq-hb" id="blq-min" title="最小化">—</button>' +
      '<button class="blq-hb" id="blq-close" title="关闭">✕</button></span></div>' +
      '<div class="blq-tabs">' +
      '<div class="blq-tab on" data-tab="run">答题</div>' +
      '<div class="blq-tab" data-tab="api">接口</div>' +
      '<div class="blq-tab" data-tab="log">日志</div></div>' +

      // ---- 答题 ----
      '<div class="blq-pane on" data-pane="run">' +
      '<div class="blq-card"><div style="flex:1"><div class="blq-l1" id="blq-status">未开始</div>' +
      '<div class="blq-l2" id="blq-status2">先在「接口」页填好 API 信息</div></div></div>' +
      '<div class="blq-sec">控制</div>' +
      row('总开关', 'blq-enabled', cfg.enabled, '打开后才能自动答题') +
      row('答完自动下一题', 'blq-autoNext', cfg.autoNext) +
      row('自动作答主观题', 'blq-answerSubjective', cfg.answerSubjective, '生成长篇答案并回填答题框') +
      row('答题卡满就停止', 'blq-stopWhenFull', cfg.stopWhenFull, '停止后由你手动提交') +
      row('演练模式（不勾选）', 'blq-dryRun', cfg.dryRun, '只看 AI 答案，不实际操作') +
      '<div class="blq-sec">节奏</div>' +
      field('每题最短停顿（秒）', 'blq-thinkMin', cfg.thinkMin) +
      field('每题最长停顿（秒）', 'blq-thinkMax', cfg.thinkMax) +
      field('速率上限（题/分钟）', 'blq-maxPerMinute', cfg.maxPerMinute) +
      '<div style="margin-top:11px"><button class="blq-btn blq-pri" id="blq-start">▶ 开始自动答题</button></div>' +
      '<div style="margin-top:7px"><button class="blq-btn blq-sec2" id="blq-rethink">' +
      '↻ 清本题缓存并重新思考</button></div>' +
      '<div class="blq-g2">' +
      '<button class="blq-btn blq-sec2" id="blq-once">答当前一题</button>' +
      '<button class="blq-btn blq-dan" id="blq-stop">■ 停止</button></div>' +
      '<div class="blq-g2">' +
      '<button class="blq-btn blq-sec2" id="blq-scan">🔍 诊断结构</button>' +
      '<button class="blq-btn blq-sec2" id="blq-testapi">⚡ 测试接口</button></div>' +
      '</div>' +

      // ---- 接口 ----
      '<div class="blq-pane" data-pane="api">' +
      '<div class="blq-sec">DeepSeek API</div>' +
      '<div style="display:flex;flex-wrap:wrap;gap:5px;margin-bottom:9px">' +
      PRESETS.map((p, i) =>
        '<button class="blq-btn blq-sec2" data-preset="' + i + '" style="width:auto;padding:5px 9px;' +
        'font-size:11.5px;flex:0 0 auto">填入 ' + p.name + ' 默认配置</button>').join('') +
      '</div>' +
      field('DeepSeek 接口地址（可只填域名）', 'blq-apiBase', cfg.apiBase, 'text',
        'https://api.deepseek.com/v1') +
      field('API Key', 'blq-apiKey', cfg.apiKey, 'password', '在此填写 DeepSeek API Key') +
      field('模型名', 'blq-model', cfg.model, 'text', 'deepseek-chat') +
      field('temperature', 'blq-temperature', cfg.temperature) +
      field('max_tokens（主观题建议 2048+）', 'blq-maxTokens', cfg.maxTokens) +
      field('超时（毫秒）', 'blq-timeout', cfg.timeout) +
      '<div class="blq-g2"><button class="blq-btn blq-pri" id="blq-save">保存配置</button>' +
      '<button class="blq-btn blq-sec2" id="blq-testapi2">测试连接</button></div>' +
      '<div style="margin-top:7px"><button class="blq-btn blq-sec2" id="blq-probe" ' +
      'style="background:#F5F9FF;border-color:#B8D0FF;color:#165DFF">🔎 自动探测地址（404 时用这个）</button></div>' +
      '<div style="margin-top:7px"><button class="blq-btn blq-sec2" id="blq-models" ' +
      'style="background:#F5F9FF;border-color:#B8D0FF;color:#165DFF">📋 拉取模型列表（自动填模型名）</button></div>' +
      '<div class="blq-sec">答案缓存</div>' +
      '<div class="blq-stats" id="blq-bank">缓存 0 条</div>' +
      '<div class="blq-g2"><button class="blq-btn blq-sec2" id="blq-bankview">查看</button>' +
      '<button class="blq-btn blq-dan" id="blq-bankclear">清空缓存</button></div>' +
      '<div class="blq-f" style="margin-top:9px"><label>提示词预览（只读）</label>' +
      '<textarea id="blq-prompt" readonly style="width:100%;height:150px;padding:7px 9px;font-size:11px;' +
      'color:#4E5969;background:#F7F8FA;border:1px solid #E5E6EB;border-radius:8px;font-family:Consolas,monospace"></textarea></div>' +
      '</div>' +

      // ---- 日志 ----
      '<div class="blq-pane" data-pane="log">' +
      '<div class="blq-stats" id="blq-stat2">—</div>' +
      '<div class="blq-log" id="blq-log"></div>' +
      '<div class="blq-g2"><button class="blq-btn blq-sec2" id="blq-clearlog">清空日志</button>' +
      '<button class="blq-btn blq-sec2" id="blq-copylog">复制日志</button></div>' +
      '</div>';

    (document.body || document.documentElement).appendChild(panel);

    mini = document.createElement('div');
    mini.id = 'blq-mini';
    mini.textContent = 'AI';
    mini.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;width:46px;height:46px;' +
      'border-radius:50%;background:linear-gradient(135deg,#165DFF,#4080FF);color:#fff;display:none;' +
      'align-items:center;justify-content:center;font-size:15px;font-weight:700;cursor:pointer;' +
      'box-shadow:0 6px 18px rgba(22,93,255,.36)';
    (document.body || document.documentElement).appendChild(mini);

    bindPanel();
    renderLog();
    updateStats();
    updatePromptPreview();
  }

  function $(id) { return panel ? panel.querySelector('#' + id) : null; }
  function bindOrSkip(id, evt, fn) {
    try {
      const el = $(id);
      if (!el) return;
      el.addEventListener(evt, (e) => {
        if (e && e.isTrusted === false) return;   // 只响应真实用户操作
        fn(e);
      });
    } catch (e) {}
  }

  function bindPanel() {
    bindOrSkip('blq-close', 'click', () => {
      try { panel.remove(); } catch (e) {}
      try { mini.remove(); } catch (e) {}
      panel = null; mini = null;
    });
    bindOrSkip('blq-min', 'click', () => {
      try { panel.style.display = 'none'; mini.style.display = 'flex'; } catch (e) {}
    });
    try { mini.addEventListener('click', () => { panel.style.display = 'block'; mini.style.display = 'none'; }); } catch (e) {}
    try {
      const head = $('blq-head');
      let drag = null;
      head.addEventListener('mousedown', (e) => {
        try { const r = panel.getBoundingClientRect(); drag = { dx: e.clientX - r.left, dy: e.clientY - r.top }; e.preventDefault(); } catch (e2) {}
      });
      document.addEventListener('mousemove', (e) => {
        if (!drag || !panel) return;
        const w = panel.offsetWidth || 330, h = panel.offsetHeight || 400;
        panel.style.left = Math.max(0, Math.min(e.clientX - drag.dx, (window.innerWidth || 1200) - w)) + 'px';
        panel.style.top = Math.max(0, Math.min(e.clientY - drag.dy, (window.innerHeight || 800) - h)) + 'px';
        panel.style.right = 'auto'; panel.style.bottom = 'auto';
      });
      document.addEventListener('mouseup', () => { drag = null; });
    } catch (e) {}

    try {
      for (const t of qsa('.blq-tab', panel)) {
        t.addEventListener('click', () => {
          const name = t.getAttribute('data-tab');
          for (const x of qsa('.blq-tab', panel)) x.classList.toggle('on', x === t);
          for (const p of qsa('.blq-pane', panel)) p.classList.toggle('on', p.getAttribute('data-pane') === name);
        });
      }
    } catch (e) {}

    // 开关
    for (const k of ['enabled', 'autoNext', 'answerSubjective', 'stopWhenFull', 'dryRun']) {
      bindOrSkip('blq-' + k, 'change', (e) => {
        if (e.target.checked === cfg[k]) return;
        cfg[k] = e.target.checked; saveCfg();
        log('设置 ' + k + ' = ' + cfg[k]);
        updateStats();
      });
    }
    // 数字项
    for (const k of ['thinkMin', 'thinkMax', 'maxPerMinute']) {
      bindOrSkip('blq-' + k, 'change', (e) => {
        const v = parseFloat(e.target.value);
        if (!isFinite(v)) return;
        cfg[k] = v; saveCfg(); log('设置 ' + k + ' = ' + v);
      });
    }
    // 接口字段
    for (const k of ['apiBase', 'apiKey', 'model', 'temperature', 'maxTokens', 'timeout']) {
      bindOrSkip('blq-' + k, 'change', (e) => {
        const raw = e.target.value.trim();
        if (k === 'apiBase' || k === 'model' || k === 'apiKey') cfg[k] = raw;
        else { const n = parseFloat(raw); if (isFinite(n)) cfg[k] = n; }
        saveCfg(); log('接口配置已更新：' + k);
        updateStats();
      });
    }
    bindOrSkip('blq-save', 'click', () => {
      cfg = loadCfg();          // 重新走一遍校验
      // 把校验后的值回填到界面
      for (const k of ['apiBase', 'apiKey', 'model', 'temperature', 'maxTokens', 'timeout',
        'thinkMin', 'thinkMax', 'maxPerMinute']) {
        const el = $('blq-' + k); if (el) el.value = cfg[k];
      }
      saveCfg();
      log('✅ 配置已保存' + (cfg.apiKey ? '' : '（注意：API Key 为空）'), 'ok');
      updateStats();
    });

    bindOrSkip('blq-start', 'click', () => {
      if (!cfg.enabled) { cfg.enabled = true; saveCfg(); const c = $('blq-enabled'); if (c) c.checked = true; }
      runLoop();
    });
    bindOrSkip('blq-once', 'click', () => { answerCurrent('manual'); });
    bindOrSkip('blq-rethink', 'click', async () => {
      if (S.running || S.busy) {
        log('请先停止当前自动答题，再使用「清本题缓存并重新思考」', 'warn');
        return;
      }
      const q = readQuestion();
      if (!q) {
        log('未识别到当前题目，无法清理本题缓存', 'err');
        return;
      }
      try {
        const fp = fingerprint(q);
        const removed = bankDelete(fp);
        S.stopRequested = false;
        S.stopReason = '';
        if (!cfg.enabled) {
          cfg.enabled = true;
          saveCfg();
          const c = $('blq-enabled');
          if (c) c.checked = true;
        }
        updateStats();
        log(removed ? '已清除本题缓存 → 重新请求 AI' : '本题没有缓存 → 直接重新请求 AI', 'warn');
        const r = await answerCurrent('manual', { force: true });
        if (!r.ok) log('重新思考失败：' + (r.why || 'unknown'), 'err');
      } catch (e) {
        log('重新思考异常：' + (e && e.message), 'err');
      }
    });
    bindOrSkip('blq-stop', 'click', () => stopLoop('用户点击'));
    bindOrSkip('blq-scan', 'click', () => { log(diagnose(), 'info'); });
    bindOrSkip('blq-testapi', 'click', testApi);
    bindOrSkip('blq-testapi2', 'click', testApi);
    bindOrSkip('blq-probe', 'click', autoProbe);
    // 预设按钮：一键填入地址与模型名（不动 API Key）
    try {
      for (const b of qsa('[data-preset]', panel)) {
        b.addEventListener('click', (e) => {
          if (e && e.isTrusted === false) return;
          const p = PRESETS[parseInt(b.getAttribute('data-preset'), 10)];
          if (!p) return;
          cfg.apiBase = p.base;
          cfg.model = p.model;
          saveCfg();
          const a = $('blq-apiBase'); if (a) a.value = p.base;
          const m = $('blq-model'); if (m) m.value = p.model;
          log('已套用预设「' + p.name + '」：' + p.base + ' | 模型 ' + p.model, 'ok');
          log('  → 还需填入你的 API Key（只保存在本机，不会写进脚本）', 'info');
        });
      }
    } catch (e) {}
    bindOrSkip('blq-models', 'click', fetchModels);
    bindOrSkip('blq-clearlog', 'click', () => { logs.length = 0; renderLog(); log('日志已清空'); });
    bindOrSkip('blq-copylog', 'click', () => {
      const s = logs.map((l) => l.t).join('\n');
      try { navigator.clipboard.writeText(s); log('已复制日志到剪贴板', 'ok'); } catch (e) { log('复制失败', 'err'); }
    });
    bindOrSkip('blq-bankview', 'click', () => {
      const b = loadBank();
      const keys = Object.keys(b);
      if (!keys.length) { log('答案缓存为空', 'info'); return; }
      log('=== 答案缓存（' + keys.length + ' 条）===', 'info');
      keys.slice(-20).forEach((k) => {
        const ans = String(b[k].ans || '');
        log('  ' + ans.slice(0, 80) + (ans.length > 80 ? '…' : '') + '  ' + (b[k].q || ''), 'info');
      });
    });
    bindOrSkip('blq-bankclear', 'click', () => {
      bank = {}; gmSet(STORE_BANK, '{}');
      log('答案缓存已清空', 'warn'); updateStats();
    });
  }

  async function testApi() {
    cfg = loadCfg();
    if (!cfg.apiKey) { log('测试失败：未填 API Key', 'err'); return; }
    const norm = normalizeEndpoint(cfg.apiBase);
    if (norm !== cfg.apiBase) {
      log('接口地址已自动补全：' + cfg.apiBase + ' → ' + norm, 'info');
      cfg.apiBase = norm; saveCfg();
      const el = $('blq-apiBase'); if (el) el.value = norm;
    }
    log('正在测试接口…（' + norm + '）', 'info');
    const fake = {
      type: 'single', stem: '中国的首都是哪座城市？', tag: '单选', score: 5,
      options: [
        { letter: 'A', text: '上海' }, { letter: 'B', text: '北京' },
        { letter: 'C', text: '广州' }, { letter: 'D', text: '深圳' },
      ],
    };
    const t0 = Date.now();
    try {
      const res = await askAI(fake);
      log('✅ 接口正常（' + (Date.now() - t0) + 'ms）→ 返回 "' + res.raw.trim().slice(0, 40) +
        '"，解析为 ' + (res.letters.join('') || '空'), 'ok');
      if (!res.letters.length) log('⚠️ 能连上但解析不出字母，检查模型输出格式', 'warn');
    } catch (e) {
      log('❌ 接口测试失败：' + (e && e.message), 'err');
      log('提示：若是 404，点「🔎 自动探测地址」让脚本帮你找出正确路径', 'warn');
    }
  }

  // 自动探测可用端点（解决"404 不知填什么路径"）
  async function autoProbe() {
    cfg = loadCfg();
    if (!cfg.apiKey) { log('请先填 API Key，再自动探测', 'err'); return; }
    log('🔎 开始自动探测可用接口地址…', 'info');
    const r = await probeEndpoint();
    if (r.ok) {
      cfg.apiBase = r.url; saveCfg();
      const el = $('blq-apiBase'); if (el) el.value = r.url;
      log('✅ 已自动填入可用地址并保存：' + r.url, 'ok');
      log('现在可以点「测试连接」做一次带真实回答的验证', 'info');
      return;
    }
    if (r.reason === 'auth') {
      cfg.apiBase = r.url; saveCfg();
      const el = $('blq-apiBase'); if (el) el.value = r.url;
      log('地址找到了（' + r.url + '），但鉴权失败（HTTP ' + r.status + '）', 'err');
      log('  → 请检查 API Key 是否填对、是否有该模型权限', 'warn');
      let d = '';
      try { const j = JSON.parse(r.text); d = (j.error && j.error.message) || ''; } catch (e) {}
      if (d) log('  → 服务端说明：' + String(d).slice(0, 120), 'warn');
      return;
    }
    log('❌ 所有候选地址都不可用。', 'err');
    log('  → 请确认 DeepSeek 域名是否为 api.deepseek.com，或手动填入完整端点', 'warn');
    log('  → 也确认浏览器能直接访问该域名（有些内网/代理地址需要额外配置）', 'warn');
  }

  // 拉取模型列表（解决"不知道该填哪个模型名"）
  // DeepSeek 兼容接口通过 GET {base}/models 返回模型列表。
  async function fetchModels() {
    cfg = loadCfg();
    if (!cfg.apiKey) { log('请先填 API Key，再拉取模型列表', 'err'); return; }
    const norm = normalizeEndpoint(cfg.apiBase);
    // 从端点反推 base（去掉 /chat/completions）
    const base = norm.replace(/\/chat\/completions$/i, '').replace(/\/completions$/i, '');
    const url = base + '/models';
    log('📋 拉取模型列表：' + url, 'info');
    try {
      const res = await httpGet(url, { 'Authorization': 'Bearer ' + cfg.apiKey }, Math.min(cfg.timeout, 20000));
      if (res.status < 200 || res.status >= 300) {
        log('  → HTTP ' + res.status + '，该服务可能不支持 /models 接口', 'warn');
        if (res.status === 401 || res.status === 403) log('  → 鉴权失败，请检查 API Key', 'err');
        return;
      }
      let data = null;
      try { data = JSON.parse(res.text); } catch (e) { log('  → 返回不是 JSON', 'warn'); return; }
      const arr = (data && (data.data || data.models || data.result)) || [];
      const ids = [];
      for (const it of arr) {
        const id = (typeof it === 'string') ? it : (it && (it.id || it.name || it.model));
        if (id) ids.push(String(id));
      }
      if (!ids.length) { log('  → 返回里没解析出模型 id', 'warn'); return; }
      log('✅ 该接口支持 ' + ids.length + ' 个模型：', 'ok');
      ids.slice(0, 40).forEach((id) => log('     · ' + id, 'info'));
      if (ids.length > 40) log('     …（还有 ' + (ids.length - 40) + ' 个）', 'info');
      // 自动选一个：优先 deepseek-chat，其次任意 deepseek 模型。
      const prefer = ids.filter((id) => /^deepseek-chat$/i.test(id))
        .concat(ids.filter((id) => /deepseek/i.test(id) && !/^deepseek-chat$/i.test(id)));
      const pick = (prefer.length ? prefer : ids)[0];
      if (pick) {
        cfg.model = pick; saveCfg();
        const el = $('blq-model'); if (el) el.value = pick;
        log('👉 已自动填入模型名：' + pick + (prefer.length > 1 ? '（其他 DeepSeek 模型：' + prefer.slice(1, 4).join(', ') + '）' : ''), 'ok');
      }
    } catch (e) {
      log('  → 请求失败：' + (e && e.message), 'err');
    }
  }

  function renderLog() {
    const box = $('blq-log');
    if (!box) return;
    box.innerHTML = logs.slice(-150).map((l) => {
      const esc = l.t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      return '<div' + (l.k ? ' class="' + l.k + '"' : '') + '>' + esc + '</div>';
    }).join('');
    box.scrollTop = box.scrollHeight;
  }

  function updateStats() {
    const dot = $('blq-dot');
    if (dot) dot.className = 'blq-dot' + (S.running ? ' run' : (cfg.enabled ? '' : ' off'));
    const st = cardStatus();
    const s1 = $('blq-status'), s2 = $('blq-status2');
    if (s1) s1.textContent = S.running ? '正在答题…' : (cfg.enabled ? '待命中' : '未启用');
    if (s2) {
      s2.textContent = '答题卡 ' + (st.reliable ? st.answered + '/' + st.total : '未识别') +
        ' · 本次已答 ' + S.answeredCount + ' · AI ' + S.aiCalls + '（缓存 ' + S.cacheHits + '）' +
        (S.stopReason ? ' · 已停：' + S.stopReason : '');
    }
    const b = $('blq-bank');
    if (b) b.textContent = '缓存 ' + bankCount() + ' 条';
    const s2b = $('blq-stat2');
    if (s2b) {
      s2b.textContent = '已答 ' + S.answeredCount + ' · AI 调用 ' + S.aiCalls + ' · 缓存命中 ' +
        S.cacheHits + ' · 失败 ' + S.fails;
    }
  }

  let promptCacheKey = '';
  function updatePromptPreview() {
    const ta = $('blq-prompt');
    if (!ta) return;
    const q = readQuestion();
    if (!q) { ta.value = '（未识别到题目——请先进入答题页面）'; return; }
    const k = fingerprint(q);
    if (k === promptCacheKey && ta.value) return;
    promptCacheKey = k;
    ta.value = '【System】\n' + systemPromptFor(q) + '\n\n【User】\n' + buildPrompt(q);
  }

  // ==========================================================================
  //  8. 诊断
  // ==========================================================================
  function diagnose() {
    const out = [];
    out.push('===== 自动答题 · 结构诊断 =====');
    const st = cardStatus();
    out.push('答题卡：' + (st.reliable ? st.total + ' 题，已答 ' + st.answered : '未识别'));
    if (st.items.length) {
      out.push('  题号元素样例：<' + st.items[0].el.tagName.toLowerCase() + '> class="' +
        (typeof st.items[0].el.className === 'string' ? st.items[0].el.className : '') + '"');
    }
    out.push('当前题号：' + (questionNo() || '未识别（不影响答题，仅影响显示）'));
    const box = findQuestionBox();
    out.push('题目块：' + (box ? '<' + box.tagName.toLowerCase() + '> class="' +
      (typeof box.className === 'string' ? box.className.slice(0, 60) : '') + '"' : '未找到'));
    const q = readQuestion();
    if (q) {
      out.push('题型：' + q.type + (q.tag ? '（标签：' + q.tag + '）' : '') + '，分值：' + q.score);
      out.push('题干：' + q.stem.slice(0, 100));
      if (q.type === 'subjective') {
        const ed = q.editor;
        const r = (() => { try { return ed.getBoundingClientRect(); } catch (e) { return null; } })();
        out.push('编辑器：<' + String(ed.tagName || '?').toLowerCase() + '> class="' +
          String(ed.className || '').slice(0, 60) + '"');
        if (r) out.push('   rect=' + Math.round(r.width) + 'x' + Math.round(r.height));
        out.push('当前内容：' + (editorText(ed).length ? editorText(ed).slice(0, 100) + '…' : '（空）'));
      } else if (q.type === 'cloze') {
        out.push('空格：' + q.blanks.length + ' 个');
        q.blanks.forEach((input, i) => {
          out.push('  [' + (i + 1) + '] type=' + (input.type || 'text') +
            ' placeholder="' + String(input.getAttribute('placeholder') || '') + '"' +
            ' value="' + String(input.value || '').slice(0, 80) + '"' +
            ' visible=' + visible(input) + ' disabled=' + !!input.disabled);
        });
      } else {
        out.push('选项：');
        q.options.forEach((o) => out.push('   ' + o.letter + '. ' + o.text.slice(0, 50)));
        out.push('当前已选：' + (selectedLetters(q.box).join('') || '（无）'));
      }
      out.push('题目指纹：' + fingerprint(q));
      const cached = bankGet(fingerprint(q));
      out.push('缓存命中：' + (cached ? String(cached).slice(0, 100) + (String(cached).length > 100 ? '…' : '') : '（无）'));

      // ★ 选项结构详情（排查"点了不生效"必须看这段）
      if (q.type !== 'subjective' && q.type !== 'cloze') {
        out.push('');
        out.push('—— 选项结构详情（用于排查点击失效）——');
      }
      q.options.forEach((o) => {
        const n = o.node;
        const inp = o.input || (n.querySelector && n.querySelector('input[type="radio"], input[type="checkbox"]'));
        const r = (() => { try { return n.getBoundingClientRect(); } catch (e) { return null; } })();
        const st2 = (() => { try { return getComputedStyle(n); } catch (e) { return null; } })();
        out.push('  [' + o.letter + '] <' + (n.tagName || '?').toLowerCase() + '> class="' +
          String(n.className || '').slice(0, 50) + '"');
        out.push('      脚本用字母=' + o.letter + ' | 平台自带的=' + (o.nativeLetter || '(读不到)') +
          (o.nativeLetter && o.nativeLetter !== o.letter ? '  ← 两套体系，脚本以位置为准' : ''));
        out.push('      is-checked=' + (n.classList && n.classList.contains('is-checked')) +
          ' | visible=' + visible(n) +
          ' | reallyClickable=' + reallyClickable(n));
        if (r) out.push('      rect=' + Math.round(r.left) + ',' + Math.round(r.top) +
          ' ' + Math.round(r.width) + 'x' + Math.round(r.height));
        if (st2) out.push('      opacity=' + st2.opacity + ' pointer-events=' + st2.pointerEvents +
          ' display=' + st2.display);
        if (inp) {
          out.push('      input: type=' + inp.type + ' value=' + inp.value +
            ' checked=' + inp.checked + ' disabled=' + inp.disabled);
          const ir = (() => { try { return inp.getBoundingClientRect(); } catch (e) { return null; } })();
          const ist = (() => { try { return getComputedStyle(inp); } catch (e) { return null; } })();
          if (ir) out.push('      input.rect=' + Math.round(ir.width) + 'x' + Math.round(ir.height));
          if (ist) out.push('      input.opacity=' + ist.opacity + ' pointer-events=' + ist.pointerEvents +
            ' display=' + ist.display + ' visibility=' + ist.visibility);
        } else {
          out.push('      ⚠️ 没有找到内部 input 元素');
        }
      });
      if (q.type !== 'subjective' && q.type !== 'cloze') {
        out.push('  —— 提示：若 input 是 opacity:0（Element UI 常态），属正常，');
        out.push('      脚本会用原生 input.click() 勾选，不依赖坐标命中。');
      }
    } else {
      out.push('⚠️ 未能解析出题目——请把这段输出发给我');
    }
    out.push('翻页按钮：下一题=' + (findNavButton('next') ? '找到' : '未找到') +
      '，上一题=' + (findNavButton('prev') ? '找到' : '未找到'));
    out.push('接口：' + cfg.apiBase + ' | 模型 ' + cfg.model + ' | Key ' +
      (cfg.apiKey ? '已填写（内容已隐藏）' : '未填写'));
    return out.join('\n');
  }

  // ==========================================================================
  //  9. 启动
  // ==========================================================================
  function boot() {
    try { buildPanel(); } catch (e) { panel = null; }
    log('脚本已加载。填写「接口」页后打开总开关即可开始。', 'info');
    if (!cfg.apiKey) log('提示：API Key 尚未填写', 'warn');
    // 定时刷新状态
    setInterval(() => { try { updateStats(); updatePromptPreview(); } catch (e) {} }, 2000);
    // 页面结构变化时刷新提示词预览
    try {
      new MutationObserver(() => { try { updatePromptPreview(); } catch (e) {} })
        .observe(document.documentElement, { childList: true, subtree: true });
    } catch (e) {}
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();
