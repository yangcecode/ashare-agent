/**
 * A 股助理的工具集（Pi Durable）。
 *
 * 工具是 durable task：intent 在 execute() 之前就 commit，崩溃后按 replay 策略续跑。
 * 只读工具 replay: "safe"；有副作用的（写 document）必须让模型自己决定重试。
 */
import { Type } from "@earendil-works/pi-ai";
import { defineDoc, defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import { fetchDailyBars, fetchQuotes } from "../data/market.mjs";
import { computeIndicators } from "../data/indicators.mjs";
import { fetchDisclosures } from "../monitor/news.mjs";
import { isMarketOpen, beijingNow } from "../monitor/schedule.mjs";

// --------------------------------------------------------------- 持久状态
export const Watchlist = defineDoc({
	kind: "stock.watchlist",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "asOf",
	initial: () => ({ codes: [] }),
});

/** 助理发现的东西。模型自己决定记什么，不是每只股票都记。 */
export const Findings = defineDoc({
	kind: "stock.findings",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "asOf",
	initial: () => ({ items: [] }),
});

/** 已经给模型看过的新闻/公告 id，避免重复喂。 */
export const SeenItems = defineDoc({
	kind: "stock.seen",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ ids: [] }),
});

const codeParam = Type.String({
	description: "6 位 A 股代码：沪市 600519、深市 000001、创业板 300750、科创板 688981；也接受「上证」「深证」「创业板」等指数",
});

function fmtQuote(q) {
	if (q.isIndex) return `${q.name}: ${q.price}, ${q.changePct >= 0 ? "+" : ""}${q.changePct}%`;
	return [
		`${q.name}(${q.code}): ${q.price} 元`,
		`${q.changePct >= 0 ? "+" : ""}${q.changePct}%`,
		`今开 ${q.open} 最高 ${q.high} 最低 ${q.low}`,
		`成交额 ${(q.amountWan / 10000).toFixed(2)} 亿`,
		`换手 ${q.turnoverPct}%`,
		`PE ${q.pe ?? "亏损/无"} PB ${q.pb ?? "n/a"}`,
		`总市值 ${q.totalCapYi} 亿`,
		`量比 ${q.volumeRatio ?? "n/a"}`,
		`涨停 ${q.limitUp} 跌停 ${q.limitDown}`,
		`asOf ${q.asOf}`,
	].join(" | ");
}

// ---------------------------------------------------------------- 采集工具
const quote = defineTool({
	name: "quote",
	description: "查 A 股实时行情：价格、涨跌幅、成交额、换手率、PE/PB、市值、量比、涨跌停价",
	parameters: Type.Object({ codes: Type.Array(codeParam, { description: "要查的代码" }) }),
	replay: "safe",
	execute: async ({ codes }) => {
		const quotes = await fetchQuotes(codes);
		return { output: [{ type: "text", text: quotes.map(fmtQuote).join("\n") }] };
	},
});

const indicators = defineTool({
	name: "indicators",
	description: "算技术指标：MA5/10/20/60、RSI14、MACD、年化波动率、最大回撤、距区间高低点 + 信号摘要",
	parameters: Type.Object({
		code: codeParam,
		limit: Type.Optional(Type.Number({ description: "用多少根日线，默认 120" })),
	}),
	replay: "safe",
	execute: async ({ code, limit }, api) => {
		const bars = await fetchDailyBars(code, limit ?? 120);
		let q;
		// 行情拿不到也要出指标，所以单独包一层。
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

/**
 * 新闻 + 公告。默认只返回没见过的（记在 SeenItems document 里），
 * 所以重复调用不会把同样几条新闻反复喂给模型。
 */
const disclosures = defineTool({
	name: "disclosures",
	description: "查一只股票的新闻和公告。默认只返回之前没看过的，避免重复。",
	parameters: Type.Object({
		code: codeParam,
		name: Type.Optional(Type.String({ description: "股票名，用于搜新闻，比代码准" })),
		includeSeen: Type.Optional(Type.Boolean({ description: "true 则连看过的也返回" })),
	}),
	replay: "safe",
	execute: async ({ code, name, includeSeen }, api, ctx) => {
		// commit 回调外读到的 doc 会失效，所以在里面把 seen 拷出来。
		const seen = await api.commit(async (tx) => {
			const doc = await tx.doc(SeenItems, api.conversationId);
			return doc.ids.slice();
		}, ctx);
		const seenSet = includeSeen ? new Set() : new Set(seen);
		const d = await fetchDisclosures({ code, name: name ?? code }, { seen: seenSet });
		const fresh = [...d.news.map((n) => n.id), ...d.announcements.map((a) => a.id)];
		if (fresh.length > 0) {
			await api.commit(async (tx) => {
				const doc = await tx.doc(SeenItems, api.conversationId);
				for (const id of fresh) if (!doc.ids.includes(id)) doc.ids.push(id);
			}, ctx);
		}
		const parts = [];
		if (d.announcements.length) {
			parts.push("【公告】\n" + d.announcements.map((a) => `- ${a.date} [${a.type}] ${a.title}`).join("\n"));
		} else parts.push("【公告】无新公告");
		if (d.news.length) {
			parts.push("【新闻】\n" + d.news.map((n) => `- ${n.date} ${n.title}${n.summary ? "：" + n.summary.slice(0, 100) : ""}`).join("\n"));
		} else parts.push("【新闻】无新新闻");
		if (d.errors.length) parts.push(`【采集异常】${d.errors.join("; ")}`);
		return { output: [{ type: "text", text: parts.join("\n\n") }] };
	},
});

const marketOverview = defineTool({
	name: "market_overview",
	description: "查大盘：上证指数、深证成指、创业板指的实时行情",
	parameters: Type.Object({}),
	replay: "safe",
	execute: async () => {
		const quotes = await fetchQuotes(["上证", "深证", "创业板"]);
		return { output: [{ type: "text", text: quotes.map(fmtQuote).join("\n") }] };
	},
});

const marketStatus = defineTool({
	name: "market_status",
	description: "现在 A 股开市吗（北京时间、交易时段）",
	parameters: Type.Object({}),
	replay: "safe",
	execute: async () => {
		const now = new Date();
		const bj = beijingNow(now);
		const open = isMarketOpen(now);
		const wd = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][bj.weekday];
		return {
			output: [{
				type: "text",
				text: `${wd} ${String(bj.hour).padStart(2, "0")}:${String(bj.minute).padStart(2, "0")}（北京时间），${open ? "开市中" : "休市"}`,
			}],
		};
	},
});

// ------------------------------------------------------------ 自选股管理
const addToWatchlist = defineTool({
	name: "watch",
	description: "把股票加入自选股（持久保存）",
	parameters: Type.Object({ codes: Type.Array(codeParam, { description: "要加入的代码" }) }),
	// 有副作用，不声明 replay：崩溃后让模型决定是否重试。
	execute: async ({ codes }, api, ctx) => {
		const added = await api.commit(async (tx) => {
			const list = await tx.doc(Watchlist, api.conversationId);
			const out = [];
			for (const code of codes) {
				const c = String(code).trim();
				if (!list.codes.includes(c)) {
					list.codes.push(c);
					out.push(c);
				}
			}
			return out;
		}, ctx);
		return {
			output: [{
				type: "text",
				text: added.length ? `已加入自选：${added.join(", ")}` : "这些都已经在自选里了",
			}],
		};
	},
});

const unwatch = defineTool({
	name: "unwatch",
	description: "把股票移出自选股",
	parameters: Type.Object({ codes: Type.Array(codeParam) }),
	execute: async ({ codes }, api, ctx) => {
		const removed = await api.commit(async (tx) => {
			const list = await tx.doc(Watchlist, api.conversationId);
			const out = [];
			for (const code of codes) {
				const i = list.codes.indexOf(String(code).trim());
				if (i >= 0) {
					list.codes.splice(i, 1);
					out.push(String(code).trim());
				}
			}
			return out;
		}, ctx);
		return { output: [{ type: "text", text: removed.length ? `已移除：${removed.join(", ")}` : "都不在自选里" }] };
	},
});

// --------------------------------------------------------------- 记录发现
const saveFinding = defineTool({
	name: "save_finding",
	description: "把一条分析结论记进长期档案（持久保存，以后能翻）。只在真的值得记时用，不要每只都记。",
	parameters: Type.Object({
		code: codeParam,
		summary: Type.String({ description: "结论，一两句，讲事实" }),
		stance: Type.Optional(Type.String({ description: "偏多 / 偏空 / 中性 / 观望" })),
		tags: Type.Optional(Type.Array(Type.String({ description: "标签，如 放量、超卖、公告利好" }))),
	}),
	execute: async ({ code, summary, stance, tags }, api, ctx) => {
		const finding = await api.commit(async (tx) => {
			const doc = await tx.doc(Findings, api.conversationId);
			const rec = {
				at: new Date().toISOString(),
				code: String(code).trim(),
				summary,
				...(stance ? { stance } : {}),
				tags: tags ?? [],
			};
			doc.items.push(rec);
			// 只留最近 500 条，shortcut: 不按时间清理，到几千条时改成分页。
			if (doc.items.length > 500) doc.items.splice(0, doc.items.length - 500);
			return rec;
		}, ctx);
		return { output: [{ type: "text", text: `已记录 ${finding.code}：${finding.summary}` }] };
	},
});

const listFindings = defineTool({
	name: "list_findings",
	description: "翻看之前记录的分析结论（长期档案）",
	parameters: Type.Object({
		code: Type.Optional(codeParam),
		limit: Type.Optional(Type.Number({ description: "最多返回几条，默认 20" })),
	}),
	replay: "safe",
	execute: async ({ code, limit }, api, ctx) => {
		const items = await api.commit(
			async (tx) => (await tx.doc(Findings, api.conversationId)).items.slice(),
			ctx,
		);
		const filtered = code ? items.filter((i) => i.code === String(code).trim()) : items;
		const recent = filtered.slice(-(limit ?? 20));
		if (recent.length === 0) return { output: [{ type: "text", text: code ? `${code} 还没有记录` : "档案还是空的" }] };
		return {
			output: [{
				type: "text",
				text: recent.map((i) => `${i.at.slice(0, 16)} ${i.code} [${i.stance ?? "-"}] ${i.summary}${i.tags.length ? " #" + i.tags.join(" #") : ""}`).join("\n"),
			}],
		};
	},
});

// ------------------------------------------------- 系统提示词段落（每次请求重渲染）
const watchlistSection = section("watchlist", async (input, context) => {
	const doc = await input.read.snapshot(Watchlist, input.conversationId, context);
	if (!doc || doc.codes.length === 0) return undefined;
	return `当前自选股：${doc.codes.join(", ")}`;
});

const findingsSection = section("findings", async (input, context) => {
	const doc = await input.read.snapshot(Findings, input.conversationId, context);
	if (!doc || doc.items.length === 0) return undefined;
	const recent = doc.items.slice(-8).map((i) => `- ${i.at.slice(0, 10)} ${i.code} [${i.stance ?? "-"}] ${i.summary}`);
	return `最近的档案记录（共 ${doc.items.length} 条）：\n${recent.join("\n")}`;
});

export const StockTools = defineExtension({
	name: "stock",
	tools: [
		quote, indicators, disclosures, marketOverview, marketStatus,
		addToWatchlist, unwatch, saveFinding, listFindings,
	],
	sections: [watchlistSection, findingsSection],
});

export const STOCK_INSTRUCTIONS = [
	"你是一个 A 股投资研究助理，只分析中国 A 股（沪市、深市、创业板、科创板、北交所）和场内 ETF。",
	"",
	"你是一个能长跑的助手：状态、自选股、档案都存在持久存储里，崩溃后能续。所以你可以慢慢做，记录做到一半也没关系。",
	"",
	"工作方式：",
	"- 要行情、指标、新闻，必须调工具拿真实数据，绝不凭记忆编造价格或事件。",
	"- 用 quote / indicators / disclosures 采集；用 watch / unwatch 管理自选股；用 save_finding 记结论；用 list_findings 翻旧账。",
	"- save_finding 只记真正有价值的结论（有具体理由、可回头验证的），不要把每只股票都记一遍。",
	"- 想深挖某个方向时，可以派子 agent 去做（subagent 工具）；子 agent 有自己的对话，适合独立的多步分析。",
	"",
	"分析纪律：",
	"- 讲事实、给数字、给依据。区分事实和推测，推测要写明「可能」。",
	"- 消息面要区分实质和噪音：业绩、增减持、重组、监管问询是实质；ETF 权重、指数调整、研报排名通常是噪音。",
	"- 不做收益承诺，不直接给买卖建议。可以说「偏强 / 偏弱 / 中性 / 值得关注」。",
	"",
	"A 股特有的要说：涨跌停（主板 10%、创业板/科创板 20%、北交所 30%、ST 5%）、T+1、换手率。",
	"提到价格用人民币；指数点位不加「元」。",
].join("\n");
