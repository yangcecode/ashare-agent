/**
 * 技术指标：纯函数，不碰网络。
 *
 * 输入都是「按时间从旧到新」的收盘价数组，或 [{date,open,close,high,low,volume}]。
 */

export function sma(values, period) {
	if (values.length < period) return undefined;
	return values.slice(-period).reduce((a, b) => a + b, 0) / period;
}

export function ema(values, period) {
	if (values.length < period) return undefined;
	const k = 2 / (period + 1);
	let e = sma(values.slice(0, period), period);
	for (let i = period; i < values.length; i++) e = values[i] * k + e * (1 - k);
	return e;
}

/** Wilder 平滑 RSI，默认 14。 */
export function rsi(values, period = 14) {
	if (values.length < period + 1) return undefined;
	let gain = 0;
	let loss = 0;
	for (let i = 1; i <= period; i++) {
		const d = values[i] - values[i - 1];
		if (d >= 0) gain += d;
		else loss -= d;
	}
	gain /= period;
	loss /= period;
	for (let i = period + 1; i < values.length; i++) {
		const d = values[i] - values[i - 1];
		gain = (gain * (period - 1) + Math.max(d, 0)) / period;
		loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
	}
	if (loss === 0) return 100;
	return 100 - 100 / (1 + gain / loss);
}

export function macd(values, fast = 12, slow = 26, signal = 9) {
	if (values.length < slow + signal) return undefined;
	const kFast = 2 / (fast + 1);
	const kSlow = 2 / (slow + 1);
	let ef = sma(values.slice(0, fast), fast);
	let es = sma(values.slice(0, slow), slow);
	const difs = [];
	for (let i = slow; i < values.length; i++) {
		ef = values[i] * kFast + ef * (1 - kFast);
		es = values[i] * kSlow + es * (1 - kSlow);
		difs.push(ef - es);
	}
	if (difs.length < signal) return undefined;
	const kSig = 2 / (signal + 1);
	let dea = sma(difs.slice(0, signal), signal);
	for (let i = signal; i < difs.length; i++) dea = difs[i] * kSig + dea * (1 - kSig);
	const dif = difs[difs.length - 1];
	return { dif, dea, hist: dif - dea };
}

/** 年化波动率：日收益标准差 * sqrt(252)。 */
export function volatility(values, period = 20) {
	if (values.length < period + 1) return undefined;
	const rets = [];
	for (let i = values.length - period; i < values.length; i++) rets.push(Math.log(values[i] / values[i - 1]));
	const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
	const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1);
	return Math.sqrt(variance) * Math.sqrt(252);
}

/** 最大回撤（正数，0.2 = 回撤 20%）。 */
export function maxDrawdown(values) {
	let peak = values[0];
	let worst = 0;
	for (const v of values) {
		if (v > peak) peak = v;
		const dd = (peak - v) / peak;
		if (dd > worst) worst = dd;
	}
	return worst;
}

/**
 * A 股的一个涨跌停幅度。主板 10%，创业板/科创板 20%，北交所 30%，ST 5%。
 * 用「涨停价 vs 昨收」反推，比按代码硬编码更准。
 */
export function limitFromQuote(quote) {
	if (quote.isIndex || quote.prevClose == null || quote.limitUp == null) return undefined;
	return Number(((quote.limitUp - quote.prevClose) / quote.prevClose).toFixed(4));
}

/** 把一段 K 线算成指标快照。 */
export function computeIndicators(bars, quote) {
	const closes = bars.map((b) => b.close);
	const last = closes[closes.length - 1];
	const ma = (p) => sma(closes, p);
	const ma5 = ma(5);
	const ma10 = ma(10);
	const ma20 = ma(20);
	const ma60 = ma(60);
	const m = macd(closes);
	const r = rsi(closes);
	const vol = volatility(closes);
	const high = Math.max(...bars.map((b) => b.high));
	const low = Math.min(...bars.map((b) => b.low));

	const signals = [];
	if (ma20 !== undefined) signals.push(last >= ma20 ? "收盘在 MA20 上方（短期偏强）" : "收盘在 MA20 下方（短期偏弱）");
	if (ma20 !== undefined && ma60 !== undefined) {
		signals.push(ma20 >= ma60 ? "MA20 ≥ MA60（多头排列）" : "MA20 < MA60（空头排列）");
	}
	if (ma5 !== undefined && ma10 !== undefined) signals.push(ma5 >= ma10 ? "MA5 ≥ MA10（短均线向上）" : "MA5 < MA10（短均线向下）");
	if (r !== undefined) {
		if (r >= 70) signals.push(`RSI ${r.toFixed(1)}，超买`);
		else if (r <= 30) signals.push(`RSI ${r.toFixed(1)}，超卖`);
		else signals.push(`RSI ${r.toFixed(1)}，中性`);
	}
	if (m) signals.push(m.hist > 0 ? "MACD 柱为正（动能偏多）" : "MACD 柱为负（动能偏空）");

	// 涨跌停状态：A 股特有的信息
	if (quote && !quote.isIndex && quote.price != null && quote.limitUp != null) {
		if (quote.price >= quote.limitUp - 0.005) signals.push("已涨停");
		else if (quote.price <= quote.limitDown + 0.005) signals.push("已跌停");
		else {
			const roomUp = ((quote.limitUp - quote.price) / quote.price) * 100;
			if (roomUp < 1.5) signals.push(`接近涨停（距涨停约 ${roomUp.toFixed(1)}%）`);
		}
	}

	return {
		last: round(last),
		ma5: round(ma5),
		ma10: round(ma10),
		ma20: round(ma20),
		ma60: round(ma60),
		rsi14: round(r),
		macd: m ? { dif: round(m.dif), dea: round(m.dea), hist: round(m.hist) } : undefined,
		volatilityAnnual: vol === undefined ? undefined : round(vol, 4),
		maxDrawdown: round(maxDrawdown(closes), 4),
		fromHighPct: round(((last - high) / high) * 100),
		fromLowPct: round(((last - low) / low) * 100),
		bars: bars.length,
		range: `${bars[0].date} ~ ${bars[bars.length - 1].date}`,
		signals,
	};
}

function round(v, digits = 2) {
	if (v === undefined || v === null || !Number.isFinite(v)) return undefined;
	const f = 10 ** digits;
	return Math.round(v * f) / f;
}
