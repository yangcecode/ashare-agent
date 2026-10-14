/**
 * 崩溃恢复测试。
 *   阶段 1（--crash）：起一个 run，在工具执行中途 process.exit(9)
 *   阶段 2（默认）  ：重开同一 storage，harness.resume() 续跑
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { AssistantEntry, Harness, createRegistry } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { StockTools } from "./tools.mjs";
import { localGatewayProvider } from "./local-provider.mjs";

const DB = "./crash.sqlite";
const JOB = { type: "input", content: "给我 600519 和 300750 的技术指标", requestId: "crash-job" };
const context = BACKGROUND_CONTEXT;
const models = createModels();
models.setProvider(localGatewayProvider());
const registry = createRegistry();
registry.install(StockTools);

const harness = await Harness.open(await openNodeSqliteStorage(DB), { models, registry }, context);
const root = await harness.root(context, {
	agent: { model: { provider: "local", modelId: "group/auto-deepseek-v4-1-flash" }, instructions: "用工具拿数据。" },
});

if (process.argv.includes("--crash")) {
	await root.submit(JOB, context);
	for (let i = 0; i < 200; i++) {
		await new Promise((r) => setTimeout(r, 150));
		const nodes = Object.values((await harness.taskGraph(context)).value.tasks);
		if (nodes.some((n) => n.kind === "pi.tool" && n.state.status === "running")) {
			for (const n of nodes) console.log(`  ${n.kind} -> ${n.state.status}`);
			console.log("工具执行中，杀掉进程（exit 9）");
			process.exit(9);
		}
	}
	console.log("没等到工具开始");
	process.exit(9);
}

// 阶段 2：重开，续跑
console.log("重开 storage，resume()");
harness.resume();
const submission = await root.submit(JOB, context); // 同 requestId，拿回原来那个 submission
const settled = await submission.wait(context);
console.log("status:", settled.status);
if (settled.status === "done") {
	const e = await root.commit((tx) => tx.entry(AssistantEntry, settled.answer), context);
	const text = e.model.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((c) => c.type === "text").map((c) => c.text).join("");
	console.log("\n" + text.slice(0, 600));
}
const view = await root.viewState(context);
console.log(`\nentry 总数: ${view.value.entries.length}`);
await harness.close(context);
