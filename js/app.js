/* =========================================================
 * app.js —— 主程序：回放控制、图表交互、面板渲染
 *  · 回放栏在图表上方：随机起点 / 起始日期
 *  · 右键菜单两项随价格位置动态变化
 *  · 画线：单击定起点、再单击结束（斐波扩展三点）
 *  · 历史成交记录持久化 + 详情弹窗（K线波段 + 备注）
 *  · 快捷键可自定义并持久化
 * ========================================================= */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var FONT = '-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif';

  var state = {
    data: [], rawData: [], symbol: 'default',
    idx: 0, startIdx: 60,
    playing: false, speed: 1, baseInterval: 300,   // baseInterval = 播放间隔(ms)
    periodMul: 1,                                  // 周期聚合倍数（合并几根基础K线）
    baseKInterval: 3600000,                        // 基础K线周期(ms)
    follow: true,                                  // 播放时隐式跟随（手动平移后暂停跟随）
    tool: 'select',
    side: 'buy', orderType: 'market',
    snapEvery: 1,
    snapCursor: true                            // 光标横向吸附到K线中央（默认开启）
  };

  var chart, engine, drawings, host, canvas;
  var snapshots = {};
  var needsRender = true, uiDirty = true, structureDirty = true, historyDirty = true;
  var drag = null, lastT = 0, acc = 0, toastTimer = null;
  var hoverOverlay = null;   // 悬停中的挂单/持仓线（用于开仓线提示文案）
  var ctxPrice = null;       // 右键菜单对应的价格
  var pending = null;        // 画线待确认状态 {type, pts:[{i,p}], cur:{i,p}}
  var drawArm = null;        // 当前按下的画线手势 {need, isText, prev, downAt} —— 点击提交 / 移出取消
  var lastMouse = null;      // 最近一次光标位置（供 mouseup 取落点，兼容不带坐标的场景）
  var CLICK_TOL = 6;         // 像素阈值：按下→松开位移小于此值视为一次「点击」（提交一个锚点），否则视为按住拖动（不提交）
  var shiftHeld = false;     // Shift 键是否按住：线段/趋势线/射线锁定水平

  // 受 Shift 水平锁定的画线类型
  function isHorizType(t) { return t === 'segment' || t === 'trend' || t === 'ray'; }
  var fibEditing = null;     // 正在编辑比例的斐波画线对象

  /* ================= 工具 ================= */
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function d() { return chart ? chart.priceDigits : 2; }
  function fmt(n) { return (n == null || !isFinite(n)) ? '--' : Number(n).toFixed(d()); }
  function sgn(n) { return (n >= 0 ? '+' : '') + Number(n).toFixed(d()); }
  function pnlCls(n) { return n >= 0 ? 'pnl-up' : 'pnl-down'; }
  function fmtTime(t) {
    if (!t) return '--';
    var x = new Date(t), p = function (n) { return n < 10 ? '0' + n : '' + n; };
    return (x.getMonth() + 1) + '-' + p(x.getDate()) + ' ' + p(x.getHours()) + ':' + p(x.getMinutes());
  }
  function fmtFull(t) {
    if (!t) return '--';
    var x = new Date(t), p = function (n) { return n < 10 ? '0' + n : '' + n; };
    return x.getFullYear() + '-' + p(x.getMonth() + 1) + '-' + p(x.getDate()) + ' ' + p(x.getHours()) + ':' + p(x.getMinutes());
  }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function requestRender() { needsRender = true; }
  function markStructure() {
    structureDirty = true; uiDirty = true;
    histSync();
  }
  function toast(msg, type) {
    var el = $('toast');
    el.textContent = msg;
    el.className = 'toast on' + (type ? ' ' + type : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.className = 'toast'; }, 2200);
  }

  /* ================= 初始化 ================= */
  function init() {
    canvas = $('chart');
    host = $('canvasHost');
    chart = new KLineChart(canvas);
    drawings = new Drawings();
    engine = new TradingEngine({ onChange: function () { markStructure(); } });

    chart.drawingsRender = function (ctx, c) {
      drawings.render(ctx, c);
      var pv = previewItem();
      if (pv) drawings.drawItem(ctx, c, pv, false, true);
    };
    chart.overlaysRender = drawOverlays;

    chart.resize();
    keysLoad();
    bindTopbar();
    bindToolbar();
    bindReplay();
    bindPanels();
    bindChart();
    bindContextMenu();
    bindTradeModal();
    bindFibModal();
    bindKeyModal();
    bindKeys();
    renderKbdList();

    // 同步已保存的画线工具配置到 UI（颜色 / 线型）
    setTool('select');

    window.addEventListener('resize', function () { chart.resize(); requestRender(); drawEquity(); });
    document.addEventListener('fullscreenchange', afterLayoutChange);
    document.addEventListener('webkitfullscreenchange', afterLayoutChange);

    /* 调试 / 自动化测试用的只读句柄（不影响正常功能） */
    window.__KLINE_APP__ = {
      get state() { return state; },
      get chart() { return chart; },
      get drawings() { return drawings; },
      get engine() { return engine; },
      get pending() { return pending; },
      get replayTrade() { return replayTrade; },
      followLatest: function (i) { return followLatest(i); }
    };

    loadSample();
    requestAnimationFrame(frame);
  }

  /* ================= 数据载入 ================= */
  /* 将内置数据集的 [t,o,h,l,c,v] 数组统一转换为对象行 */
  function normalizeRows(rows) {
    if (!rows || !rows.length) return rows;
    if (Array.isArray(rows[0])) {
      var out = new Array(rows.length);
      for (var i = 0; i < rows.length; i++) {
        var r = rows[i];
        out[i] = { t: r[0], o: r[1], h: r[2], l: r[3], c: r[4], v: r[5], i: i };
      }
      return out;
    }
    return rows;
  }
  /* 原始数据载入（会重置周期为 1） */
  function loadData(rows, label) {
    rows = normalizeRows(rows);
    if (!rows || rows.length < 2) { toast('数据不足，至少需要 2 根K线', 'err'); return; }
    state.rawData = rows;
    state.symbol = label || 'default';
    state.periodMul = 1;
    state.baseKInterval = medianInterval(rows);
    state.startIdx = clamp(60, 0, Math.max(0, rows.length - 2));
    pending = null; drawArm = null;
    buildPeriodOptions();
    applyAggregate();
    histLoad();
    replayTrade = null;              // 换数据集时清空复盘标记
  }

  /* 按当前周期倍数聚合，并重置回放 / 交易 / 视图；toLatest=true 时直接跳到最新K线 */
  function applyAggregate(toLatest) {
    var rows = DataUtil.aggregate(state.rawData, state.periodMul);
    if (rows.length < 2) {
      toast('聚合后不足 2 根K线，请减小合并根数', 'err');
      return false;
    }
    state.data = rows;
    state.snapEvery = rows.length > 20000 ? 10 : 1;
    chart.setData(rows);
    chart.resetPriceZoom();
    chart.resize();

    state.startIdx = toLatest
      ? Math.max(0, rows.length - 1)
      : clamp(state.startIdx, 0, Math.max(0, rows.length - 2));
    state.idx = state.startIdx;

    var f = engine.feePerLot;
    engine.reset();
    engine.feePerLot = f;
    snapshots = {};
    engine.setBar(rows[state.idx], state.idx);
    snapshots[state.idx] = engine.snapshot();

    var pg = $('progress');
    pg.min = state.startIdx;
    pg.max = Math.max(state.startIdx, rows.length - 1);
    pg.value = state.idx;

    chart.fitRange(140);
    if (state.follow || toLatest) chart.scrollToIndex(state.idx, 0.18);

    updateDataInfo();
    pause();
    markStructure(); requestRender();
    return true;
  }

  /* 切换周期：起点等比换算，画线索引同步换算，原始数据保留可切回 */
  function switchPeriod(mul) {
    if (!state.rawData.length) return;
    mul = clamp(Math.round(mul) || 1, 1, 100000);
    if (mul === state.periodMul) return;

    var busy = engine.positions.length || engine.pendingOrders().length || engine.trades.length;
    if (busy && !confirm('切换周期会重置回放与交易状态（原始数据保留，可随时切回原周期）。是否继续？')) {
      syncPeriodInputs();
      return;
    }

    var ratio = mul / state.periodMul;      // 新/旧 倍数比
    var oldStart = state.startIdx;
    state.startIdx = Math.max(0, Math.round(state.startIdx / ratio));
    var prevMul = state.periodMul;
    state.periodMul = mul;
    remapDrawings(ratio);
    if (!applyAggregate(true)) {             // 聚合后根数不足则回滚
      state.periodMul = prevMul;
      state.startIdx = oldStart;
      remapDrawings(1 / ratio);
      applyAggregate();
      syncPeriodInputs();
      return;
    }
    syncPeriodInputs();
    toast('已切换为 ' + DataUtil.periodText(chart.interval) + ' · 已跳至最新K线', 'ok');
  }

  /* 画线锚点是K线索引，聚合后需等比例换算，避免位置错乱 */
  function remapDrawings(ratio) {
    if (!ratio || ratio === 1) return;
    drawings.items.forEach(function (it) {
      if (it.p1) it.p1.i = it.p1.i / ratio;
      if (it.p2) it.p2.i = it.p2.i / ratio;
      if (it.p3) it.p3.i = it.p3.i / ratio;
    });
  }

  /* 周期下拉：初始周期 + 5分 / 1时 / 1天 / 1周（按基础周期换算，不足40根不显示） */
  function buildPeriodOptions() {
    var sel = $('selPeriod');
    var base = state.baseKInterval;
    var targets = [300000, 3600000, 86400000, 604800000];
    var opts = [{ mul: 1, label: '初始 · ' + DataUtil.periodText(base) }];
    for (var i = 0; i < targets.length; i++) {
      var m = targets[i] / base;
      if (m <= 1 || Math.abs(m - Math.round(m)) > 1e-9) continue;   // 非整数倍或更小 → 不支持
      if (state.rawData.length / m < 30) continue;   // 聚合后至少保留 30 根
      var label = DataUtil.periodText(base * m);
      if (opts.some(function (o) { return o.label === label; })) continue;
      opts.push({ mul: Math.round(m), label: label });
    }
    var html = '';
    for (var j = 0; j < opts.length; j++) {
      html += '<option value="' + opts[j].mul + '">' + opts[j].label + '</option>';
    }
    sel.innerHTML = html;
    syncPeriodInputs();
  }

  function syncPeriodInputs() {
    $('selPeriod').value = String(state.periodMul);
  }

  function updateDataInfo() {
    var per = DataUtil.periodText(chart.interval);
    var txt = state.symbol + ' · ' + state.data.length + '根 · ' + per;
    if (state.periodMul > 1) txt += '（' + state.periodMul + '合1，原始 ' + state.rawData.length + '根）';
    $('dataInfo').textContent = txt;
    // 日期跳转范围限定在数据集内，避免选到无数据的日期
    var di = $('inpDate');
    if (state.data.length) {
      var d0 = new Date(state.data[0].t), d1 = new Date(state.data[state.data.length - 1].t);
      var pz = function (n) { return n < 10 ? '0' + n : '' + n; };
      var fmtD = function (x) { return x.getFullYear() + '-' + pz(x.getMonth() + 1) + '-' + pz(x.getDate()); };
      di.min = fmtD(d0); di.max = fmtD(d1);
    }
  }

  function medianInterval(rows) {
    var gaps = [];
    for (var i = 1; i < Math.min(80, rows.length); i++) {
      var g = rows[i].t - rows[i - 1].t;
      if (g > 0) gaps.push(g);
    }
    gaps.sort(function (a, b) { return a - b; });
    return gaps.length ? gaps[Math.floor(gaps.length / 2)] : 3600000;
  }

  /* 内置数据集注册表（data/*.js 通过 window.__KLINE_DATASETS__ 注入） */
  function loadDatasets() {
    var ds = window.__KLINE_DATASETS__ || {};
    if (!ds.BTCUSDT && window.__KLINE_DEFAULT__) {
      ds.BTCUSDT = { label: 'BTCUSDT · 5分', rows: window.__KLINE_DEFAULT__ };
    }
    return ds;
  }
  /* 填充顶栏数据集下拉，默认 BTCUSDT */
  function buildDatasetOptions() {
    var ds = loadDatasets();
    var ids = Object.keys(ds);
    var sel = $('selDataset');
    if (!sel) return;
    sel.innerHTML = '';
    for (var i = 0; i < ids.length; i++) {
      var o = document.createElement('option');
      o.value = ids[i];
      o.textContent = ds[ids[i]].label || ids[i];
      sel.appendChild(o);
    }
    if (ids.indexOf('BTCUSDT') >= 0) sel.value = 'BTCUSDT';
    else if (ids.length) sel.value = ids[0];
  }
  function loadDatasetById(id) {
    var ds = loadDatasets();
    var d = ds[id];
    if (!d || !d.rows || d.rows.length < 2) { toast('该数据集不可用', 'err'); return; }
    loadData(d.rows, d.label || id);
    /* 开启页面 / 切换品种：载入后自动进行一次随机跳转（随机起点） */
    randomStart();
    toast('已切换到 ' + (d.label || id) + ' · 随机起点第 ' + (state.idx + 1) + ' 根K线', 'ok');
  }
  /* 内置默认数据集（BTCUSDT 5分钟 2020-2026）。优先使用，无需手动导入 */
  function loadDefault() {
    var ds = loadDatasets();
    var ids = Object.keys(ds);
    if (!ids.length) return false;
    var id = ds.BTCUSDT ? 'BTCUSDT' : ids[0];
    loadDatasetById(id);
    return true;
  }
  /* forceSample=true 时忽略内置默认数据，强制载入合成示例 */
  function loadSample(forceSample) {
    if (!forceSample && loadDefault()) return;
    var rows = DataUtil.generateSample(720, 20260830);
    loadData(rows, '示例数据 DEMO');
  }

  function readFile(file) {
    var fr = new FileReader();
    fr.onload = function () {
      var rows = DataUtil.parseCSV(fr.result);
      if (!rows.length) { toast('未能解析出K线数据，请检查文件格式', 'err'); return; }
      loadData(rows, file.name.replace(/\.[^.]+$/, ''));
      toast('已导入 ' + rows.length + ' 根K线', 'ok');
    };
    fr.readAsText(file, 'utf-8');
  }

  function bindTopbar() {
    buildDatasetOptions();
    $('btnSample').onclick = function () { loadSample(true); toast('已载入示例数据', 'ok'); };
    $('selPeriod').onchange = function (e) { switchPeriod(parseInt(e.target.value, 10) || 1); };
    var dsSel = $('selDataset');
    if (dsSel) dsSel.onchange = function (e) {
      if (e.target.value) loadDatasetById(e.target.value);
    };
    $('fileInput').onchange = function (e) {
      if (e.target.files && e.target.files[0]) readFile(e.target.files[0]);
      e.target.value = '';
    };
    $('btnTemplate').onclick = function () {
      var rows = DataUtil.generateSample(20, 777);
      DataUtil.download('kline_template.csv', DataUtil.toCSV(rows));
      toast('模板已下载', 'ok');
    };
    $('btnHelp').onclick = function () { $('helpCard').hidden = !$('helpCard').hidden; };
    $('btnHelpClose').onclick = function () { $('helpCard').hidden = true; };

    // 拖拽导入
    ['dragenter', 'dragover'].forEach(function (ev) {
      host.addEventListener(ev, function (e) { e.preventDefault(); $('dropHint').classList.add('on'); });
    });
    ['dragleave', 'dragend'].forEach(function (ev) {
      host.addEventListener(ev, function (e) {
        if (ev === 'dragleave' && host.contains(e.relatedTarget)) return;
        $('dropHint').classList.remove('on');
      });
    });
    host.addEventListener('drop', function (e) {
      e.preventDefault();
      $('dropHint').classList.remove('on');
      if (e.dataTransfer.files && e.dataTransfer.files[0]) readFile(e.dataTransfer.files[0]);
    });
  }

  /* ================= 画线工具栏 ================= */
  function setTool(t) {
    if (state.tool !== t) { pending = null; drawArm = null; }
    state.tool = t;
    var btns = $('toolGroup').querySelectorAll('.tool');
    for (var i = 0; i < btns.length; i++) btns[i].classList.toggle('active', btns[i].dataset.tool === t);
    canvas.style.cursor = t === 'select' ? 'default' : 'crosshair';
    if (t !== 'select') { drawings.useTool(t); }
    syncToolUI();
    requestRender();
  }
  function syncToolUI() {
    var cp = $('colorPick');
    if (cp) cp.value = /^[0-9a-fA-F]{6}$/.test(drawings.color) ? drawings.color : (drawings.color || '#f0a020');
    $('btnDash').textContent = drawings.dash ? '虚线' : '实线';
    $('btnDash').classList.toggle('active', drawings.dash);
  }
  function bindToolbar() {
    $('toolGroup').addEventListener('click', function (e) {
      var b = e.target.closest('.tool');
      if (!b || !b.dataset.tool) return;
      setTool(b.dataset.tool);
    });
    // 自定义颜色（色板）：任意颜色均可，按当前工具记忆
    var colorPick = $('colorPick');
    if (colorPick) colorPick.addEventListener('input', function () {
      drawings.setToolColor(this.value);
      var sel = drawings.selectedId != null ? drawings.getById(drawings.selectedId) : null;
      if (sel) { sel.color = drawings.color; }
      requestRender();
    });
    $('btnDash').onclick = function () {
      drawings.setToolDash(!drawings.dash);
      syncToolUI();
      var sel = drawings.selectedId != null ? drawings.getById(drawings.selectedId) : null;
      if (sel) { sel.dash = drawings.dash; requestRender(); }
    };
    $('btnDelDrawing').onclick = function () {
      if (drawings.removeSelected()) { requestRender(); }
      else toast('请先选中一条画线');
    };
    $('btnClearDrawing').onclick = function () {
      if (!drawings.items.length) { toast('当前没有画线'); return; }
      drawings.clear(); pending = null; drawArm = null; requestRender();
    };
    $('chkEMA').onchange = function (e) { chart.showEMA = e.target.checked; requestRender(); };
    var emaColor = $('emaColor');
    if (emaColor) {
      try { var ec = localStorage.getItem('kline_ema_color_v1'); if (ec) chart.emaColor = ec; } catch (e) { }
      emaColor.value = chart.emaColor || 'gold';
      emaColor.classList.add('ema-pick');
      emaColor.addEventListener('input', function () {
        chart.emaColor = this.value;
        try { localStorage.setItem('kline_ema_color_v1', this.value); } catch (e) { }
        requestRender();
      });
    }
    $('btnFullscreen').onclick = toggleFullscreen;
  }

  /* ---- 全屏 ---- */
  function isFullscreen() {
    return !!(document.fullscreenElement || document.webkitFullscreenElement) ||
      $('chartWrap').classList.contains('fs');
  }
  function toggleFullscreen() {
    var el = $('chartWrap');
    if (isFullscreen()) {
      if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen();
      else if (document.webkitFullscreenElement && document.webkitExitFullscreen) document.webkitExitFullscreen();
      else { el.classList.remove('fs'); afterLayoutChange(); }
      return;
    }
    var req = el.requestFullscreen || el.webkitRequestFullscreen;
    if (req) {
      try {
        var r = req.call(el);
        // 某些浏览器/文件协议下 Promise 会 reject，降级为 CSS 全屏
        if (r && typeof r.catch === 'function') {
          r.catch(function () { el.classList.add('fs'); afterLayoutChange(); });
        }
      } catch (e) { el.classList.add('fs'); afterLayoutChange(); }
    } else {
      el.classList.add('fs');
      afterLayoutChange();
    }
    setTimeout(updateFsButton, 50);
  }
  function afterLayoutChange() {
    chart.resize();
    requestRender();
    drawEquity();
    updateFsButton();
  }
  function updateFsButton() {
    var on = isFullscreen();
    $('btnFullscreen').textContent = on ? '退出全屏' : '全屏';
    $('btnFullscreen').classList.toggle('active', on);
  }

  /* ================= 回放控制 ================= */
  function bindReplay() {
    $('btnPlay').onclick = togglePlay;
    $('btnNext').onclick = function () { pause(); step(1); };
    $('btnReset').onclick = resetReplay;
    $('speeds').addEventListener('click', function (e) {
      var b = e.target.closest('button');
      if (!b) return;
      state.speed = +b.dataset.speed;
      var all = $('speeds').querySelectorAll('button');
      for (var i = 0; i < all.length; i++) all[i].classList.toggle('active', all[i] === b);
    });
    $('progress').addEventListener('input', function (e) { seek(+e.target.value); });
    $('btnRandom').onclick = randomStart;
    $('inpDate').onchange = function (e) { dateStart(e.target.value); };
  }

  /* 随机起点：清空画线并跳到随机位置重新开始 */
  function randomStart() {
    var n = state.data.length;
    if (n < 10) { toast('数据不足', 'err'); return; }
    var lo = Math.min(60, n - 2);
    var idx = lo + Math.floor(Math.random() * (n - 1 - lo));
    pending = null; drawArm = null;
    drawings.clear();
    replayTrade = null;          // 开启新起点复盘时清除旧交易标记
    setStart(idx);
    toast('已随机跳到第 ' + (idx + 1) + ' 根K线（画线已清空）', 'ok');
  }

  /* 指定起始日期：从该日期（含）之后的第一根K线开始（二分查找，大数据集也即时响应） */
  function dateStart(v) {
    if (!v) return;
    var n = state.data.length;
    if (!n) { toast('请先载入数据', 'err'); return; }
    var ts = new Date(v + 'T00:00:00').getTime();
    if (isNaN(ts)) { toast('日期格式无效', 'err'); return; }

    var last = state.data[n - 1].t;
    if (ts > last) {                                  // 超出数据末尾：落到最后一根
      toast('该日期之后没有数据，已跳到最后一根K线', 'err');
      setStart(Math.max(0, n - 2));
      return;
    }
    var lo = 0, hi = n - 1, idx = n - 1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (state.data[mid].t >= ts) { idx = mid; hi = mid - 1; }
      else lo = mid + 1;
    }
    idx = clamp(idx, 0, Math.max(0, n - 2));
    setStart(idx);
    toast('已从 ' + fmtFull(state.data[idx].t) + ' 开始', 'ok');
  }

  /* 设置起点并重置回放 */
  function setStart(idx) {
    pause();
    /* 保留至少 1 根 K 线的可前进空间，避免起点卡在末尾导致播放/下一根无效 */
    var maxStart = Math.max(0, state.data.length - 2);
    state.startIdx = clamp(idx, 0, maxStart);
    state.follow = true;         // 换起点后重新跟随，避免视口停在旧位置
    resetReplay();
  }

  function togglePlay() { state.playing ? pause() : play(); }
  function play() {
    if (!state.data.length) return;
    if (state.idx >= state.data.length - 1) resetReplay();
    state.playing = true; acc = 0; lastT = performance.now();
    state.follow = true;                          // 播放时隐式跟随最新K线
    chart.scrollToIndex(state.idx, 0.18);
    $('btnPlay').innerHTML = '&#10073;&#10073;';
    $('playStatus').className = 'status play';
    $('playStatus').textContent = '回放中';
  }
  function pause() {
    state.playing = false;
    acc = 0;                                          // 暂停时清零帧累加器，避免恢复播放时瞬间跳跃
    $('btnPlay').innerHTML = '&#9654;';
    $('playStatus').className = 'status';
    $('playStatus').textContent = state.idx >= state.data.length - 1 && state.data.length ? '已结束' : '已暂停';
  }
  function step(n) {
    if (n > 0) state.follow = true;   // 手动向前推进时自动跟随最新K线
    seek(state.idx + n);
  }
  function resetReplay() {
    pause();
    acc = 0;                                          // 复位帧累加器，避免日期跳转等操作后残留值导致播放异常
    state.idx = clamp(state.startIdx, 0, Math.max(0, state.data.length - 1));
    var f = engine.feePerLot;
    engine.reset(); engine.feePerLot = f;
    snapshots = {};
    if (state.data.length) {
      engine.setBar(state.data[state.idx], state.idx);
      snapshots[state.idx] = engine.snapshot();
    }
    var pg = $('progress');
    pg.min = state.startIdx;
    pg.max = Math.max(state.startIdx, state.data.length - 1);
    pg.value = state.idx;
    syncChart();
    /* 无论当前是否跟随，都强制把视口定位到起点：
     * 手动平移过（follow=false）或向后跳转时，否则视口会停在旧位置甚至空白 */
    /* 无论当前是否跟随，都强制把视口定位到起点：
     * 手动平移过（follow=false）或向后跳转时，否则视口会停在旧位置甚至空白 */
    chart.maxIndex = state.idx;
    chart.scrollToIndex(state.idx, 0.18);
    chart.clampOffset();
    markStructure(); requestRender();
  }

  /* ---- seek：前进逐根撮合，后退用快照回滚 ---- */
  function saveSnapshot(i) { snapshots[i] = engine.snapshot(); }
  function shouldSave(i) { return (i % state.snapEvery) === 0; }

  function restoreTo(target) {
    var keys = Object.keys(snapshots).map(Number).sort(function (a, b) { return a - b; });
    var best = null;
    for (var i = 0; i < keys.length; i++) if (keys[i] <= target) best = keys[i];
    for (var j = 0; j < keys.length; j++) if (keys[j] > target) delete snapshots[keys[j]];
    if (best != null) { engine.restore(snapshots[best]); state.idx = best; }
    else {
      var f = engine.feePerLot;
      engine.reset(); engine.feePerLot = f;
      state.idx = state.startIdx;
    }
  }

  function seek(target) {
    if (!state.data.length) return;
    target = clamp(Math.round(target), state.startIdx, state.data.length - 1);
    if (target < state.idx) restoreTo(target);
    if (target > state.idx) {
      for (var i = state.idx + 1; i <= target; i++) {
        engine.setBar(state.data[i], i);
        engine.onNewBar(state.data[i], i);
        if (shouldSave(i)) saveSnapshot(i);
      }
      state.idx = target;
    }
    engine.setBar(state.data[state.idx], state.idx);
    if (shouldSave(state.idx)) saveSnapshot(state.idx);
    syncChart();
    markStructure(); requestRender();
  }

  function syncChart() {
    chart.maxIndex = state.idx;
    $('progress').value = state.idx;
    if (state.follow) followLatest(state.idx);
    updateBarInfo();
  }

  /* 跟随最新K线（播放/下一根）：仅当最新K线位于「固定位置」右侧时才回卷到该固定位置；
   * 若最新K线仍在该固定位置左侧，则保持视口当前位置不做移动。
   * 固定位置 = scrollToIndex(idx, 0.18) 时最新K线所在的屏幕横坐标。 */
  function followLatest(idx) {
    var frac = 0.18;
    var anchorX = chart.plot.x + chart.plot.w * (1 - frac);
    if (chart.x(idx) > anchorX) chart.scrollToIndex(idx, frac);
    chart.clampOffset();
  }

  function updateBarInfo() {
    var b = state.data[state.idx];
    var zoom = chart.priceZoom > 1.001 ? ' · 纵轴×' + chart.priceZoom.toFixed(1) : '';
    $('barInfo').textContent = b ? (fmtFull(b.t) + zoom) : '--';
  }

  /* ================= 两段式画线状态机 ================= */
  /* 按下鼠标确定起点并进入待确认状态（拖动实时预览）→ 松开鼠标确认；
     一次拖拽即可成图，也可先单击起点再单击终点；斐波扩展需 A/B/C 三点；
     按下后指针移出图表再松开 = 取消本次操作（回滚，无副作用）。 */
  function previewItem() {
    if (!pending || !pending.pts.length) return null;
    var need = window.DRAW_NEED[pending.type] || 2;
    var it = {
      type: pending.type, color: drawings.color, dash: drawings.dash, width: 1.6,
      p1: pending.pts[0]
    };
    /* 斐波预览使用已保存的默认比例，确认后与预览一致 */
    if (pending.type === 'fib' || pending.type === 'fibext') {
      it.levels = drawings.getDefaultLevels(pending.type);
    }
    /* 盈亏工具预览：开仓 = 首击位置（固定），止盈/止损 = 默认价，
     * 矩形右边界 = 鼠标当前位置（pending.cur.i），随右移实时拉伸 */
    if (isPnlType(pending.type)) {
      var ri = (pending.cur && pending.cur.i != null) ? pending.cur.i : pending.pts[0].i;
      it.p2 = { i: ri, p: pending.tpP };
      it.p3 = { i: ri, p: pending.slP };
      return it;
    }
    if (pending.pts[1]) it.p2 = pending.pts[1];
    if (pending.pts[2]) it.p3 = pending.pts[2];
    if (pending.cur && pending.pts.length < need) {
      if (pending.pts.length === 1 && need >= 2) it.p2 = pending.cur;
      else if (pending.pts.length === 2 && need >= 3) it.p3 = pending.cur;
    }
    return it;
  }

  /* 取光标处的数据点：含弱磁吸（O/C/L/H）与 Shift 水平约束 */
  function drawPointAt(x, y, baseType, baseP) {
    var sn = (state.tool !== 'select') ? snapPriceAt(x, y) : null;
    var py = sn ? sn.y : y;
    var pr = chart.priceAt(py);
    // Shift 锁定水平：线段/趋势线/射线的后续点价格对齐首个点
    if (shiftHeld && baseP != null && isHorizType(baseType)) pr = baseP;
    return { i: chart.idxAt(x), p: pr, y: py };
  }

  /* 盈亏工具默认止盈/止损距离：开仓价 ±2%（且不小于可视价格范围的 2%），
   * 并裁剪到可视价格区内（留 15% 边距），确保初始止盈/止损线「合适且可见」。
   * 做多：止盈在上(entry+d)、止损在下(entry-d)；做空反之 */
  function defaultPnlPrices(entry, long) {
    var pp = chart.pricePane;
    var vTop = chart.priceAt(pp.y), vBot = chart.priceAt(pp.y + pp.h);
    var range = Math.abs(vBot - vTop);
    var d = Math.max(entry * 0.02, range * 0.02);
    var maxD = Math.min(entry - vBot, vTop - entry);   // 止损/止盈仍留在可视区内
    if (maxD > 0) d = Math.min(d, maxD * 0.85);
    else d = Math.max(d, range * 0.03);                // 开仓贴边时保底可见
    return long ? { tp: entry + d, sl: entry - d } : { tp: entry - d, sl: entry + d };
  }
  function isPnlType(t) { return t === 'longpnl' || t === 'shortpnl'; }

  /* 两段式点击交互（统一模式）：
   * 每次「点击」（按下后在原位松开，位移 < CLICK_TOL）提交一个锚点：
   *   - 单点工具（need=1：hline/text/arrow…）：点击一下即完成画线；
   *   - 多点工具（need=2/3：线段/测量/斐波回撤/拓展…）：点击开始设第 1 点，再次点击确认完成；
   *   - 盈亏工具：点击开仓(定左边界/默认止盈止损) → 再次点击确认右边界成图。
   * 不再支持「点击开始、按住拖动、松开确认」的拖拽成图：按住拖动的松开不提交锚点，
   * 仅在指针相对按下位置位移小于阈值时（即干净点击）才提交。 */

  /* 第一段：按下鼠标 —— 仅启动画线手势 / 刷新预览，不立即确定锚点 */
  function onToolDown(p) {
    var need = window.DRAW_NEED[state.tool] || 2;
    var pt = drawPointAt(p.x, p.y, state.tool, null);
    lastMouse = { x: p.x, y: p.y };
    // 记录手势开始前的状态（供指针移出图表 = 取消时回滚）与按下起点（供判定「是否干净点击」）
    drawArm = {
      need: need,
      isText: state.tool === 'text',
      downAt: { x: p.x, y: p.y },
      prev: pending ? JSON.parse(JSON.stringify({
        type: pending.type, pts: pending.pts, cur: pending.cur,
        tpP: pending.tpP, slP: pending.slP
      })) : null
    };
    if (drawArm.isText) { requestRender(); return; }
    if (!pending) {
      pending = { type: state.tool, pts: [], cur: { i: pt.i, p: pt.p } };
    } else {
      pending.cur = { i: pt.i, p: pt.p };   // 预览随按下点实时更新
    }
    requestRender();
  }

  /* 第二段：松开鼠标 —— 若为「干净点击」则提交该位置为一个锚点 */
  function onToolUp() {
    if (!drawArm) return;
    var arm = drawArm;
    drawArm = null;
    var pos = lastMouse;
    if (!pos) { requestRender(); return; }

    if (arm.isText) {
      var tp = drawPointAt(pos.x, pos.y, 'text', null);
      openTextEditor(pos.x, tp.y, tp.i, tp.p, null);
      return;
    }
    if (!pending) { requestRender(); return; }

    /* 点击判定：指针从按下到松开发生了明显位移 = 按住拖动，非干净点击。
     * 按需求已取消「点击开始、松开确认」的拖拽成图，故拖动松开不提交锚点；
     * 预览已在拖动中实时显示，仅需在目标处再干净地点击一次即可确认该点。 */
    if (arm.downAt) {
      var dx = pos.x - arm.downAt.x, dy = pos.y - arm.downAt.y;
      if (Math.abs(dx) >= CLICK_TOL || Math.abs(dy) >= CLICK_TOL) { requestRender(); return; }
    }

    /* 盈亏工具：首击=固定开仓(左边界)+默认止盈/止损预览，次击=确认右边界成图 */
    if (isPnlType(pending.type)) {
      if (!pending.pts.length) {
        var e0 = drawPointAt(pos.x, pos.y, pending.type, null);
        pending.pts.push({ i: e0.i, p: e0.p });                       // p1 = 开仓
        var def = defaultPnlPrices(e0.p, pending.type === 'longpnl');
        pending.tpP = def.tp;                                          // 默认止盈（预览）
        pending.slP = def.sl;                                          // 默认止损（预览）
        pending.cur = { i: e0.i, p: e0.p };
        requestRender();                                               // 保持预览，等待第二次点击确认右边界
        return;
      }
      var cp2 = drawPointAt(pos.x, pos.y, pending.type, null);
      var rightI = Math.max(cp2.i, pending.pts[0].i + 1);   // 右边界至少向右 1 根K线，保证矩形可见
      pending.pts.push({ i: rightI, p: pending.tpP });       // p2 = 止盈（默认价，索引 = 右边界）
      pending.cur = { i: rightI, p: pending.tpP };
      finishPending();
      return;
    }

    /* 通用工具：每次点击提交一个锚点 */
    var baseP = pending.pts.length ? pending.pts[0].p : null;
    var cp = drawPointAt(pos.x, pos.y, pending.type, baseP);
    var last = pending.pts[pending.pts.length - 1];
    // 与已提交的上一锚点几乎重合：忽略本次重复点击，继续等待
    if (last && Math.abs(chart.x(cp.i) - chart.x(last.i)) < 4 && Math.abs(chart.y(cp.p) - chart.y(last.p)) < 4) {
      requestRender();
      return;
    }
    pending.pts.push({ i: cp.i, p: cp.p });
    pending.cur = { i: cp.i, p: cp.p };
    if (pending.pts.length >= arm.need) finishPending();
    else requestRender();
  }

  /* 按下后指针移出图表：取消本次操作，回滚到按下前的状态（无副作用） */
  function cancelDrawArm() {
    if (!drawArm) return;
    var prev = drawArm.prev;
    drawArm = null;
    pending = prev ? { type: prev.type, pts: prev.pts, cur: prev.cur, tpP: prev.tpP, slP: prev.slP } : null;
    state.snap = null;
    requestRender();
  }

  function finishPending() {
    if (!pending) return;
    var need = window.DRAW_NEED[pending.type] || 2;
    /* 盈亏工具仅需 2 个用户锚点（开仓 p1 + 止盈 p2），止损 p3 由下方自动对称生成，
     * 因此完成门槛按 2 点计算，而非 NEED=3 */
    var minPts = (pending.type === 'longpnl' || pending.type === 'shortpnl') ? 2 : need;
    if (pending.pts.length < minPts) return;
    var it = { type: pending.type, p1: pending.pts[0] };
    if (need >= 2) it.p2 = pending.pts[1];
    if (need >= 3) it.p3 = pending.pts[2];   // 盈亏工具无第三用户锚点，保持 undefined，由下方自动生成
    /* 盈亏工具：自动生成止损点 p3（以开仓价 p1 为轴，止盈 p2 的对称位置）
     * 例如做多：p1=entry, p2=TP(上方)，则 p3=SL(下方)，距离 ≈ |TP-entry|
     * p3 与 p2 同索引（右边界），保证止损线与止盈线一样横贯整个矩形 */
    if ((it.type === 'longpnl' || it.type === 'shortpnl') && it.p2 && !it.p3) {
      var entryP = it.p1.p, tpP = it.p2.p;
      var dist = tpP - entryP;              // 止盈距离（正=上方，负=下方）
      var slP = entryP - dist;             // 对称止损
      it.p3 = { i: it.p2.i, p: slP };
    }
    drawings.add(it);
    pending = null;
    setTool('select');
    requestRender();
  }

  /* ================= 画图光标弱磁吸（OHLC） ================= */
  var SNAP_PX = 7;   // 弱磁吸阈值（像素）：仅在该范围内轻微吸附，超出则自由定位
  /* 返回光标附近最近的 K 线 开/收/低/高 价吸附点 {i,p,y,dist}，否则 null */
  function snapPriceAt(x, y) {
    if (!state.data.length) return null;
    var i = Math.round(chart.idxAt(x));
    if (i < 0 || i > chart.maxIndex) return null;
    var b = state.data[i];
    if (!b) return null;
    var cands = [b.o, b.c, b.l, b.h];
    var bestY = 0, bestP = 0, bestD = Infinity;
    for (var k = 0; k < cands.length; k++) {
      var yy = chart.y(cands[k]);
      var d = Math.abs(yy - y);
      if (d < bestD) { bestD = d; bestP = cands[k]; bestY = yy; }
    }
    if (bestD <= SNAP_PX) return { i: i, p: bestP, y: bestY, dist: bestD };
    return null;
  }

  /* ================= 图表内文字输入（替代 prompt，全屏下不退出） ================= */
  function openTextEditor(sx, sy, i, pr, initial, item) {
    var inp = $('drawTextInput');
    if (!inp) return;
    inp.value = initial || '';
    inp.dataset.i = i;
    inp.dataset.pr = pr;
    inp._editing = item || null;
    var host = $('canvasHost');
    var rect = host ? host.getBoundingClientRect() : { width: 800, height: 500 };
    var W = rect.width || (chart.w || 800), H = rect.height || (chart.h || 500);
    var left = Math.max(4, Math.min(sx, W - 150));
    var top = Math.max(4, Math.min(sy - 12, H - 36));
    inp.style.left = left + 'px';
    inp.style.top = top + 'px';
    // 关键修复：移除 hidden 属性，否则 [hidden]{display:none !important} 会覆盖 .on 的显示，
    // 导致文字输入框在真实浏览器中不可见（“点击文字选项后无反应”）
    inp.hidden = false;
    inp.classList.add('on');
    setTimeout(function () { try { inp.focus(); inp.select(); } catch (e) { } }, 0);
  }
  function commitText() {
    var inp = $('drawTextInput');
    if (!inp || !inp.classList.contains('on')) return;
    var t = inp.value;
    var editing = inp._editing;
    inp.classList.remove('on');
    inp.hidden = true;
    inp._editing = null;
    if (editing) {
      if (String(t).trim() !== '') { editing.text = t; requestRender(); }
      else requestRender();
      return;
    }
    if (String(t).trim() === '') { setTool('select'); return; }
    drawings.add({ type: 'text', p1: { i: +inp.dataset.i, p: +inp.dataset.pr }, text: t });
    setTool('select');
    requestRender();
  }
  function cancelText() {
    var inp = $('drawTextInput');
    if (!inp || !inp.classList.contains('on')) return;
    var editing = inp._editing;
    inp.classList.remove('on');
    inp.hidden = true;
    inp._editing = null;
    if (editing) { requestRender(); return; }
    setTool('select');
  }

  /* ================= 图表交互 ================= */
  function mousePos(e) {
    var r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  function bindChart() {
    canvas.addEventListener('mousedown', onDown);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    canvas.addEventListener('mouseleave', function () {
      cancelDrawArm();                       // 按下后移出图表：取消本次画线操作
      chart.mouse = null; hoverOverlay = null; state.snap = null; requestRender(); updateLegend();
    });
    canvas.addEventListener('wheel', function (e) {
      e.preventDefault();
      var p = mousePos(e);
      chart.zoomAt(p.x, e.deltaY < 0 ? 1.12 : 1 / 1.12);
      // 滚轮缩放后的回卷跟随：复用 followLatest 的判断——
      // 只有当最新K线已越过「固定位置」右侧时才回卷到该位置；
      // 若是手动平移（最新K线在固定位置左侧）则保持视口不动，不被强行拽回。
      if (state.follow) followLatest(state.idx);
      requestRender();
    }, { passive: false });
    canvas.addEventListener('dblclick', function (e) {
      var p = mousePos(e);
      // 双击价格轴：纵轴缩放复位
      if (chart.hitAxisY(p.x)) {
        chart.resetPriceZoom();
        updateBarInfo();
        requestRender();
        toast('纵轴缩放已复位');
        return;
      }
      var hit = drawings.hitTest(chart, p.x, p.y);
      if (!hit) return;
      var it = drawings.getById(hit.id);
      if (!it) return;
      if (it.type === 'text') {
        openTextEditor(chart.x(it.p1.i), chart.y(it.p1.p), it.p1.i, it.p1.p, it.text || '', it);
      } else if (it.type === 'hline') {
        var l = prompt('修改水平线标签（留空显示价格）：', it.label == null ? '' : it.label);
        if (l != null) { it.label = l === '' ? null : l; requestRender(); }
      } else if (it.type === 'fib' || it.type === 'fibext') {
        openFibModal(it);
      }
    });
    canvas.addEventListener('contextmenu', function (e) {
      e.preventDefault();
      var p = mousePos(e);
      // 命中挂单线 → 菜单仅「撤销此挂单」；命中空白图表 → 菜单仅「限价/突破」下单（均不显示价格）
      var hit = overlayHitTest(p.x, p.y);
      var orderId = (hit && hit.kind === 'order') ? hit.id : null;
      openCtxMenu(p.x, p.y, chart.priceAt(p.y), orderId);
    });
    // 图表内文字输入框：回车提交 / Esc 取消 / 失焦提交
    var textInput = $('drawTextInput');
    if (textInput) {
      textInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); commitText(); }
        else if (e.key === 'Escape') { e.preventDefault(); cancelText(); }
      });
      textInput.addEventListener('blur', function () { commitText(); });
    }
  }

  /* ================= 右键菜单（空白=两项下单 / 挂单线=仅撤销，均不显示价格） ================= */
  function openCtxMenu(x, y, price, orderId) {
    if (!state.data.length || price == null || !isFinite(price)) return;
    var menu = $('ctxMenu');
    var a = $('cmA'), b = $('cmB'), c = $('cmC');
    ctxPrice = price;
    if (orderId != null) {
      // 命中挂单线：只显示「撤销此挂单」，隐藏两个下单入口
      if (a) a.hidden = true;
      if (b) b.hidden = true;
      if (c) {
        c.hidden = false;
        c.textContent = '撤销此挂单 #' + orderId;
        c.dataset.a = 'cancel-' + orderId;
        c.className = 'cm-item danger';
      }
    } else {
      // 空白图表：只显示「限价 xx / 突破 xx」两个下单项（精简，不含价格尾注）
      var mkt = engine.price();
      if (a) {
        a.hidden = false;
        if (mkt != null && price > mkt) {
          a.textContent = '限价做空'; a.dataset.a = 'limit-sell'; a.className = 'cm-item sell';
        } else {
          a.textContent = '限价做多'; a.dataset.a = 'limit-buy'; a.className = 'cm-item buy';
        }
      }
      if (b) {
        b.hidden = false;
        if (mkt != null && price > mkt) {
          b.textContent = '突破做多'; b.dataset.a = 'stop-buy'; b.className = 'cm-item buy';
        } else {
          b.textContent = '突破做空'; b.dataset.a = 'stop-sell'; b.className = 'cm-item sell';
        }
      }
      if (c) { c.hidden = true; c.dataset.a = ''; }
    }
    menu.hidden = false;
    var mw = menu.offsetWidth || 180, mh = menu.offsetHeight || 60;
    var hw = host.clientWidth || 800, hh = host.clientHeight || 500;
    menu.style.left = Math.max(0, Math.min(x + 2, hw - mw - 4)) + 'px';
    menu.style.top = Math.max(0, Math.min(y + 2, hh - mh - 4)) + 'px';
  }
  function closeCtxMenu() {
    var m = $('ctxMenu'); if (m) m.hidden = true;
    var c = $('cmC'); if (c) c.hidden = true;   // 复位撤销入口，避免残留显示
  }

  function bindContextMenu() {
    var menu = $('ctxMenu');
    menu.addEventListener('click', function (e) {
      var b = e.target.closest('.cm-item');
      if (!b) return;
      ctxAction(b.dataset.a);
    });
    // 点击别处 / Esc / 滚动 关闭
    document.addEventListener('mousedown', function (e) {
      if (menu.hidden) return;
      if (e.target && e.target.closest && e.target.closest('#ctxMenu')) return;
      closeCtxMenu();
    });
    canvas.addEventListener('wheel', closeCtxMenu);
  }

  function ctxAction(a) {
    closeCtxMenu();
    if (!a) return;
    // 撤销单笔挂单：cancel-<id>
    var parts = String(a).split('-');
    if (parts[0] === 'cancel') {
      var id = Number(parts.slice(1).join('-'));
      if (!isFinite(id)) return;
      var ok = engine.cancelOrder(id);
      if (ok) { afterMutation(); toast('已撤销挂单 #' + id, 'ok'); }
      else toast('挂单 #' + id + ' 已不可撤销', 'err');
      return;
    }
    if (ctxPrice == null) return;
    if (parts.length !== 2) return;
    submitCtxOrder(parts[0], parts[1]);
  }

  function submitCtxOrder(type, side) {
    if (ctxPrice == null || !state.data.length) return;
    var r = engine.submit({
      type: type, side: side,
      qty: 1,
      price: ctxPrice
    });
    if (!r.ok) { toast(r.msg, 'err'); return; }
    afterMutation();
    toast((type === 'limit' ? '限价' : 'Stop') + (side === 'buy' ? '买入' : '卖出') +
      '挂单 #' + r.id + ' @' + fmt(ctxPrice), 'ok');
  }

  function onDown(e) {
    if (e.button !== 0) return;
    // 文字编辑器打开时，先提交/关闭，避免重复触发
    if ($('drawTextInput') && $('drawTextInput').classList.contains('on')) { commitText(); return; }
    shiftHeld = e.shiftKey;
    var p = mousePos(e);
    lastMouse = { x: p.x, y: p.y };

    // 右侧价格轴：上下拖动缩放纵轴
    if (chart.hitAxisY(p.x)) { drag = { mode: 'axisY', lastY: p.y }; return; }

    // 画线模式：两段式点击交互（第一次点击开始 → 再次点击确认）
    if (state.tool !== 'select') {
      onToolDown(p);
      return;
    }

    // 拖拽挂单 / 止损止盈线 / 开仓线（拖开仓线到目标位 = 设置止盈或止损）
    var oh = overlayHitTest(p.x, p.y);
    if (oh) { drawings.removeMeasure(); drag = { mode: 'overlay', hit: oh, startY: p.y, moved: false, price: null }; return; }

    // 选中画线
    var hit = drawings.hitTest(chart, p.x, p.y);
    if (hit) {
      if (drawings.getById(hit.id).type !== 'measure' && drawings.removeMeasure()) requestRender();
      drawings.selectedId = hit.id;
      var it = drawings.getById(hit.id);
      drag = {
        mode: hit.handle >= 0 ? 'handle' : 'body',
        id: hit.id, handle: hit.handle,
        start: { x: p.x, y: p.y },
        orig: JSON.parse(JSON.stringify({ p1: it.p1, p2: it.p2, p3: it.p3 }))
      };
      requestRender();
      return;
    }

    drawings.selectedId = null;
    if (drawings.removeMeasure()) requestRender();   // 测量标注：点击图表其他位置自动消失
    drag = { mode: 'pan', lastX: p.x };
    state.follow = false;                    // 手动平移后暂停跟随，再次播放时恢复
    requestRender();
  }

  function onMove(e) {
    if (!state.data.length) return;
    shiftHeld = e.shiftKey;
    var p = mousePos(e);
    lastMouse = { x: p.x, y: p.y };
    var inside = p.x >= 0 && p.y >= 0 && p.x <= chart.w && p.y <= chart.h;
    // 光标横向吸附：开启时十字光标 x 强制对齐最近K线中央竖轴（最小步进=一根K线宽度），
    // 游标不会落在K线之间的空隙；纵向 y 保持自由，不受限制。拖拽中不吸附（避免步进卡顿）。
    var mx = p.x;
    if (inside && !drag && state.snapCursor) {
      var pl0 = chart.plot;
      if (p.x >= pl0.x && p.x <= pl0.x + pl0.w) mx = chart.x(Math.round(chart.idxAt(p.x)));
    }
    chart.mouse = inside ? { x: mx, y: p.y } : null;
    updateLegend();

    // 弱磁吸：画图工具激活 或 正在拖动图形/挂单线（二次编辑）时，
    // 光标价格轻微吸附到该 K 线 开/收/低/高 价（阈值内，不强制对齐）
    state.snap = null;
    var editDrag = drag && (drag.mode === 'handle' || drag.mode === 'body' || drag.mode === 'overlay');
    if (inside && (state.tool !== 'select' || editDrag)) {
      var sn0 = snapPriceAt(p.x, p.y);
      if (sn0) {
        state.snap = sn0;
        chart.mouse = { x: mx, y: sn0.y };   // 十字光标也轻微吸附，提供视觉反馈
      }
    }

    // 画线预览：跟随鼠标
    if (pending) {
      var curP = chart.priceAt(p.y);
      if (state.snap) curP = state.snap.p;
      if (shiftHeld && pending.pts.length >= 1 && isHorizType(pending.type)) curP = pending.pts[0].p;
      pending.cur = { i: chart.idxAt(p.x), p: curP };
      requestRender();
      return;
    }

    if (!drag) {
      if (inside && state.tool === 'select') {
        // 价格轴 / 挂单持仓线 / 画线 的光标反馈
        var onAxis = chart.hitAxisY(p.x);
        var oh = onAxis ? null : overlayHitTest(p.x, p.y);
        hoverOverlay = oh;
        var hh = oh ? null : drawings.hitTest(chart, p.x, p.y);
        drawings.hoverId = hh ? hh.id : null;
        if (onAxis) canvas.style.cursor = 'ns-resize';
        else canvas.style.cursor = (oh || hh) ? (oh ? 'ns-resize' : 'move') : 'default';
      } else {
        hoverOverlay = null;
        drawings.hoverId = null;
      }
      requestRender();
      return;
    }

    if (drag.mode === 'pan') {
      chart.panBy(p.x - drag.lastX);
      drag.lastX = p.x;
    } else if (drag.mode === 'axisY') {
      // 价格轴上下拖动：向上拖 = 拉近（价格方向放大）
      chart.zoomPriceBy(p.y - drag.lastY);
      drag.lastY = p.y;
      updateBarInfo();   // 状态栏实时显示纵轴缩放倍数
    } else if (drag.mode === 'handle') {
      var dh = drawings.getById(drag.id);
      if (dh) {
        var pt = drag.handle === 0 ? dh.p1 : (drag.handle === 1 ? dh.p2 : dh.p3);
        if (pt) {
          if (isPnlType(dh.type) && drag.handle >= 1) {
            /* 盈亏工具：止盈/止损线「自由拖动」——
             * 水平分量移动「右边界」（p2/p3 索引同步，≥ p1.i+1，扩大/缩小盈亏计算范围）
             * 垂直分量调整该线价格（磁吸优先）；开仓线与左边界固定不动 */
            var rbI = Math.max(chart.idxAt(p.x), dh.p1.i + 1);
            dh.p2.i = rbI;
            if (dh.p3) dh.p3.i = rbI;
            pt.p = state.snap ? state.snap.p : chart.priceAt(p.y);
          } else {
            pt.i = chart.idxAt(p.x);
            // Shift 锁定水平：线段/趋势线/射线拖端点时价格不变，仅沿水平轴移动
            if (shiftHeld && isHorizType(dh.type)) {
              pt.p = (drag.handle === 0 ? drag.orig.p1 : (drag.handle === 1 ? drag.orig.p2 : drag.orig.p3)).p;
            } else {
              // 磁吸优先：吸附到该 K 线最近的 开/收/低/高 价，否则自由定位
              pt.p = state.snap ? state.snap.p : chart.priceAt(p.y);
            }
          }
        }
      }
    } else if (drag.mode === 'body') {
      var db = drawings.getById(drag.id);
      if (db) {
        if (isPnlType(db.type)) {
          /* 盈亏工具：开仓/左边界固定，禁止整体平移（只能调整右边界） */
        } else {
          var di = chart.idxAt(p.x) - chart.idxAt(drag.start.x);
          // Shift 锁定水平：整体只沿水平轴平移（价格位移归零）；否则按磁吸后的落点计算位移
          var dp = (shiftHeld && isHorizType(db.type))
            ? 0
            : chart.priceAt(state.snap ? state.snap.y : p.y) - chart.priceAt(drag.start.y);
          db.p1.i = drag.orig.p1.i + di;
          db.p1.p = drag.orig.p1.p + dp;
          if (db.p2 && drag.orig.p2) {
            db.p2.i = drag.orig.p2.i + di;
            db.p2.p = drag.orig.p2.p + dp;
          }
          if (db.p3 && drag.orig.p3) {
            db.p3.i = drag.orig.p3.i + di;
            db.p3.p = drag.orig.p3.p + dp;
          }
        }
      }
    } else if (drag.mode === 'overlay') {
      // 磁吸：拖动挂单 / 止盈止损 / 开仓线时同样吸附到最近 OHLC
      var price = state.snap ? state.snap.p : chart.priceAt(p.y);
      if (price > 0) {
        if (drag.hit.kind === 'order') engine.modifyOrder(drag.hit.id, { price: price });
        else if (drag.hit.part === 'sl') engine.modifyPosition(drag.hit.id, { sl: price });
        else if (drag.hit.part === 'tp') engine.modifyPosition(drag.hit.id, { tp: price });
        else if (drag.hit.part === 'entry') {
          // 拖开仓线：不立即生效，先记录预览价；超过阈值才算有意拖动
          if (Math.abs(p.y - drag.startY) > 4) drag.moved = true;
          drag.price = price;
        }
      }
    }
    requestRender();
  }

  function onUp(e) {
    /* 用松开瞬间的鼠标坐标刷新 lastMouse：
     * 快速甩动/快速拖拽画线时，最后一次 mousemove 可能未及时送达，导致
     * onToolUp 里读到的 lastMouse 仍停留在起点附近，造成终点与起点几乎重合
     * （测量/斐波/盈亏等工具"两点重叠"）。直接用 mouseup 事件的坐标最可靠。 */
    if (e && e.clientX != null && canvas) {
      var r = canvas.getBoundingClientRect();
      if (r && r.width) lastMouse = { x: e.clientX - r.left, y: e.clientY - r.top };
    }
    // 画线：松开鼠标 = 确认（未在按下状态则忽略，不影响拖拽逻辑）
    if (drawArm) { onToolUp(); }
    if (!drag) return;
    if (drag.mode === 'overlay') {
      // 松手：若拖的是开仓线，按拖动方向决定设置止盈还是止损
      if (drag.hit.kind === 'position' && drag.hit.part === 'entry' && drag.moved && drag.price > 0) {
        var pos = null;
        for (var pi = 0; pi < engine.positions.length; pi++) {
          if (engine.positions[pi].id === drag.hit.id) { pos = engine.positions[pi]; break; }
        }
        if (pos) {
          var isTP = (pos.side === 'buy') === (drag.price > pos.entry);
          var patch = {};
          patch[isTP ? 'tp' : 'sl'] = drag.price;
          engine.modifyPosition(drag.hit.id, patch);
          toast('已设置' + (isTP ? '止盈' : '止损') + ' ' + fmt(drag.price), 'ok');
        }
      }
      saveSnapshot(state.idx);
      markStructure();
    }
    drag = null;
    state.snap = null;
    requestRender();
  }

  /* ---- 挂单 / 持仓线命中 ---- */
  function overlayHitTest(x, y) {
    if (!engine || !state.data.length) return null;
    var pl = chart.plot;
    if (x < pl.x || x > pl.x + pl.w) return null;
    var tol = 5, i;
    var pend = engine.pendingOrders();
    for (i = 0; i < pend.length; i++) {
      if (Math.abs(chart.y(pend[i].price) - y) <= tol) return { kind: 'order', id: pend[i].id, part: 'price' };
    }
    var pos = engine.positions;
    for (i = 0; i < pos.length; i++) {
      var parts = [['entry', pos[i].entry], ['sl', pos[i].sl], ['tp', pos[i].tp]];
      for (var k = 0; k < parts.length; k++) {
        var v = parts[k][1];
        if (v == null || !(v > 0)) continue;
        if (Math.abs(chart.y(v) - y) <= tol) return { kind: 'position', id: pos[i].id, part: parts[k][0] };
      }
    }
    return null;
  }

  /* ---- 绘制挂单 / 持仓覆盖层 ---- */
  function drawOverlays(ctx, c) {
    if (!engine || !state.data.length) return;
    var pl = c.plot, pp = c.pricePane;
    ctx.save();
    ctx.beginPath();
    ctx.rect(pl.x, pl.y, pl.w, pl.h);
    ctx.clip();
    ctx.font = '10px ' + FONT;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';

    function line(price, color, dashed, label, thick) {
      var y = c.y(price);
      if (y < pp.y - 4 || y > pp.y + pp.h + 4) return;
      ctx.strokeStyle = color;
      ctx.lineWidth = thick ? 2.2 : 1.3;
      ctx.setLineDash(dashed ? [5, 4] : []);
      ctx.beginPath();
      ctx.moveTo(pl.x, y);
      ctx.lineTo(pl.x + pl.w, y);
      ctx.stroke();
      ctx.setLineDash([]);
      var w = ctx.measureText(label).width + 10;
      ctx.fillStyle = color;
      ctx.fillRect(pl.x + 4, y - 8, w, 16);
      ctx.fillStyle = '#fff';
      ctx.fillText(label, pl.x + 9, y + 1);
    }

    // 持仓
    var cur = engine.price();
    engine.positions.forEach(function (p) {
      var hot = drag && drag.mode === 'overlay' && drag.hit.kind === 'position' && drag.hit.id === p.id;
      var dir = p.side === 'buy' ? 1 : -1;
      var fl = (cur - p.entry) * p.qty * dir;
      var base = (p.side === 'buy' ? '多 ' : '空 ') + trimNum(p.qty) + ' @' + fmt(p.entry);
      // 悬停开仓线时提示可拖动设置止盈止损
      var hov = hoverOverlay && hoverOverlay.kind === 'position' && hoverOverlay.id === p.id && hoverOverlay.part === 'entry';
      line(p.entry, '#4c8dff', false, base + '  ' + sgn(fl) + (hov ? '  ↕拖动设止盈/止损' : ''), hot && drag.hit.part === 'entry');
      if (p.sl > 0) line(p.sl, '#fa541c', true, '止损 ' + fmt(p.sl), hot && drag.hit.part === 'sl');
      if (p.tp > 0) line(p.tp, '#a855f7', true, '止盈 ' + fmt(p.tp), hot && drag.hit.part === 'tp');

      // 拖开仓线的实时预览：按拖到开仓价的哪一侧，显示将设置的止盈/止损
      if (hot && drag.hit.part === 'entry' && drag.moved && drag.price > 0) {
        var isTP = (p.side === 'buy') === (drag.price > p.entry);
        line(drag.price, isTP ? '#a855f7' : '#fa541c', true,
          '松手设置' + (isTP ? '止盈 ' : '止损 ') + fmt(drag.price), true);
      }

      // 开仓标记
      var mx = c.x(p.entryIdx), my = c.y(p.entry);
      if (mx >= pl.x - 10 && mx <= pl.x + pl.w + 10) {
        ctx.fillStyle = p.side === 'buy' ? '#4c8dff' : '#a855f7';
        ctx.beginPath();
        if (p.side === 'buy') { ctx.moveTo(mx, my + 3); ctx.lineTo(mx - 4, my + 11); ctx.lineTo(mx + 4, my + 11); }
        else { ctx.moveTo(mx, my - 3); ctx.lineTo(mx - 4, my - 11); ctx.lineTo(mx + 4, my - 11); }
        ctx.closePath();
        ctx.fill();
      }
    });

    // 挂单
    engine.pendingOrders().forEach(function (o) {
      var hot = drag && drag.mode === 'overlay' && drag.hit.kind === 'order' && drag.hit.id === o.id;
      var tn = o.type === 'limit' ? '限价' : 'Stop';
      var label = (o.side === 'buy' ? '多 ' : '空 ') + tn + ' ' + trimNum(o.qty) + ' @' + fmt(o.price);
      if (o.sl > 0) label += ' SL' + fmt(o.sl);
      if (o.tp > 0) label += ' TP' + fmt(o.tp);
      line(o.price, '#f0a020', true, label, hot);
    });

    // 历史成交标记（开仓箭头 / 平仓叉号 / 开平仓连线，默认常开）
    drawMarks(ctx, c);

    // 弱磁吸提示：画图或二次编辑拖动时，光标吸附到 K 线 O/C/L/H 时画一条淡线 + 圆点
    if (state.snap) {
      var sy = c.y(state.snap.p);
      ctx.save();
      ctx.strokeStyle = 'rgba(255,255,255,.28)';
      ctx.setLineDash([3, 3]); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(pl.x, sy); ctx.lineTo(pl.x + pl.w, sy); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#ffd54a';
      ctx.beginPath(); ctx.arc(c.x(state.snap.i), sy, 3.2, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }

    // 两段式画线「待确认」反馈：按下期间高亮已确定锚点（黄）与当前光标点（蓝）
    if (drawArm) {
      var marks = [];
      if (pending) {
        for (var mi = 0; mi < pending.pts.length; mi++) marks.push(pending.pts[mi]);
        marks.push(pending.cur);
      } else if (lastMouse) {
        marks.push({ i: c.idxAt(lastMouse.x), p: c.priceAt(lastMouse.y) });
      }
      ctx.save();
      for (var mk = 0; mk < marks.length; mk++) {
        var q = marks[mk];
        if (!q) continue;
        var qx = c.x(q.i), qy = c.y(q.p);
        ctx.beginPath(); ctx.arc(qx, qy, 3.6, 0, Math.PI * 2);
        ctx.fillStyle = mk === 0 ? '#ffd54a' : '#4c8dff';
        ctx.fill();
        ctx.strokeStyle = 'rgba(10,14,21,.85)'; ctx.lineWidth = 1; ctx.stroke();
      }
      ctx.restore();
    }

    ctx.restore();
  }
  function trimNum(n) { return String(Math.round(n * 10000) / 10000); }

  /* ---- 历史成交标记 ---- */
  var MK = { buy: '#e34d59', sell: '#2ebd85', win: '#e34d59', loss: '#2ebd85' };

  function drawMarks(ctx, c) {
    var pl = c.plot, cur = state.idx;

    // 开仓：多=向上三角(红) 放在K线下方；空=向下三角(绿) 放在K线上方
    engine.fills.forEach(function (f) {
      if (f.action !== 'open' || f.idx == null || f.idx > cur) return;
      var b = state.data[f.idx];
      if (!b) return;
      var x = c.x(f.idx);
      if (x < pl.x - 10 || x > pl.x + pl.w + 10) return;
      var isBuy = f.side === 'buy';
      var y = isBuy ? c.y(b.l) + 11 : c.y(b.h) - 11;
      markerArrow(ctx, x, y, isBuy ? 1 : -1, isBuy ? MK.buy : MK.sell);
    });

    // 平仓：✕ 标记 + 开平仓虚线连线（红=盈利，绿=亏损）
    engine.trades.forEach(function (t) {
      if (t.exitIdx == null || t.exitIdx > cur) return;
      var x1 = c.x(t.entryIdx), y1 = c.y(t.entry);
      var x2 = c.x(t.exitIdx), y2 = c.y(t.exit);
      var col = t.pnl >= 0 ? MK.win : MK.loss;
      var vis1 = x1 >= pl.x - 60 && x1 <= pl.x + pl.w + 60;
      var vis2 = x2 >= pl.x - 60 && x2 <= pl.x + pl.w + 60;
      if (vis1 || vis2) {
        ctx.save();
        ctx.globalAlpha = 0.45;
        ctx.strokeStyle = col;
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(x1, y1); ctx.lineTo(x2, y2);
        ctx.stroke();
        ctx.restore();
      }
      if (x2 >= pl.x - 10 && x2 <= pl.x + pl.w + 10) markerCross(ctx, x2, y2, col);
    });

    /* 复盘中的历史交易：进场点（箭头）+ 平仓点（叉号）+ 连线 */
    if (replayTrade && replayTrade.entryIdx != null && replayTrade.exitIdx != null) {
      var rx1 = c.x(replayTrade.entryIdx), ry1 = c.y(replayTrade.entry);
      var rx2 = c.x(replayTrade.exitIdx), ry2 = c.y(replayTrade.exit);
      var rCol = replayTrade.pnl >= 0 ? MK.win : MK.loss;
      var rv1 = rx1 >= pl.x - 60 && rx1 <= pl.x + pl.w + 60;
      var rv2 = rx2 >= pl.x - 60 && rx2 <= pl.x + pl.w + 60;
      if (rv1 || rv2) {
        ctx.save();
        ctx.globalAlpha = 0.55;
        ctx.strokeStyle = rCol;
        ctx.lineWidth = 1.2;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(rx1, ry1); ctx.lineTo(rx2, ry2);
        ctx.stroke();
        ctx.restore();
      }
      /* 进场标记：多=向上三角(红)、空=向下三角(绿)（箭头下方补一小段竖线增强辨识） */
      if (rv1) {
        markerArrow(ctx, rx1, ry1 + (replayTrade.side === 'buy' ? 9 : -9),
          replayTrade.side === 'buy' ? 1 : -1,
          replayTrade.side === 'buy' ? MK.buy : MK.sell);
      }
      if (rv2) markerCross(ctx, rx2, ry2, rCol);
    }
  }

  function markerArrow(ctx, x, y, dir, color) {
    ctx.save();
    ctx.fillStyle = color;
    var w = 4.6, h = 5.4;
    ctx.beginPath();
    if (dir > 0) { ctx.moveTo(x, y - h); ctx.lineTo(x - w, y + h * 0.7); ctx.lineTo(x + w, y + h * 0.7); }
    else { ctx.moveTo(x, y + h); ctx.lineTo(x - w, y - h * 0.7); ctx.lineTo(x + w, y - h * 0.7); }
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  function markerCross(ctx, x, y, color) {
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.8;
    var r = 3.8;
    ctx.beginPath();
    ctx.moveTo(x - r, y - r); ctx.lineTo(x + r, y + r);
    ctx.moveTo(x + r, y - r); ctx.lineTo(x - r, y + r);
    ctx.stroke();
    ctx.restore();
  }

  /* ---- 顶部行情信息（仅显示时间） ---- */
  function updateLegend() {
    var idx = chart.mouse ? chart.barAt(chart.mouse.x) : -1;
    if (idx < 0) idx = state.idx;
    var b = state.data[idx];
    if (!b) { $('legend').innerHTML = ''; return; }
    $('legend').innerHTML =
      '<span>' + fmtFull(b.t) + (idx !== state.idx ? ' <i style="color:#8b93a1">(#' + (idx + 1) + ')</i>' : ' <b style="color:#4c8dff">(当前)</b>') + '</span>';
  }

  /* ================= 历史成交记录（持久化） ================= */
  var HIST_KEY = 'kline_replay_history_v1';
  var hist = { list: [], seen: {} };
  var curTradeUid = null;
  var replayTrade = null;   // 复盘中的历史交易 {entryIdx,exitIdx,entry,exit,side,pnl}，用于在主图上标注进出场

  function histLoad() {
    hist.list = []; hist.seen = {};
    try {
      var all = JSON.parse(localStorage.getItem(HIST_KEY) || '{}');
      var arr = all[state.symbol];
      if (Array.isArray(arr)) hist.list = arr;
    } catch (e) { }
    hist.list.forEach(function (r) { if (r && r.uid) hist.seen[r.uid] = 1; });
    historyDirty = true;
  }

  function histPersist() {
    try {
      var all = {};
      try { all = JSON.parse(localStorage.getItem(HIST_KEY) || '{}') || {}; } catch (e) { }
      all[state.symbol] = hist.list;
      localStorage.setItem(HIST_KEY, JSON.stringify(all));
    } catch (e) { }
  }

  /* 在【当前数据集】上用时间戳定位某根K线的索引（返回 t<=ts 的最后一根，未命中返回 -1） */
  function barIndexAtOrBefore(ts) {
    if (!state.data.length || ts == null) return -1;
    var lo = 0, hi = state.data.length - 1, ans = -1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (state.data[mid].t <= ts) { ans = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    return ans;
  }
  /* 把一条历史交易记录转换为「主图复盘标记」（定位到当前数据集的进场/平仓K线） */
  function replayMarkerFor(rec) {
    if (!rec) return null;
    var eIdx = barIndexAtOrBefore(rec.entryTime);
    var xIdx = barIndexAtOrBefore(rec.exitTime);
    if (eIdx < 0 && xIdx < 0) return null;
    if (eIdx < 0) eIdx = Math.max(0, xIdx);
    if (xIdx < 0) xIdx = Math.min(state.data.length - 1, eIdx);
    return { entryIdx: eIdx, exitIdx: xIdx, entry: rec.entry, exit: rec.exit, side: rec.side, pnl: rec.pnl };
  }

  /* 把 engine 新产生的平仓记录归档（含K线波段快照） */
  function archiveTrade(t) {
    var from = Math.max(0, t.entryIdx - 10);
    var to = Math.min(state.data.length - 1, t.exitIdx == null ? t.entryIdx : t.exitIdx);
    if (to - from > 400) from = Math.max(0, to - 400);
    var seg = [];
    for (var i = from; i <= to; i++) {
      var b = state.data[i];
      if (b) seg.push([b.t, b.o, b.h, b.l, b.c, b.v]);
    }
    return {
      uid: state.symbol + '#' + t.id + '#' + t.exitTime + '#' + t.entry,
      symbol: state.symbol,
      side: t.side, qty: t.qty,
      entry: t.entry, exit: t.exit,
      entryTime: t.entryTime, exitTime: t.exitTime,
      pnl: t.pnl, fee: t.fee || 0, reason: t.reason,
      bars: t.bars, note: '',
      period: DataUtil.periodText(chart.interval),
      seg: seg,
      off0: clamp(t.entryIdx - from, 0, Math.max(0, seg.length - 1)),
      off1: clamp((t.exitIdx == null ? t.entryIdx : t.exitIdx) - from, 0, Math.max(0, seg.length - 1))
    };
  }

  function histSync() {
    if (!state.data.length || !engine.trades.length) return;
    var added = false;
    for (var i = 0; i < engine.trades.length; i++) {
      var t = engine.trades[i];
      var uid = state.symbol + '#' + t.id + '#' + t.exitTime + '#' + t.entry;
      if (hist.seen[uid]) continue;
      hist.seen[uid] = 1;
      hist.list.push(archiveTrade(t));
      added = true;
    }
    if (added) { histPersist(); historyDirty = true; }
  }

  function renderHistory() {
    var box = $('histList');
    if (!hist.list.length) {
      box.innerHTML = '<div class="empty">暂无历史成交记录<br><span style="font-size:11px">平仓后自动记录并保存到本地</span></div>';
      return;
    }
    var html = '';
    for (var i = hist.list.length - 1; i >= 0; i--) {
      var r = hist.list[i];
      if (!r || !r.uid) continue;
      html += '<div class="card hist-card" data-uid="' + esc(r.uid) + '">' +
        '<div class="card-head" style="margin-bottom:2px">' +
        '<span class="tag ' + (r.side === 'buy' ? 'buy' : 'sell') + '">' + (r.side === 'buy' ? '多' : '空') + ' ' + trimNum(r.qty) + '</span>' +
        '<span class="mono ' + pnlCls(r.pnl) + '" style="font-weight:600">' + sgn(r.pnl) + '</span>' +
        '</div>' +
        '<div class="grid2">' +
        '<span>开/平<b>' + fmt(r.entry) + ' → ' + fmt(r.exit) + '</b></span>' +
        '<span>平仓时间<b>' + fmtTime(r.exitTime) + '</b></span>' +
        '</div>' +
        (r.note ? '<div class="hist-note">' + esc(r.note.length > 40 ? r.note.slice(0, 40) + '…' : r.note) + '</div>' : '') +
        '</div>';
    }
    box.innerHTML = html;
    historyDirty = false;
  }

  function bindHist() {
    $('histList').addEventListener('click', function (e) {
      var card = e.target.closest('[data-uid]');
      if (!card) return;
      openTradeModal(card.dataset.uid);
    });
    $('btnClearHist').onclick = function () {
      if (!hist.list.length) { toast('历史记录已为空'); return; }
      if (!confirm('确定清空「' + state.symbol + '」的全部 ' + hist.list.length + ' 条历史成交记录？此操作不可恢复。')) return;
      hist.list = []; hist.seen = {};
      replayTrade = null;
      histPersist(); historyDirty = true; renderHistory();
      toast('历史记录已清空', 'ok');
    };
  }

  /* ---- 交易详情弹窗 ---- */
  function bindTradeModal() {
    bindHist();
    $('btnTradeClose').onclick = closeTradeModal;
    $('btnTmCancel').onclick = closeTradeModal;
    $('btnTmSave').onclick = function () {
      var rec = hist.list.find(function (r) { return r && r.uid === curTradeUid; });
      if (!rec) return;
      rec.note = $('tmNote').value;
      histPersist(); historyDirty = true; renderHistory();
      toast('备注已保存', 'ok');
    };
    $('btnTmJump').onclick = function () {
      var rec = hist.list.find(function (r) { return r && r.uid === curTradeUid; });
      if (!rec) return;
      var t = rec.exitTime;
      var idx = -1;
      for (var i = 0; i < state.data.length; i++) {
        if (state.data[i].t <= t) idx = i; else break;
      }
      if (idx < state.startIdx) idx = state.startIdx;
      if (idx < 0 || !state.data.length) { toast('当前数据中找不到该时间', 'err'); return; }
      pause();
      seek(idx);
      closeTradeModal();
      /* 记录该笔历史交易的进出场位置，供主图标注回溯 */
      replayTrade = replayMarkerFor(rec);
      /* 若进场点落在视口左侧之外，回卷视口让「进场点」也进入画面，便于同时看清进出场 */
      if (replayTrade && replayTrade.entryIdx >= 0) {
        var eI = replayTrade.entryIdx;
        if (chart.x(eI) < chart.plot.x) chart.scrollToIndex(eI, 0.03);
        chart.clampOffset();
        requestRender();
      }
      toast('已跳到该笔交易平仓处', 'ok');
    };
    $('tradeModal').addEventListener('mousedown', function (e) {
      if (e.target === this) closeTradeModal();
    });
  }

  function openTradeModal(uid) {
    var rec = null;
    for (var i = 0; i < hist.list.length; i++) if (hist.list[i] && hist.list[i].uid === uid) { rec = hist.list[i]; break; }
    if (!rec) return;
    curTradeUid = uid;
    $('tmHead').innerHTML =
      '<span class="tag ' + (rec.side === 'buy' ? 'buy' : 'sell') + '">' + (rec.side === 'buy' ? '做多' : '做空') + ' ' + trimNum(rec.qty) + ' 手</span>' +
      '<span class="mono ' + pnlCls(rec.pnl) + '" style="font-weight:700;font-size:15px">' + sgn(rec.pnl) + '</span>' +
      '<span style="color:#8b93a1;font-size:11px">' + esc(rec.period || '') + ' · ' + esc(rec.symbol || '') + '</span>';
    $('tmGrid').innerHTML =
      '<div><div class="k">开仓价</div><div class="v">' + fmt(rec.entry) + '</div></div>' +
      '<div><div class="k">平仓价</div><div class="v">' + fmt(rec.exit) + '</div></div>' +
      '<div><div class="k">开仓时间</div><div class="v">' + fmtFull(rec.entryTime) + '</div></div>' +
      '<div><div class="k">平仓时间</div><div class="v">' + fmtFull(rec.exitTime) + '</div></div>' +
      '<div><div class="k">平仓原因</div><div class="v">' + esc(rec.reason || '--') + '</div></div>' +
      '<div><div class="k">持有 / 手续费</div><div class="v">' + (rec.bars || 0) + '根 / ' + (rec.fee || 0).toFixed(2) + '</div></div>';
    $('tmNote').value = rec.note || '';
    $('tradeModal').hidden = false;
    drawTradeChart(rec);
  }

  function closeTradeModal() {
    $('tradeModal').hidden = true;
    curTradeUid = null;
  }

  /* 详情弹窗内的K线波段小图 */
  function drawTradeChart(rec) {
    var cv = $('tradeChart');
    var w = cv.clientWidth || 420, h = 190;
    var dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    cv.style.height = h + 'px';
    var ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.font = '10px ' + FONT;
    var seg = rec.seg || [];
    if (seg.length < 2) {
      ctx.fillStyle = '#666e80'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('该记录没有K线波段数据（可能跨周期后产生）', w / 2, h / 2);
      return;
    }
    var padL = 10, padR = 60, padT = 14, padB = 20;
    var iw = w - padL - padR, ih = h - padT - padB;
    var hi = -Infinity, lo = Infinity;
    for (var i = 0; i < seg.length; i++) {
      if (seg[i][2] > hi) hi = seg[i][2];
      if (seg[i][3] < lo) lo = seg[i][3];
    }
    var span0 = (hi - lo) || 1;
    hi += span0 * 0.05; lo -= span0 * 0.05;
    var span = hi - lo;
    function X(i) { return padL + (i + 0.5) / seg.length * iw; }
    function Y(p) { return padT + (hi - p) / span * ih; }
    var bw = Math.max(1, iw / seg.length * 0.62);

    // 网格
    ctx.strokeStyle = '#242938'; ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padL, padT); ctx.lineTo(padL + iw, padT);
    ctx.moveTo(padL, padT + ih); ctx.lineTo(padL + iw, padT + ih);
    ctx.stroke();

    // K线（涨红跌绿）
    for (var k = 0; k < seg.length; k++) {
      var b = seg[k];
      var up = b[4] >= b[1];
      var col = up ? '#e34d59' : '#2ebd85';
      var x = X(k);
      ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, Y(b[2])); ctx.lineTo(x, Y(b[3])); ctx.stroke();
      var yo = Y(b[1]), yc = Y(b[4]);
      ctx.fillRect(x - bw / 2, Math.min(yo, yc), bw, Math.max(1, Math.abs(yc - yo)));
    }

    // 开平仓
    var i0 = clamp(rec.off0 || 0, 0, seg.length - 1);
    var i1 = clamp(rec.off1 || 0, 0, seg.length - 1);
    var x0 = X(i0), y0 = Y(rec.entry), x1 = X(i1), y1 = Y(rec.exit);
    var colLine = rec.pnl >= 0 ? '#e34d59' : '#2ebd85';
    ctx.save();
    ctx.globalAlpha = 0.6;
    ctx.strokeStyle = colLine; ctx.lineWidth = 1.2; ctx.setLineDash([4, 3]);
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
    ctx.restore();

    // 开仓箭头（多=上三角红，空=下三角绿）/ 平仓叉号
    markerArrow(ctx, x0, rec.side === 'buy' ? y0 + 9 : y0 - 9, rec.side === 'buy' ? 1 : -1, rec.side === 'buy' ? '#e34d59' : '#2ebd85');
    markerCross(ctx, x1, y1, colLine);

    // 右侧价格标签
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillStyle = '#4c8dff';
    ctx.fillText('开 ' + fmt(rec.entry), padL + iw + 6, y0);
    ctx.fillStyle = colLine;
    ctx.fillText('平 ' + fmt(rec.exit), padL + iw + 6, y1);

    // 时间
    ctx.fillStyle = '#787b86'; ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    ctx.fillText(fmtTime(seg[0][0]), padL, padT + ih + 4);
    ctx.textAlign = 'right';
    ctx.fillText(fmtTime(seg[seg.length - 1][0]), padL + iw, padT + ih + 4);
  }

  /* ================= 右侧面板 ================= */
  function bindPanels() {
    $('tabs').addEventListener('click', function (e) {
      var b = e.target.closest('button');
      if (!b) return;
      var all = $('tabs').querySelectorAll('button');
      for (var i = 0; i < all.length; i++) all[i].classList.toggle('active', all[i] === b);
      var ps = document.querySelectorAll('.panel');
      for (var j = 0; j < ps.length; j++) ps[j].classList.toggle('active', ps[j].dataset.panel === b.dataset.tab);
      uiDirty = true;
      if (b.dataset.tab === 'stats') setTimeout(drawEquity, 0);
      if (b.dataset.tab === 'hist') renderHistory();
    });

    // 持仓列表事件委托
    $('posList').addEventListener('click', function (e) {
      var b = e.target.closest('button'); if (!b) return;
      var card = b.closest('[data-pos]'); if (!card) return;
      var id = +card.dataset.pos;
      if (b.dataset.a === 'flat') { engine.closePosition(id); afterMutation(); toast('已平仓 #' + id, 'ok'); }
      else if (b.dataset.a === 'save') {
        var sl = card.querySelector('[data-f="sl"]').value;
        var tp = card.querySelector('[data-f="tp"]').value;
        engine.modifyPosition(id, { sl: sl, tp: tp });
        afterMutation(); toast('已更新 #' + id, 'ok');
      }
    });
  }

  function afterMutation() {
    saveSnapshot(state.idx);
    markStructure();
    requestRender();
  }

  /* 快捷开单：市价买入/卖出，数量固定 1 手（B 键买入、S 键卖出） */
  function quickOrder(side) {
    if (!state.data.length) { toast('暂无行情数据', 'err'); return; }
    var r = engine.submit({ type: 'market', side: side, qty: 1 });
    if (!r.ok) { toast(r.msg, 'err'); return; }
    afterMutation();
    toast('市价' + (side === 'buy' ? '买入' : '卖出') + ' 1手 #' + r.id + ' @' + fmt(engine.price()), 'ok');
  }
  /* 快捷全部平仓（C 键） */
  function quickCloseAll() {
    if (!engine.positions.length) { toast('当前没有持仓', 'err'); return; }
    var n = engine.closeAll();
    afterMutation();
    toast('已市价平仓 ' + n + ' 笔持仓', 'ok');
  }

  /* ---- 面板渲染 ---- */
  function renderPanels() {
    $('cntPos').textContent = engine.positions.length;
    var histActive = document.querySelector('.panel[data-panel="hist"]').classList.contains('active');
    if (structureDirty || (histActive && historyDirty)) {
      renderPositions(); renderStats(); renderTrades();
      if (histActive || historyDirty) renderHistory();
      structureDirty = false;
    } else {
      updateLiveCells();
    }
    updateBarInfo();
  }

  function updateLiveCells() {
    // 持仓浮动盈亏（金额 + 百分比）/ 现价 / 持有根数
    var cur = engine.price();
    engine.positions.forEach(function (p) {
      var card = $('posList').querySelector('[data-pos="' + p.id + '"]');
      if (!card) return;
      var fl = (cur - p.entry) * p.qty * (p.side === 'buy' ? 1 : -1);
      var pct = (cur - p.entry) * (p.side === 'buy' ? 1 : -1) / p.entry * 100;
      var v = card.querySelector('.pnl-val');
      if (v) {
        v.className = 'pnl-val ' + pnlCls(fl);
        v.childNodes[0].nodeValue = sgn(fl);          // 更新金额文本，保留百分比 <i>
        var pctEl = card.querySelector('.pnl-pct');
        if (pctEl) { pctEl.textContent = '(' + (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%)'; pctEl.className = 'pnl-pct ' + pnlCls(pct); }
      }
      var c2 = card.querySelector('.pnl-cur'); if (c2) c2.textContent = fmt(cur);
      var hb = card.querySelector('.hold-bars'); if (hb) hb.textContent = (state.idx - p.entryIdx) + '根';
    });
    var st = document.querySelector('.panel[data-panel="stats"]').classList.contains('active');
    if (st) renderStats();
  }

  function renderPositions() {
    var box = $('posList');
    if (!engine.positions.length) { box.innerHTML = '<div class="empty">当前没有持仓<br><span style="font-size:11px">在「下单」页提交订单开始模拟</span></div>'; return; }
    var cur = engine.price();
    var html = '';
    engine.positions.forEach(function (p) {
      var fl = (cur - p.entry) * p.qty * (p.side === 'buy' ? 1 : -1);
      var pct = (cur - p.entry) * (p.side === 'buy' ? 1 : -1) / p.entry * 100;   // 浮动盈亏百分比
      html += '<div class="card" data-pos="' + p.id + '">' +
        '<div class="card-head">' +
        '<span class="tag ' + (p.side === 'buy' ? 'buy' : 'sell') + '">' + (p.side === 'buy' ? '做多' : '做空') + ' ' + trimNum(p.qty) + '</span>' +
        '<span style="font-size:11px;color:#8b93a1">#' + p.id + ' · ' + fmtTime(p.entryTime) + '</span>' +
        '</div>' +
        '<div class="grid2">' +
        '<span>开仓价<b>' + fmt(p.entry) + '</b></span>' +
        '<span>现价<b class="pnl-cur">' + fmt(cur) + '</b></span>' +
        '<span>浮动盈亏<b class="pnl-val ' + pnlCls(fl) + '">' + sgn(fl) + ' <i class="pnl-pct ' + pnlCls(pct) + '">(' + (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%)</i></b></span>' +
        '<span>持有<b class="hold-bars">' + (state.idx - p.entryIdx) + '根</b></span>' +
        '</div>' +
        '<div class="row-edit">' +
        '<input data-f="sl" value="' + (p.sl == null ? '' : p.sl) + '" placeholder="止损价">' +
        '<input data-f="tp" value="' + (p.tp == null ? '' : p.tp) + '" placeholder="止盈价">' +
        '</div>' +
        '<div class="acts"><button data-a="save">保存修改</button><button data-a="flat" class="danger">市价平仓</button></div>' +
        '</div>';
    });
    box.innerHTML = html;
  }

  function renderTrades() {
    var box = $('tradeList');
    if (!engine.trades.length) { box.innerHTML = '<div class="empty">暂无平仓记录</div>'; return; }
    var html = '';
    engine.trades.slice().reverse().forEach(function (t) {
      html += '<div class="card" style="padding:6px 9px">' +
        '<div class="card-head" style="margin-bottom:2px">' +
        '<span class="tag ' + (t.side === 'buy' ? 'buy' : 'sell') + '">' + (t.side === 'buy' ? '多' : '空') + ' ' + trimNum(t.qty) + '</span>' +
        '<span class="mono ' + pnlCls(t.pnl) + '" style="font-weight:600">' + sgn(t.pnl) + '</span>' +
        '</div>' +
        '<div class="grid2">' +
        '<span>开/平<b>' + fmt(t.entry) + ' → ' + fmt(t.exit) + '</b></span>' +
        '<span>原因<b>' + esc(t.reason) + '</b></span>' +
        '<span>持有<b>' + t.bars + '根</b></span>' +
        '<span>费用<b>' + t.fee.toFixed(2) + '</b></span>' +
        '</div></div>';
    });
    box.innerHTML = html;
  }

  function renderStats() {
    var s = engine.stats();
    function cell(k, v, cls) {
      return '<div class="stat"><div class="k">' + k + '</div><div class="v ' + (cls || '') + '">' + v + '</div></div>';
    }
    var rr = isFinite(s.rr) ? s.rr.toFixed(2) : (s.rr === Infinity ? '∞' : '--');
    var pf = isFinite(s.pf) ? s.pf.toFixed(2) : (s.pf === Infinity ? '∞' : '--');
    $('statsBox').innerHTML =
      '<div class="stats-grid">' +
      cell('平仓笔数', s.count) +
      cell('胜率', s.winRate.toFixed(1) + '%') +
      cell('总盈亏', sgn(s.total), pnlCls(s.total)) +
      cell('盈亏比(均盈/均亏)', rr) +
      cell('盈利因子', pf) +
      cell('平均盈亏', sgn(s.avg), pnlCls(s.avg)) +
      cell('最大单笔盈利', s.maxWin ? '+' + s.maxWin.toFixed(d()) : '--', 'pnl-up') +
      cell('最大单笔亏损', s.maxLoss ? '-' + s.maxLoss.toFixed(d()) : '--', 'pnl-down') +
      cell('最大回撤', (s.maxDD > 0 ? '-' : '') + s.maxDD.toFixed(d()), s.maxDD > 0 ? 'pnl-down' : '') +
      cell('盈利/亏损笔数', s.wins + ' / ' + s.losses) +
      cell('浮动盈亏', sgn(s.floating), pnlCls(s.floating)) +
      cell('总权益', sgn(s.equity), pnlCls(s.equity)) +
      '</div>' +
      '<div class="hint" style="margin-top:10px">撮合规则：按整根K线判定，跳空按开盘价成交；同一根K线同时触及止损与止盈时保守判为<b>先止损</b>。</div>';
    drawEquity();
  }

  function drawEquity() {
    var cv = $('equityCanvas');
    if (!cv) return;
    var w = cv.clientWidth || 290, h = 120;
    var dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    cv.style.height = h + 'px';
    var ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.font = '10px ' + FONT;

    var eq = engine.equity;
    if (eq.length < 2) {
      ctx.fillStyle = '#666e80'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('暂无平仓记录', w / 2, h / 2);
      return;
    }
    var lo = 0, hi = 0;
    for (var i = 0; i < eq.length; i++) { if (eq[i].v < lo) lo = eq[i].v; if (eq[i].v > hi) hi = eq[i].v; }
    var cur = engine.equityNow();
    lo = Math.min(lo, cur); hi = Math.max(hi, cur, 0);
    var span = (hi - lo) || 1;
    var padY = 12, padX = 6;
    function px(i) { return padX + i / (eq.length - 1) * (w - padX * 2); }
    function py(v) { return padY + (hi - v) / span * (h - padY * 2); }

    // 零轴
    ctx.strokeStyle = '#2a2e39'; ctx.setLineDash([3, 3]); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(padX, py(0)); ctx.lineTo(w - padX, py(0)); ctx.stroke();
    ctx.setLineDash([]);

    // 面积
    ctx.beginPath();
    ctx.moveTo(px(0), py(eq[0].v));
    for (var j = 1; j < eq.length; j++) ctx.lineTo(px(j), py(eq[j].v));
    var lastX = px(eq.length - 1);
    ctx.lineTo(lastX, py(cur));
    var grad = ctx.createLinearGradient(0, padY, 0, h - padY);
    grad.addColorStop(0, 'rgba(76,141,255,.30)');
    grad.addColorStop(1, 'rgba(76,141,255,.03)');
    ctx.lineTo(lastX, py(Math.max(lo, 0)));
    ctx.lineTo(px(0), py(Math.max(lo, 0)));
    ctx.closePath();
    ctx.fillStyle = grad; ctx.fill();

    // 折线
    ctx.beginPath();
    ctx.moveTo(px(0), py(eq[0].v));
    for (var k = 1; k < eq.length; k++) ctx.lineTo(px(k), py(eq[k].v));
    ctx.strokeStyle = '#4c8dff'; ctx.lineWidth = 1.6; ctx.stroke();

    // 当前总权益点
    ctx.fillStyle = cur >= 0 ? '#ff7a85' : '#42d69b';
    ctx.beginPath(); ctx.arc(lastX, py(cur), 3, 0, Math.PI * 2); ctx.fill();

    ctx.fillStyle = '#666e80'; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.fillText('高 ' + hi.toFixed(2), padX + 2, 2);
    ctx.textBaseline = 'bottom';
    ctx.fillText('低 ' + lo.toFixed(2), padX + 2, h - 2);
    ctx.textAlign = 'right'; ctx.textBaseline = 'top';
    ctx.fillText('当前 ' + sgn(cur), w - padX - 2, 2);
  }

  /* ================= 自定义快捷键 ================= */
  var KEY_STORE = 'kline_replay_keys_v1';
  var KEY_ACTIONS = [
    { id: 'play', name: '播放 / 暂停', def: '=' },
    { id: 'next', name: '下一根K线', def: ' ' },
    { id: 'fullscreen', name: '图表全屏', def: 'f' }
  ];
  var keymap = {};        // action -> key（生效中）
  var keyDraft = null;    // 编辑中的副本
  var keyCapturing = null;// 正在等待按键的 action

  function keysLoad() {
    keymap = {};
    KEY_ACTIONS.forEach(function (a) { keymap[a.id] = a.def; });
    try {
      var o = JSON.parse(localStorage.getItem(KEY_STORE) || '{}');
      KEY_ACTIONS.forEach(function (a) { if (o[a.id]) keymap[a.id] = o[a.id]; });
    } catch (e) { }
  }
  function keysPersist() {
    try { localStorage.setItem(KEY_STORE, JSON.stringify(keymap)); } catch (e) { }
  }
  function normKey(e) {
    return e.key.length === 1 ? e.key.toLowerCase() : e.key;
  }
  function keyName(k) {
    var m = { ' ': '空格', 'ArrowLeft': '←', 'ArrowRight': '→', 'ArrowUp': '↑', 'ArrowDown': '↓', 'Enter': '回车' };
    return m[k] || (k && k.length === 1 ? k.toUpperCase() : k);
  }

  function renderKbdList() {
    var rows = [
      ['play', '播放'], ['next', '下一根'], ['fullscreen', '全屏']
    ];
    var html = '';
    for (var i = 0; i < rows.length; i++) {
      html += '<div class="kh-row"><kbd>' + esc(keyName(keymap[rows[i][0]])) + '</kbd> ' + rows[i][1] + '</div>';
    }
    $('kbdList').innerHTML = html;
  }

  function renderKeyRows() {
    var html = '';
    KEY_ACTIONS.forEach(function (a) {
      var k = keyDraft[a.id];
      html += '<div class="km-row">' +
        '<span class="km-name">' + a.name + '</span>' +
        '<button class="km-key' + (keyCapturing === a.id ? ' capturing' : '') + '" data-act="' + a.id + '">' +
        (keyCapturing === a.id ? '按键…' : esc(keyName(k))) + '</button>' +
        '</div>';
    });
    $('keyRows').innerHTML = html;
  }

  /* ================= 斐波那契比例设置弹窗 ================= */
  var FIB_PRESETS = {
    fib: [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1],
    fibext: [0.618, 1, 1.618, 2, 2.618],
    abcd: [1]
  };
  function openFibModal(it) {
    fibEditing = it;
    $('chkFibDefault').checked = false;
    renderFibLevels(it.levels && it.levels.length ? it.levels.slice() : drawings.getDefaultLevels(it.type).slice());
    $('fibModal').hidden = false;
  }
  function closeFibModal() {
    $('fibModal').hidden = true;
    fibEditing = null;
  }
  function renderFibLevels(arr) {
    var html = '';
    for (var i = 0; i < arr.length; i++) {
      html += '<div class="fib-row">' +
        '<input type="number" step="any" class="fib-input" value="' + esc(arr[i]) + '" placeholder="0.618">' +
        '<button class="fib-del" title="删除" data-idx="' + i + '">&#10005;</button>' +
        '</div>';
    }
    $('fibLevelList').innerHTML = html;
  }
  function readFibLevels() {
    var rows = $('fibLevelList').querySelectorAll('.fib-input');
    var arr = [];
    for (var i = 0; i < rows.length; i++) {
      var n = parseFloat(rows[i].value);
      if (isFinite(n)) arr.push(n);
    }
    arr.sort(function (a, b) { return a - b; });
    return arr;
  }
  function bindFibModal() {
    $('btnFibClose').onclick = closeFibModal;
    $('btnFibCancel').onclick = closeFibModal;
    $('fibModal').addEventListener('mousedown', function (e) { if (e.target === this) closeFibModal(); });
    $('btnFibAdd').onclick = function () {
      var arr = readFibLevels();
      arr.push(0.5);
      renderFibLevels(arr);
      var inputs = $('fibLevelList').querySelectorAll('input');
      if (inputs.length) inputs[inputs.length - 1].focus();
    };
    $('fibLevelList').addEventListener('click', function (e) {
      var b = e.target.closest('.fib-del');
      if (!b) return;
      var arr = readFibLevels();
      var idx = +b.dataset.idx;
      if (idx >= 0 && idx < arr.length) arr.splice(idx, 1);
      renderFibLevels(arr);
    });
    var presets = $('fibModal').querySelectorAll('[data-preset]');
    for (var pi = 0; pi < presets.length; pi++) {
      presets[pi].onclick = function () {
        var p = FIB_PRESETS[this.dataset.preset];
        if (p) renderFibLevels(p.slice());
      };
    }
    $('btnFibSave').onclick = function () {
      if (!fibEditing) return;
      var arr = readFibLevels();
      if (arr.length < 1) { toast('至少需要 1 个有效比例', 'err'); return; }
      fibEditing.levels = arr;
      if ($('chkFibDefault').checked) {
        drawings.setDefaultLevels(fibEditing.type, arr);
      }
      requestRender();
      closeFibModal();
      toast('斐波比例已更新', 'ok');
    };
  }

  function bindKeyModal() {
    $('btnKeys').onclick = function () {
      keyDraft = {};
      KEY_ACTIONS.forEach(function (a) { keyDraft[a.id] = keymap[a.id]; });
      keyCapturing = null;
      renderKeyRows();
      $('keyModal').hidden = false;
    };
    $('btnKeyClose').onclick = closeKeyModal;
    $('keyRows').addEventListener('click', function (e) {
      var b = e.target.closest('.km-key');
      if (!b) return;
      keyCapturing = (keyCapturing === b.dataset.act) ? null : b.dataset.act;
      renderKeyRows();
    });
    $('btnKeyReset').onclick = function () {
      keyDraft = {};
      KEY_ACTIONS.forEach(function (a) { keyDraft[a.id] = a.def; });
      keyCapturing = null;
      renderKeyRows();
    };
    $('btnKeySave').onclick = function () {
      keymap = {};
      KEY_ACTIONS.forEach(function (a) { keymap[a.id] = keyDraft[a.id]; });
      keysPersist();
      renderKbdList();
      closeKeyModal();
      toast('快捷键已保存', 'ok');
    };
    $('keyModal').addEventListener('mousedown', function (e) {
      if (e.target === this) closeKeyModal();
    });
  }
  function closeKeyModal() {
    $('keyModal').hidden = true;
    keyCapturing = null;
  }

  /* 快捷键设置弹窗内的按键捕获 */
  function handleKeyCapture(e) {
    e.preventDefault();
    e.stopPropagation();
    var k = normKey(e);
    if (e.key === 'Escape') { keyCapturing = null; renderKeyRows(); return; }
    if (e.key === 'Shift' || e.key === 'Control' || e.key === 'Alt' || e.key === 'Meta') return;
    if (k === 'Delete' || k === 'Backspace') { toast('Delete / Backspace 为固定功能，不可绑定', 'err'); return; }
    if (!keyCapturing) return;
    // 冲突检测
    for (var i = 0; i < KEY_ACTIONS.length; i++) {
      var a = KEY_ACTIONS[i];
      if (a.id !== keyCapturing && keyDraft[a.id] === k) {
        toast('「' + keyName(k) + '」已绑定给「' + a.name + '」', 'err');
        return;
      }
    }
    keyDraft[keyCapturing] = k;
    keyCapturing = null;
    renderKeyRows();
  }

  function runAction(id) {
    switch (id) {
      case 'play': togglePlay(); break;
      case 'next': pause(); step(1); break;
      case 'fullscreen': toggleFullscreen(); break;
    }
  }

  /* ================= 键盘 ================= */
  function bindKeys() {
    document.addEventListener('keydown', function (e) {
      // 快捷键设置弹窗：捕获按键
      if (!$('keyModal').hidden) { handleKeyCapture(e); return; }
      // 交易详情弹窗：Esc 关闭
      if (!$('tradeModal').hidden) {
        if (e.key === 'Escape') { e.preventDefault(); closeTradeModal(); }
        return;
      }
      // 输入框 / 下拉框内不响应快捷键，避免与输入冲突
      var tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return;

      var k = normKey(e);

      // 固定功能：Delete 删画线，Esc 取消/关闭
      if (k === 'Delete' || k === 'Backspace') {
        if (drawings.removeSelected()) { requestRender(); }
        return;
      }
      if (k === 'Escape') {
        closeCtxMenu();
        if (pending) { pending = null; drawArm = null; setTool('select'); toast('已取消画线'); }
        else { setTool('select'); drawings.selectedId = null; }
        requestRender();
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      /* 固定快捷键（不受自定义 keymap 影响，始终生效）：
       * B 买入 1 手 / S 卖出 1 手 / C 全部平仓 / = 播放·暂停 / 空格 下一根（只前进，无上一根） */
      if (k === 'b') { e.preventDefault(); quickOrder('buy'); return; }
      if (k === 's') { e.preventDefault(); quickOrder('sell'); return; }
      if (k === 'c') { e.preventDefault(); quickCloseAll(); return; }
      if (k === '=') { e.preventDefault(); togglePlay(); return; }
      if (k === ' ') { e.preventDefault(); pause(); step(1); return; }   // 空格只前进，不回退

      for (var i = 0; i < KEY_ACTIONS.length; i++) {
        if (keymap[KEY_ACTIONS[i].id] === k) {
          e.preventDefault();
          runAction(KEY_ACTIONS[i].id);
          return;
        }
      }
    });
  }

  /* ================= 主循环 ================= */
  function frame(now) {
    var dt = now - lastT; lastT = now;
    if (state.playing) {
      acc += dt * state.speed;
      var stepMs = state.baseInterval, guard = 0;
      while (acc >= stepMs && guard < 400) {
        acc -= stepMs; guard++;
        if (state.idx < state.data.length - 1) seek(state.idx + 1);
        else { pause(); acc = 0; break; }
      }
    }
    if (uiDirty) { renderPanels(); uiDirty = false; }
    if (needsRender) { chart.render(); needsRender = false; }
    requestAnimationFrame(frame);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
