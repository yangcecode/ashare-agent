/**
 * A 股行情取数（实时行情 + 前复权日线）。无外部依赖。
 *
 * 数据源：腾讯（qt.gtimg.cn 实时含 PE/PB/市值、web.ifzq.gtimg.cn 前复权日线）。
 * 只支持 A 股：沪市 6 开头、深市 0/3 开头、北交所 8/4 开头，以及指数。
 *
 * 这是非官方接口：字段位置靠实测、随时可能变。真用要自己加缓存和重试。
 *
 * 指标计算在 ./indicators.mjs。
 */

/** 代码 -> 腾讯符号。600519->sh600519, 000001->sz000001, 300750->sz300750, 688981->sh688981 */
export function toTencentSymbol(code) {
	const c = String(code).trim().toUpperCase();
	if (/^(SH|SZ|BJ)\d{6}$/.test(c)) return c.toLowerCase();
	if (/^\d{6}$/.test(c)) {
		if (/^(5|6)/.test(c)) return "sh" + c; // 沪市：60 主板 / 68 科创板 / 5 沪市基金ETF / 9 B股
		if (/^(0|1|2|3)/.test(c)) return "sz" + c; // 深市：00 主板 / 30 创业板 / 15,16,18 基金ETF / 1 债 / 2 B股
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

