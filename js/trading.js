/* =========================================================
 * trading.js —— 模拟交易引擎
 *  · 市价单 / 限价(Limit)单 / Stop 单
 *  · 每笔订单可带止盈止损（成交后转移到持仓）
 *  · 改单、撤单、平仓、浮动盈亏、成交记录、交易统计
 * 说明：撮合以"整根K线"为单位（无 tick 数据），采用跳空优先的保守撮合：
 *   若开盘价已越过触发价，按开盘价成交；否则按触发价成交。
 *   同一根K线内同时触及止损和止盈时，保守判定为**先止损**。
 * ========================================================= */
(function (global) {
  'use strict';

  function TradingEngine(opts) {
    opts = opts || {};
    this.onChange = opts.onChange || function () { };
    this.reset();
  }

  TradingEngine.prototype = {

    reset: function () {
      this.orders = [];      // 已成交的也保留在列表里（status=filled/canceled 显示为历史）
      this.positions = [];
      this.fills = [];
      this.trades = [];
      this.seq = 1;
      this.realized = 0;
      this.equity = [];      // [{idx, v}] 已实现权益
      this.feePerLot = 0;
      this.multiplier = 1;
      this.currentBar = null;
      this.currentIndex = -1;
      this.peak = 0;
      this.maxDD = 0;
    },

    /* ---------- 基础 ---------- */
    setBar: function (bar, idx) {
      this.currentBar = bar;
      this.currentIndex = idx;
    },
    price: function () { return this.currentBar ? this.currentBar.c : null; },

    feeOf: function (qty) { return (this.feePerLot || 0) * qty * this.multiplier; },

    floating: function () {
      var p = this.price();
      if (p == null) return 0;
      var f = 0;
      for (var i = 0; i < this.positions.length; i++) {
        var pos = this.positions[i];
        f += (p - pos.entry) * pos.qty * (pos.side === 'buy' ? 1 : -1) * this.multiplier;
      }
      return f;
    },
    equityNow: function () { return this.realized + this.floating(); },

    /* ---------- 下单 ---------- */
    submit: function (spec) {
      var qty = parseFloat(spec.qty);
      if (!(qty > 0)) return { ok: false, msg: '请填写正确的数量' };
      if (this.currentBar == null) return { ok: false, msg: '暂无行情数据' };

      var o = {
        id: this.seq++,
        type: spec.type || 'market',        // market | limit | stop
        side: spec.side,                    // buy | sell
        qty: qty,
        price: spec.price != null && spec.price !== '' ? parseFloat(spec.price) : null,
        sl: spec.sl != null && spec.sl !== '' ? parseFloat(spec.sl) : null,
        tp: spec.tp != null && spec.tp !== '' ? parseFloat(spec.tp) : null,
        status: 'pending',
        createdIdx: this.currentIndex,
        createdTime: this.currentBar.t,
        filledIdx: null,
        filledTime: null,
        fillPrice: null
      };

      if (o.type === 'market') {
        o.fillPrice = this.price();
        this._fill(o, o.fillPrice, this.currentIndex, '市价成交');
      } else {
        if (!(o.price > 0)) return { ok: false, msg: '请填写挂单价格' };
        this.orders.push(o);
      }
      this.onChange('structure');
      return { ok: true, id: o.id };
    },

    modifyOrder: function (id, patch) {
      var o = this._order(id);
      if (!o || o.status !== 'pending') return false;
      if (patch.price != null && patch.price !== '') { var p = parseFloat(patch.price); if (p > 0) o.price = p; }
      if (patch.qty != null && patch.qty !== '') { var q = parseFloat(patch.qty); if (q > 0) o.qty = q; }
      if (patch.sl !== undefined) o.sl = patch.sl === '' || patch.sl == null ? null : parseFloat(patch.sl);
      if (patch.tp !== undefined) o.tp = patch.tp === '' || patch.tp == null ? null : parseFloat(patch.tp);
      if (patch.type) o.type = patch.type;
      this.onChange('structure');
      return true;
    },
    cancelOrder: function (id) {
      var o = this._order(id);
      if (!o || o.status !== 'pending') return false;
      o.status = 'canceled';
      this.onChange('structure');
      return true;
    },
    cancelAll: function () {
      var n = 0;
      for (var i = 0; i < this.orders.length; i++) {
        if (this.orders[i].status === 'pending') { this.orders[i].status = 'canceled'; n++; }
      }
      if (n) this.onChange('structure');
      return n;
    },

    modifyPosition: function (id, patch) {
      var p = this._position(id);
      if (!p) return false;
      if (patch.sl !== undefined) p.sl = patch.sl === '' || patch.sl == null ? null : parseFloat(patch.sl);
      if (patch.tp !== undefined) p.tp = patch.tp === '' || patch.tp == null ? null : parseFloat(patch.tp);
      this.onChange('structure');
      return true;
    },
    closePosition: function (id) {
      var p = this._position(id);
      if (!p || this.price() == null) return false;
      this._close(p, this.price(), this.currentIndex, '手动平仓');
      this.onChange('structure');
      return true;
    },
    closeAll: function () {
      var list = this.positions.slice();
      var n = 0;
      for (var i = 0; i < list.length; i++) {
        this._close(list[i], this.price(), this.currentIndex, '手动平仓');
        n++;
      }
      if (n) this.onChange('structure');
      return n;
    },

    /* ---------- 每根新K线：撮合 + 止盈止损 ---------- */
    onNewBar: function (bar, idx) {
      this.currentBar = bar;
      this.currentIndex = idx;
      var changed = false;

      // 1) 挂单撮合
      for (var i = 0; i < this.orders.length; i++) {
        var o = this.orders[i];
        if (o.status !== 'pending') continue;
        var fp = this._matchPending(o, bar);
        if (fp != null) { this._fill(o, fp, idx, o.type === 'limit' ? '限价成交' : 'Stop成交'); changed = true; }
      }

      // 2) 持仓止盈止损（当根K线才开的仓不参与，避免同根即进即出）
      for (var j = this.positions.length - 1; j >= 0; j--) {
        var pos = this.positions[j];
        if (pos.entryIdx === idx) continue;
        var ex = this._matchExit(pos, bar);
        if (ex) { this._close(pos, ex.price, idx, ex.reason); changed = true; }
      }
      if (changed) this.onChange('structure');
      return changed;
    },

    _matchPending: function (o, bar) {
      var bo = bar.o, bh = bar.h, bl = bar.l;
      if (o.side === 'buy') {
        if (o.type === 'limit') {
          if (bo <= o.price) return bo;          // 跳空低开，按开盘价成交
          if (bl <= o.price) return o.price;
        } else {
          if (bo >= o.price) return bo;          // 跳空高开
          if (bh >= o.price) return o.price;
        }
      } else {
        if (o.type === 'limit') {
          if (bo >= o.price) return bo;
          if (bh >= o.price) return o.price;
        } else {
          if (bo <= o.price) return bo;
          if (bl <= o.price) return o.price;
        }
      }
      return null;
    },

    _matchExit: function (pos, bar) {
      var bo = bar.o, bh = bar.h, bl = bar.l;
      var dir = pos.side === 'buy' ? 1 : -1;
      var sl = null, tp = null;
      if (pos.sl != null && pos.sl > 0) {
        if (dir > 0) { if (bo <= pos.sl) sl = bo; else if (bl <= pos.sl) sl = pos.sl; }
        else { if (bo >= pos.sl) sl = bo; else if (bh >= pos.sl) sl = pos.sl; }
      }
      if (pos.tp != null && pos.tp > 0) {
        if (dir > 0) { if (bo >= pos.tp) tp = bo; else if (bh >= pos.tp) tp = pos.tp; }
        else { if (bo <= pos.tp) tp = bo; else if (bl <= pos.tp) tp = pos.tp; }
      }
      if (sl != null) return { price: sl, reason: '止损' };   // 同根同时触及，保守判为止损
      if (tp != null) return { price: tp, reason: '止盈' };
      return null;
    },

    /* ---------- 内部：成交 / 平仓 ---------- */
    _fill: function (o, price, idx, reason) {
      o.status = 'filled';
      o.fillPrice = price;
      o.filledIdx = idx;
      o.filledTime = this.currentBar ? this.currentBar.t : null;

      var fee = this.feeOf(o.qty);
      var pos = {
        id: this.seq++,
        orderId: o.id,
        side: o.side,
        qty: o.qty,
        entry: price,
        entryIdx: idx,
        entryTime: o.filledTime,
        sl: o.sl, tp: o.tp,
        fee: fee
      };
      this.positions.push(pos);
      this.fills.push({
        id: this.seq++, orderId: o.id, positionId: pos.id,
        idx: idx, time: o.filledTime, side: o.side, qty: o.qty,
        price: price, type: o.type, action: 'open', fee: fee, reason: reason
      });
      this.realized -= fee;
      this._pushEquity(idx);
    },

    _close: function (pos, price, idx, reason) {
      var dir = pos.side === 'buy' ? 1 : -1;
      var gross = (price - pos.entry) * pos.qty * dir * this.multiplier;
      var fee = this.feeOf(pos.qty);
      var pnl = gross - fee;
      this.realized += pnl;
      this.trades.push({
        id: this.seq++, positionId: pos.id,
        side: pos.side, qty: pos.qty,
        entry: pos.entry, exit: price,
        entryIdx: pos.entryIdx, exitIdx: idx,
        entryTime: pos.entryTime, exitTime: this.currentBar ? this.currentBar.t : null,
        gross: gross, fee: pos.fee + fee, pnl: pnl, reason: reason,
        bars: idx - pos.entryIdx
      });
      this.fills.push({
        id: this.seq++, orderId: pos.orderId, positionId: pos.id,
        idx: idx, time: this.currentBar ? this.currentBar.t : null,
        side: pos.side === 'buy' ? 'sell' : 'buy', qty: pos.qty,
        price: price, type: 'close', action: 'close', fee: fee, reason: reason
      });
      var k = this.positions.indexOf(pos);
      if (k >= 0) this.positions.splice(k, 1);
      this._pushEquity(idx);
    },

    _pushEquity: function (idx) {
      this.equity.push({ idx: idx, v: this.realized });
      if (this.realized > this.peak) this.peak = this.realized;
      var dd = this.peak - this.realized;
      if (dd > this.maxDD) this.maxDD = dd;
    },

    _order: function (id) {
      for (var i = 0; i < this.orders.length; i++) if (this.orders[i].id === +id) return this.orders[i];
      return null;
    },
    _position: function (id) {
      for (var i = 0; i < this.positions.length; i++) if (this.positions[i].id === +id) return this.positions[i];
      return null;
    },
    pendingOrders: function () {
      return this.orders.filter(function (o) { return o.status === 'pending'; });
    },

    /* ---------- 统计 ---------- */
    stats: function () {
      var t = this.trades;
      var n = t.length;
      var wins = [], losses = [];
      var gp = 0, gl = 0, total = 0, maxWin = 0, maxLoss = 0;
      for (var i = 0; i < n; i++) {
        var p = t[i].pnl;
        total += p;
        if (p > 0) { wins.push(p); gp += p; if (p > maxWin) maxWin = p; }
        else if (p < 0) { losses.push(-p); gl += -p; if (-p > maxLoss) maxLoss = -p; }
      }
      var avgWin = wins.length ? gp / wins.length : 0;
      var avgLoss = losses.length ? gl / losses.length : 0;
      var avg = n ? total / n : 0;
      var rr = avgLoss > 0 ? avgWin / avgLoss : (gp > 0 ? Infinity : 0);
      var pf = gl > 0 ? gp / gl : (gp > 0 ? Infinity : 0);
      var winRate = n ? (wins.length / n) * 100 : 0;

      // 最大回撤（含当前浮动）
      var peak = 0, mdd = this.maxDD;
      for (var j = 0; j < this.equity.length; j++) {
        if (this.equity[j].v > peak) peak = this.equity[j].v;
        var d = peak - this.equity[j].v;
        if (d > mdd) mdd = d;
      }
      var eq = this.equityNow();
      if (peak - eq > mdd) mdd = peak - eq;

      return {
        count: n,
        wins: wins.length,
        losses: losses.length,
        winRate: winRate,
        total: total,
        avg: avg,
        avgWin: avgWin,
        avgLoss: avgLoss,
        rr: rr,
        pf: pf,
        maxWin: maxWin,
        maxLoss: maxLoss,
        maxDD: mdd,
        floating: this.floating(),
        realized: this.realized,
        equity: eq,
        openCount: this.positions.length,
        pendingCount: this.pendingOrders().length
      };
    },

    /* ---------- 快照（用于回放回溯） ---------- */
    snapshot: function () {
      return JSON.stringify({
        orders: this.orders, positions: this.positions, fills: this.fills,
        trades: this.trades, seq: this.seq, realized: this.realized,
        equity: this.equity, peak: this.peak, maxDD: this.maxDD,
        feePerLot: this.feePerLot, currentIndex: this.currentIndex
      });
    },
    restore: function (s) {
      var o = typeof s === 'string' ? JSON.parse(s) : s;
      this.orders = o.orders || [];
      this.positions = o.positions || [];
      this.fills = o.fills || [];
      this.trades = o.trades || [];
      this.seq = o.seq || 1;
      this.realized = o.realized || 0;
      this.equity = o.equity || [];
      this.peak = o.peak || 0;
      this.maxDD = o.maxDD || 0;
      this.feePerLot = o.feePerLot || 0;
      this.currentIndex = o.currentIndex == null ? -1 : o.currentIndex;
      // 当前K线由调用方重新 setBar，避免沿用旧价计算浮动盈亏
      this.currentBar = null;
    }
  };

  global.TradingEngine = TradingEngine;
})(window);
