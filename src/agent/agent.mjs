/**
 * A 股研究助理 —— 一个长跑的 durable agent。
 *
 * 它不是流水线：你给目标，它自己决定调什么工具、要不要派子 agent、记什么进档案。
 * 状态、自选股、档案、子 agent 都在 stock.sqlite 里，随时中断、重跑，能从断点续。
 *
 *   node src/agent/agent.mjs "看看我的自选，有异动的深挖一下"   # 问它
 *   node src/agent/agent.mjs --watch                            # 常驻：每小时自动检查一次
 *   node src/agent/agent.mjs --add 600519 510300                # 加自选（不走模型）
 *   node src/agent/agent.mjs --history                          # 看 transcript / 自选 / 档案 / 用量
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { AssistantEntry, Harness, createRegistry } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { Findings, STOCK_INSTRUCTIONS, StockTools, Watchlist } from "./tools.mjs";
import { SubagentTools, Subagents } from "./subagent.mjs";
import { localGatewayProvider } from "../model/local-provider.mjs";
import { isMarketOpen, msUntilNextHour, beijingNow } from "../monitor/schedule.mjs";

const PROVIDER = process.env.STOCK_PROVIDER ?? "local";
const MODEL = process.env.STOCK_MODEL ?? "group/auto-deepseek-v4-1-flash";
const DB = process.env.STOCK_DB ?? "./stock.sqlite";
const WATCH_PROMPT =
	process.env.STOCK_WATCH_PROMPT ??
	"检查自选股的实时行情和指标。有异动的（放量、涨跌停、超卖超买、破均线）调 disclosures 看有没有对应的消息，值得记的用 save_finding 记下来。没有异动的不要记。最后给一句大盘概览。";

const context = BACKGROUND_CONTEXT;
const args = process.argv.slice(2);

// ------------------------------------------------------------------ 组装
const models = createModels();
models.setProvider(localGatewayProvider());

const registry = createRegistry();
registry.install(StockTools);
registry.install(SubagentTools);

const harness = await Harness.open(
	await openNodeSqliteStorage(DB),
	{ models, registry },
	context,
);
const root = await harness.root(context, {
	agent: {
		model: { provider: PROVIDER, modelId: MODEL },
		instructions: STOCK_INSTRUCTIONS,
	},
});

// ------------------------------------------------------------------ 输出
function assistantText(entry) {
	return (entry.model ?? [])
		.flatMap((m) => (Array.isArray(m.content) ? m.content : []))
		.filter((c) => c.type === "text")
		.map((c) => c.text)
		.join("");
}

function beijingStamp(now = new Date()) {
	return new Intl.DateTimeFormat("zh-CN", {
		timeZone: "Asia/Shanghai",
		year: "numeric", month: "2-digit", day: "2-digit",
		hour: "2-digit", minute: "2-digit", hour12: false,
	}).format(now);
}

/** 问一次，打印答案和用量。 */
async function ask(prompt, requestId) {
	const submission = await root.submit({ type: "input", content: prompt, ...(requestId ? { requestId } : {}) }, context);
	const done = await submission.wait(context);
	if (done.status !== "done") {
		console.error(`未完成：${done.status}${done.reason ? ` / ${done.reason}` : ""}`);
		process.exitCode = 1;
		return;
	}
	const entry = await root.commit((tx) => tx.entry(AssistantEntry, done.answer), context);
	console.log(`\n${assistantText(entry)}\n`);
	const usage = await harness.usage(context);
	const totals = Object.values(usage.models)[0];
	if (totals) {
		console.log(`— tokens: ${totals.input} in / ${totals.output} out，成本 $${(totals.cost?.total ?? 0).toFixed(4)}`);
	}
}

// ------------------------------------------------------------------ 命令
if (args.includes("--history")) {
	const view = await root.viewState(context);
	console.log(`对话 ${root.id}，${view.value.entries.length} 条 entry\n`);
	for (const e of view.value.entries) {
		const text = assistantText(e) || JSON.stringify(e.data ?? "").slice(0, 60);
		console.log(`[${e.kind}] ${text.slice(0, 200).replace(/\n/g, " ")}`);
	}
	const wl = await harness.snapshot(Watchlist, root.id, context);
	console.log(`\n自选股：${JSON.stringify(wl?.codes ?? [])}`);
	const fd = await harness.snapshot(Findings, root.id, context);
	console.log(`档案 ${fd?.items.length ?? 0} 条：`);
	for (const i of (fd?.items ?? []).slice(-10)) {
		console.log(`  ${i.at.slice(0, 16)} ${i.code} [${i.stance ?? "-"}] ${i.summary}`);
	}
	const sa = await harness.snapshot(Subagents, root.id, context);
	const names = Object.keys(sa?.agents ?? {});
	console.log(`子 agent：${names.length ? names.join(", ") : "无"}`);
	const usage = await harness.usage(context);
	console.log(`用量：${JSON.stringify(usage.models)}`);
} else if (args.includes("--add")) {
	// 不走模型，直接往自选股里写。
	const codes = args.filter((a) => !a.startsWith("--"));
	await root.commit(async (tx) => {
		const list = await tx.doc(Watchlist, root.id);
		for (const c of codes) {
			const s = c.trim().toUpperCase();
			if (!list.codes.includes(s)) list.codes.push(s);
		}
	}, context);
	console.log(`自选股：${(await harness.snapshot(Watchlist, root.id, context)).codes.join(", ")}`);
} else if (args.includes("--watch")) {
	// 常驻：开市时段的整点自动问一次。仍然是同一个 durable 对话，上下文连续。
	harness.resume();
	console.log(`常驻模式，助理对话 ${root.id}。开市时段整点自动检查，闭市跳过。Ctrl-C 退出。`);
	for (;;) {
		const now = new Date();
		if (isMarketOpen(now)) {
			const bj = beijingNow(now);
			const stamp = `${bj.weekday}-${bj.hour}${String(bj.minute).padStart(2, "0")}`;
			console.log(`\n=== 自动检查 ${beijingStamp(now)} ===`);
			// requestId 用时刻做键：同一小时重跑不会问两次。
			await ask(WATCH_PROMPT, `watch:${bj.weekday}:${bj.hour}:${bj.minute < 30 ? 0 : 30}`);
		} else {
			console.log(`休市（${beijingStamp(now)}），等到下一个整点。`);
		}
		await new Promise((r) => setTimeout(r, msUntilNextHour()));
	}
} else {
	harness.resume(); // 续跑上次没完成的 run
	const prompt = args.join(" ") || "看看我的自选股现在什么情况";
	await ask(prompt);
}

await harness.close(context);
