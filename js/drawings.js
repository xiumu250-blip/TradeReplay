/* =========================================================
 * drawings.js —— 画线工具
 *  支持：线段 / 射线 / 水平线 / 测量 / 斐波那契回撤 / 斐波那契扩展(AB=CD) / 文字 / 箭头 / 做多盈亏 / 做空盈亏
 *  锚点以 (K线索引 i, 价格 p) 存储，缩放平移后位置自动保持正确
 *  每种工具可自定义颜色与线型（实线/虚线），设置保存在本地
 * ========================================================= */
(function (global) {
  'use strict';

  var HANDLE_R = 5;
  var HIT = 6;
  var FONT = '-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif';
  var FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
  var FIBEXT_LEVELS = [0.618, 1, 1.618, 2, 2.618];
  var CFG_KEY = 'kline_replay_toolcfg_v1';
  var DEFAULT_COLOR = '#f0a020';

  function dist(ax, ay, bx, by) {
    var dx = ax - bx, dy = ay - by;
    return Math.sqrt(dx * dx + dy * dy);
  }
  function distToSeg(px, py, x1, y1, x2, y2) {
    var dx = x2 - x1, dy = y2 - y1;
    var L = dx * dx + dy * dy;
    if (L === 0) return dist(px, py, x1, y1);
    var t = ((px - x1) * dx + (py - y1) * dy) / L;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    return dist(px, py, x1 + t * dx, y1 + t * dy);
  }
  function distToLine(px, py, x1, y1, x2, y2) {
    var dx = x2 - x1, dy = y2 - y1;
    var L = dx * dx + dy * dy;
    if (L === 0) return dist(px, py, x1, y1);
    return Math.abs((px - x1) * dy - (py - y1) * dx) / Math.sqrt(L);
  }
  /* hex 颜色转 rgba（半透明填充用） */
  function hexA(hex, a) {
    var h = String(hex || DEFAULT_COLOR).replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var n = parseInt(h, 16);
    if (isNaN(n)) return 'rgba(240,160,32,' + a + ')';
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
  }
  /* 每种工具需要的锚点数 */
  var NEED = { segment: 2, ray: 2, hline: 1, fib: 2, fibext: 3, text: 1, arrowup: 1, arrowdown: 1, measure: 2, longpnl: 3, shortpnl: 3 };

  function Drawings() {
    this.items = [];
    this.seq = 1;
    this.selectedId = null;
    this.hoverId = null;
    this.color = DEFAULT_COLOR;
    this.dash = false;
    this.tool = 'segment';
    this.toolCfg = this._loadCfg();
    this._applyCfg();
  }

  Drawings.prototype = {

    /* ---------- 工具配置（颜色 / 线型，按工具独立保存） ---------- */
    _loadCfg: function () {
      try {
        var o = JSON.parse(localStorage.getItem(CFG_KEY) || '{}');
        return o && typeof o === 'object' ? o : {};
      } catch (e) { return {}; }
    },
    _saveCfg: function () {
      try { localStorage.setItem(CFG_KEY, JSON.stringify(this.toolCfg)); } catch (e) { }
    },
    _applyCfg: function () {
      var c = this.toolCfg[this.tool];
      this.color = (c && c.color) || DEFAULT_COLOR;
      this.dash = !!(c && c.dash);
    },
    /* 切换当前工具（app.setTool 调用） */
    useTool: function (t) {
      this.tool = t;
      this._applyCfg();
      return { color: this.color, dash: this.dash };
    },
    /* 斐波那契默认比例（按工具类型独立保存） */
    getDefaultLevels: function (type) {
      var c = this.toolCfg[type];
      if (c && c.levels && c.levels.length) return c.levels.slice();
      return (type === 'fibext' ? FIBEXT_LEVELS : FIB_LEVELS).slice();
    },
    setDefaultLevels: function (type, levels) {
      var c = this.toolCfg[type] || {};
      c.levels = levels.slice();
      this.toolCfg[type] = c;
      this._saveCfg();
    },
    setToolColor: function (color) {
      this.color = color;
      var c = this.toolCfg[this.tool] || {};
      c.color = color;
      this.toolCfg[this.tool] = c;
      this._saveCfg();
    },
    setToolDash: function (dash) {
      this.dash = !!dash;
      var c = this.toolCfg[this.tool] || {};
      c.dash = this.dash;
      this.toolCfg[this.tool] = c;
      this._saveCfg();
    },

    /* ---------- 增删改 ---------- */
    add: function (item) {
      item.id = this.seq++;
      item.color = item.color || this.color;
      item.dash = (item.dash == null) ? this.dash : !!item.dash;
      item.width = item.width || 1.6;
      if ((item.type === 'fib' || item.type === 'fibext') && (!item.levels || !item.levels.length)) {
        item.levels = this.getDefaultLevels(item.type);
      }
      this.items.push(item);
      this.selectedId = item.id;
      return item;
    },
    remove: function (id) {
      this.items = this.items.filter(function (d) { return d.id !== id; });
      if (this.selectedId === id) this.selectedId = null;
    },
    removeSelected: function () {
      if (this.selectedId == null) return false;
      this.remove(this.selectedId);
      return true;
    },
    clear: function () { this.items = []; this.selectedId = null; },
    /* 删除全部测量标注（临时标注：点击其他位置自动消失），返回是否有删除 */
    removeMeasure: function () {
      var hit = false;
      for (var i = this.items.length - 1; i >= 0; i--) {
        if (this.items[i].type === 'measure') { this.items.splice(i, 1); hit = true; }
      }
      if (hit && this.selectedId != null && !this.getById(this.selectedId)) this.selectedId = null;
      return hit;
    },
    getById: function (id) {
      for (var i = 0; i < this.items.length; i++) if (this.items[i].id === id) return this.items[i];
      return null;
    },

    /* ---------- 命中测试 ----------
     * 返回 {id, handle}  handle: 0/1/2 = 端点，-1 = 整体
     */
    hitTest: function (chart, x, y) {
      for (var k = this.items.length - 1; k >= 0; k--) {
        var d = this.items[k];
        var pts = this._points(chart, d);
        for (var pi = 0; pi < pts.length; pi++) {
          /* 盈亏工具：开仓点固定，不提供单独手柄（点开仓线 = 整体拖动） */
          if ((d.type === 'longpnl' || d.type === 'shortpnl') && pi === 0) continue;
          if (dist(x, y, pts[pi].x, pts[pi].y) <= HANDLE_R + 3) {
            return { id: d.id, handle: pi };
          }
        }
      }
      /* 盈亏工具：命中整条「止盈线 / 止损线」（不限于端点）即可单独拖动调整 */
      for (var m = this.items.length - 1; m >= 0; m--) {
        var dd = this.items[m];
        if (dd.type !== 'longpnl' && dd.type !== 'shortpnl') continue;
        var pp = this._points(chart, dd);
        if (!pp[0] || !pp[1]) continue;
        var pxa = Math.min(pp[0].x, pp[1].x) - HIT, pxb = Math.max(pp[0].x, pp[1].x) + HIT;
        if (x < pxa || x > pxb) continue;
        if (pp[2] && Math.abs(y - pp[2].y) <= HIT) return { id: dd.id, handle: 2 };   // 止损线
        if (Math.abs(y - pp[1].y) <= HIT) return { id: dd.id, handle: 1 };           // 止盈线
        /* 开仓线/左边界：固定不动，不提供拖动（命中后落到矩形 body 仅选中） */
      }
      for (var j = this.items.length - 1; j >= 0; j--) {
        if (this._hitBody(chart, this.items[j], x, y)) return { id: this.items[j].id, handle: -1 };
      }
      return null;
    },
    _hitBody: function (chart, d, x, y) {
      var p = this._points(chart, d);
      if (d.type === 'hline') {
        return Math.abs(y - chart.y(d.p1.p)) <= HIT;
      }
      if (d.type === 'measure') {
        // 测量工具：命中半透明矩形内部（含边缘容差）
        var mx0 = Math.min(p[0].x, p[1].x), mx1 = Math.max(p[0].x, p[1].x);
        var my0 = Math.min(p[0].y, p[1].y), my1 = Math.max(p[0].y, p[1].y);
        return x >= mx0 - HIT && x <= mx1 + HIT && y >= my0 - HIT && y <= my1 + HIT;
      }
      if (d.type === 'longpnl' || d.type === 'shortpnl') {
        // 盈亏工具：命中三条线（开仓/止盈/止损）覆盖的整个垂直范围
        var pnYs = [p[0].y];
        if (p[1]) pnYs.push(p[1].y);
        if (p[2]) pnYs.push(p[2].y);
        var pmx0 = Math.min(p[0].x, p[1] ? p[1].x : p[0].x), pmx1 = Math.max(p[0].x, p[1] ? p[1].x : p[0].x);
        var pmy0 = Math.min.apply(null, pnYs), pmy1 = Math.max.apply(null, pnYs);
        return x >= pmx0 - HIT && x <= pmx1 + HIT && y >= pmy0 - HIT && y <= pmy1 + HIT;
      }
      if (d.type === 'segment' || d.type === 'ray' || d.type === 'trend') {
        if (d.type === 'ray') {
          // 射线：只命中 p1→p2 方向的延长线上
          var dx = p[1].x - p[0].x, dy = p[1].y - p[0].y;
          var L = dx * dx + dy * dy;
          if (!L) return false;
          var t = ((x - p[0].x) * dx + (y - p[0].y) * dy) / L;
          if (t < 0) return false;
          return distToLine(x, y, p[0].x, p[0].y, p[1].x, p[1].y) <= HIT;
        }
        return distToSeg(x, y, p[0].x, p[0].y, p[1].x, p[1].y) <= HIT;
      }
      if (d.type === 'fib') {
        var p1p = d.p1.p, p2p = d.p2.p;
        var levels = (d.levels && d.levels.length >= 2) ? d.levels : FIB_LEVELS;
        var fx0 = Math.min(p[0].x, p[1].x), fx1 = Math.max(p[0].x, p[1].x);
        for (var li = 0; li < levels.length; li++) {
          var price = p1p + (p2p - p1p) * levels[li];
          var ly = chart.y(price);
          if (distToSeg(x, y, fx0, ly, fx1, ly) <= HIT) return true;
        }
        return false;
      }
      if (d.type === 'fibext') {
        // 仅命中实际绘制的元素：A→B→C 参考折线 与 各比例投影水平线（从 C 的 x 画到右边界）
        if (!d.p3) {
          // 绘制中预览（只点了 A、B）：仅命中 A→B 参考线
          return distToSeg(x, y, p[0].x, p[0].y, p[1].x, p[1].y) <= HIT;
        }
        var A = d.p1, B = d.p2, Cc = d.p3;
        var diff = B.p - A.p;                       // 定向价差（与绘制一致）
        var levels = (d.levels && d.levels.length) ? d.levels : FIBEXT_LEVELS;
        var xe = chart.plot.x + chart.plot.w;        // 投影水平线右端点（与 _fibext 渲染一致）
        // A→B 与 B→C 参考折线
        if (distToSeg(x, y, p[0].x, p[0].y, p[1].x, p[1].y) <= HIT) return true;
        if (distToSeg(x, y, p[1].x, p[1].y, p[2].x, p[2].y) <= HIT) return true;
        // 投影水平线
        for (var ei = 0; ei < levels.length; ei++) {
          var ep = Cc.p + diff * levels[ei];
          var ey = chart.y(ep);
          if (distToSeg(x, y, p[2].x, ey, xe, ey) <= HIT) return true;
        }
        return false;
      }
      if (d.type === 'text') {
        var ctx = chart.ctx;
        ctx.font = (d.fontSize || 13) + 'px ' + FONT;
        var w = ctx.measureText(d.text || '').width + 10;
        var h = (d.fontSize || 13) + 10;
        return x >= p[0].x && x <= p[0].x + w && y >= p[0].y - h / 2 && y <= p[0].y + h / 2;
      }
      if (d.type === 'arrowup' || d.type === 'arrowdown') {
        return Math.abs(x - p[0].x) <= 12 && Math.abs(y - p[0].y) <= 12;
      }
      return false;
    },
    _points: function (chart, d) {
      var a = [{ x: chart.x(d.p1.i), y: chart.y(d.p1.p) }];
      if (d.p2) a.push({ x: chart.x(d.p2.i), y: chart.y(d.p2.p) });
      if (d.p3) a.push({ x: chart.x(d.p3.i), y: chart.y(d.p3.p) });
      return a;
    },

    /* ---------- 渲染 ---------- */
    render: function (ctx, chart) {
      var pl = chart.plot;
      ctx.save();
      ctx.beginPath();
      ctx.rect(pl.x, pl.y, pl.w, pl.h);
      ctx.clip();
      for (var i = 0; i < this.items.length; i++) {
        var d = this.items[i];
        if (!d || !d.p1) continue;
        this.drawItem(ctx, chart, d, d.id === this.selectedId, d.id === this.hoverId);
      }
      ctx.restore();
    },

    /* 单条画线渲染（绘制中的预览也走这里） */
    drawItem: function (ctx, chart, d, sel, hov) {
      var pl = chart.plot;
      ctx.save();
      ctx.lineWidth = (d.width || 1.6) + (sel ? 0.8 : 0) + (hov ? 0.4 : 0);
      ctx.strokeStyle = d.color;
      ctx.fillStyle = d.color;
      ctx.setLineDash(d.dash ? [6, 4] : []);
      switch (d.type) {
        case 'segment': case 'trend': this._segment(ctx, chart, d, d.type === 'trend'); break;
        case 'ray': this._ray(ctx, chart, d); break;
        case 'hline': this._hline(ctx, chart, d); break;
        case 'fib': this._fib(ctx, chart, d); break;
        case 'fibext': this._fibext(ctx, chart, d); break;
        case 'text': this._text(ctx, chart, d); break;
        case 'arrowup': case 'arrowdown': this._arrow(ctx, chart, d); break;
        case 'measure': this._measure(ctx, chart, d); break;
        case 'longpnl': case 'shortpnl': this._pnl(ctx, chart, d); break;
      }
      ctx.setLineDash([]);
      if (sel) this._handles(ctx, chart, d);
      ctx.restore();
    },

    _handles: function (ctx, chart, d) {
      var p = this._points(chart, d);
      ctx.save();
      for (var i = 0; i < p.length; i++) {
        ctx.beginPath();
        ctx.arc(Math.round(p[i].x) + 0.5, Math.round(p[i].y) + 0.5, HANDLE_R, 0, Math.PI * 2);
        ctx.fillStyle = '#131722';
        ctx.fill();
        ctx.lineWidth = 1.6;
        ctx.strokeStyle = d.color;
        ctx.stroke();
      }
      ctx.restore();
    },

    /* 线段（trend=双向延伸，兼容旧数据） */
    _segment: function (ctx, chart, d, extend) {
      var x1 = chart.x(d.p1.i), y1 = chart.y(d.p1.p);
      var x2 = chart.x(d.p2.i), y2 = chart.y(d.p2.p);
      if (Math.abs(x2 - x1) < 0.01 && Math.abs(y2 - y1) < 0.01) return;
      if (!extend) {
        ctx.beginPath();
        ctx.moveTo(x1, y1); ctx.lineTo(x2, y2);
        ctx.stroke();
        return;
      }
      var pp = chart.pricePane;
      var dx = x2 - x1, dy = y2 - y1;
      var k = dy / (dx || 0.0001);
      var xa = chart.plot.x - 20, xb = chart.plot.x + chart.plot.w + 20;
      ctx.beginPath();
      if (Math.abs(dx) < 0.01) {
        ctx.moveTo(x1, pp.y - 20); ctx.lineTo(x1, pp.y + pp.h + 20);
      } else {
        ctx.moveTo(xa, y1 + (xa - x1) * k); ctx.lineTo(xb, y1 + (xb - x1) * k);
      }
      ctx.stroke();
    },

    /* 射线：从 p1 经 p2 方向延伸到图表边缘 */
    _ray: function (ctx, chart, d) {
      var x1 = chart.x(d.p1.i), y1 = chart.y(d.p1.p);
      var x2 = chart.x(d.p2.i), y2 = chart.y(d.p2.p);
      var dx = x2 - x1, dy = y2 - y1;
      if (Math.abs(dx) < 0.01 && Math.abs(dy) < 0.01) return;
      var pl = chart.plot;
      // 取足够大的延伸系数到达边界
      var t = 1e5;
      if (dx > 0) t = Math.min(t, (pl.x + pl.w + 20 - x1) / dx);
      else if (dx < 0) t = Math.min(t, (pl.x - 20 - x1) / dx);
      if (dy > 0) t = Math.min(t, (pl.y + pl.h + 20 - y1) / dy);
      else if (dy < 0) t = Math.min(t, (pl.y - 20 - y1) / dy);
      ctx.beginPath();
      ctx.moveTo(x1, y1); ctx.lineTo(x1 + dx * t, y1 + dy * t);
      ctx.stroke();
    },

    _hline: function (ctx, chart, d) {
      var y = chart.y(d.p1.p);
      var pl = chart.plot;
      ctx.beginPath();
      ctx.moveTo(pl.x, y); ctx.lineTo(pl.x + pl.w, y);
      ctx.stroke();
      var label = d.label != null ? d.label : d.p1.p.toFixed(chart.priceDigits);
      ctx.font = '10px ' + FONT;
      var w = ctx.measureText(label).width + 8;
      ctx.fillStyle = d.color;
      ctx.fillRect(pl.x + 2, y - 15, w, 14);
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, pl.x + 6, y - 8);
    },

    _fmtLv: function (lv) {
      return String(Math.round(lv * 1000) / 1000);
    },

    /* 斐波那契回撤：比例可用 d.levels 自定义
     * 无背景填充，水平线只覆盖 A→B 的横向范围，不向右无限延长 */
    _fib: function (ctx, chart, d) {
      var p1 = d.p1.p, p2 = d.p2.p;
      var levels = (d.levels && d.levels.length >= 2) ? d.levels : FIB_LEVELS;
      var x1 = chart.x(d.p1.i), x2 = chart.x(d.p2.i);
      var xs = Math.min(x1, x2);
      var xe = Math.max(Math.max(x1, x2), xs + 28);   // 两点重合时也保留最小可视宽度
      ctx.save();
      for (var i = 0; i < levels.length; i++) {
        var lv = levels[i];
        var price = p1 + (p2 - p1) * lv;
        var y = chart.y(price);
        ctx.strokeStyle = d.color;
        ctx.lineWidth = (lv === 0.5 ? 1.4 : 0.9) * (d.width || 1.6);
        ctx.setLineDash(d.dash && (lv === 0 || lv === 1) ? [6, 4] : (lv === 0 || lv === 1) ? [] : [4, 3]);
        ctx.beginPath();
        ctx.moveTo(xs, y); ctx.lineTo(xe, y);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.font = '10px ' + FONT;
        ctx.fillStyle = d.color;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'bottom';
        ctx.fillText(this._fmtLv(lv) + '  ' + price.toFixed(chart.priceDigits), xs + 4, y - 2);
      }
      ctx.restore();
    },

    /* 斐波那契扩展（AB=CD）：A=p1, B=p2, C=p3
     * 以 B→A 的价差（带方向）从 C 投影：D = C + ratio × (B - A) */
    _fibext: function (ctx, chart, d) {
      var pl = chart.plot;
      var A = d.p1, B = d.p2, C = d.p3;
      if (!A || !B) return;
      var ax = chart.x(A.i), ay = chart.y(A.p);
      var bx = chart.x(B.i), by = chart.y(B.p);
      // 缺 C 点（绘制中预览，只点了 A、B）：先画 A→B 参考线
      if (!C) {
        ctx.save();
        ctx.globalAlpha = 0.85;
        ctx.beginPath();
        ctx.moveTo(ax, ay); ctx.lineTo(bx, by);
        ctx.stroke();
        ctx.globalAlpha = 1;
        ctx.font = '10px ' + FONT;
        ctx.fillStyle = d.color;
        ctx.textAlign = 'center'; ctx.textBaseline = 'top';
        ctx.fillText('A', ax, ay + 4); ctx.fillText('B', bx, by + 4);
        ctx.restore();
        return;
      }
      var cx = chart.x(C.i), cy = chart.y(C.p);
      var levels = (d.levels && d.levels.length) ? d.levels : FIBEXT_LEVELS;
      var diff = B.p - A.p;   // 定向价差
      ctx.save();

      // A→B→C 参考折线
      ctx.globalAlpha = 0.85;
      ctx.beginPath();
      ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.lineTo(cx, cy);
      ctx.stroke();
      ctx.globalAlpha = 1;

      // 比例投影水平线（从 C 的 x 画到右边界）
      for (var i = 0; i < levels.length; i++) {
        var lv = levels[i];
        var price = C.p + diff * lv;
        var y = chart.y(price);
        ctx.strokeStyle = d.color;
        ctx.lineWidth = (lv === 1 ? 1.4 : 0.9) * (d.width || 1.6);
        ctx.setLineDash(d.dash ? [6, 4] : (lv === 1 ? [] : [4, 3]));
        ctx.beginPath();
        ctx.moveTo(cx, y); ctx.lineTo(pl.x + pl.w, y);
        ctx.stroke();
        ctx.setLineDash([]);
        var label = (lv === 1 ? 'AB=CD  ' : this._fmtLv(lv) + '  ') + price.toFixed(chart.priceDigits);
        ctx.font = '10px ' + FONT;
        ctx.fillStyle = d.color;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'bottom';
        ctx.fillText(label, cx + 4, y - 2);
      }
      // A/B/C 端点小标签
      ctx.font = '10px ' + FONT;
      ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      ctx.fillStyle = d.color;
      ctx.fillText('A', ax, ay + 4); ctx.fillText('B', bx, by + 4); ctx.fillText('C', cx, cy + 4);
      ctx.restore();
    },

    _text: function (ctx, chart, d) {
      var x = chart.x(d.p1.i), y = chart.y(d.p1.p);
      var size = d.fontSize || 13;
      ctx.save();
      ctx.font = size + 'px ' + FONT;
      var w = ctx.measureText(d.text || '').width + 10;
      ctx.fillStyle = 'rgba(19,23,34,.86)';
      ctx.fillRect(x, y - size / 2 - 4, w, size + 9);
      ctx.strokeStyle = d.color;
      ctx.lineWidth = 1;
      ctx.strokeRect(x, y - size / 2 - 4, w, size + 9);
      ctx.fillStyle = d.color;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(d.text || '', x + 5, y + 1);
      ctx.restore();
    },

    /* 蘑菇状箭头：三角箭头头部 + 矩形箭身，单击即放置；arrowup=看涨，arrowdown=看跌 */
    _arrow: function (ctx, chart, d) {
      var p = this._points(chart, d)[0];
      var capW = 8;     // 三角头部半宽
      var capH = 9;     // 三角头部高度
      var bodyW = 4;    // 矩形箭身半宽
      var bodyH = 13;   // 矩形箭身高度
      var half = (capH + bodyH) / 2;   // 整体半高，整体以 p 为中心
      ctx.save();
      ctx.fillStyle = d.color;
      if (d.type === 'arrowdown') {
        // 三角头部朝下（在底部），矩形箭身在上方
        ctx.beginPath();
        ctx.moveTo(p.x, p.y + half);                       // 顶点（朝下）
        ctx.lineTo(p.x - capW, p.y + half - capH);         // 头部左上
        ctx.lineTo(p.x + capW, p.y + half - capH);         // 头部右上
        ctx.closePath();
        ctx.fill();
        var topY = p.y - half, botY = p.y + half - capH;   // 箭身：头部基线到顶端
        ctx.fillRect(p.x - bodyW, topY, bodyW * 2, botY - topY);
      } else {
        // 三角头部朝上（在顶部），矩形箭身在下方
        ctx.beginPath();
        ctx.moveTo(p.x, p.y - half);                       // 顶点（朝上）
        ctx.lineTo(p.x - capW, p.y - half + capH);         // 头部左下
        ctx.lineTo(p.x + capW, p.y - half + capH);         // 头部右下
        ctx.closePath();
        ctx.fill();
        var y0 = p.y - half + capH, y1 = p.y + half;       // 箭身：头部基线到底端
        ctx.fillRect(p.x - bodyW, y0, bodyW * 2, y1 - y0);
      }
      ctx.restore();
    },

    /* 测量工具：半透明矩形（虚线边缘）+ 中央标注「K线根数 + 波动百分比」
     * 两点对角确定矩形；根数 = |i2-i1| + 1（含两端）；百分比 = (p2-p1)/p1 × 100，带正负号
     * 临时标注：保留在图表上，点击其他位置自动消失 */
    _measure: function (ctx, chart, d) {
      var x1 = chart.x(d.p1.i), y1 = chart.y(d.p1.p);
      var x2 = chart.x(d.p2.i), y2 = chart.y(d.p2.p);
      if (Math.abs(x2 - x1) < 0.01 && Math.abs(y2 - y1) < 0.01) return;
      var rx = Math.min(x1, x2), rw = Math.abs(x2 - x1);
      var ry = Math.min(y1, y2), rh = Math.abs(y2 - y1);
      ctx.save();
      // 半透明填充矩形
      ctx.fillStyle = hexA(d.color, 0.16);
      ctx.fillRect(rx, ry, rw, rh);
      // 虚线边缘
      ctx.strokeStyle = d.color;
      ctx.lineWidth = 1;
      ctx.setLineDash([5, 4]);
      ctx.strokeRect(rx + 0.5, ry + 0.5, Math.max(0, rw - 1), Math.max(0, rh - 1));
      ctx.setLineDash([]);
      // 端点圆点（拖动手柄）
      ctx.fillStyle = d.color;
      ctx.beginPath(); ctx.arc(x1, y1, 2.6, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(x2, y2, 2.6, 0, Math.PI * 2); ctx.fill();
      // 中央统计标注：K线根数 + 波动百分比
      var n = Math.round(Math.abs(d.p2.i - d.p1.i)) + 1;      // 含两端的K线根数
      var base = d.p1.p || 1;
      var pct = (d.p2.p - d.p1.p) / base * 100;
      var txt1 = n + ' 根';
      var txt2 = (pct >= 0 ? '+' : '-') + Math.abs(pct).toFixed(2) + '%';
      ctx.font = '10px ' + FONT;
      var w1 = ctx.measureText(txt1).width, w2 = ctx.measureText(txt2).width;
      var w = Math.max(w1, w2) + 12, h = 30;
      var mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
      // 标注框夹在图表区内：默认中点上方，放不下换下方
      var pl = chart.plot;
      var bx = Math.max(pl.x + 2, Math.min(mx - w / 2, pl.x + pl.w - w - 2));
      var by = my - h - 10;
      if (by < pl.y + 2) by = my + 10;
      if (by + h > pl.y + pl.h - 2) by = my - h - 10;
      ctx.fillStyle = 'rgba(19,23,34,.85)';
      ctx.fillRect(bx, by, w, h);
      ctx.strokeStyle = d.color;
      ctx.strokeRect(bx, by, w, h);
      ctx.fillStyle = d.color;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(txt1, bx + w / 2, by + 9);
      ctx.fillText(txt2, bx + w / 2, by + 21);
      ctx.restore();
    },

    /* 盈亏工具：计算「离场位置」——预设止盈/止损价位在 [开仓+1, 右边界] 区间内
     * 首次被K线触发（打到）的K线索引与价位（离场位置不由用户手动绘制）。
     * 规则：
     *   做多：止盈 = 最高价 ≥ 止盈价；止损 = 最低价 ≤ 止损价
     *   做空：止盈 = 最低价 ≤ 止盈价；止损 = 最高价 ≥ 止损价
     * 互斥规则（关键，避免「同时出现两条离场连线」）：
     *   ① 「先行触发即平仓」：从开仓后第一根K线开始逐根扫描，**第一个被触发的
     *      价位就是该笔交易的离场**；其后序K线不再判定另一价位。
     *   ② 同根K线若同时打穿 TP 与 SL，按行业「不利方先行」惯例——
     *      取距离开仓价更近的那个价位作为该K线的触发方向（爆仓K线视为止损）。
     *   ③ 区间内任一价位均未触发 → 对应连线不绘制。
     * 返回 {tp, sl}：仅有一个非 null，另一个保持 null；互斥时另一条绝不画虚线。 */
    pnlExit: function (chart, d) {
      var long = d.type === 'longpnl';
      var data = chart.data || [];
      if (!data.length || !d.p1 || !d.p2) return { tp: null, sl: null };
      var i0 = Math.max(0, Math.round(d.p1.i));
      var i1 = Math.max(i0 + 1, Math.round(d.p2.i));
      // 触发判断只看「当前回放可见范围」内的K线（chart.maxIndex）——
      // 未解锁的未来K线不得参与触发，否则会"未触止损已画连线"。
      // 未提供 maxIndex（单元测试桩等）时回退到 data.length - 1。
      var maxI = (typeof chart.maxIndex === 'number' && chart.maxIndex >= 0) ? chart.maxIndex : data.length - 1;
      i1 = Math.min(i1, maxI);
      var tpP = d.p2 ? d.p2.p : null;
      var slP = d.p3 ? d.p3.p : null;
      var entryP = d.p1.p;
      var tp = null, sl = null;
      for (var i = i0 + 1; i <= i1; i++) {
        var b = data[i];
        if (!b) continue;
        /* 单根K线分别判断两个价位是否被这根K线触及 */
        var hitTp = tpP != null && (long ? b.h >= tpP : b.l <= tpP);
        var hitSl = slP != null && (long ? b.l <= slP : b.h >= slP);
        if (!hitTp && !hitSl) continue;
        /* 同一根K线同时打穿两个价位 → 「更靠近开仓者先行」——
         * 假设价位同时被打到，K线先打到更近的那个价位（爆仓K线视为止损） */
        if (hitTp && hitSl) {
          if (Math.abs(tpP - entryP) < Math.abs(slP - entryP)) hitSl = false;
          else hitTp = false;
        }
        if (hitTp && !tp) { tp = { i: i, p: tpP }; break; }
        if (hitSl && !sl) { sl = { i: i, p: slP }; break; }
      }
      return { tp: tp, sl: sl };
    },

    /* 做多盈亏 / 做空盈亏：矩形区域（开仓线 + 止盈线 + 止损线）
     * p1 = 开仓（首次点击，固定），p2 = 止盈（默认价，索引 = 矩形右边界），p3 = 止损（自动对称生成或手动拖动）
     * 布局：矩形横跨 [左边界 x(p1.i), 右边界 x(p2.i)]，三条水平线横贯矩形宽度，中间填充半透明色带
     * 颜色规则「盈红亏绿」：
     *   做多：止盈在开仓上方(红色区)、止损在开仓下方(绿色区)
     *   做空：止盈在开仓下方(红色区)、止损在开仓上方(绿色区)
     *   开仓线始终为紫色虚线 */
    _pnl: function (ctx, chart, d) {
      var long = d.type === 'longpnl';
      var x1 = chart.x(d.p1.i), yEntry = chart.y(d.p1.p);
      var yTP = d.p2 ? chart.y(d.p2.p) : yEntry;
      var ySL = d.p3 ? chart.y(d.p3.p) : yEntry;
      var x2 = d.p2 ? chart.x(d.p2.i) : x1;

      /* 确定三条线的 Y 顺序（屏幕坐标） */
      var yMid, yTP_line, ySL_line;
      if (long) {
        /* 做多：止盈在上（红），止损在下（绿），开仓在中 */
        yTP_line = Math.min(yTP, yEntry);       // 止盈线在上方
        ySL_line = Math.max(ySL, yEntry);       // 止损线在下方
        yMid = yEntry;
      } else {
        /* 做空：止盈在下（红），止损在上（绿），开仓在中 */
        yTP_line = Math.max(yTP, yEntry);       // 止盈线在下方
        ySL_line = Math.min(ySL, yEntry);       // 止损线在上方
        yMid = yEntry;
      }

      /* 矩形左右边界：左 = 开仓列，右 = 止盈索引列 */
      var rx = Math.min(x1, x2), rw = Math.max(1, Math.abs(x2 - x1));
      var cx = rx + rw / 2;
      var pl = chart.plot;

      /* 价格与幅度计算 */
      var entryPrice = d.p1.p;
      var tpPrice = d.p2 ? d.p2.p : entryPrice;
      var slPrice = d.p3 ? d.p3.p : entryPrice;
      var tpAmt = Math.abs(tpPrice - entryPrice);
      var slAmt = Math.abs(slPrice - entryPrice);
      var tpPct = tpAmt / (entryPrice || 1) * 100;
      var slPct = slAmt / (entryPrice || 1) * 100;
      var rrRatio = slAmt > 0.001 ? (tpAmt / slAmt).toFixed(2) : '∞';

      /* 固定颜色 */
      var C_TP = '#e34d59';          // 止盈 = 红（盈利色）
      var C_SL = '#2ebd85';          // 止损 = 绿（亏损色）
      var C_ENTRY = '#a855f7';       // 开仓 = 紫

      ctx.save();
      ctx.beginPath();
      ctx.rect(pl.x, pl.y, pl.w, pl.h);
      ctx.clip();

      /* ---- 1. 止盈带（淡红透明填充 + 实线上边框）---- */
      if (Math.abs(yTP_line - yMid) > 0.5) {
        var tpFillTop = long ? yTP_line : yMid;
        var tpFillBot = long ? yMid : yTP_line;
        var tpH = Math.abs(tpFillBot - tpFillTop);
        ctx.fillStyle = hexA(C_TP, 0.18);
        ctx.fillRect(rx, Math.min(tpFillTop, tpFillBot), rw, tpH);
        ctx.strokeStyle = C_TP;
        ctx.lineWidth = 0.8;
        ctx.beginPath();
        ctx.moveTo(rx, yTP_line); ctx.lineTo(rx + rw, yTP_line);
        ctx.stroke();
        /* 止盈标签 */
        ctx.font = '10px ' + FONT;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        var tpSign = long ? '+' : '-';
        var tpTxt = '止盈 ' + tpPrice.toFixed(2) + ' · ' + tpSign + tpAmt.toFixed(2) + ' (' + tpSign + tpPct.toFixed(2) + '%)';
        ctx.fillStyle = C_TP;
        ctx.fillText(tpTxt, cx, yTP_line);
      }

      /* ---- 2. 止损带（淡绿透明填充 + 实线下边框）---- */
      if (Math.abs(ySL_line - yMid) > 0.5) {
        var slFillTop = long ? yMid : ySL_line;
        var slFillBot = long ? ySL_line : yMid;
        var slH = Math.abs(slFillBot - slFillTop);
        ctx.fillStyle = hexA(C_SL, 0.18);
        ctx.fillRect(rx, Math.min(slFillTop, slFillBot), rw, slH);
        ctx.strokeStyle = C_SL;
        ctx.lineWidth = 0.8;
        ctx.beginPath();
        ctx.moveTo(rx, ySL_line); ctx.lineTo(rx + rw, ySL_line);
        ctx.stroke();
        /* 止损标签 */
        ctx.font = '10px ' + FONT;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        var slSign = long ? '-' : '+';
        var slTxt = '止损 ' + slPrice.toFixed(2) + ' · ' + slSign + slAmt.toFixed(2) + ' (' + slSign + slPct.toFixed(2) + '%)';
        ctx.fillStyle = C_SL;
        ctx.fillText(slTxt, cx, ySL_line);
      }

      /* ---- 3. 开仓 → 止盈/止损 离场路径虚线 ----
       * 离场位置不由用户手动绘制：按K线高低价，取「预设止盈/止损价位在 [开仓+1, 右边界]
       * 区间内首次被触发」的K线位置自动生成连线（区间内未触发则该条连线不绘制） */
      var exit = this.pnlExit(chart, d);
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      if (exit.tp && Math.abs(chart.y(exit.tp.p) - yEntry) > 0.5) {
        var exTpX = chart.x(exit.tp.i), exTpY = chart.y(exit.tp.p);
        ctx.strokeStyle = hexA(C_TP, 0.7);
        ctx.beginPath(); ctx.moveTo(x1, yEntry); ctx.lineTo(exTpX, exTpY); ctx.stroke();
        ctx.fillStyle = C_TP;
        ctx.beginPath(); ctx.arc(exTpX, exTpY, 3, 0, Math.PI * 2); ctx.fill();   // 止盈触发离场标记
      }
      if (exit.sl && Math.abs(chart.y(exit.sl.p) - yEntry) > 0.5) {
        var exSlX = chart.x(exit.sl.i), exSlY = chart.y(exit.sl.p);
        ctx.strokeStyle = hexA(C_SL, 0.7);
        ctx.beginPath(); ctx.moveTo(x1, yEntry); ctx.lineTo(exSlX, exSlY); ctx.stroke();
        ctx.fillStyle = C_SL;
        ctx.beginPath(); ctx.arc(exSlX, exSlY, 3, 0, Math.PI * 2); ctx.fill();   // 止损触发离场标记
      }
      ctx.setLineDash([]);

      /* ---- 4. 开仓成本线（紫色虚线，横贯整个矩形宽度）---- */
      ctx.strokeStyle = C_ENTRY;
      ctx.lineWidth = 1;
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      ctx.moveTo(rx, yEntry); ctx.lineTo(rx + rw, yEntry);
      ctx.stroke();
      ctx.setLineDash([]);
      /* 开仓标签 */
      ctx.font = '10px ' + FONT;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      var entryTxt = '开仓 ' + entryPrice.toFixed(2) + ' · 盈亏比 1:' + rrRatio;
      ctx.fillStyle = C_ENTRY;
      ctx.fillText(entryTxt, cx, yEntry);

      /* ---- 5. 端点拖动手柄（开仓在左边界，止盈/止损在右边界）---- */
      ctx.fillStyle = d.color;
      ctx.beginPath(); ctx.arc(x1, yEntry, 3, 0, Math.PI * 2); ctx.fill();   // handle 0: 开仓（左侧固定）
      if (d.p2) { ctx.beginPath(); ctx.arc(x2, yTP, 3, 0, Math.PI * 2); ctx.fill(); }  // handle 1: 止盈（右端点）
      if (d.p3) { ctx.beginPath(); ctx.arc(x2, ySL, 3, 0, Math.PI * 2); ctx.fill(); }  // handle 2: 止损（右端点）

      ctx.restore();
    }
  };

  global.Drawings = Drawings;
  global.FIB_LEVELS = FIB_LEVELS;
  global.FIBEXT_LEVELS = FIBEXT_LEVELS;
  global.DRAW_NEED = NEED;
})(window);
