/* =========================================================
 * chart.js —— Canvas K线图表引擎
 *  · 蜡烛图 + 成交量
 *  · 滚轮缩放 / 拖拽平移 / 十字光标
 *  · maxIndex 控制可见的最后一根 K 线（回放隐藏未来数据）
 * ========================================================= */
(function (global) {
  'use strict';

  /* 配色（涨红跌绿）；深色 / 浅色两套，运行时可切换 */
  var PALETTES = {
    dark: {
      bg: '#131722',
      grid: '#1e222d',
      gridStrong: '#2a2e39',
      axis: '#2a2e39',
      axisText: '#787b86',
      text: '#d1d4dc',
      up: '#e34d59',      // 涨 红
      down: '#2ebd85',    // 跌 绿
      cross: '#758696',
      nowLine: '#4a4f5c',
      volUp: 'rgba(227,77,89,.55)',
      volDown: 'rgba(46,189,133,.55)',
      labelBg: '#363a45',
      labelText: '#d1d4dc',
      wickUp: '#e34d59',
      wickDown: '#2ebd85'
    }
    /* 主题切换（白天/黑夜）功能已移除，仅保留深色交易终端配色 */
  };
  var C = PALETTES.dark;
  var FONT = '-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif';

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

  function niceStep(range, target) {
    if (!(range > 0)) return 1;
    var raw = range / Math.max(1, target);
    var mag = Math.pow(10, Math.floor(Math.log10(raw)));
    var n = raw / mag;
    var s = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
    return s * mag;
  }

  var NICE = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000];
  function niceIndexStep(x) {
    for (var i = 0; i < NICE.length; i++) if (NICE[i] >= x) return NICE[i];
    return Math.ceil(x / 5000) * 5000;
  }

  function pad2(n) { return n < 10 ? '0' + n : '' + n; }

  function KLineChart(canvas) {
    this.c = canvas;
    this.ctx = canvas.getContext('2d');
    this.data = [];
    this.maxIndex = -1;          // 可见的最后一根K线索引
    this.offset = 0;             // 左边缘对应的K线索引（浮点）
    this.cw = 9;                 // 单根K线宽（px）
    this.pad = { l: 8, r: 74, t: 12, b: 24 };
    this.volRatio = 0.2;
    this.showVolume = false;       // 成交量副图默认关闭，界面不再提供开启入口
    this.showEMA = true;           // EMA20 默认开启
    this.emaColor = '#ffd700';        // EMA20 颜色（可自定义，默认金）
    this.ema = [];
    this.mouse = null;
    this.priceDigits = 2;
    this.interval = 3600000;
    this.drawingsRender = null;  // function(ctx, chart)
    this.overlaysRender = null;  // function(ctx, chart)
    this.w = 0; this.h = 0; this.dpr = 1;
    this._minP = 0; this._maxP = 1; this._maxVol = 1;
    this.priceZoom = 1;          // 纵轴缩放系数：>1 拉近距离（显示为更小的价格区间）
  }

  KLineChart.prototype = {

    /* ---------------- 数据 ---------------- */
    setData: function (data) {
      this.data = data || [];
      this.maxIndex = this.data.length - 1;
      // 推断 K 线周期
      if (this.data.length > 2) {
        var d = [];
        for (var i = 1; i < Math.min(60, this.data.length); i++) {
          var gap = this.data[i].t - this.data[i - 1].t;
          if (gap > 0) d.push(gap);
        }
        d.sort(function (a, b) { return a - b; });
        this.interval = d.length ? d[Math.floor(d.length / 2)] : 3600000;
      }
      var mp = 0;
      for (var j = 0; j < this.data.length; j++) mp = Math.max(mp, this.data[j].h);
      this.priceDigits = mp >= 1000 ? 2 : mp >= 10 ? 2 : mp >= 1 ? 4 : 6;
      this.cw = 9;
      this.offset = 0;
      this._computeEMA(20);
    },

    /* 切换主题配色（dark / light） —— 主题切换功能已移除 */

    /* ---------------- 尺寸 ---------------- */
    resize: function () {
      var host = this.c.parentElement;
      var rect = host.getBoundingClientRect();
      this.dpr = window.devicePixelRatio || 1;
      this.w = Math.max(60, Math.floor(rect.width));
      this.h = Math.max(60, Math.floor(rect.height));
      this.c.width = Math.floor(this.w * this.dpr);
      this.c.height = Math.floor(this.h * this.dpr);
      this.c.style.width = this.w + 'px';
      this.c.style.height = this.h + 'px';
    },

    /* ---------------- 布局 ---------------- */
    get plot() {
      var p = this.pad;
      return {
        x: p.l, y: p.t,
        w: Math.max(20, this.w - p.l - p.r),
        h: Math.max(20, this.h - p.t - p.b)
      };
    },
    get pricePane() {
      var pl = this.plot;
      var vh = this.showVolume ? Math.max(26, pl.h * this.volRatio) : 0;
      var gap = this.showVolume ? 10 : 0;
      return { x: pl.x, y: pl.y, w: pl.w, h: Math.max(20, pl.h - vh - gap) };
    },
    get volPane() {
      var pl = this.plot;
      if (!this.showVolume) return { x: pl.x, y: pl.y + pl.h, w: pl.w, h: 0 };
      var vh = Math.max(26, pl.h * this.volRatio);
      return { x: pl.x, y: pl.y + pl.h - vh, w: pl.w, h: vh };
    },
    visibleCount: function () { return this.plot.w / this.cw; },

    /* ---------------- 坐标变换 ---------------- */
    x: function (i) { return this.plot.x + (i - this.offset) * this.cw + this.cw / 2; },
    idxAt: function (x) { return (x - this.plot.x) / this.cw + this.offset - 0.5; },
    y: function (p) {
      var pp = this.pricePane;
      return pp.y + (this._maxP - p) / (this._maxP - this._minP || 1) * pp.h;
    },
    priceAt: function (y) {
      var pp = this.pricePane;
      return this._maxP - (y - pp.y) / pp.h * (this._maxP - this._minP);
    },
    volY: function (v) {
      var vp = this.volPane;
      return vp.y + vp.h - (v / (this._maxVol || 1)) * vp.h;
    },

    /* ---------------- 价格区间 ---------------- */
    /* 自动区间（按当前可见K线） */
    autoRange: function () {
      var i0 = Math.max(0, Math.floor(this.offset));
      var i1 = Math.min(this.maxIndex, Math.ceil(this.offset + this.visibleCount()));
      var lo = Infinity, hi = -Infinity;
      for (var i = i0; i <= i1; i++) {
        var b = this.data[i];
        if (!b) continue;
        if (b.l < lo) lo = b.l;
        if (b.h > hi) hi = b.h;
      }
      if (!isFinite(lo)) {
        var k = this.data[clamp(this.maxIndex, 0, this.data.length - 1)] || { l: 0, h: 1 };
        lo = k.l; hi = k.h;
      }
      if (hi - lo < 1e-9) { hi = lo + Math.max(1, Math.abs(lo) * 0.01); }
      var padv = (hi - lo) * 0.08;
      return [lo - padv, hi + padv];
    },
    /* 实际渲染区间 = 自动区间 / 纵轴缩放系数（围绕自动区间中心） */
    priceRange: function () {
      var r = this.autoRange();
      if (!this.priceZoom || Math.abs(this.priceZoom - 1) < 1e-6) return r;
      var c = (r[0] + r[1]) / 2;
      var half = (r[1] - r[0]) / 2 / this.priceZoom;
      return [c - half, c + half];
    },

    /* ---------------- 纵轴缩放 ---------------- */
    /** 拖动价格轴：dy 为像素位移（向上拖为负 → 拉近/放大） */
    zoomPriceBy: function (dy) {
      this.priceZoom = clamp(this.priceZoom * Math.pow(1.006, -dy), 0.25, 12);
    },
    resetPriceZoom: function () { this.priceZoom = 1; },
    /** 是否命中右侧价格轴区域 */
    hitAxisY: function (x) {
      var pl = this.plot;
      return x > pl.x + pl.w && x <= this.w;
    },

    /* ---------------- 视图操作 ---------------- */
    clampOffset: function () {
      var vc = this.visibleCount();
      var maxOff = Math.max(0, this.maxIndex - 1);
      var minOff = -vc * 0.7;
      this.offset = clamp(this.offset, minOff, maxOff + 1);
    },
    panBy: function (dx) {
      this.offset -= dx / this.cw;
      this.clampOffset();
    },
    zoomAt: function (x, factor) {
      var idx = this.idxAt(x);
      this.cw = clamp(this.cw * factor, 0.4, 90);
      this.offset = idx - (x - this.plot.x) / this.cw;
      this.clampOffset();
    },
    scrollToIndex: function (i, rightFrac) {
      var vc = this.visibleCount();
      this.offset = i - vc * (1 - (rightFrac == null ? 0.15 : rightFrac));
      this.clampOffset();
    },
    fitRange: function (count) {
      this.cw = clamp(this.plot.w / Math.max(1, count), 0.4, 90);
      this.scrollToIndex(this.maxIndex, 0.12);
    },

    /* ---------------- 指标：EMA20 ---------------- */
    _computeEMA: function (period) {
      var p = period || 20;
      var ema = new Array(this.data.length);
      if (!this.data.length) { this.ema = ema; return; }
      var mult = 2 / (p + 1);
      var sum = 0;
      for (var i = 0; i < this.data.length; i++) {
        if (i < p - 1) { ema[i] = null; sum += this.data[i].c; }
        else if (i === p - 1) { sum += this.data[i].c; ema[i] = sum / p; }
        else { ema[i] = (this.data[i].c - ema[i - 1]) * mult + ema[i - 1]; }
      }
      this.ema = ema;
    },

    /* ---------------- 每日日期竖直虚线分割 ---------------- */
    _daySeparators: function (pl) {
      if (this.interval >= 86400000 || this.data.length < 2) return;
      var ctx = this.ctx;
      var i0 = Math.max(0, Math.floor(this.offset));
      var i1 = Math.min(this.maxIndex, Math.ceil(this.offset + this.visibleCount()));
      ctx.save();
      ctx.beginPath();
      ctx.rect(pl.x, pl.y, pl.w, pl.h);
      ctx.clip();
      ctx.strokeStyle = 'rgba(120,123,134,0.42)';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      var prevDay = null;
      for (var i = i0; i <= i1; i++) {
        var day = new Date(this.data[i].t).getDate();
        if (prevDay != null && day !== prevDay) {
          var x = Math.round(this.x(i) - this.cw / 2) + 0.5;
          if (x >= pl.x && x <= pl.x + pl.w) {
            ctx.beginPath();
            ctx.moveTo(x, pl.y); ctx.lineTo(x, pl.y + pl.h);
            ctx.stroke();
          }
        }
        prevDay = day;
      }
      ctx.restore();
    },

    /* ---------------- EMA20 渲染 ---------------- */
    _emaLine: function (pp) {
      if (!this.showEMA || !this.ema || this.ema.length < 20) return;
      var ctx = this.ctx;
      ctx.save();
      ctx.beginPath();
      ctx.rect(pp.x, pp.y, pp.w, pp.h);
      ctx.clip();
      ctx.strokeStyle = this.emaColor || '#ffd700';
      ctx.lineWidth = 1.4;
      ctx.setLineDash([]);
      var started = false;
      var i0 = Math.max(0, Math.floor(this.offset));
      var i1 = Math.min(this.maxIndex, Math.ceil(this.offset + this.visibleCount()));
      for (var i = i0; i <= i1; i++) {
        var v = this.ema[i];
        if (v == null || !isFinite(v)) continue;
        var x = this.x(i), y = this.y(v);
        if (!started) { ctx.beginPath(); ctx.moveTo(x, y); started = true; }
        else ctx.lineTo(x, y);
      }
      if (started) ctx.stroke();
      ctx.restore();
    },

    barAt: function (x) {
      var i = Math.round(this.idxAt(x));
      if (i < 0 || i > this.maxIndex) return -1;
      return i;
    },

    /* ---------------- 渲染 ---------------- */
    render: function () {
      var ctx = this.ctx;
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      ctx.clearRect(0, 0, this.w, this.h);
      ctx.fillStyle = C.bg;
      ctx.fillRect(0, 0, this.w, this.h);
      ctx.font = '11px ' + FONT;
      ctx.textBaseline = 'middle';

      if (!this.data.length || this.maxIndex < 0) { this._empty(); return; }

      var pr = this.priceRange();
      this._minP = pr[0]; this._maxP = pr[1];

      var pl = this.plot, pp = this.pricePane, vp = this.volPane;

      this._volumeMax();
      this._timeGrid(pl);
      this._daySeparators(pl);
      this._priceGrid(pl);
      this._candles(pp);
      this._emaLine(pp);
      if (this.showVolume) this._volume(vp);
      if (this.overlaysRender) this.overlaysRender(ctx, this);
      if (this.drawingsRender) this.drawingsRender(ctx, this);
      this._nowLine(pl);
      if (this.mouse) this._crosshair(pl);
      this._border(pl);
    },

    _empty: function () {
      var ctx = this.ctx;
      ctx.fillStyle = C.axisText;
      ctx.font = '13px ' + FONT;
      ctx.textAlign = 'center';
      ctx.fillText('导入 CSV 或点击「示例数据」开始复盘', this.w / 2, this.h / 2);
      ctx.textAlign = 'left';
    },

    _border: function (pl) {
      var ctx = this.ctx;
      ctx.strokeStyle = C.axis;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(pl.x - 0.5, pl.y);
      ctx.lineTo(pl.x - 0.5, pl.y + pl.h + 0.5);
      ctx.lineTo(pl.x + pl.w + 0.5, pl.y + pl.h + 0.5);
      ctx.stroke();
    },

    _volumeMax: function () {
      var i0 = Math.max(0, Math.floor(this.offset));
      var i1 = Math.min(this.maxIndex, Math.ceil(this.offset + this.visibleCount()));
      var m = 1;
      for (var i = i0; i <= i1; i++) {
        var b = this.data[i];
        if (b && b.v > m) m = b.v;
      }
      this._maxVol = m * 1.15;
    },

    _priceGrid: function (pl) {
      var ctx = this.ctx;
      var rng = this._maxP - this._minP;
      var step = niceStep(rng, Math.max(3, Math.floor(pl.h / 46)));
      var start = Math.ceil(this._minP / step) * step;
      var d = this.priceDigits;
      ctx.textAlign = 'left';
      for (var p = start; p <= this._maxP; p += step) {
        var y = Math.round(this.y(p)) + 0.5;
        if (y < pl.y || y > pl.y + pl.h) continue;
        ctx.strokeStyle = C.grid;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(pl.x, y); ctx.lineTo(pl.x + pl.w, y);
        ctx.stroke();
        ctx.fillStyle = C.axisText;
        ctx.fillText(p.toFixed(d), pl.x + pl.w + 7, y);
      }
    },

    _fmtTime: function (t) {
      var d = new Date(t);
      if (this.interval < 86400000) {
        return pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
      }
      return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
    },
    _fmtTimeShort: function (t) {
      var d = new Date(t);
      if (this.interval < 86400000) return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
      return pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
    },

    _timeGrid: function (pl) {
      var ctx = this.ctx;
      var vc = this.visibleCount();
      var step = niceIndexStep(Math.max(1, Math.ceil(64 / this.cw)));
      var first = Math.ceil(this.offset / step) * step;
      ctx.textAlign = 'center';
      for (var i = first; i <= this.offset + vc; i += step) {
        if (i < 0 || i > this.maxIndex) continue;
        var x = Math.round(this.x(i)) + 0.5;
        if (x < pl.x || x > pl.x + pl.w) continue;
        ctx.strokeStyle = C.grid;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, pl.y); ctx.lineTo(x, pl.y + pl.h);
        ctx.stroke();
        ctx.fillStyle = C.axisText;
        ctx.fillText(this._fmtTime(this.data[i].t), x, pl.y + pl.h + 12);
      }
      ctx.textAlign = 'left';
    },

    _candles: function (pp) {
      var ctx = this.ctx;
      var i0 = Math.max(0, Math.floor(this.offset));
      var i1 = Math.min(this.maxIndex, Math.ceil(this.offset + this.visibleCount()));
      var bw = Math.max(1, this.cw - Math.max(1, this.cw * 0.24));
      for (var i = i0; i <= i1; i++) {
        var b = this.data[i];
        if (!b) continue;
        var cx = this.x(i);
        var up = b.c >= b.o;
        var col = up ? C.up : C.down;
        var yo = this.y(b.o), yc = this.y(b.c);
        var yh = this.y(b.h), yl = this.y(b.l);
        ctx.strokeStyle = col;
        ctx.fillStyle = col;
        var xc = Math.round(cx) + 0.5;
        // 影线
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(xc, yh); ctx.lineTo(xc, yl);
        ctx.stroke();
        // 实体
        var top = Math.min(yo, yc);
        var hgt = Math.max(1, Math.abs(yc - yo));
        if (bw <= 2) {
          ctx.fillRect(Math.round(cx - bw / 2), Math.round(top), Math.max(1, Math.round(bw)), Math.max(1, Math.round(hgt)));
        } else {
          ctx.fillRect(cx - bw / 2, top, bw, hgt);
        }
      }
    },

    _volume: function (vp) {
      var ctx = this.ctx;
      var i0 = Math.max(0, Math.floor(this.offset));
      var i1 = Math.min(this.maxIndex, Math.ceil(this.offset + this.visibleCount()));
      var bw = Math.max(1, this.cw - Math.max(1, this.cw * 0.24));
      for (var i = i0; i <= i1; i++) {
        var b = this.data[i];
        if (!b) continue;
        var cx = this.x(i);
        var up = b.c >= b.o;
        ctx.fillStyle = up ? C.volUp : C.volDown;
        var y = this.volY(b.v);
        var h = Math.max(1, vp.y + vp.h - y);
        ctx.fillRect(cx - bw / 2, y, bw, h);
      }
      // 顶部分隔线
      ctx.strokeStyle = C.grid;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(vp.x, vp.y - 5.5); ctx.lineTo(vp.x + vp.w, vp.y - 5.5);
      ctx.stroke();
      ctx.fillStyle = C.axisText;
      ctx.font = '10px ' + FONT;
      ctx.fillText('VOL', vp.x + 3, vp.y + 7);
      ctx.font = '11px ' + FONT;
    },

    /* 当前回放位置：最新价标签（不绘制竖直虚线） */
    _nowLine: function (pl) {
      var ctx = this.ctx;
      var b = this.data[this.maxIndex];
      if (!b) return;
      var col = b.c >= b.o ? C.up : C.down;
      var y = this.y(b.c);
      // 最新价标签
      ctx.save();
      ctx.fillStyle = col;
      var label = b.c.toFixed(this.priceDigits);
      var tw = ctx.measureText(label).width + 10;
      ctx.fillRect(pl.x + pl.w + 2, y - 9, tw, 18);
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'left';
      ctx.fillText(label, pl.x + pl.w + 7, y + 1);
      ctx.restore();
    },

    _crosshair: function (pl) {
      var ctx = this.ctx;
      var m = this.mouse;
      if (m.x < pl.x || m.x > pl.x + pl.w || m.y < pl.y || m.y > pl.y + pl.h) return;
      ctx.save();
      ctx.strokeStyle = C.cross;
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      var x = Math.round(m.x) + 0.5, y = Math.round(m.y) + 0.5;
      ctx.beginPath(); ctx.moveTo(pl.x, y); ctx.lineTo(pl.x + pl.w, y); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x, pl.y); ctx.lineTo(x, pl.y + pl.h); ctx.stroke();
      ctx.restore();

      // 价格标签
      var p = this.priceAt(m.y);
      var lp = p.toFixed(this.priceDigits);
      ctx.fillStyle = C.labelBg;
      var w = ctx.measureText(lp).width + 10;
      ctx.fillRect(pl.x + pl.w + 2, y - 9, w, 18);
      ctx.fillStyle = C.labelText;
      ctx.textAlign = 'left';
      ctx.fillText(lp, pl.x + pl.w + 7, y + 1);

      // 时间标签
      var idx = this.barAt(m.x);
      if (idx >= 0) {
        var ts = this._fmtTime(this.data[idx].t);
        ctx.fillStyle = C.labelBg;
        var w2 = ctx.measureText(ts).width + 12;
        ctx.fillRect(x - w2 / 2, pl.y + pl.h + 3, w2, 16);
        ctx.fillStyle = C.labelText;
        ctx.textAlign = 'center';
        ctx.fillText(ts, x, pl.y + pl.h + 11.5);
        ctx.textAlign = 'left';
      }
    }
  };

  global.KLineChart = KLineChart;
  global.ChartConst = C;
})(window);
