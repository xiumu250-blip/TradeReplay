/* =========================================================
 * data.js —— CSV 解析 / 示例数据生成 / 模板下载
 * ========================================================= */
(function (global) {
  'use strict';

  /* ---------- 工具 ---------- */
  function pad2(n) { return n < 10 ? '0' + n : '' + n; }

  function fmtDateTime(t) {
    var d = new Date(t);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
      ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  }

  /* 解析时间：支持 epoch(秒/毫秒)、2024-01-02 09:30:00、2024/01/02、ISO 等 */
  function parseTime(s) {
    if (s == null) return NaN;
    var str = String(s).trim();
    if (str === '') return NaN;
    if (/^\d+$/.test(str)) {
      var n = Number(str);
      // 10 位视为秒，13 位视为毫秒
      return str.length <= 10 ? n * 1000 : n;
    }
    str = str.replace('T', ' ').replace(/\//g, '-').replace(/\./g, '-');
    var m = str.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ ](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
    if (m) {
      return new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)).getTime();
    }
    var d = Date.parse(str);
    return isNaN(d) ? NaN : d;
  }

  function toNum(s) {
    if (s == null) return NaN;
    var v = parseFloat(String(s).replace(/[,\s%"']/g, ''));
    return isNaN(v) ? NaN : v;
  }

  /* 猜测分隔符 */
  function guessDelim(line) {
    var cands = [',', '\t', ';', '|'];
    var best = ',', bestN = 0;
    for (var i = 0; i < cands.length; i++) {
      var n = line.split(cands[i]).length;
      if (n > bestN) { bestN = n; best = cands[i]; }
    }
    return best;
  }

  var ALIAS = {
    time: ['time', 'date', 'datetime', 'timestamp', 'ts', '日期', '时间', 'date_time', 'open_time'],
    open: ['open', 'o', '开盘', '开盘价', 'open_price'],
    high: ['high', 'h', '最高', '最高价', 'high_price'],
    low: ['low', 'l', '最低', '最低价', 'low_price'],
    close: ['close', 'c', 'close_price', '收盘', '收盘价', 'price', 'last'],
    volume: ['volume', 'v', 'vol', 'qty', 'quantity', '成交量', 'volume_from', 'size']
  };

  function matchCol(header, keys) {
    for (var i = 0; i < header.length; i++) {
      var h = header[i];
      for (var k = 0; k < keys.length; k++) {
        if (h === keys[k]) return i;
      }
    }
    // 退化为包含匹配
    for (var i2 = 0; i2 < header.length; i2++) {
      for (var k2 = 0; k2 < keys.length; k2++) {
        if (header[i2].indexOf(keys[k2]) >= 0) return i2;
      }
    }
    return -1;
  }

  /**
   * 解析 CSV 文本
   * @returns {Array<{t,o,h,l,c,v}>}
   */
  function parseCSV(text) {
    if (!text) return [];
    var lines = String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
    // 去掉空行与注释行
    lines = lines.filter(function (l) { return l.trim() !== '' && l.trim().charAt(0) !== '#'; });
    if (lines.length < 2) return [];

    var delim = guessDelim(lines[0]);
    var firstCells = lines[0].split(delim).map(function (s) {
      return s.trim().toLowerCase().replace(/^["']|["']$/g, '');
    });

    // 判断是否有表头：第一列无法解析为时间/数字，则认为是表头
    var hasHeader = isNaN(parseTime(firstCells[0])) || !/^\d/.test(firstCells[0]);

    // 默认列序：时间,开,高,低,收,量（无表头时使用）
    var map = { t: 0, o: 1, h: 2, l: 3, c: 4, v: 5 };
    var start = 0;
    if (hasHeader) {
      map.t = matchCol(firstCells, ALIAS.time);
      map.o = matchCol(firstCells, ALIAS.open);
      map.h = matchCol(firstCells, ALIAS.high);
      map.l = matchCol(firstCells, ALIAS.low);
      map.c = matchCol(firstCells, ALIAS.close);
      map.v = matchCol(firstCells, ALIAS.volume);
      start = 1;
      if (map.t < 0 || map.c < 0) {
        // 表头识别失败，退回默认列序且第一行当数据
        map = { t: 0, o: 1, h: 2, l: 3, c: 4, v: 5 };
        start = 0;
      }
    }

    var out = [];
    for (var i = start; i < lines.length; i++) {
      var cells = lines[i].split(delim);
      if (cells.length < 5) continue;
      var t = parseTime(cells[map.t]);
      var o = toNum(cells[map.o]);
      var h = toNum(cells[map.h]);
      var l = toNum(cells[map.l]);
      var c = toNum(cells[map.c]);
      var v = map.v >= 0 ? toNum(cells[map.v]) : 0;
      if (isNaN(t) || isNaN(o) || isNaN(h) || isNaN(l) || isNaN(c)) continue;
      if (isNaN(v)) v = 0;
      // 修正异常高低价
      var hi = Math.max(o, c, h, l);
      var lo = Math.min(o, c, h, l);
      out.push({ t: t, o: o, h: hi, l: lo, c: c, v: Math.max(0, v), i: out.length });
    }

    // 按时间升序
    out.sort(function (a, b) { return a.t - b.t; });
    for (var j = 0; j < out.length; j++) out[j].i = j;
    return out;
  }

  /* ---------- 伪随机 ---------- */
  function mulberry32(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      var t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  function gauss(r) {
    var u = 0, v = 0;
    while (u === 0) u = r();
    while (v === 0) v = r();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  /**
   * 生成示例行情（1 小时 K 线，含趋势/回调/震荡/突破等结构）
   */
  function generateSample(n, seed) {
    n = n || 720;
    var r = mulberry32(seed || 20260830);
    var regimes = [
      { drift: 0.7, vol: 2.4, len: 70 },
      { drift: -0.5, vol: 3.2, len: 50 },
      { drift: 0.05, vol: 1.7, len: 80 },   // 震荡
      { drift: 1.5, vol: 3.0, len: 90 },    // 主升
      { drift: -1.4, vol: 4.4, len: 65 },   // 急跌
      { drift: 0.25, vol: 2.1, len: 95 },   // 区间
      { drift: 1.0, vol: 2.8, len: 75 },
      { drift: -0.9, vol: 3.8, len: 60 },
      { drift: 0.45, vol: 2.2, len: 70 },
      { drift: -0.3, vol: 3.0, len: 65 }
    ];
    var price = 3200;
    var start = new Date(2025, 2, 3, 0, 0, 0).getTime();
    var step = 60 * 60 * 1000;
    var rows = [];
    var ri = 0, rc = 0;

    for (var i = 0; i < n; i++) {
      if (rc >= regimes[ri].len) { ri = (ri + 1) % regimes.length; rc = 0; }
      var rg = regimes[ri]; rc++;

      var drift = rg.drift;
      var vol = rg.vol;
      // 均值回复，避免走出离谱价格
      var pull = (3200 - price) * 0.0015;
      var chg = drift + pull + gauss(r) * vol;
      var open = price;
      var close = open + chg;
      var wickA = Math.abs(gauss(r)) * vol * 0.8;
      var wickB = Math.abs(gauss(r)) * vol * 0.8;
      var high = Math.max(open, close) + wickA;
      var low = Math.min(open, close) - wickB;
      if (low < 1) low = 1;
      var body = Math.abs(close - open);
      var volume = Math.round((600 + Math.abs(gauss(r)) * 260 + body * 70) * (1 + (vol / 10)));
      rows.push({
        t: start + i * step,
        o: round2(open), h: round2(high), l: round2(low), c: round2(close), v: volume, i: i
      });
      price = close;
    }
    return rows;
  }

  function round2(x) { return Math.round(x * 100) / 100; }

  /**
   * 周期聚合：把基础K线按 mul 根合并为 1 根
   *  开 = 首根开盘，高 = 区间最高，低 = 区间最低，收 = 末根收盘，量 = 区间求和
   * @param {Array} rows 基础周期K线（时间升序）
   * @param {number} mul  合并根数（>=1）
   */
  function aggregate(rows, mul) {
    mul = Math.max(1, Math.round(mul || 1));
    if (!rows || !rows.length) return [];
    if (mul === 1) {
      return rows.map(function (b, i) {
        return { t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v, i: i };
      });
    }
    var out = [];
    for (var i = 0; i < rows.length; i += mul) {
      var end = Math.min(rows.length, i + mul);
      var h = -Infinity, l = Infinity, v = 0;
      for (var j = i; j < end; j++) {
        if (rows[j].h > h) h = rows[j].h;
        if (rows[j].l < l) l = rows[j].l;
        v += rows[j].v || 0;
      }
      out.push({
        t: rows[i].t,          // 用区间首根时间作为该K线时间
        o: rows[i].o,
        h: h, l: l,
        c: rows[end - 1].c,
        v: v,
        i: out.length
      });
    }
    return out;
  }

  /* 毫秒 → 人类可读周期文本 */
  function periodText(ms) {
    if (!ms || !(ms > 0)) return '--';
    if (ms < 60000) return Math.round(ms / 1000) + '秒';
    if (ms < 3600000) {
      var m = ms / 60000;
      return (Math.round(m * 10) / 10) + '分';
    }
    if (ms < 86400000) {
      var h = ms / 3600000;
      return (Math.round(h * 10) / 10) + '时';
    }
    var d = ms / 86400000;
    if (d < 7) return (Math.round(d * 10) / 10) + '日';
    return (Math.round(d / 7 * 10) / 10) + '周';
  }

  function toCSV(rows) {
    var out = ['time,open,high,low,close,volume'];
    for (var i = 0; i < rows.length; i++) {
      var b = rows[i];
      out.push([fmtDateTime(b.t), b.o, b.h, b.l, b.c, b.v].join(','));
    }
    return out.join('\n');
  }

  function download(filename, content) {
    var blob = new Blob(['\ufeff' + content], { type: 'text/csv;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    setTimeout(function () { document.body.removeChild(a); URL.revokeObjectURL(url); }, 200);
  }

  global.DataUtil = {
    parseCSV: parseCSV,
    generateSample: generateSample,
    aggregate: aggregate,
    periodText: periodText,
    toCSV: toCSV,
    download: download,
    fmtDateTime: fmtDateTime,
    parseTime: parseTime
  };
})(window);
