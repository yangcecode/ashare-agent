/**
 * A 股分析 agent 的工具集（Pi Durable）。
 *
 * 数据来自腾讯的公开接口，不需要 key。非官方接口，随时可能变。
 */
import { Type } from "@earendil-works/pi-ai";
import { defineDoc, defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import { computeIndicators, fetchDailyBars, fetchQuotes } from "./market.mjs";

// ----------------------------------------------------------- 自选股（持久状态）
export const Watchlist = defineDoc({
	kind: "stock.watchlist",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "asOf",
	initial: () => ({ codes: [] }),
});

const codeParam = Type.String({
	description: "6 位 A 股代码：沪市 600519、深市 000001、创业板 300750、科创板 688981；也接受「上证」「深证」「创业板」等指数",
});

function fmtQuote(q) {
	if (q.isIndex) {
		return `${q.name}: ${q.price}, ${q.changePct >= 0 ? "+" : ""}${q.changePct}%`;
	}
	const parts = [
		`${q.name}(${q.code}): ${q.price} 元`,
		`${q.changePct >= 0 ? "+" : ""}${q.changePct}%`,
		`今开 ${q.open} 最高 ${q.high} 最低 ${q.low}`,
		`成交额 ${(q.amountWan / 10000).toFixed(2)} 亿`,
		`换手 ${q.turnoverPct}%`,
		`PE ${q.pe ?? "亏损/无"} PB ${q.pb ?? "n/a"}`,
		`总市值 ${q.totalCapYi} 亿`,
		`涨停 ${q.limitUp} 跌停 ${q.limitDown}`,
	];
	if (q.price != null && q.limitUp != null && q.price >= q.limitUp - 0.005) parts.push("【涨停】");
	if (q.price != null && q.limitDown != null && q.price <= q.limitDown + 0.005) parts.push("【跌停】");
	return parts.join(" | ");
}

// ---------------------------------------------------------------------- 工具
const quote = defineTool({
	name: "quote",
	description: "查 A 股实时行情：价格、涨跌幅、成交额、换手率、PE/PB、市值、涨跌停价",
	parameters: Type.Object({
		codes: Type.Array(codeParam, { description: "要查的代码，如 [\"600519\",\"000001\"]" }),
	}),
	replay: "safe", // 只读，崩溃后重跑没问题
	execute: async ({ codes }) => {
		const quotes = await fetchQuotes(codes);
		return { output: [{ type: "text", text: quotes.map(fmtQuote).join("\n") }] };
	},
});

const indicators = defineTool({
	name: "indicators",
	description: "算技术指标：MA5/10/20/60、RSI14、MACD、年化波动率、最大回撤、距区间高低点，并给出信号摘要",
	parameters: Type.Object({
		code: codeParam,
		limit: Type.Optional(Type.Number({ description: "用多少根日线，默认 120" })),
	}),
	replay: "safe",
	execute: async ({ code, limit }, api) => {
		const bars = await fetchDailyBars(code, limit ?? 120);
		// 行情拿不到也要出指标，所以单独包一层。
		let q;
		try {
			q = (await fetchQuotes([code]))[0];
		} catch {
			q = undefined;
		}
		const ind = computeIndicators(bars, q);
		api.output(`${q?.name ?? code}：${bars.length} 根日线 (${ind.range})，收盘 ${ind.last}\n`);
		return { output: [{ type: "text", text: JSON.stringify(ind, null, 1) }] };
	},
});

const addToWatchlist = defineTool({
	name: "watch",
	description: "把股票加入自选股（持久保存）",
	parameters: Type.Object({ code: codeParam }),
	replay: "safe",
	execute: async ({ code }, api, ctx) => {
		// 幂等：同一个 code 加两次只留一条。重跑安全。
		const added = await api.commit(async (tx) => {
			const list = await tx.doc(Watchlist, api.conversationId);
			const c = String(code).trim();
			if (list.codes.includes(c)) return false;
			list.codes.push(c);
			return true;
		}, ctx);
		return { output: [{ type: "text", text: added ? `已加入自选：${code}` : `${code} 已在自选中` }] };
	},
});

const unwatch = defineTool({
	name: "unwatch",
	description: "把股票移出自选股",
	parameters: Type.Object({ code: codeParam }),
	replay: "safe",
	execute: async ({ code }, api, ctx) => {
		const removed = await api.commit(async (tx) => {
			const list = await tx.doc(Watchlist, api.conversationId);
			const i = list.codes.indexOf(String(code).trim());
			if (i < 0) return false;
			list.codes.splice(i, 1);
			return true;
		}, ctx);
		return { output: [{ type: "text", text: removed ? `已移除：${code}` : `${code} 不在自选中` }] };
	},
});

/**
 * 一次查完自选股。故意做成一次调用而不是让模型循环：
 * 省 token、少往返，且所有行情取自同一时刻。
 */
const scanWatchlist = defineTool({
	name: "scan_watchlist",
	description: "一次查完自选股里所有股票的实时行情和关键指标",
	parameters: Type.Object({}),
	replay: "safe",
	execute: async (_args, api, ctx) => {
		// 必须在 commit 回调内部把值拷出来：commit 结束后返回的是失效的 overlay。
		const list = await api.commit(
			async (tx) => (await tx.doc(Watchlist, api.conversationId)).codes.slice(),
			ctx,
		);
		if (list.length === 0) return { output: [{ type: "text", text: "自选股是空的，先让我加几个。" }] };

		api.output(`扫描 ${list.length} 只：${list.join(", ")}\n`);
		const quotes = await fetchQuotes(list);
		const rows = [];
		for (const q of quotes) {
			let extra = "";
			// 每只单独 try：一只取不到 K 线不该让整个扫描失败。
			try {
				const ind = computeIndicators(await fetchDailyBars(q.symbol, 120), q);
				extra = ` | MA20 ${ind.ma20 ?? "n/a"} RSI ${ind.rsi14 ?? "n/a"} 回撤 ${ind.maxDrawdown === undefined ? "n/a" : (ind.maxDrawdown * 100).toFixed(1) + "%"} | ${ind.signals.join("；") || "无信号"}`;
			} catch (e) {
				extra = ` | 指标不可用（${e.message}）`;
			}
			rows.push(`${fmtQuote(q)}${extra}`);
		}
		return { output: [{ type: "text", text: rows.join("\n") }] };
	},
});

/** 大盘概览：主要指数一次查完，判断市场整体环境。 */
const marketOverview = defineTool({
	name: "market_overview",
	description: "查主要 A 股指数的实时行情：上证指数、深证成指、创业板指",
	parameters: Type.Object({}),
	replay: "safe",
	execute: async () => {
		const quotes = await fetchQuotes(["上证", "深证", "创业板"]);
		return { output: [{ type: "text", text: quotes.map(fmtQuote).join("\n") }] };
	},
});

// ------------------------------------------------- 系统提示词段落（每次请求重渲染）
const watchlistSection = section("watchlist", async (input, context) => {
	const doc = await input.read.snapshot(Watchlist, input.conversationId, context);
	if (!doc || doc.codes.length === 0) return undefined; // undefined 就是省略这一段
	return `当前自选股：${doc.codes.join(", ")}`;
});

export const StockTools = defineExtension({
	name: "stock",
	tools: [quote, indicators, addToWatchlist, unwatch, scanWatchlist, marketOverview],
	sections: [watchlistSection],
});

export const STOCK_INSTRUCTIONS = [
	"你是一个 A 股分析助手，只分析中国 A 股（沪市、深市、创业板、科创板、北交所）。",
	"回答行情/指标问题必须调用工具拿真实数据，绝不凭记忆编造价格或财务数据。",
	"分析要讲事实：给数字、给依据。不做收益承诺，不给买卖建议。",
	"提到价格时用人民币；指数点位不加「元」。",
	"用户说「看看我的自选」时用 scan_watchlist 一次查完；问大盘用 market_overview。",
	"A 股特有的事要提：涨跌停（主板 10%、创业板/科创板 20%、北交所 30%、ST 5%）、换手率、T+1。",
].join("\n");
