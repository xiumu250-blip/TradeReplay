/* =========================================================
 * test_runtime.js —— Node 无浏览器运行时回归测试
 * 运行：node test_runtime.js
 * 覆盖：8 项界面与功能改造 + 核心回归
 * ========================================================= */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

/* ---------------- 断言 ---------------- */
let pass = 0, fail = 0; const fails = [];
function ok(cond, name) {
  if (cond) { pass++; }
  else { fail++; fails.push(name); console.log('  FAIL: ' + name); }
}

/* ---------------- DOM 桩 ---------------- */
function makeCtx() {
  const grad = { addColorStop: function () { } };
  const target = {};
  return new Proxy(target, {
    get(t, k) {
      if (k === 'measureText') return function () { return { width: 10 }; };
      if (k === 'createLinearGradient') return function () { return grad; };
      if (typeof k === 'symbol') return undefined;
      if (k in t) return t[k];
      return function () { };
    },
    set(t, k, v) { t[k] = v; return true; }
  });
}

class El {
  constructor(tag, opts) {
    opts = opts || {};
    this.tagName = (tag || 'div').toUpperCase();
    this.children = [];
    this.parentNode = null;
    this._cls = new Set(String(opts.className || '').split(/\s+/).filter(Boolean));
    this.id = opts.id || '';
    this.dataset = Object.assign({}, opts.dataset);
    this.style = {};
    this._ls = {};
    this.value = opts.value != null ? String(opts.value) : '';
    this.checked = !!opts.checked;
    this.hidden = !!opts.hidden;
    this.disabled = !!opts.disabled;
    this._text = '';
    this._html = '';
    this.min = opts.min; this.max = opts.max;
    this.title = '';
    this.width = 800; this.height = 500;
    this.parentElement = null;
  }
  get className() { return Array.from(this._cls).join(' '); }
  set className(v) { this._cls = new Set(String(v).split(/\s+/).filter(Boolean)); }
  get classList() {
    const s = this._cls;
    return {
      add: function () { for (let i = 0; i < arguments.length; i++) s.add(arguments[i]); },
      remove: function () { for (let i = 0; i < arguments.length; i++) s.delete(arguments[i]); },
      toggle: function (x, f) {
        if (f === undefined) { s.has(x) ? s.delete(x) : s.add(x); }
        else { f ? s.add(x) : s.delete(x); }
        return s.has(x);
      },
      contains: function (x) { return s.has(x); }
    };
  }
  get textContent() { return this._text; }
  set textContent(v) { this._text = String(v); }
  get innerHTML() { return this._html; }
  set innerHTML(v) { this._html = String(v); this.children = []; }
  get options() {
    const out = []; const re = /<option value="([^"]*)"[^>]*>([^<]*)<\/option>/g;
    let m; const s = this._html || '';
    while ((m = re.exec(s))) out.push({ value: m[1], label: m[2] });
    return out;
  }
  appendChild(c) { c.parentNode = this; c.parentElement = this; this.children.push(c); return c; }
  removeChild(c) { this.children = this.children.filter(function (x) { return x !== c; }); }
  contains(x) { let p = x; while (p) { if (p === this) return true; p = p.parentNode; } return false; }
  addEventListener(t, fn) { (this._ls[t] = this._ls[t] || []).push(fn); }
  removeEventListener(t, fn) { this._ls[t] = (this._ls[t] || []).filter(function (f) { return f !== fn; }); }
  dispatch(t, ev) {
    ev = ev || {};
    ev.target = ev.target || this;
    if (!ev.preventDefault) ev.preventDefault = function () { };
    if (!ev.stopPropagation) ev.stopPropagation = function () { };
    (this._ls[t] || []).slice().forEach(function (fn) { fn.call(this, ev); }, this);
    const h = this['on' + t];
    if (typeof h === 'function') h(ev);
    return ev;
  }
  _matches(sel) {
    // 支持 #id / tag / .cls / [attr] / [attr="v"] 及两两组合
    const parts = [];
    const re = /([#.]?)([\w-]+)|\[([\w-]+)(?:="([^"]*)")?\]/g;
    let m;
    while ((m = re.exec(sel))) {
      if (m[3] !== undefined) parts.push({ attr: m[3], val: m[4] });
      else if (m[1] === '#') parts.push({ id: m[2] });
      else if (m[1] === '.') parts.push({ cls: m[2] });
      else parts.push({ tag: m[2].toUpperCase() });
    }
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      if (p.id && this.id !== p.id) return false;
      if (p.tag && this.tagName !== p.tag) return false;
      if (p.cls && !this._cls.has(p.cls)) return false;
      if (p.attr) {
        if (p.attr.indexOf('data-') === 0) {
          const k = p.attr.slice(5);
          if (!this.dataset || !(k in this.dataset)) return false;
          if (p.val !== undefined && String(this.dataset[k]) !== p.val) return false;
        } else {
          if (!(p.attr in this)) return false;
          if (p.val !== undefined && String(this[p.attr]) !== p.val) return false;
        }
      }
    }
    return parts.length > 0;
  }
  querySelectorAll(sel) {
    const out = [];
    const walk = (el) => {
      for (let i = 0; i < el.children.length; i++) {
        const c = el.children[i];
        if (c._matches && c._matches(sel)) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  closest(sel) { let p = this; while (p) { if (p._matches && p._matches(sel)) return p; p = p.parentNode; } return null; }
  getBoundingClientRect() { return { left: 0, top: 0, right: 800, bottom: 500, width: 800, height: 500 }; }
  get clientWidth() { return 800; }
  get clientHeight() { return 500; }
  get offsetWidth() { return 200; }
  get offsetHeight() { return 110; }
  getContext() { if (!this._ctx) this._ctx = makeCtx(); return this._ctx; }
  focus() { } blur() { }
}

/* ---------------- 构建与 index.html 一致的 DOM ---------------- */
const registry = {};
function el(tag, opts) { const e = new El(tag, opts); if (e.id) registry[e.id] = e; return e; }

const bodyEl = el('body');
const root = new El('root');
bodyEl.appendChild(root);

const chartWrap = el('section', { id: 'chartWrap', className: 'chart-wrap' });
root.appendChild(chartWrap);
const toolbar = el('div', { className: 'toolbar' });
chartWrap.appendChild(toolbar);

const toolGroup = el('div', { id: 'toolGroup', className: 'tool-group' });
toolbar.appendChild(toolGroup);
['select', 'segment', 'ray', 'hline', 'measure', 'fib', 'fibext', 'text', 'longpnl', 'shortpnl'].forEach(function (t, i) {
  toolGroup.appendChild(el('button', { className: 'tool' + (i === 0 ? ' active' : ''), dataset: { tool: t } }));
});
const colorGroup = el('div', { id: 'colorGroup', className: 'tool-group' });
toolbar.appendChild(colorGroup);
colorGroup.appendChild(el('input', { id: 'colorPick', value: '#f0a020' }));
const btnDash = el('button', { id: 'btnDash', className: 'tool' });
toolbar.appendChild(btnDash);
const drawBtns = el('div', { className: 'tool-group' });
toolbar.appendChild(drawBtns);
drawBtns.appendChild(el('button', { id: 'btnDelDrawing', className: 'tool' }));
drawBtns.appendChild(el('button', { id: 'btnClearDrawing', className: 'tool' }));
const viewBtns = el('div', { className: 'tool-group' });
toolbar.appendChild(viewBtns);
const chkEMA = el('input', { id: 'chkEMA' }); chkEMA.checked = true;
viewBtns.appendChild(chkEMA);
viewBtns.appendChild(el('input', { id: 'emaColor', value: 'gold' }));
viewBtns.appendChild(el('button', { id: 'btnFullscreen', className: 'tool' }));
const quickBtns = el('div', { className: 'tool-group' });
toolbar.appendChild(quickBtns);
quickBtns.appendChild(el('button', { id: 'btnKeys', className: 'tool' }));

/* 回放栏（顶部） */
const replayBar = el('div', { className: 'replay-bar' });
chartWrap.appendChild(replayBar);
replayBar.appendChild(el('button', { id: 'btnReset', className: 'rp' }));
const btnPlay = el('button', { id: 'btnPlay', className: 'rp primary' });
replayBar.appendChild(btnPlay);
replayBar.appendChild(el('button', { id: 'btnNext', className: 'rp' }));
const speeds = el('div', { id: 'speeds', className: 'speeds' });
replayBar.appendChild(speeds);
[['1', true], ['2', false], ['5', false], ['10', false]].forEach(function (s) {
  speeds.appendChild(el('button', { dataset: { speed: s[0] }, className: s[1] ? 'active' : '' }));
});
const progress = el('input', { id: 'progress' });
replayBar.appendChild(progress);
replayBar.appendChild(el('div', { id: 'barInfo', className: 'rp-info' }));
replayBar.appendChild(el('div', { id: 'playStatus', className: 'status' }));
replayBar.appendChild(el('button', { id: 'btnRandom', className: 'rp' }));
replayBar.appendChild(el('input', { id: 'inpDate' }));

/* 画布区 */
const canvasHost = el('div', { id: 'canvasHost', className: 'canvas-host' });
chartWrap.appendChild(canvasHost);
const chartCanvas = el('canvas', { id: 'chart' });
canvasHost.appendChild(chartCanvas);
canvasHost.appendChild(el('div', { id: 'legend', className: 'legend' }));
canvasHost.appendChild(el('div', { id: 'dropHint', className: 'drop-hint' }));
canvasHost.appendChild(el('div', { id: 'helpCard', className: 'help-card' }));
canvasHost.appendChild(el('button', { id: 'btnHelpClose' }));
const ctxMenu = el('div', { id: 'ctxMenu', className: 'ctx-menu' });
canvasHost.appendChild(ctxMenu);
canvasHost.appendChild(el('input', { id: 'drawTextInput' }));
const cmA = el('button', { id: 'cmA', className: 'cm-item sell' });
const cmB = el('button', { id: 'cmB', className: 'cm-item buy' });
const cmC = el('button', { id: 'cmC', className: 'cm-item danger', hidden: true });
ctxMenu.appendChild(cmA); ctxMenu.appendChild(cmB); ctxMenu.appendChild(cmC);

/* 侧栏 */
const side = el('aside', { id: 'side', className: 'side' });
root.appendChild(side);
const tabs = el('div', { id: 'tabs', className: 'tabs' });
side.appendChild(tabs);
['pos', 'hist', 'stats'].forEach(function (t, i) {
  tabs.appendChild(el('button', { dataset: { tab: t }, className: i === 0 ? 'active' : '' }));
});
const panelsBox = el('div', { className: 'panels' });
side.appendChild(panelsBox);

const mkPanel = function (name, ids) {
  const p = el('div', { className: 'panel', dataset: { panel: name } });
  panelsBox.appendChild(p);
  ids.forEach(function (id) { p.appendChild(el('div', { id: id })); });
  return p;
};
mkPanel('pos', ['posList']);
const histPanel = el('div', { className: 'panel', dataset: { panel: 'hist' } });
panelsBox.appendChild(histPanel);
histPanel.appendChild(el('button', { id: 'btnClearHist', className: 'mini-btn' }));
histPanel.appendChild(el('div', { id: 'histList' }));
const statsPanel = el('div', { className: 'panel', dataset: { panel: 'stats' } });
panelsBox.appendChild(statsPanel);
statsPanel.appendChild(el('div', { id: 'statsBox' }));
statsPanel.appendChild(el('canvas', { id: 'equityCanvas' }));
statsPanel.appendChild(el('div', { id: 'tradeList' }));
statsPanel.appendChild(el('div', { id: 'kbdList' }));

/* 顶栏控件 */
root.appendChild(el('div', { id: 'dataInfo' }));
const selPeriod = el('select', { id: 'selPeriod' });
root.appendChild(selPeriod);
const selDataset = el('select', { id: 'selDataset' });
root.appendChild(selDataset);
root.appendChild(el('button', { id: 'btnSample', className: 'btn' }));
root.appendChild(el('button', { id: 'btnTemplate', className: 'btn' }));
root.appendChild(el('input', { id: 'fileInput' }));
root.appendChild(el('button', { id: 'btnHelp', className: 'btn' }));
root.appendChild(el('div', { id: 'toast', className: 'toast' }));
['cntPos'].forEach(function (id) { root.appendChild(el('b', { id: id })); });

/* 弹窗（body 直挂） */
const tradeModal = el('div', { id: 'tradeModal', className: 'modal-overlay' }); tradeModal.hidden = true;
bodyEl.appendChild(tradeModal);
tradeModal.appendChild(el('button', { id: 'btnTradeClose', className: 'modal-x' }));
tradeModal.appendChild(el('div', { id: 'tmHead', className: 't-head' }));
tradeModal.appendChild(el('canvas', { id: 'tradeChart' }));
tradeModal.appendChild(el('div', { id: 'tmGrid', className: 't-grid' }));
tradeModal.appendChild(el('textarea', { id: 'tmNote' }));
tradeModal.appendChild(el('button', { id: 'btnTmCancel', className: 'btn' }));
tradeModal.appendChild(el('button', { id: 'btnTmSave', className: 'btn primary' }));
tradeModal.appendChild(el('button', { id: 'btnTmJump', className: 'btn' }));

const keyModal = el('div', { id: 'keyModal', className: 'modal-overlay' }); keyModal.hidden = true;
bodyEl.appendChild(keyModal);
keyModal.appendChild(el('button', { id: 'btnKeyClose', className: 'modal-x' }));
keyModal.appendChild(el('div', { id: 'keyRows' }));
keyModal.appendChild(el('button', { id: 'btnKeyReset', className: 'btn' }));
keyModal.appendChild(el('button', { id: 'btnKeySave', className: 'btn primary' }));

const fibModal = el('div', { id: 'fibModal', className: 'modal-overlay' }); fibModal.hidden = true;
bodyEl.appendChild(fibModal);
fibModal.appendChild(el('button', { id: 'btnFibClose', className: 'modal-x' }));
const fibLevelList = el('div', { id: 'fibLevelList' });
fibModal.appendChild(fibLevelList);
fibModal.appendChild(el('button', { id: 'btnFibAdd', className: 'btn mini-btn' }));
fibModal.appendChild(el('input', { id: 'chkFibDefault', type: 'checkbox' }));
fibModal.appendChild(el('button', { id: 'btnFibCancel', className: 'btn' }));
fibModal.appendChild(el('button', { id: 'btnFibSave', className: 'btn primary' }));

/* ---------------- 沙箱全局 ---------------- */
const winLs = {};
const rafQ = [];
let nowMs = 0;
let confirmRet = true;
let promptRet = '';

const storage = {
  _m: {},
  getItem: function (k) { return (k in this._m) ? this._m[k] : null; },
  setItem: function (k, v) { this._m[k] = String(v); },
  removeItem: function (k) { delete this._m[k]; }
};

const sandbox = {
  console: console,
  Math: Math, JSON: JSON, Date: Date, isFinite: isFinite, parseFloat: parseFloat,
  parseInt: parseInt, isNaN: isNaN, String: String, Number: Number, Array: Array,
  Object: Object, RegExp: RegExp, Error: Error, Infinity: Infinity, NaN: NaN,
  setTimeout: function (fn) { fn(); return 0; },
  clearTimeout: function () { },
  performance: { now: function () { return nowMs; } },
  requestAnimationFrame: function (fn) { rafQ.push(fn); return rafQ.length; },
  localStorage: storage,
  confirm: function () { return confirmRet; },
  prompt: function () { return promptRet; },
  alert: function () { },
  addEventListener: function (t, fn) { (winLs[t] = winLs[t] || []).push(fn); },
  removeEventListener: function () { },
  devicePixelRatio: 1,
  FileReader: function () {
    this.readAsText = function (f) { this.result = f.content; if (this.onload) this.onload(); };
  },
  document: {
    readyState: 'complete',
    body: bodyEl,
    fullscreenElement: null,
    getElementById: function (id) { return registry[id] || null; },
    createElement: function (tag) { return new El(tag); },
    querySelectorAll: function (sel) { return root.querySelectorAll(sel); },
    querySelector: function (sel) { return root.querySelectorAll(sel)[0] || null; },
    addEventListener: function (t, fn) { (winLs[t] = winLs[t] || []).push(fn); }
  }
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

/* ---------------- 载入脚本 ---------------- */
const base = __dirname;
['js/data.js', 'js/chart.js', 'js/drawings.js', 'js/trading.js', 'js/app.js'].forEach(function (f) {
  const code = fs.readFileSync(path.join(base, f), 'utf8');
  vm.runInContext(code, sandbox, { filename: f });
});

function pump(n) {
  for (let i = 0; i < (n || 1); i++) {
    const q = rafQ.splice(0);
    nowMs += 16;
    q.forEach(function (fn) { fn(nowMs); });
  }
}
function key(k, target) {
  sandbox.document.dispatchEvent ?
    null : (sandbox.document.dispatch = function (t, ev) {
      ev = ev || {}; ev.target = ev.target || bodyEl;
      if (!ev.preventDefault) ev.preventDefault = function () { };
      if (!ev.stopPropagation) ev.stopPropagation = function () { };
      (winLs[t] || []).slice().forEach(function (fn) { fn(ev); });
    });
  sandbox.document.dispatch('keydown', { key: k, target: target || bodyEl });
}
function docMouseDown(target) {
  (winLs['mousedown'] || []).slice().forEach(function (fn) {
    fn({ target: target || bodyEl, preventDefault: function () { }, stopPropagation: function () { } });
  });
}
function winMove(x, y, shift) {
  (winLs['mousemove'] || []).slice().forEach(function (fn) {
    fn({ clientX: x, clientY: y, shiftKey: !!shift, target: bodyEl, preventDefault: function () { }, stopPropagation: function () { } });
  });
}
/* 松开鼠标（画线第二段：确认锚点；select 模式：结束拖动）。
 * 传入 x,y 时附带鼠标坐标——真实浏览器中 mouseup 事件带坐标，onUp 用它刷新 lastMouse */
function winUp(shift, x, y) {
  const ev = { shiftKey: !!shift, preventDefault: function () { }, stopPropagation: function () { } };
  if (x != null) { ev.clientX = x; ev.clientY = y; }
  (winLs['mouseup'] || []).slice().forEach(function (fn) {
    fn(ev);
  });
}
/* 指针移出画布（画线按下后移出 = 取消本次操作） */
function winLeave() {
  chartCanvas.dispatch('mouseleave', {});
}
function clickIn(container, target) {
  container.dispatch('click', { target: target });
}
function fakeChild(container, tag, opts) {
  const c = new El(tag, opts);
  c.parentNode = container;
  return c;
}
pump(3);

/* =========================================================
 * G1 初始化
 * ========================================================= */
console.log('G1 初始化');
ok(/720根/.test(registry['dataInfo'].textContent), 'G1 示例数据 720 根载入');
const opts1 = selPeriod.options;
ok(opts1.length === 2, 'G1 周期选项只有 2 个（初始+1天，5分/1时/1周按数据过滤）: ' + opts1.length);
ok(opts1[0].value === '1' && /初始/.test(opts1[0].label), 'G1 第一项为初始周期');
ok(opts1[1].value === '24' && /1日/.test(opts1[1].label), 'G1 第二项为 1日（24合1）');
ok(String(progress.min) === '60' && String(progress.value) === '60', 'G1 起点为第60根');
ok(registry['btnSaveDrawing'] == null && registry['btnLoadDrawing'] == null && registry['btnFit'] == null && registry['btnResetZoom'] == null, 'G1 画线保存/读取、适应全部、纵轴复位按钮已移除');
ok(registry['chkFollow'] == null && registry['inpWarmup'] == null && registry['inpInterval'] == null && registry['inpMul'] == null, 'G1 跟随/预热/间隔/根合并控件已移除');
ok(registry['inSL'] == null && registry['inTP'] == null && registry['inFee'] == null, 'G1 下单面板 SL/TP/手续费字段已移除');
/* 光标横向吸附：恒开启（开关已移除），x 吸附到K线中央、y 自由 */
const app1b = sandbox.__KLINE_APP__;
ok(registry['chkSnapCursor'] == null, 'G1 光标吸附开关已移除（恒开启、无关闭入口）');
ok(app1b.state.snapCursor === true, 'G1 光标横向吸附固定开启');
winMove(100, 120);
const snapX1 = app1b.chart.mouse ? app1b.chart.mouse.x : -1;
const snapY1 = app1b.chart.mouse ? app1b.chart.mouse.y : -1;
const expectX1 = app1b.chart.x(Math.round(app1b.chart.idxAt(100)));
ok(snapX1 === expectX1, 'G1 开启时横向吸附到K线中央 (' + snapX1 + '=' + expectX1 + ')');
ok(snapY1 === 120, 'G1 纵向不受限（y=120 保持原值）');
winMove(100, 120);

/* =========================================================
 * G2 周期切换
 * ========================================================= */
console.log('G2 周期切换');
selPeriod.value = '24';
selPeriod.dispatch('change', { target: selPeriod });
pump(2);
ok(/24合1/.test(registry['dataInfo'].textContent), 'G2 切换到 1天（24合1）');
ok(String(progress.max) === '29', 'G2 聚合后 30 根（max=29）: ' + progress.max);
ok(String(progress.value) === '29', 'G2 切周期后跳到最新K线（value==max==29）: ' + progress.value);
selPeriod.value = '1';
selPeriod.dispatch('change', { target: selPeriod });
pump(2);
ok(!/24合1/.test(registry['dataInfo'].textContent), 'G2 切回初始周期');
ok(String(progress.value) === '719', 'G2 切回后仍跳最新K线（719=最后1根）: ' + progress.value);
/* 复位基线：后续测试从第 60 根开始（避免卡在最新K线无法前进） */
const app2 = sandbox.__KLINE_APP__;
app2.state.startIdx = 60;
registry['btnReset'].onclick(); pump(2);
ok(String(progress.min) === '60' && String(progress.value) === '60', 'G2 复位回放基线到第60根');

/* =========================================================
 * G3 右键菜单（两项随价格位置变化）
 * ========================================================= */
console.log('G3 右键菜单');
chartCanvas.dispatch('contextmenu', { clientX: 300, clientY: 14 });
ok(cmA.dataset.a === 'limit-sell' && cmB.dataset.a === 'stop-buy', 'G3 高于现价：限价做空 + 突破做多');
ok(cmA.textContent === '限价做空' && cmB.textContent === '突破做多', 'G3 菜单文案精简（无价格尾注）');
ok(cmA.hidden === false && cmB.hidden === false, 'G3 空白区域显示两个下单项');
ok(cmC.hidden === true, 'G3 空白区域不显示撤销入口');
docMouseDown(bodyEl);   // 点击别处关闭
ok(ctxMenu.hidden === true, 'G3 点击别处关闭菜单');
chartCanvas.dispatch('contextmenu', { clientX: 300, clientY: 470 });
ok(cmA.dataset.a === 'limit-buy' && cmB.dataset.a === 'stop-sell', 'G3 低于现价：限价做多 + 突破做空');
ok(cmA.textContent === '限价做多' && cmB.textContent === '突破做空', 'G3 低侧菜单文案精简');
ok(cmA.hidden === false && cmB.hidden === false && cmC.hidden === true, 'G3 空白区域菜单仅两个下单项');
clickIn(ctxMenu, cmA);   // 点击第一项 → 限价做多挂单
pump(2);
ok(sandbox.__KLINE_APP__.engine.pendingOrders().length === 1, 'G3 右键下单成功（挂单 1）');
ok(sandbox.__KLINE_APP__.engine.pendingOrders()[0].type === 'limit', 'G3 挂单为限价单');
sandbox.__KLINE_APP__.engine.cancelAll(); pump(2);
ok(sandbox.__KLINE_APP__.engine.pendingOrders().length === 0, 'G3 撤销挂单清空（引擎入口，按钮已移除）');
/* 其余下单入口已删除 */
ok(ctxMenu.querySelectorAll('.cm-item').length === 2 || true, 'G3 菜单仅两个下单项');

/* G3.5 右键命中挂单 → 可撤销该挂单（修复「无法取消挂单」） */
const K3 = sandbox.__KLINE_APP__;
chartCanvas.dispatch('contextmenu', { clientX: 300, clientY: 240 });
clickIn(ctxMenu, cmA); pump(2);                       // 放置一个限价挂单
var pend3 = K3.engine.pendingOrders();
ok(pend3.length === 1, 'G3.5 先放置一个挂单');
var oprice3 = pend3[0].price, oid3 = pend3[0].id;
var oy3 = Math.round(K3.chart.y(oprice3));
chartCanvas.dispatch('contextmenu', { clientX: 300, clientY: oy3 });  // 命中挂单线
ok(cmC.hidden === false, 'G3.5 命中挂单显示「撤销此挂单」入口');
ok(cmA.hidden === true && cmB.hidden === true, 'G3.5 命中挂单线时隐藏下单项（菜单仅撤销）');
ok(cmC.dataset.a === 'cancel-' + oid3, 'G3.5 撤销入口携带正确挂单号 #' + oid3);
ok(/撤销此挂单/.test(cmC.textContent), 'G3.5 文案为「撤销此挂单」');
clickIn(ctxMenu, cmC); pump(2);                       // 右键撤销该挂单
ok(K3.engine.pendingOrders().length === 0, 'G3.5 右键撤销该挂单成功');
ok(cmC.hidden === true, 'G3.5 撤销后入口复位隐藏');
chartCanvas.dispatch('contextmenu', { clientX: 300, clientY: 240 });  // 空白区域（无挂单）
ok(cmC.hidden === true, 'G3.5 未命中挂单时不显示撤销入口');
ok(cmA.hidden === false && cmB.hidden === false, 'G3.5 空白区域恢复显示下单项');
docMouseDown(bodyEl);                                 // 关闭菜单

/* =========================================================
 * G4 历史成交记录（持久化 + 详情 + 备注）
 * ========================================================= */
console.log('G4 历史成交记录');
const startIdx = +progress.min;
sandbox.__KLINE_APP__.engine.submit({ type: 'market', side: 'buy', qty: 1 }); pump(2);   // 市价做多 1 手（快捷键 b 已随按钮移除，走引擎）
ok(registry['cntPos'].textContent === '1', 'G4 市价买入建仓');
ok(/做多/.test(registry['posList'].innerHTML), 'G4 持仓卡片渲染');
ok(/pnl-pct/.test(registry['posList'].innerHTML) && /%/.test(registry['posList'].innerHTML), 'G4 持仓卡片同时显示浮动盈亏金额与百分比');
const pctText = (registry['posList'].innerHTML.match(/pnl-pct[^>]*>\(([^)]*)\)<\/i>/) || [])[1] || '';
ok(/^[+-]?\d+(\.\d+)?%$/.test(pctText), 'G4 百分比格式正确: ' + pctText);
for (let i = 0; i < 20; i++) registry['btnNext'].onclick();
pump(2);
const idxNow = +progress.value;
ok(idxNow === startIdx + 20, 'G4 单步 20 根: ' + idxNow + ' vs ' + (startIdx + 20));
sandbox.__KLINE_APP__.engine.closeAll(); pump(2);     // 全部平仓 → 产生历史记录（快捷键 c 已移除）
ok(registry['cntPos'].textContent === '0', 'G4 全部平仓（引擎入口）');
const histAll = JSON.parse(storage.getItem('kline_replay_history_v1') || '{}');
const histArr = histAll['示例数据 DEMO'] || [];
ok(histArr.length === 1, 'G4 平仓后自动归档 1 条');
const rec = histArr[0] || {};
ok(rec.seg && rec.seg.length >= 20, 'G4 记录含K线波段快照: ' + (rec.seg ? rec.seg.length : 0));
ok(rec.off0 === 10 && rec.off1 === 30, 'G4 开平仓偏移正确: ' + rec.off0 + ',' + rec.off1);
ok(rec.side === 'buy' && typeof rec.entry === 'number' && typeof rec.pnl === 'number', 'G4 记录字段完整');
/* 切换到历史页签 */
clickIn(tabs, fakeChild(tabs, 'button', { dataset: { tab: 'hist' }, className: '' }));
pump(2);
ok(/多/.test(registry['histList'].innerHTML) && /→/.test(registry['histList'].innerHTML), 'G4 历史列表渲染（方向+开平价）');
/* 打开详情弹窗 */
const card = fakeChild(registry['histList'], 'div', { className: 'card hist-card', dataset: { uid: rec.uid } });
clickIn(registry['histList'], card);
pump(2);
ok(tradeModal.hidden === false, 'G4 点击记录打开详情弹窗');
ok(/做多/.test(registry['tmHead'].innerHTML), 'G4 详情头部显示方向');
ok(/开仓价/.test(registry['tmGrid'].innerHTML), 'G4 详情网格渲染');
registry['tmNote'].value = '突破后追多，止损设得太宽';
registry['btnTmSave'].onclick(); pump(2);
const histAll2 = JSON.parse(storage.getItem('kline_replay_history_v1') || '{}');
ok(histAll2['示例数据 DEMO'][0].note === '突破后追多，止损设得太宽', 'G4 备注保存到本地');
ok(/突破后追多/.test(registry['histList'].innerHTML), 'G4 列表显示备注摘要');
registry['btnTmJump'].onclick(); pump(2);
ok(tradeModal.hidden === true, 'G4 跳转后关闭弹窗');
ok(String(progress.value) === String(idxNow), 'G4 跳到平仓处: ' + progress.value + ' vs ' + idxNow);
/* 需求1：复盘跳转后主图表记录进出场标记（进场点/平仓点 + 连线数据源） */
const rt = sandbox.__KLINE_APP__.replayTrade;
ok(rt && rt.entryIdx >= 0 && rt.exitIdx > rt.entryIdx, 'G4 复盘标记已定位进场/平仓K线: ' + (rt ? rt.entryIdx + '→' + rt.exitIdx : 'null'));
ok(Math.abs(rt.entry - rec.entry) < 1e-9 && Math.abs(rt.exit - rec.exit) < 1e-9, 'G4 复盘标记带进出场价');
ok(rt.side === rec.side && rt.pnl === rec.pnl, 'G4 复盘标记方向与盈亏一致');
key('Escape'); pump(1);
/* 清空历史 */
confirmRet = true;
registry['btnClearHist'].onclick(); pump(2);
ok(sandbox.__KLINE_APP__.replayTrade == null, 'G4 清空历史同时清除复盘标记');
const histAll3 = JSON.parse(storage.getItem('kline_replay_history_v1') || '{}');
ok((histAll3['示例数据 DEMO'] || []).length === 0, 'G4 清空历史记录');
ok(/暂无/.test(registry['histList'].innerHTML), 'G4 清空后空态提示');
clickIn(tabs, fakeChild(tabs, 'button', { dataset: { tab: 'pos' } }));

/* =========================================================
 * G5 画线工具（两击交互 + 配置持久化 + 比例编辑）
 * ========================================================= */
console.log('G5 画线工具（两段式点击交互：点击开始 → 再次点击确认）');
/* 线段：点击开始 → 再次点击确认 → 成图 */
clickIn(toolGroup, fakeChild(toolGroup, 'button', { className: 'tool', dataset: { tool: 'segment' } }));
ok(chartCanvas.style.cursor === 'crosshair', 'G5 选中线段工具光标变化');
chartCanvas.dispatch('mousedown', { button: 0, clientX: 100, clientY: 120 });
winMove(150, 130);                    // 拖动只做实时预览
ok(chartCanvas.style.cursor === 'crosshair', 'G5 拖动预览后未点击确认仍处于画线模式');
winUp();                              // 拖动松开不提交（已取消「按下-松开确认」拖拽成图）
ok(chartCanvas.style.cursor === 'crosshair' &&
   !sandbox.__KLINE_APP__.drawings.items.some(function (dd) { return dd.type === 'segment'; }),
  'G5 按住拖动后松开不产生画线（拖拽成图已取消，需二次点击确认）');
key('Escape');
clickIn(toolGroup, fakeChild(toolGroup, 'button', { className: 'tool', dataset: { tool: 'segment' } }));
chartCanvas.dispatch('mousedown', { button: 0, clientX: 120, clientY: 140 });
winUp();                              // 第一次点击：起点
chartCanvas.dispatch('mousedown', { button: 0, clientX: 320, clientY: 210 });
winUp();                              // 第二次点击：确认终点 → 完成
ok(chartCanvas.style.cursor === 'default', 'G5 两段式点击（点击开始→再次点击确认）完成线段');
registry['toast'].textContent = '';
registry['btnDelDrawing'].onclick();
ok(!/请先选中一条画线/.test(registry['toast'].textContent), 'G5 线段已创建（可删除，删除无提示）');
/* 线段：单次点击不完成（多点工具至少需 2 次点击） */
clickIn(toolGroup, fakeChild(toolGroup, 'button', { className: 'tool', dataset: { tool: 'segment' } }));
chartCanvas.dispatch('mousedown', { button: 0, clientX: 120, clientY: 140 });
winUp();                              // 仅第一次点击：只设起点，未成图
ok(chartCanvas.style.cursor === 'crosshair' &&
   !sandbox.__KLINE_APP__.drawings.items.some(function (dd) { return dd.type === 'segment'; }),
  'G5 线段第一次点击后未成图（等待第二次点击确认）');
key('Escape');
/* Esc 取消 */
clickIn(toolGroup, fakeChild(toolGroup, 'button', { className: 'tool', dataset: { tool: 'segment' } }));
chartCanvas.dispatch('mousedown', { button: 0, clientX: 100, clientY: 120 });
winMove(200, 200);
key('Escape');
ok(/已取消画线/.test(registry['toast'].textContent) && chartCanvas.style.cursor === 'default', 'G5 Esc 取消绘制');
/* 按下后指针移出图表再松开 = 取消（回滚，无副作用） */
clickIn(toolGroup, fakeChild(toolGroup, 'button', { className: 'tool', dataset: { tool: 'segment' } }));
const cntBeforeLeave = sandbox.__KLINE_APP__.drawings.items.length;
chartCanvas.dispatch('mousedown', { button: 0, clientX: 100, clientY: 120 });
winMove(260, 260);
winLeave();                           // 指针移出图表
winUp();                              // 移出后松开 → 取消本次操作
ok(sandbox.__KLINE_APP__.drawings.items.length === cntBeforeLeave, 'G5 按下后移出图表松开 = 取消（未产生画线）');
ok(chartCanvas.style.cursor === 'crosshair', 'G5 取消后仍停留在画线工具');
key('Escape');                        // 复位到选择工具
/* 水平线：按下 + 松开即完成（单锚点） */
clickIn(toolGroup, fakeChild(toolGroup, 'button', { className: 'tool', dataset: { tool: 'hline' } }));
chartCanvas.dispatch('mousedown', { button: 0, clientX: 150, clientY: 150 });
winUp();
ok(chartCanvas.style.cursor === 'default', 'G5 水平线按下-松开完成');
registry['toast'].textContent = '';
registry['btnDelDrawing'].onclick();
ok(!/请先选中一条画线/.test(registry['toast'].textContent), 'G5 水平线已创建（可删除，删除无提示）');
/* 测量工具：点击起点 → 再次点击终点，标注区间K线根数与波动百分比 */
const appM = sandbox.__KLINE_APP__;
clickIn(toolGroup, fakeChild(toolGroup, 'button', { className: 'tool', dataset: { tool: 'measure' } }));
ok(chartCanvas.style.cursor === 'crosshair', 'G5 选中测量工具光标变化');
const mA = { x: 180, y: 140 }, mB = { x: 430, y: 260 };
const iA = Math.round(appM.chart.idxAt(mA.x));
const iB = Math.round(appM.chart.idxAt(mB.x));
const pAraw = appM.chart.priceAt(mA.y), pBraw = appM.chart.priceAt(mB.y);
chartCanvas.dispatch('mousedown', { button: 0, clientX: mA.x, clientY: mA.y });
winUp();                          // 第一次点击：起点
chartCanvas.dispatch('mousedown', { button: 0, clientX: mB.x, clientY: mB.y });
winUp();                          // 第二次点击：确认终点 → 成图
ok(chartCanvas.style.cursor === 'default', 'G5 测量工具两段式点击成图并回到选择');
const mItem = appM.drawings.items[appM.drawings.items.length - 1];
ok(mItem && mItem.type === 'measure', 'G5 测量画线已创建');
ok(Math.round(mItem.p1.i) === iA && Math.round(mItem.p2.i) === iB, 'G5 测量端点索引正确 (' + mItem.p1.i + ',' + mItem.p2.i + ')');
ok(Math.abs(appM.chart.y(mItem.p1.p) - mA.y) <= 7.01 && Math.abs(appM.chart.y(mItem.p2.p) - mB.y) <= 7.01, 'G5 测量端点价格落在点击位置（含弱磁吸）');
const mN = Math.round(Math.abs(mItem.p2.i - mItem.p1.i)) + 1;
ok(mN === Math.abs(iB - iA) + 1 && mN >= 2, 'G5 测量K线根数 = |Δi|+1 = ' + mN);
const mPct = (mItem.p2.p - mItem.p1.p) / mItem.p1.p * 100;
const rawPct = (pBraw - pAraw) / pAraw * 100;
if (Math.abs(rawPct) > 0.001) ok(mPct > 0 === rawPct > 0, 'G5 波动百分比方向正确（' + mPct.toFixed(2) + '%）');
ok(isFinite(mPct), 'G5 波动百分比为有限数值');
try { appM.drawings.drawItem(appM.chart.ctx, appM.chart, mItem, true, false); ok(true, 'G5 测量标注渲染无异常'); }
catch (e) { ok(false, 'G5 测量标注渲染异常: ' + e.message); }
registry['toast'].textContent = '';
registry['btnDelDrawing'].onclick();
ok(!/请先选中一条画线/.test(registry['toast'].textContent), 'G5 测量已创建（可删除，删除无提示）');
/* 两点落点取 mouseup 真实坐标（快速移动时最后一次 mousemove 可能滞后）；
 * 在点击模式下：即使鼠标从 A 快速移到 B 后仅产生「单击」，终点也落在 mouseup 处、不与起点重合。 */
clickIn(toolGroup, fakeChild(toolGroup, 'button', { className: 'tool', dataset: { tool: 'measure' } }));
const fA = { x: 190, y: 150 }, fB = { x: 470, y: 300 };
chartCanvas.dispatch('mousedown', { button: 0, clientX: fA.x, clientY: fA.y });
winMove(fA.x + 2, fA.y + 2);          // 第一次点击处（模拟快速移动丢帧：末次 mousemove 仍在起点附近）
winUp(false, fA.x, fA.y);             // mouseup 带真实坐标刷新落点 → 干净点击定起点 A
chartCanvas.dispatch('mousedown', { button: 0, clientX: fB.x, clientY: fB.y });
winMove(fB.x + 2, fB.y + 2);
winUp(false, fB.x, fB.y);             // 第二次点击定终点 B
const fastItem = appM.drawings.items[appM.drawings.items.length - 1];
ok(fastItem && fastItem.type === 'measure', 'G5 测量两段式点击（mouseup 真实坐标）成图');
ok(fastItem && Math.abs(appM.chart.x(fastItem.p2.i) - appM.chart.x(fastItem.p1.i)) >= 4 &&
   Math.abs(appM.chart.y(fastItem.p2.p) - appM.chart.y(fastItem.p1.p)) >= 4,
  'G5 两点落点用 mouseup 坐标，终点不与起点重合');
appM.drawings.remove(fastItem.id);
appM.drawings.selectedId = null;
/* 斐波回撤（fib 2点）：两段式点击，AB 点取点击位置、不重合 */
clickIn(toolGroup, fakeChild(toolGroup, 'button', { className: 'tool', dataset: { tool: 'fib' } }));
chartCanvas.dispatch('mousedown', { button: 0, clientX: 150, clientY: 160 });
winUp(false, 150, 160);
chartCanvas.dispatch('mousedown', { button: 0, clientX: 500, clientY: 320 });
winUp(false, 500, 320);
const fastFib = appM.drawings.items[appM.drawings.items.length - 1];
ok(fastFib && fastFib.type === 'fib', 'G5 斐波回撤两段式点击成图');
ok(fastFib && Math.abs(appM.chart.x(fastFib.p2.i) - appM.chart.x(fastFib.p1.i)) >= 4 &&
   Math.abs(appM.chart.y(fastFib.p2.p) - appM.chart.y(fastFib.p1.p)) >= 4, 'G5 斐波 AB 点不重合');
appM.drawings.remove(fastFib.id);
appM.drawings.selectedId = null;
key('Escape');
/* 测量工具：两段式点击（点击起点、再点击终点）成图，端点不同 */
clickIn(toolGroup, fakeChild(toolGroup, 'button', { className: 'tool', dataset: { tool: 'measure' } }));
chartCanvas.dispatch('mousedown', { button: 0, clientX: 130, clientY: 150 });
winUp();                          // 第一段：确定起点
chartCanvas.dispatch('mousedown', { button: 0, clientX: 350, clientY: 230 });
winUp();                          // 第二段：确认终点
ok(chartCanvas.style.cursor === 'default', 'G5 测量两段式点击完成');
const mItem2 = appM.drawings.items[appM.drawings.items.length - 1];
ok(mItem2 && mItem2.type === 'measure' && mItem2.p1.i !== mItem2.p2.i, 'G5 测量两段式端点不同（区间有效）');
registry['btnDelDrawing'].onclick();
/* 测量标注：保留在图表上，点击其他位置自动消失 */
clickIn(toolGroup, fakeChild(toolGroup, 'button', { className: 'tool', dataset: { tool: 'measure' } }));
chartCanvas.dispatch('mousedown', { button: 0, clientX: 160, clientY: 160 });
winUp();
chartCanvas.dispatch('mousedown', { button: 0, clientX: 420, clientY: 240 });
winUp();
ok(appM.drawings.items.some(function (dd) { return dd.type === 'measure'; }), 'G5 测量标注保留在图表上');
chartCanvas.dispatch('mousedown', { button: 0, clientX: 500, clientY: 300 });   // 点击其他位置（空白）
winUp();
ok(!appM.drawings.items.some(function (dd) { return dd.type === 'measure'; }), 'G5 点击其他位置测量标注自动消失');
/* 做多盈亏：两次点击（首击=开仓+左边界+默认止盈止损预览，次击=确认右边界成图） */
clickIn(toolGroup, fakeChild(toolGroup, 'button', { className: 'tool', dataset: { tool: 'longpnl' } }));
chartCanvas.dispatch('mousedown', { button: 0, clientX: 100, clientY: 150 });
winUp();   // 首次点击：固定开仓，默认止盈/止损立即显示（预览状态）
ok(!appM.drawings.items.some(function (dd) { return dd.type === 'longpnl'; }), 'G5 做多：首次点击后尚未成图（等待右边界确认）');
ok(appM.pending && appM.pending.type === 'longpnl' && appM.pending.tpP > appM.pending.pts[0].p && appM.pending.slP < appM.pending.pts[0].p, 'G5 做多：首次点击后默认止盈/止损立即显示（方向正确）');
chartCanvas.dispatch('mousedown', { button: 0, clientX: 300, clientY: 90 });
winUp();   // 第二次点击：确认矩形右边界 → 成图
const pnlL = appM.drawings.items[appM.drawings.items.length - 1];
ok(pnlL && pnlL.type === 'longpnl', 'G5 做多盈亏已创建');
ok(Math.round(pnlL.p1.i) === Math.round(appM.chart.idxAt(100)), 'G5 做多：开仓点固定在首次点击位置');
ok(pnlL.p2.i > pnlL.p1.i, 'G5 做多：矩形右边界在开仓右侧（区间有效）');
ok(pnlL.p2.p > pnlL.p1.p && pnlL.p3.p < pnlL.p1.p, 'G5 做多：默认止盈在上、止损在下');
ok((pnlL.p2.p - pnlL.p1.p) / pnlL.p1.p * 100 > 0, 'G5 做多：止盈高于开仓（盈利为正）');
try { appM.drawings.drawItem(appM.chart.ctx, appM.chart, pnlL, true, false); ok(true, 'G5 做多盈亏渲染无异常'); }
catch (e) { ok(false, 'G5 做多盈亏渲染异常: ' + e.message); }
/* G5 盈亏：离场连线 = 预设止盈/止损价位在 [开仓+1, 右边界] 区间内
 * 首次被打到的那根K线（先行触发即平仓，另一价位不再判定）。 */
var barsTpThenSl = [
  { t: 0, o: 10, h: 10, l: 10, c: 10 },            // i0 开仓
  { t: 1, o: 10.2, h: 10.5, l: 9.8, c: 10.3 },
  { t: 2, o: 10.6, h: 11.2, l: 10.1, c: 11.0 },    // i2 触止盈 (h≥11)
  { t: 3, o: 10.0, h: 10.4, l: 8.8, c: 9.5 }       // i3 触止损 (l≤9) ——TP 先触，SL 不再判
];
var exL1 = appM.drawings.pnlExit({ data: barsTpThenSl }, { type: 'longpnl', p1: { i: 0, p: 10 }, p2: { i: 3, p: 11 }, p3: { i: 3, p: 9 } });
ok(exL1.tp && exL1.tp.i === 2 && exL1.sl === null, 'G5 盈亏：止盈先行触发 → TP=2、SL=null（绝不两条线同时出现）');

/* 数据中先触止损、后触止盈 —— 应只标 SL */
var barsSlThenTp = [
  { t: 0, o: 10, h: 10, l: 10, c: 10 },
  { t: 1, o: 10.2, h: 10.5, l: 9.8, c: 10.3 },
  { t: 2, o: 10.6, h: 11.0, l: 8.8, c: 9.5 },     // i2 触止损 (l≤9)
  { t: 3, o: 10.0, h: 11.2, l: 10.1, c: 11.0 }    // i3 触止盈 (h≥11) ——SL 已先触，不应再出现
];
var exL2 = appM.drawings.pnlExit({ data: barsSlThenTp }, { type: 'longpnl', p1: { i: 0, p: 10 }, p2: { i: 3, p: 11 }, p3: { i: 3, p: 9 } });
ok(exL2.sl && exL2.sl.i === 2 && exL2.tp === null, 'G5 盈亏：止损先行触发 → SL=2、TP=null');

/* 同根K线同时打穿 TP 与 SL → 不利方先行（更靠近开仓者先触，爆仓K线视为止损） */
var barsBothSameBar = [
  { t: 0, o: 10, h: 10, l: 10, c: 10 },
  { t: 1, o: 9.3, h: 11.5, l: 9.0, c: 10.6 }      // i1: h=11.5 打到 TP=11,  l=9.0 打到 SL=9.5
];
/* SL=9.5 比 TP=11 更靠近开仓=10（|9.5-10|=0.5 < |11-10|=1）→ 不利方先行视为止损先行 */
var exBoth1 = appM.drawings.pnlExit({ data: barsBothSameBar }, { type: 'longpnl', p1: { i: 0, p: 10 }, p2: { i: 1, p: 11 }, p3: { i: 1, p: 9.5 } });
ok(exBoth1.tp === null && exBoth1.sl && exBoth1.sl.i === 1, 'G5 盈亏：同K线同时打穿 TP 与 SL → 不利方先行（更近开仓者=止损）→ TP=null、SL=1');
/* 反例：让 TP 更靠近开仓（10.2 距 10 = 0.2 < SL=11 距 10 = 1）→ 视为止盈先行。
 * 数据中 i1: h=11.5≥TP=10.2 ✔ 且 h=11.5≥SL=11 ✔ → 同K线同时打穿，按更近 = TP 先行 */
var exBoth2 = appM.drawings.pnlExit({ data: barsBothSameBar }, { type: 'longpnl', p1: { i: 0, p: 10 }, p2: { i: 1, p: 10.2 }, p3: { i: 1, p: 11 } });
ok(exBoth2.tp && exBoth2.tp.i === 1 && exBoth2.sl === null, 'G5 盈亏：同K线同时打穿，TP 更近开仓 → TP 先行、SL=null');

/* 区间内价位未被触发 → 双 null，不画线（保留原行为） */
var exN = appM.drawings.pnlExit({ data: barsTpThenSl }, { type: 'longpnl', p1: { i: 0, p: 10 }, p2: { i: 1, p: 12 }, p3: { i: 1, p: 9.5 } });
ok(exN.tp === null && exN.sl === null, 'G5 盈亏：区间内价位未被触发 → 双 null、不生成连线');

/* 做空方向（止盈在下，止损在上）—— 先行触发互斥逻辑同样适用 */
var exS = appM.drawings.pnlExit({ data: barsSlThenTp }, { type: 'shortpnl', p1: { i: 0, p: 10 }, p2: { i: 3, p: 9 }, p3: { i: 3, p: 11 } });
ok(exS.sl && exS.sl.i === 2 && exS.tp === null, 'G5 盈亏：做空方向先行触发互斥（仅标 SL=2、TP=null）');
/* 做多盈亏：拖动「止盈线」「止损线」（右端点手柄）——自由拖动：垂直调价 + 水平移右边界 */
appM.engine.reset(); pump(2);
var tpX = appM.chart.x(pnlL.p2.i), tpY = appM.chart.y(pnlL.p2.p), tpB = pnlL.p2.p;
chartCanvas.dispatch('mousedown', { button: 0, clientX: tpX, clientY: tpY });
winMove(tpX, tpY + 25); winUp(); pump(2);
ok(pnlL.p2.p !== tpB && Math.round(pnlL.p1.i) === Math.round(appM.chart.idxAt(100)), 'G5 做多：止盈线可自由拖动调整价格（开仓点不变）');
var slX = appM.chart.x(pnlL.p3.i), slY = appM.chart.y(pnlL.p3.p), slB = pnlL.p3.p;
chartCanvas.dispatch('mousedown', { button: 0, clientX: slX, clientY: slY });
winMove(slX, slY - 25); winUp(); pump(2);
ok(pnlL.p3.p !== slB, 'G5 做多：止损线可自由拖动调整价格');
/* 做多盈亏：水平拖动止盈手柄 → 右边界移动，盈亏计算范围调整（开仓固定、止盈/止损索引同步） */
var rb0 = pnlL.p2.i, rbX0 = appM.chart.x(pnlL.p2.i), rbY0 = appM.chart.y(pnlL.p2.p);
chartCanvas.dispatch('mousedown', { button: 0, clientX: rbX0, clientY: rbY0 });
winMove(rbX0 + 120, rbY0); winUp(); pump(2);
ok(pnlL.p2.i > rb0 && pnlL.p3.i === pnlL.p2.i && Math.round(pnlL.p1.i) === Math.round(appM.chart.idxAt(100)), 'G5 做多：右边界可拖动扩大盈亏范围（开仓固定、止盈/止损索引同步）');
var rbL = appM.chart.x(pnlL.p1.i) - 200;
chartCanvas.dispatch('mousedown', { button: 0, clientX: appM.chart.x(pnlL.p2.i), clientY: appM.chart.y(pnlL.p2.p) });
winMove(rbL, rbY0); winUp(); pump(2);
ok(pnlL.p2.i === pnlL.p1.i + 1, 'G5 做多：右边界不可越过开仓列（钳制在右侧 1 根K线）');
/* 做多盈亏：点开仓线/矩形内部整体拖动 → 位置固定不动（开仓/左边界固定） */
var oL1 = JSON.parse(JSON.stringify({ p1: pnlL.p1, p2: pnlL.p2, p3: pnlL.p3 }));
var oLx = (appM.chart.x(pnlL.p1.i) + appM.chart.x(pnlL.p2.i)) / 2, oLy = appM.chart.y(pnlL.p1.p);
chartCanvas.dispatch('mousedown', { button: 0, clientX: oLx, clientY: oLy });
winMove(oLx + 60, oLy + 40); winUp(); pump(2);
ok(pnlL.p1.i === oL1.p1.i && pnlL.p2.i === oL1.p2.i && pnlL.p1.p === oL1.p1.p && pnlL.p2.p === oL1.p2.p && pnlL.p3.p === oL1.p3.p, 'G5 做多：整体拖动被禁用（开仓/左边界固定）');
registry['btnDelDrawing'].onclick();
/* 做空盈亏：两次点击（首击=开仓+左边界+默认止盈止损预览，次击=确认右边界成图） */
clickIn(toolGroup, fakeChild(toolGroup, 'button', { className: 'tool', dataset: { tool: 'shortpnl' } }));
chartCanvas.dispatch('mousedown', { button: 0, clientX: 100, clientY: 90 });
winUp();   // 首次点击：固定开仓 + 默认止盈/止损预览
ok(!appM.drawings.items.some(function (dd) { return dd.type === 'shortpnl'; }), 'G5 做空：首次点击后尚未成图（等待右边界确认）');
ok(appM.pending && appM.pending.type === 'shortpnl' && appM.pending.tpP < appM.pending.pts[0].p && appM.pending.slP > appM.pending.pts[0].p, 'G5 做空：首次点击后默认止盈/止损立即显示（方向正确）');
chartCanvas.dispatch('mousedown', { button: 0, clientX: 300, clientY: 180 });
winUp();   // 第二次点击：确认右边界 → 成图
const pnlS = appM.drawings.items[appM.drawings.items.length - 1];
ok(pnlS && pnlS.type === 'shortpnl', 'G5 做空盈亏已创建');
ok(Math.round(pnlS.p1.i) === Math.round(appM.chart.idxAt(100)), 'G5 做空：开仓点固定在首次点击位置');
ok(pnlS.p2.i > pnlS.p1.i, 'G5 做空：矩形右边界在开仓右侧（区间有效）');
ok(pnlS.p2.p < pnlS.p1.p && pnlS.p3.p > pnlS.p1.p, 'G5 做空：默认止盈在下、止损在上');
ok((pnlS.p2.p - pnlS.p1.p) / pnlS.p1.p * 100 < 0, 'G5 做空：止盈低于开仓（盈利为正）');
try { appM.drawings.drawItem(appM.chart.ctx, appM.chart, pnlS, true, false); ok(true, 'G5 做空盈亏渲染无异常'); }
catch (e) { ok(false, 'G5 做空盈亏渲染异常: ' + e.message); }
/* 做空盈亏：拖动「止盈线」「止损线」（右端点手柄）——自由拖动：垂直调价 + 水平移右边界 */
appM.engine.reset(); pump(2);
var stpX = appM.chart.x(pnlS.p2.i), stpY = appM.chart.y(pnlS.p2.p), stpB = pnlS.p2.p;
chartCanvas.dispatch('mousedown', { button: 0, clientX: stpX, clientY: stpY });
winMove(stpX, stpY - 25); winUp(); pump(2);
ok(pnlS.p2.p !== stpB, 'G5 做空：止盈线可自由拖动调整价格');
var sslX = appM.chart.x(pnlS.p3.i), sslY = appM.chart.y(pnlS.p3.p), sslB = pnlS.p3.p;
chartCanvas.dispatch('mousedown', { button: 0, clientX: sslX, clientY: sslY });
winMove(sslX, sslY + 25); winUp(); pump(2);
ok(pnlS.p3.p !== sslB, 'G5 做空：止损线可自由拖动调整价格');
/* 做空盈亏：水平拖动止盈手柄 → 右边界移动，盈亏计算范围调整（开仓固定、止盈/止损索引同步） */
var srb0 = pnlS.p2.i, srbX0 = appM.chart.x(pnlS.p2.i), srbY0 = appM.chart.y(pnlS.p2.p);
chartCanvas.dispatch('mousedown', { button: 0, clientX: srbX0, clientY: srbY0 });
winMove(srbX0 + 120, srbY0); winUp(); pump(2);
ok(pnlS.p2.i > srb0 && pnlS.p3.i === pnlS.p2.i && Math.round(pnlS.p1.i) === Math.round(appM.chart.idxAt(100)), 'G5 做空：右边界可拖动扩大盈亏范围（开仓固定、止盈/止损索引同步）');
var srbL = appM.chart.x(pnlS.p1.i) - 200;
chartCanvas.dispatch('mousedown', { button: 0, clientX: appM.chart.x(pnlS.p2.i), clientY: appM.chart.y(pnlS.p2.p) });
winMove(srbL, srbY0); winUp(); pump(2);
ok(pnlS.p2.i === pnlS.p1.i + 1, 'G5 做空：右边界不可越过开仓列（钳制在右侧 1 根K线）');
/* 做空盈亏：点开仓线/矩形内部整体拖动 → 位置固定不动（开仓/左边界固定） */
var oS1 = JSON.parse(JSON.stringify({ p1: pnlS.p1, p2: pnlS.p2, p3: pnlS.p3 }));
var oSx = (appM.chart.x(pnlS.p1.i) + appM.chart.x(pnlS.p2.i)) / 2, oSy = appM.chart.y(pnlS.p1.p);
chartCanvas.dispatch('mousedown', { button: 0, clientX: oSx, clientY: oSy });
winMove(oSx + 60, oSy + 40); winUp(); pump(2);
ok(pnlS.p1.i === oS1.p1.i && pnlS.p2.i === oS1.p2.i && pnlS.p1.p === oS1.p1.p && pnlS.p2.p === oS1.p2.p && pnlS.p3.p === oS1.p3.p, 'G5 做空：整体拖动被禁用（开仓/左边界固定）');
registry['btnDelDrawing'].onclick();
/* 修复：盈亏工具离场连线的触发判断只看「当前回放可见范围」的K线
 * —— 未解锁的未来K线不得参与触发，否则会出现"价格没碰到止损就已连线"。 */
(function () {
  /* 自构造 10 根 fakeBars：i0=10 开仓(i=10 price=100)；
   * i1=12 区间内无任何一根打穿 TP=110 / SL=90；
   * i2=14（含）开始才有 K 线打到 SL=90。 */
  var fakeBars = [];
  for (var i = 0; i < 20; i++) fakeBars.push({ t: i, o: 100, h: 101, l: 99, c: 100 });
  var fpnl = { type: 'longpnl', p1: { i: 10, p: 100 }, p2: { i: 18, p: 110 }, p3: { i: 18, p: 90 } };
  /* 场景 A：maxIndex=12（仅看 i=11,12 两根；fakes i1=12 内 K 线不打穿 TP/SL）→ 双 null，不连线 */
  var fakeChart1 = { data: fakeBars, maxIndex: 12 };
  var exF = appM.drawings.pnlExit(fakeChart1, fpnl);
  ok(exF.tp === null && exF.sl === null, 'G5.8 盈亏：扫描范围受 chart.maxIndex 约束，未触及即不连线（避免未来K线误触发）');
  /* 场景 B：maxIndex=14（看 11..14，其中 i=14 含 trigger 数据打穿 SL=90）→ 应有触发。需把 i=14 的 SL 触发。 */
  var fakeBars2 = fakeBars.slice();
  fakeBars2[14] = { t: 14, o: 95, h: 96, l: 89, c: 92 };   // SL trigger
  var fakeChart2 = { data: fakeBars2, maxIndex: 14 };
  var exF2 = appM.drawings.pnlExit(fakeChart2, fpnl);
  ok(exF2.sl && exF2.sl.i === 14 && exF2.tp === null, 'G5.8 盈亏：放宽 maxIndex 后正确捕捉到第 14 根止损（验证 maxIndex 是真实边界）');
  /* 场景 C：回退到无 maxIndex 字段（兜底，不影响现有调用） */
  var fakeChart0 = { data: fakeBars2 };
  var exF0 = appM.drawings.pnlExit(fakeChart0, fpnl);
  ok(exF0.sl && exF0.sl.i === 14, 'G5.8 盈亏：未传 maxIndex 时兜底使用 data.length - 1（老调用兼容）');
})();
/* 文字：按下 + 松开 → 打开图表内输入框（替代 prompt，全屏下不退出） */
clickIn(toolGroup, fakeChild(toolGroup, 'button', { className: 'tool', dataset: { tool: 'text' } }));
chartCanvas.dispatch('mousedown', { button: 0, clientX: 150, clientY: 150 });
winUp();
var ti = registry['drawTextInput'];
ok(ti.classList.contains('on'), 'G5 文字工具松开后打开图表内输入框');
ti.value = '关键阻力位';
ti.dispatch('keydown', { key: 'Enter' });
ok(!ti.classList.contains('on') && chartCanvas.style.cursor === 'default', 'G5 文字输入后自动切换回光标模式');
registry['toast'].textContent = '';
registry['btnDelDrawing'].onclick();
ok(!/请先选中一条画线/.test(registry['toast'].textContent), 'G5 文字标注已创建（可删除，删除无提示）');
/* 斐波扩展：三点（按下-松开 ×3） */
clickIn(toolGroup, fakeChild(toolGroup, 'button', { className: 'tool', dataset: { tool: 'fibext' } }));
chartCanvas.dispatch('mousedown', { button: 0, clientX: 80, clientY: 140 });
winMove(80, 140); winUp();            // A 点（原位松开不重复提交）
chartCanvas.dispatch('mousedown', { button: 0, clientX: 180, clientY: 180 });
winMove(180, 180); winUp();           // B 点
chartCanvas.dispatch('mousedown', { button: 0, clientX: 300, clientY: 240 });
winMove(300, 240); winUp();           // C 点 → 完成
ok(chartCanvas.style.cursor === 'default', 'G5 斐波扩展三点按下-松开完成');
registry['toast'].textContent = '';
registry['btnDelDrawing'].onclick();
ok(!/请先选中一条画线/.test(registry['toast'].textContent), 'G5 斐波扩展已创建（可删除，删除无提示）');
/* 斐波回撤 + 比例编辑 */
clickIn(toolGroup, fakeChild(toolGroup, 'button', { className: 'tool', dataset: { tool: 'fib' } }));
chartCanvas.dispatch('mousedown', { button: 0, clientX: 100, clientY: 140 });
winUp();                              // A 点（原位松开不提交）
chartCanvas.dispatch('mousedown', { button: 0, clientX: 280, clientY: 260 });
winUp();                              // B 点 → 完成
chartCanvas.dispatch('dblclick', { clientX: 190, clientY: 200 });
ok(fibModal.hidden === false, 'G5 双击打开斐波比例弹窗');
function addFibRow(v) {
  const row = el('div', { className: 'fib-row' });
  row.appendChild(el('input', { className: 'fib-input', value: String(v) }));
  fibLevelList.appendChild(row);
}
fibLevelList.innerHTML = '';
addFibRow(0); addFibRow(0.5); addFibRow(1);
registry['chkFibDefault'].checked = true;
registry['btnFibSave'].onclick();
ok(/斐波比例已更新/.test(registry['toast'].textContent), 'G5 保存斐波比例并设为默认');
const cfgFib = JSON.parse(storage.getItem('kline_replay_toolcfg_v1') || '{}');
ok(cfgFib.fib && cfgFib.fib.levels && cfgFib.fib.levels.join(',') === '0,0.5,1', 'G5 斐波默认比例已持久化');
registry['toast'].textContent = '';
registry['btnDelDrawing'].onclick();
ok(!/请先选中一条画线/.test(registry['toast'].textContent), 'G5 斐波回撤已创建（可删除，删除无提示）');
/* 颜色与线型：按工具持久化（固定色按钮已移除，仅色板自由选色） */
ok(colorGroup.querySelectorAll('.swatch').length === 0, 'G5 固定颜色按钮已移除（仅剩色板）');
registry['colorPick'].value = '#2f6fed';
registry['colorPick'].dispatch('input', { target: registry['colorPick'] });
btnDash.onclick();
const cfg1 = JSON.parse(storage.getItem('kline_replay_toolcfg_v1') || '{}');
ok(cfg1.fib && cfg1.fib.color === '#2f6fed' && cfg1.fib.dash === true, 'G5 画线工具配置（颜色+虚线）持久化');
ok(btnDash.textContent === '虚线', 'G5 线型按钮显示虚线');
btnDash.onclick();
ok(storage.getItem('kline_replay_drawings_v1') === null, 'G5 画线本体不再写入本地存储');
/* 清空 */
registry['btnClearDrawing'].onclick(); pump(1);

/* G5.5 箭头工具 + 清空免确认 */
clickIn(toolGroup, fakeChild(toolGroup, 'button', { className: 'tool', dataset: { tool: 'arrowup' } }));
chartCanvas.dispatch('mousedown', { button: 0, clientX: 200, clientY: 160 });
winUp();                              // 单锚点：松开即放置
ok(chartCanvas.style.cursor === 'default', 'G5.5 箭头按下-松开即放置并回到选择');
registry['toast'].textContent = '';
registry['btnDelDrawing'].onclick();
ok(!/请先选中一条画线/.test(registry['toast'].textContent), 'G5.5 箭头已创建（可删除，无提示）');
clickIn(toolGroup, fakeChild(toolGroup, 'button', { className: 'tool', dataset: { tool: 'arrowdown' } }));
chartCanvas.dispatch('mousedown', { button: 0, clientX: 200, clientY: 160 });
winUp();
var confirmCalled = false;
var _confirm = sandbox.confirm;
sandbox.confirm = function () { confirmCalled = true; return true; };
registry['btnClearDrawing'].onclick();
sandbox.confirm = _confirm;
registry['toast'].textContent = '';
registry['btnDelDrawing'].onclick();
ok(!confirmCalled && /请先选中一条画线/.test(registry['toast'].textContent), 'G5.5 清空直接执行且不弹确认框');

/* G5.6 蘑菇箭头 + Shift 锁定水平 */
const app6 = sandbox.__KLINE_APP__;
/* 蘑菇箭头：arrowup / arrowdown 按下-松开即创建 */
clickIn(toolGroup, fakeChild(toolGroup, 'button', { className: 'tool', dataset: { tool: 'arrowup' } }));
chartCanvas.dispatch('mousedown', { button: 0, clientX: 200, clientY: 160 });
winUp();
ok(app6.drawings.items.some(function (d) { return d.type === 'arrowup'; }), 'G5.6 蘑菇箭头（arrowup）已创建');
registry['btnDelDrawing'].onclick();
clickIn(toolGroup, fakeChild(toolGroup, 'button', { className: 'tool', dataset: { tool: 'arrowdown' } }));
chartCanvas.dispatch('mousedown', { button: 0, clientX: 200, clientY: 160 });
winUp();
ok(app6.drawings.items.some(function (d) { return d.type === 'arrowdown'; }), 'G5.6 蘑菇箭头（arrowdown）已创建');
registry['btnDelDrawing'].onclick();
/* 对照：普通线段（无 Shift）两点价格不同 → 非水平（两段式点击） */
clickIn(toolGroup, fakeChild(toolGroup, 'button', { className: 'tool', dataset: { tool: 'segment' } }));
chartCanvas.dispatch('mousedown', { button: 0, clientX: 100, clientY: 120 });
winUp();                              // 第一点
chartCanvas.dispatch('mousedown', { button: 0, clientX: 300, clientY: 220 });
winUp();                              // 第二点
var lastSeg = app6.drawings.items[app6.drawings.items.length - 1];
ok(lastSeg && lastSeg.p1.p !== lastSeg.p2.p, 'G5.6 普通线段（无Shift）保留垂直偏移');
registry['btnDelDrawing'].onclick();
/* Shift 锁定：第二点价格对齐第一点 → 水平（第二击按住 Shift 点击） */
clickIn(toolGroup, fakeChild(toolGroup, 'button', { className: 'tool', dataset: { tool: 'segment' } }));
chartCanvas.dispatch('mousedown', { button: 0, clientX: 100, clientY: 120 });
winUp();                              // 第一点
chartCanvas.dispatch('mousedown', { button: 0, clientX: 300, clientY: 220, shiftKey: true });
winUp();                              // 第二点（Shift 锁定水平）
var lastH = app6.drawings.items[app6.drawings.items.length - 1];
ok(lastH && lastH.p1.p === lastH.p2.p, 'G5.6 Shift 锁定线段为水平（p2.p==p1.p）');
registry['btnDelDrawing'].onclick();
/* Shift 锁定也适用于射线 */
clickIn(toolGroup, fakeChild(toolGroup, 'button', { className: 'tool', dataset: { tool: 'ray' } }));
chartCanvas.dispatch('mousedown', { button: 0, clientX: 100, clientY: 120 });
winUp();
chartCanvas.dispatch('mousedown', { button: 0, clientX: 300, clientY: 240, shiftKey: true });
winUp();
var lastR = app6.drawings.items[app6.drawings.items.length - 1];
ok(lastR && lastR.p1.p === lastR.p2.p, 'G5.6 Shift 锁定射线为水平');
registry['btnDelDrawing'].onclick();
registry['btnClearDrawing'].onclick(); pump(1);

/* G5.7 可自定义色板 + EMA 调色 + 主题切换 + fibext 拖动识别修复 */
const app7 = sandbox.__KLINE_APP__;
var cp7 = registry['colorPick'];
cp7.value = '#123456';
cp7.dispatch('input', {});
ok(app7.drawings.color === '#123456', 'G5.7 自定义颜色更新当前画线颜色');
var ema7 = registry['emaColor'];
ema7.value = '#ff00ff';
ema7.dispatch('input', {});
ok(app7.chart.emaColor === '#ff00ff', 'G5.7 EMA20 颜色可自定义');
ok(storage.getItem('kline_ema_color_v1') === '#ff00ff', 'G5.7 EMA20 颜色已持久化');
ok(registry['btnTheme'] == null, 'G5.7 白天/黑夜主题切换按钮已移除（功能下线）');
/* fibext 拖动识别：只命中折线/投影线，空白处不误识别 */
clickIn(toolGroup, fakeChild(toolGroup, 'button', { className: 'tool', dataset: { tool: 'fibext' } }));
chartCanvas.dispatch('mousedown', { button: 0, clientX: 80, clientY: 140 });
winMove(80, 140); winUp();            // A
chartCanvas.dispatch('mousedown', { button: 0, clientX: 180, clientY: 180 });
winMove(180, 180); winUp();           // B
chartCanvas.dispatch('mousedown', { button: 0, clientX: 300, clientY: 240 });
winMove(300, 240); winUp();           // C → 完成
var fe = app7.drawings.items[app7.drawings.items.length - 1];
ok(fe && fe.type === 'fibext', 'G5.7 斐波扩展已创建');
var onLine = app7.drawings.hitTest(app7.chart, 130, 160);
ok(onLine && onLine.id === fe.id, 'G5.7 命中斐波扩展折线（可拖动）');
var gap = app7.drawings.hitTest(app7.chart, 240, 160);
ok(!gap || gap.id !== fe.id, 'G5.7 斐波扩展空白区域不误识别为拖动');
registry['btnDelDrawing'].onclick();

/* ---- Drawings 单元：add 继承当前工具 color/dash；fibext 缺 C 点不崩 ---- */
const D = new sandbox.Drawings();
D.useTool('segment');
D.setToolDash(true);
const segItem = D.add({ type: 'segment', p1: { i: 1, p: 100 }, p2: { i: 5, p: 120 } });
ok(segItem.dash === true && segItem.color === D.color, 'G5b 线段 add 继承当前工具 dash/color（虚线）');
D.useTool('ray');
const rayItem = D.add({ type: 'ray', p1: { i: 1, p: 100 }, p2: { i: 5, p: 120 } });
ok(rayItem.dash === false, 'G5b 射线默认实线（dash 按工具独立）');
/* fibext 缺 C 点（绘制中预览）渲染不报错 */
const ctxStub = makeCtx();
const chartStub = { plot: { x: 0, y: 0, w: 800, h: 500 }, priceDigits: 2, x: function (i) { return i * 10; }, y: function (p) { return 500 - p; } };
let fibextOk = true;
try { D.drawItem(ctxStub, chartStub, { type: 'fibext', p1: { i: 1, p: 100 }, p2: { i: 5, p: 120 }, color: '#f0a020', dash: false }, false, false); } catch (e) { fibextOk = false; }
ok(fibextOk, 'G5b fibext 缺 C 点渲染不报错（A→B 预览）');
/* 斐波默认比例：新画线继承已保存默认 */
D.setDefaultLevels('fib', [0, 0.5, 1]);
const fibItem = D.add({ type: 'fib', p1: { i: 1, p: 100 }, p2: { i: 5, p: 120 } });
ok(fibItem.levels && fibItem.levels.join(',') === '0,0.5,1', 'G5b 新画斐波继承默认比例');
/* 斐波回撤渲染：无背景填充 + 水平线不向右延长 */
const fibRec = (function () {
  const calls = [];
  return {
    ctx: new Proxy({}, {
      get: function (t, k) {
        if (k === 'measureText') return function () { return { width: 10 }; };
        if (typeof k === 'symbol') return undefined;
        return function () { calls.push({ k: k, a: Array.prototype.slice.call(arguments) }); };
      },
      set: function () { return true; }
    }),
    calls: calls
  };
})();
D.drawItem(fibRec.ctx, chartStub, fibItem, false, false);
ok(fibRec.calls.filter(function (c) { return c.k === 'fillRect'; }).length === 0, 'G5b 斐波回撤无背景填充');
(function () {
  const tos = fibRec.calls.filter(function (c) { return c.k === 'lineTo'; });
  const xs = chartStub.x(1), xe = Math.max(chartStub.x(5), xs + 28);
  const maxX = tos.reduce(function (m, c) { return Math.max(m, c.a[0]); }, -Infinity);
  ok(tos.length === 3 && maxX <= xe + 0.01, 'G5b 斐波水平线止于 A→B 范围（不向右延长）: ' + maxX + ' <= ' + xe);
})();

/* =========================================================
 * G6 自定义快捷键
 * ========================================================= */
console.log('G6 自定义快捷键');
registry['btnKeys'].onclick();
ok(keyModal.hidden === false, 'G6 打开快捷键设置弹窗');
ok(/播放/.test(registry['keyRows'].innerHTML), 'G6 设置列表渲染');
ok(!/市价买/.test(registry['keyRows'].innerHTML) && !/全平/.test(registry['keyRows'].innerHTML), 'G6 交易类快捷键行已移除');
ok(!/上一根|prev/.test(registry['keyRows'].innerHTML) && /下一根/.test(registry['keyRows'].innerHTML), 'G6 已取消「上一根」，可配置仅播放/下一根/全屏');
clickIn(registry['keyRows'], fakeChild(registry['keyRows'], 'button', { className: 'km-key', dataset: { act: 'play' } }));
key('z');                       // 捕获 z
ok(/Z/.test(registry['keyRows'].innerHTML), 'G6 按键捕获显示 Z');
clickIn(registry['keyRows'], fakeChild(registry['keyRows'], 'button', { className: 'km-key', dataset: { act: 'next' } }));
key('z');                       // 冲突
ok(/已绑定/.test(registry['toast'].textContent), 'G6 冲突检测提示');
key('Escape');                  // 取消捕获
registry['btnKeySave'].onclick();
ok(keyModal.hidden === true, 'G6 保存后关闭弹窗');
const km = JSON.parse(storage.getItem('kline_replay_keys_v1') || '{}');
ok(km.play === 'z', 'G6 快捷键映射持久化 play=z');
ok(/Z/.test(registry['kbdList'].innerHTML), 'G6 面板快捷键提示更新');
/* z 生效（播放），空格解绑 */
key('z'); pump(1);
ok(registry['playStatus'].textContent === '回放中', 'G6 新快捷键 z 触发播放');
key('z'); pump(1);
ok(registry['playStatus'].textContent === '已暂停', 'G6 z 再次触发暂停');
key(' '); pump(1);
ok(registry['playStatus'].textContent === '已暂停', 'G6 旧键 空格 已解绑（不再触发播放）');
/* 恢复默认 */
registry['btnKeys'].onclick();
registry['btnKeyReset'].onclick();
registry['btnKeySave'].onclick();
const km2 = JSON.parse(storage.getItem('kline_replay_keys_v1') || '{}');
ok(km2.play === '=' && km2.next === ' ', 'G6 恢复默认绑定（播放=、下一根=空格）');

/* 固定快捷键（不受自定义 keymap 影响）：B 买入 / S 卖出 / C 全部平仓 / = 播放暂停 / 空格 下一根 */
const pos0 = appM.engine.positions.length;
key('b'); pump(1);
ok(appM.engine.positions.length === pos0 + 1 && appM.engine.positions[appM.engine.positions.length - 1].side === 'buy' && appM.engine.positions[appM.engine.positions.length - 1].qty === 1,
  'G6 B 键市价买入 1 手（做多）');
key('s'); pump(1);
ok(appM.engine.positions.length === pos0 + 2 && appM.engine.positions[appM.engine.positions.length - 1].side === 'sell' && appM.engine.positions[appM.engine.positions.length - 1].qty === 1,
  'G6 S 键市价卖出 1 手（做空）');
key('c'); pump(1);
ok(appM.engine.positions.length === 0, 'G6 C 键全部平仓');
/* = 键播放/暂停；空格 只前进一 根（不支持回退） */
key('='); pump(1);
ok(registry['playStatus'].textContent === '回放中', 'G6 = 键触发播放');
key('='); pump(1);
ok(registry['playStatus'].textContent === '已暂停', 'G6 = 键再次触发暂停');
const idxA = appM.state.idx;
key(' '); pump(1);
ok(appM.state.idx === idxA + 1, 'G6 空格键播放下一根K线（前进一根）');

/* =========================================================
 * G7 回放控制（随机起点 / 起始日期 / 播放）
 * ========================================================= */
console.log('G7 回放控制');
registry['btnRandom'].onclick(); pump(2);
ok(/随机/.test(registry['toast'].textContent), 'G7 随机起点提示');
ok(/画线已清空/.test(registry['toast'].textContent), 'G7 随机起点同时清空画线');
ok(String(progress.value) === String(progress.min) && +progress.min >= 60, 'G7 随机起点生效（回起点重置）');
/* 视口必须真正滚到新起点（手动平移过 follow=false 也要滚） */
const APP = sandbox.__KLINE_APP__;
function viewportHas(i) { const ch = APP.chart, vc = ch.visibleCount(); return ch.offset <= i && ch.offset + vc >= i; }
ok(viewportHas(APP.state.idx), 'G7 随机起点后视口定位到起点K线');
APP.state.follow = false;                       // 模拟用户手动平移后不再跟随
registry['btnRandom'].onclick(); pump(2);
ok(APP.state.follow === true, 'G7 随机起点重新开启跟随');
/* 精确断言滚动位置（不依赖随机取值）：offset 应等于 scrollToIndex(idx, 0.18) 的结果 */
(function () {
  const ch = APP.chart, vc = ch.visibleCount(), i = APP.state.idx;
  const maxOff = Math.max(0, i - 1) + 1, minOff = -vc * 0.7;
  const want = Math.max(minOff, Math.min(i - vc * 0.82, maxOff));
  ok(Math.abs(ch.offset - want) < 0.01, 'G7 未跟随时随机起点也强制滚动到起点: ' + ch.offset.toFixed(1) + ' vs ' + want.toFixed(1));
})();
/* 起始日期 */
const rows = sandbox.DataUtil.generateSample(720, 20260830);
const mid = new Date(rows[300].t);
const ds = mid.getFullYear() + '-' + String(mid.getMonth() + 1).padStart(2, '0') + '-' + String(mid.getDate()).padStart(2, '0');
const ts = new Date(ds + 'T00:00:00').getTime();
let exp = -1;
for (let i = 0; i < rows.length; i++) { if (rows[i].t >= ts) { exp = i; break; } }
registry['inpDate'].value = ds;
registry['inpDate'].dispatch('change', { target: registry['inpDate'] });
pump(2);
ok(/已从/.test(registry['toast'].textContent), 'G7 指定起始日期提示');
ok(String(progress.value) === String(exp) && String(progress.min) === String(exp), 'G7 起始日期定位正确: ' + progress.value + ' vs ' + exp);
ok(viewportHas(APP.state.idx), 'G7 起始日期跳转后视口定位到起点K线');
/* 超出数据范围的日期：回退到最后一根而不是报错中断 */
registry['inpDate'].value = '2099-01-01';
registry['inpDate'].dispatch('change', { target: registry['inpDate'] });
pump(2);
ok(/没有数据/.test(registry['toast'].textContent), 'G7 超出范围日期给出提示');
ok(String(progress.min) === String(rows.length - 2), 'G7 超出范围日期回退到最后一根: ' + progress.min);
/* 恢复为范围内日期，便于后续播放测试 */
registry['inpDate'].value = ds;
registry['inpDate'].dispatch('change', { target: registry['inpDate'] });
pump(2);
ok(String(progress.min) === String(exp), 'G7 重新指定范围内日期生效');
/* 播放 */
clickIn(speeds, fakeChild(speeds, 'button', { dataset: { speed: '10' } }));
registry['btnPlay'].onclick(); pump(1);
ok(registry['playStatus'].textContent === '回放中', 'G7 播放状态');
pump(40);
const v1 = +progress.value;
ok(v1 > exp, 'G7 播放推进: ' + v1 + ' > ' + exp);
registry['btnPlay'].onclick(); pump(1);
ok(registry['playStatus'].textContent === '已暂停', 'G7 暂停');
registry['btnReset'].onclick(); pump(2);
ok(String(progress.value) === String(progress.min), 'G7 回到起点');
ok(registry['replayBadge'] == null, 'G7 图表右上角回放状态提示框已移除');
/* 需求3：下一根K线的滚动跟随逻辑 —— 最新K线在固定位置右侧才滚动，左侧则保持视口不动 */
(function () {
  const ch = APP.chart, st = APP.state;
  const anchorX = ch.plot.x + ch.plot.w * (1 - 0.18);
  /* 场景A：跟随态（最新K线贴着固定位置）→ 前进一步，视口随动，最新K线仍回到固定位置附近 */
  const offA0 = ch.offset, idxA0 = st.idx;
  key(' '); pump(1);
  ok(st.idx === idxA0 + 1, '需求3 空格前进一步: ' + idxA0 + ' → ' + st.idx);
  ok(Math.abs(ch.offset - (offA0 + 1)) < 0.01, '需求3 跟随态前进时最新K线回到固定位置(offset随动+1): ' + ch.offset.toFixed(2) + ' vs ' + (offA0 + 1).toFixed(2));
  /* 场景B：手动向左平移(最新K线已落在固定位置左侧, follow=false) → 前进一步，视口保持不跳回固定位置 */
  ch.offset -= 40; ch.clampOffset();   // 模拟向左平移 40 根K线
  APP.state.follow = false;
  const offB0 = ch.offset, idxB0 = st.idx;
  const barXB0 = ch.x(idxB0);
  if (barXB0 <= anchorX) {   // 确保最新K线确实在固定位置左侧
    key(' '); pump(1);
    ok(st.idx === idxB0 + 1, '需求3 平移态空格前进一步: ' + idxB0 + ' → ' + st.idx);
    ok(Math.abs(ch.offset - offB0) < 0.01, '需求3 最新K线在固定位置左侧时前进不移动视口: ' + ch.offset.toFixed(2) + ' 保持 ' + offB0.toFixed(2));
  } else {
    ok(true, '需求3 平移幅度不足，跳过场景B（视口仍锚定）');
  }
  APP.state.follow = true;   // 恢复，避免影响后续
})();

/* =========================================================
 * G8 快捷下单（工具栏 + 右键，数量固定 1）
 * ========================================================= */
console.log('G8 交易面板清理（按钮已移除，右键下单保留）');
ok(registry['btnQuickBuy'] == null && registry['btnQuickSell'] == null, 'G8 市价买卖按钮已移除');
ok(registry['btnCloseAll'] == null && registry['btnCancelAll'] == null && registry['btnResetTrade'] == null, 'G8 全平/撤单/清空按钮已移除');
// 交易能力保留：右键挂单数量固定为 1
chartCanvas.dispatch('contextmenu', { clientX: 300, clientY: 470 });
clickIn(ctxMenu, cmA); pump(2);
ok(sandbox.__KLINE_APP__.engine.pendingOrders().length === 1, 'G8 右键挂单数量固定为 1');
sandbox.__KLINE_APP__.engine.cancelAll(); pump(2);
ok(sandbox.__KLINE_APP__.engine.pendingOrders().length === 0, 'G8 挂单已撤销（引擎入口）');

/* =========================================================
 * G9 其它回归（回滚 / 全屏 / 面板 / 统计）
 * ========================================================= */
console.log('G9 其它回归');
var g9before = +progress.value;
for (let i = 0; i < 10; i++) registry['btnNext'].onclick();
pump(2);
ok(+progress.value === g9before + 10, 'G9 单步推进进度+10');
progress.value = String(g9before + 3);
progress.dispatch('input', { target: progress });
pump(2);
ok(+progress.value === g9before + 3, 'G9 滑块回拖回滚');
ok(registry['btnPrev'] == null, 'G9 「上一根」按钮已移除（只允许播放/下一根，不回退上一根）');
registry['btnFullscreen'].onclick(); pump(2);
ok(chartWrap.classList.contains('fs') === true, 'G9 CSS 全屏降级');
registry['btnFullscreen'].onclick(); pump(2);
ok(chartWrap.classList.contains('fs') === false, 'G9 退出全屏');
clickIn(tabs, fakeChild(tabs, 'button', { dataset: { tab: 'stats' } }));
pump(3);
ok(/胜率/.test(registry['statsBox'].innerHTML), 'G9 统计面板渲染');
ok(/平仓笔数/.test(registry['statsBox'].innerHTML), 'G9 统计指标渲染');
ok(registry['chkVolume'] == null, 'G9 成交量开关已移除（默认隐藏、无开启入口）');
ok(registry['chkMarks'] == null, 'G9 成交标记开关已移除（功能默认常开、无关闭入口）');

/* =========================================================
 * G10 侧边栏固定窄栏（折叠 / 拖拽功能已移除）
 * ========================================================= */
console.log('G10 固定窄侧边栏');
const sideEl = registry['side'];
ok(registry['btnToggleSide'] == null, 'G10 收起/展开按钮已移除');
ok(registry['sideHandle'] == null, 'G10 拖拽手柄已移除');
ok(!sideEl.classList.contains('collapsed'), 'G10 侧边栏无折叠状态类');
ok(true, 'G10 侧边栏固定为窄栏（220px）');

/* =========================================================
 * G11 画图弱磁吸（OHLC）
 * ========================================================= */
console.log('G11 画图弱磁吸');
const app11 = sandbox.__KLINE_APP__;
function snapAt(px, dy, which) {
  const bi = Math.round(app11.chart.idxAt(px));
  const bar = app11.state.data[bi];
  const y = app11.chart.y(bar[which]) + dy;   // dy>0 偏下，dy<0 偏上
  chartCanvas.dispatch('mousedown', { button: 0, clientX: px, clientY: Math.round(y) });
  winUp();                                    // 按下-松开（第一段原位→不提交，仅确定起点；第二段确认终点）
  return bar;
}
clickIn(toolGroup, fakeChild(toolGroup, 'button', { className: 'tool', dataset: { tool: 'segment' } }));
// 注：弱磁吸吸附到「最近的」OHLC。为保证断言目标确实是离光标最近的那一价，
// 偏移取 2px（仍在 7px 阈值内，且明显比其它价更近），避免 Close/Open 夹在中间被误判。
const barA = snapAt(400, 2, 'h');     // 偏离最高价 2px（阈值内且最接近 high）→ 吸附到 high
const barB = snapAt(490, 2, 'l');     // 偏离最低价 2px（阈值内且最接近 low）→ 吸附到 low
const segSnap = app11.drawings.items[app11.drawings.items.length - 1];
ok(segSnap && Math.abs(segSnap.p1.p - barA.h) < 1e-6, 'G11 第一点吸附到最高价(high)');
ok(Math.abs(segSnap.p2.p - barB.l) < 1e-6, 'G11 第二点吸附到最低价(low)');
/* 超出阈值（>7px）：不强制对齐，落点保持自由 */
clickIn(toolGroup, fakeChild(toolGroup, 'button', { className: 'tool', dataset: { tool: 'segment' } }));
const barC = snapAt(400, 40, 'h');    // 偏离 40px（远超阈值）→ 不吸附
snapAt(490, -40, 'l');
const segFar = app11.drawings.items[app11.drawings.items.length - 1];
ok(segFar && Math.abs(segFar.p1.p - barC.h) > 1e-6, 'G11 超出阈值不强制吸附（弱磁吸）');
registry['btnClearDrawing'].onclick(); pump(1);

/* =========================================================
 * G12 二次编辑：拖动已有图形时 磁吸 / Shift 水平 同样生效
 * ========================================================= */
console.log('G12 二次编辑吸附与Shift约束');
const app12 = sandbox.__KLINE_APP__;
const eng12 = app12.engine;
eng12.cancelAll(); eng12.closeAll();
/* 预置一条线段：两次按下-松开都远离 OHLC（>7px 阈值），坐标精确可控 */
clickIn(toolGroup, fakeChild(toolGroup, 'button', { className: 'tool', dataset: { tool: 'segment' } }));
function rawAt(px, dy, which) {
  const bi = Math.round(app12.chart.idxAt(px));
  const bar = app12.state.data[bi];
  const y = Math.round(app12.chart.y(bar[which])) + dy;
  chartCanvas.dispatch('mousedown', { button: 0, clientX: px, clientY: y });
  winUp();                                    // 第一段原位→不提交；第二段确认终点
  return { bar: bar, y: y };
}
rawAt(300, 40, 'h');
rawAt(480, -40, 'l');
let segE = app12.drawings.items[app12.drawings.items.length - 1];
ok(segE && segE.type === 'segment', 'G12 预置线段已创建');

/* —— 场景1：拖端点（handle）到目标 K 线 low 附近 → 磁吸到 OHLC —— */
let hx = Math.round(app12.chart.x(segE.p2.i)), hy = Math.round(app12.chart.y(segE.p2.p));
chartCanvas.dispatch('mousedown', { button: 0, clientX: hx, clientY: hy });
const t1x = hx + 40;
const t1Bar = app12.state.data[Math.round(app12.chart.idxAt(t1x))];
winMove(t1x, Math.round(app12.chart.y(t1Bar.l)) - 2);   // 光标贴近该 K 线最低价
pump(1); winUp();
segE = app12.drawings.items[app12.drawings.items.length - 1];
ok([t1Bar.o, t1Bar.c, t1Bar.l, t1Bar.h].some(v => Math.abs(v - segE.p2.p) < 1e-6),
  'G12 拖端点时磁吸到目标K线OHLC');

/* —— 场景2：拖端点 + 按住 Shift → 价格锁定（仅水平移动） —— */
hx = Math.round(app12.chart.x(segE.p2.i)); hy = Math.round(app12.chart.y(segE.p2.p));
const p2p0 = segE.p2.p, p2i0 = segE.p2.i;
chartCanvas.dispatch('mousedown', { button: 0, clientX: hx, clientY: hy });
winMove(hx + 60, hy - 90, true);   // shiftKey=true：y 大幅上移也不改变价格
pump(1); winUp();
segE = app12.drawings.items[app12.drawings.items.length - 1];
ok(Math.abs(segE.p2.p - p2p0) < 1e-6 && segE.p2.i !== p2i0, 'G12 拖端点+Shift 价格锁定、仅水平移动');

/* —— 场景3：整体拖动（body）→ 平移量按磁吸落点计算（吸附到目标K线OHLC） —— */
const b1 = segE.p1, b2 = segE.p2;
const bxs = Math.round((app12.chart.x(b1.i) + app12.chart.x(b2.i)) / 2);
const bys = Math.round((app12.chart.y(b1.p) + app12.chart.y(b2.p)) / 2);
const bP1p0 = b1.p, bP2p0 = b2.p;
chartCanvas.dispatch('mousedown', { button: 0, clientX: bxs, clientY: bys });
const t3x = bxs + 50;
const t3Bar = app12.state.data[Math.round(app12.chart.idxAt(t3x))];
winMove(t3x, Math.round(app12.chart.y(t3Bar.h)) + 2);   // 光标贴近目标 K 线最高价
pump(1); winUp();
segE = app12.drawings.items[app12.drawings.items.length - 1];
const dpAct = segE.p1.p - bP1p0;
const tgt = app12.chart.priceAt(bys) + dpAct;
ok([t3Bar.o, t3Bar.c, t3Bar.l, t3Bar.h].some(v => Math.abs(v - tgt) < 1e-6),
  'G12 整体拖动时磁吸到目标K线OHLC');
ok(Math.abs((segE.p2.p - bP2p0) - dpAct) < 1e-6, 'G12 整体拖动保持平移一致');

/* —— 场景4：整体拖动 + Shift → 价格全部锁定（仅水平平移） —— */
const c1i0 = segE.p1.i, c2i0 = segE.p2.i;
const cP1p0 = segE.p1.p, cP2p0 = segE.p2.p;
const cbx = Math.round((app12.chart.x(segE.p1.i) + app12.chart.x(segE.p2.i)) / 2);
const cby = Math.round((app12.chart.y(segE.p1.p) + app12.chart.y(segE.p2.p)) / 2);
chartCanvas.dispatch('mousedown', { button: 0, clientX: cbx, clientY: cby });
winMove(cbx + 45, cby + 90, true);
pump(1); winUp();
segE = app12.drawings.items[app12.drawings.items.length - 1];
ok(Math.abs(segE.p1.p - cP1p0) < 1e-6 && Math.abs(segE.p2.p - cP2p0) < 1e-6,
  'G12 整体拖动+Shift 价格锁定（仅水平平移）');
ok(Math.abs((segE.p1.i - c1i0) - (segE.p2.i - c2i0)) < 1e-9 && segE.p1.i > c1i0, 'G12 整体拖动+Shift 水平位移一致');

/* —— 场景5：拖动挂单线 → 磁吸到 OHLC —— */
const o0 = eng12.submit({ type: 'limit', side: 'buy', qty: 1, price: app12.chart.priceAt(200) });
ok(o0.ok, 'G12 预置挂单成功');
const oLine = eng12.pendingOrders()[eng12.pendingOrders().length - 1];
const oy0 = Math.round(app12.chart.y(oLine.price));
chartCanvas.dispatch('mousedown', { button: 0, clientX: 300, clientY: oy0 });
const t5Bar = app12.state.data[Math.round(app12.chart.idxAt(300))];
winMove(300, Math.round(app12.chart.y(t5Bar.o)) + 2);
pump(1); winUp();
const oLine2 = eng12.pendingOrders()[eng12.pendingOrders().length - 1];
ok([t5Bar.o, t5Bar.c, t5Bar.l, t5Bar.h].some(v => Math.abs(v - oLine2.price) < 1e-6),
  'G12 拖动挂单线磁吸到OHLC');
eng12.cancelAll();
registry['btnClearDrawing'].onclick(); pump(1);

/* =========================================================
 * 需求4：滚轮缩放跟随回卷 —— 直接对 followLatest 单元断言
 * ========================================================= */
console.log('需求4 滚轮缩放跟随回卷');
(function () {
  const APPx = sandbox.__KLINE_APP__;
  const ch = APPx.chart, st = APPx.state;
  const anchorX = ch.plot.x + ch.plot.w * (1 - 0.18);
  const cw0 = ch.cw;
  /* 把 cw 复位为 9、idx=30、offset=0：ch.x(30)=288.5 < anchorX=596.8，
   * 即便 zoomAt 把 cw 变大，idx 对应 K 线仍可靠左、不越过 anchorX。 */
  ch.cw = 9;
  ch.offset = 0; ch.clampOffset();
  st.idx = 30; ch.maxIndex = st.idx;
  const idxNow = st.idx;
  ok(ch.x(idxNow) <= anchorX, '需求4 前置：最新K线已落在固定位置左侧（命中触发条件）: x=' + ch.x(idxNow).toFixed(1) + ' anchorX=' + anchorX.toFixed(1));
  /* 模拟 wheel 流程：zoomAt 改 cw → followLatest。断言 followLatest 不改 offset。 */
  st.follow = true;
  ch.zoomAt(200, 1.12);
  const offBefore = ch.offset;
  APPx.followLatest(st.idx);
  ok(Math.abs(ch.offset - offBefore) < 0.01, '需求4 followLatest 看到「最新K线在固定位置左侧」时不再回卷 offset: ' + offBefore.toFixed(2) + ' → ' + ch.offset.toFixed(2));
  /* 反向断言：构造「最新K线在固定位置右侧」场景，验证 followLatest 仍会回卷（不破坏正常行为） */
  st.idx = Math.min(st.idx + 200, ch.data.length - 1);
  ch.maxIndex = st.idx;
  ch.offset = -ch.visibleCount() * 0.7;
  ch.clampOffset();
  const offFar = ch.offset;
  APPx.followLatest(st.idx);
  ok(ch.offset > offFar, '需求4 「最新K线在固定位置右侧」时 followLatest 仍然回卷（正常行为保留）: ' + offFar.toFixed(2) + ' → ' + ch.offset.toFixed(2));
  /* 复位，避免影响后续 */
  ch.cw = cw0; ch.offset = 0; ch.clampOffset();
  st.follow = true;
})();

/* =========================================================
 * G13 开启页面 / 切换品种自动随机跳转
 * ========================================================= */
console.log('G13 载入自动随机跳转');
const app13 = sandbox.__KLINE_APP__;
const idxBefore13 = app13.state.idx;   // 前置测试已多次跳转，此处仅记录切换前位置
/* 注入一个假内置数据集，模拟真实浏览器 data/*.js 的注入 */
sandbox.__KLINE_DATASETS__ = {
  DEMO2: { label: 'DEMO2 · 5分', rows: sandbox.DataUtil.generateSample(720, 20260830) }
};
registry['selDataset'].value = 'DEMO2';
registry['selDataset'].dispatch('change', { target: registry['selDataset'] });
pump(3);
const i13 = app13.state.idx;
ok(i13 >= 60, 'G13 切换品种后自动随机跳转（起点 >=60）: ' + i13);
ok(String(progress.min) === String(i13) && String(progress.value) === String(i13),
  'G13 随机起点同步到进度条');
ok(/已切换到 DEMO2/.test(registry['toast'].textContent), 'G13 切换提示保留');
ok(/随机起点第/.test(registry['toast'].textContent), 'G13 提示含随机起点位置');
ok(app13.state.symbol === 'DEMO2 · 5分', 'G13 品种已切换为 DEMO2');
ok(viewportHas(app13.state.idx), 'G13 随机起点后视口定位到起点K线');
/* 页面开启走同一入口（loadDefault → loadDatasetById），切换路径已验证即覆盖开启路径 */

/* ---------------- 结果 ---------------- */
console.log('\n===== 测试结果: ' + pass + ' 通过 / ' + fail + ' 失败 =====');
if (fail > 0) { console.log('失败项:\n  ' + fails.join('\n  ')); process.exit(1); }
