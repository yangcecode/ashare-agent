/**
 * 股票分析 agent 的命令行入口。
 *
 *   node agent.mjs "看看我的自选股"
 *   node agent.mjs "600519 现在什么情况"
 *   node agent.mjs --add 600519 AAPL
 *   node agent.mjs --history
 *
 * 状态存在 stock.sqlite。崩溃/中断后再跑同一命令，会从断点续跑。
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
	AssistantEntry,
	Harness,
	createRegistry,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { STOCK_INSTRUCTIONS, StockTools, Watchlist } from "./tools.mjs";
import { localGatewayProvider } from "./local-provider.mjs";

// 模型：默认用本地网关（127.0.0.1:3425）。
// 换真 Anthropic 直接改这两个常量（或设环境变量）。
const PROVIDER = process.env.STOCK_PROVIDER ?? "local";
const MODEL = process.env.STOCK_MODEL ?? "group/auto-deepseek-v4-1-flash";
const DB = process.env.STOCK_DB ?? "./stock.sqlite";

const context = BACKGROUND_CONTEXT;
const args = process.argv.slice(2);

// ------------------------------------------------------------------ 组装
const models = createModels();
models.setProvider(localGatewayProvider()); // 读 LOCAL_MODEL_* 环境变量

const registry = createRegistry();
registry.install(StockTools);

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

// ------------------------------------------------------------------ 命令
if (args.includes("--history")) {
	const view = await root.viewState(context);
	console.log(`对话 ${root.id}，${view.value.entries.length} 条 entry\n`);
	for (const e of view.value.entries) {
		const text =
			(e.model ?? [])
				.flatMap((m) => (Array.isArray(m.content) ? m.content : []))
				.filter((c) => c.type === "text")
				.map((c) => c.text)
				.join("") || JSON.stringify(e.data ?? "").slice(0, 60);
		console.log(`[${e.kind}] ${text.slice(0, 200)}`);
	}
	const wl = await harness.snapshot(Watchlist, root.id, context);
	console.log(`\n自选股：${JSON.stringify(wl?.codes ?? [])}`);
	const usage = await harness.usage(context);
	console.log(`用量：${JSON.stringify(usage.models)}`);
} else if (args.includes("--add")) {
	// 不走模型，直接往自选股里写。演示 document 可以直接用命令行改。
	const codes = args.filter((a) => !a.startsWith("--"));
	await root.commit(async (tx) => {
		const list = await tx.doc(Watchlist, root.id);
		for (const c of codes) {
			const s = c.trim().toUpperCase();
			if (!list.codes.includes(s)) list.codes.push(s);
		}
	}, context);
	console.log(`自选股：${(await harness.snapshot(Watchlist, root.id, context)).codes.join(", ")}`);
} else {
	const prompt = args.join(" ") || "看看我的自选股";
	harness.resume(); // 续跑上次没完成的 run

	const submission = await root.submit({ type: "input", content: prompt }, context);
	const done = await submission.wait(context);

	if (done.status !== "done") {
		console.error(`未完成：${done.status}${done.reason ? ` / ${done.reason}` : ""}`);
		process.exitCode = 1;
	} else {
		const entry = await root.commit((tx) => tx.entry(AssistantEntry, done.answer), context);
		const text = entry.model
			.flatMap((m) => (Array.isArray(m.content) ? m.content : []))
			.filter((c) => c.type === "text")
			.map((c) => c.text)
			.join("");
		console.log(`\n${text}\n`);
		const usage = await harness.usage(context);
		const totals = Object.values(usage.models)[0];
		if (totals) {
			console.log(
				`— tokens: ${totals.input} in / ${totals.output} out, 成本 $${(totals.cost?.total ?? 0).toFixed(4)}`,
			);
		}
	}
}

await harness.close(context);
