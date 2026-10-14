/**
 * A 股行情数据 + 技术指标。纯函数 + 取数函数，无外部依赖。
 *
 * 数据源：腾讯（qt.gtimg.cn 实时含 PE/PB/市值、web.ifzq.gtimg.cn 前复权日线）。
 * 只支持 A 股：沪市 6 开头、深市 0/3 开头、北交所 8/4 开头，以及指数。
 *
 * 这是非官方接口：字段位置靠实测、随时可能变。真用要自己加缓存和重试。
 */

/** 代码 -> 腾讯符号。600519->sh600519, 000001->sz000001, 300750->sz300750, 688981->sh688981 */
export function toTencentSymbol(code) {
	const c = String(code).trim().toUpperCase();
	if (/^(SH|SZ|BJ)\d{6}$/.test(c)) return c.toLowerCase();
	if (/^\d{6}$/.test(c)) {
		if (/^(60|68|9)/.test(c)) return "sh" + c; // 沪市主板/科创板/B股
		if (/^(00|30|2)/.test(c)) return "sz" + c; // 深市主板/创业板/B股
		if (/^(4|8)/.test(c)) return "bj" + c; // 北交所
		return "sh" + c;
	}
	// 常见指数别名
	const idx = { 上证: "sh000001", 深证: "sz399001", 创业板: "sz399006", 科创50: "sh000688", 沪深300: "sh000300", 中证500: "sh000905" };
	if (idx[c]) return idx[c];
	throw new Error(`无法识别的 A 股代码：${code}（应为 6 位数字，如 600519 / 000001 / 300750）`);
}

/** 判断是不是指数（用腾讯返回的代码特征：指数无 PE/PB）。 */
function isIndexSymbol(symbol) {
	return symbol === "sh000001" || symbol === "sz399001" || symbol === "sz399006" || symbol === "sh000300" || symbol === "sh000905" || symbol === "sh000688" || /^(sh000|sz399)/.test(symbol);
}

function num(v) {
	const n = Number(v);
	return Number.isFinite(n) && v !== "" ? n : undefined;
}

function parseQuoteLine(line) {
	const m = /v_([a-z0-9]+)="([^"]*)"/i.exec(line);
	if (!m) return undefined;
	const f = m[2].split("~");
	if (f.length < 50) return undefined;
	const symbol = m[1].toLowerCase();
	const index = isIndexSymbol(symbol);
	return {
		symbol,
		code: f[2],
		name: f[1],
		price: num(f[3]),
		prevClose: num(f[4]),
		open: num(f[5]),
		high: num(f[33]),
		low: num(f[34]),
		change: num(f[31]),
		changePct: num(f[32]),
		volumeLots: num(f[36]), // 手
		amountWan: num(f[37]), // 成交额（万元）
		turnoverPct: index ? undefined : num(f[38]), // 换手率
		pe: index ? undefined : num(f[39]),
		peDynamic: index ? undefined : num(f[52]),
		pb: index ? undefined : num(f[46]),
		amplitudePct: num(f[43]), // 振幅
		floatCapYi: num(f[44]), // 流通市值（亿）
		totalCapYi: num(f[45]), // 总市值（亿）
		limitUp: index ? undefined : num(f[47]),
		limitDown: index ? undefined : num(f[48]),
		volumeRatio: num(f[49]), // 量比
		avgPrice: num(f[51]),
		currency: "CNY",
		asOf: f[30],
		isIndex: index,
	};
}

/** 取实时行情。codes 是 6 位代码数组，或指数别名。 */
export async function fetchQuotes(codes, fetchImpl = fetch) {
	const symbols = codes.map(toTencentSymbol);
	const res = await fetchImpl(`https://qt.gtimg.cn/q=${symbols.join(",")}`, {
		headers: { "User-Agent": "Mozilla/5.0" },
	});
	if (!res.ok) throw new Error(`行情请求失败：HTTP ${res.status}`);
	// 腾讯返回 GBK；Node 的 fetch 只按 UTF-8 解，所以拿字节自己解。
	const text = new TextDecoder("gbk").decode(Buffer.from(await res.arrayBuffer()));
	const quotes = text.split("\n").map(parseQuoteLine).filter(Boolean);
	const missing = symbols.filter((s) => !quotes.some((q) => q.symbol === s));
	if (missing.length > 0) throw new Error(`未找到：${missing.join(", ")}（代码可能不存在或已退市）`);
	// 保持用户传入的顺序
	return symbols.map((s) => quotes.find((q) => q.symbol === s));
}

/** 取前复权日线。返回 [{date, open, close, high, low, volume}]，从旧到新。 */
export async function fetchDailyBars(code, limit = 120, fetchImpl = fetch) {
	const symbol = toTencentSymbol(code);
	const url = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${symbol},day,,,${limit},qfq`;
	const res = await fetchImpl(url, { headers: { "User-Agent": "Mozilla/5.0" } });
	if (!res.ok) throw new Error(`K线请求失败：HTTP ${res.status}`);
	const json = await res.json();
	const data = json?.data?.[symbol];
	if (!data) throw new Error(`未找到 K 线：${symbol}`);
	const rows = data.qfqday ?? data.day; // 指数没有复权数据，只有 day
	if (!Array.isArray(rows) || rows.length === 0) throw new Error(`K 线为空：${symbol}`);
	return rows.map((r) => ({
		date: r[0],
		open: Number(r[1]),
		close: Number(r[2]),
		high: Number(r[3]),
		low: Number(r[4]),
		volume: Number(r[5]),
	}));
}

// ------------------------------------------------------------------ 指标

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
