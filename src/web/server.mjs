/**
 * A 股助理的本地 Web UI。
 *
 *   node src/web/server.mjs            # http://127.0.0.1:8420
 *   PORT=9000 node src/web/server.mjs
 *
 * 一个进程独占一个 storage（pi-durable 的限制），所以这个服务就是唯一的 owner：
 * 它开着的时候，不要再跑 agent.mjs。关掉服务再跑 CLI。
 *
 * 后端只做三件事：
 *   1. 把 conversation 的状态（transcript / 正在跑什么 / 档案 / 用量）推给浏览器（SSE）
 *   2. 收浏览器发来的话，submit 给 durable agent
 *   3. 别的都不做——决策还是模型的
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { Harness, createRegistry } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { STOCK_INSTRUCTIONS, StockTools, Watchlist, Findings, SeenItems } from "../agent/tools.mjs";
import { SubagentTools, Subagents } from "../agent/subagent.mjs";
import { localGatewayProvider } from "../model/local-provider.mjs";

const PORT = Number(process.env.PORT ?? 8420);
const DB = process.env.STOCK_DB ?? "./stock.sqlite";
const PROVIDER = process.env.STOCK_PROVIDER ?? "local";
const MODEL = process.env.STOCK_MODEL ?? "group/auto-deepseek-v4-1-flash";
const HERE = dirname(fileURLToPath(import.meta.url));

const context = BACKGROUND_CONTEXT;

// ------------------------------------------------------------------ 组装
const models = createModels();
models.setProvider(localGatewayProvider());
const registry = createRegistry();
registry.install(StockTools);
registry.install(SubagentTools);

const harness = await Harness.open(await openNodeSqliteStorage(DB), { models, registry }, context);
const root = await harness.root(context, {
	agent: { model: { provider: PROVIDER, modelId: MODEL }, instructions: STOCK_INSTRUCTIONS },
});
harness.resume();

// ------------------------------------------------------------------ 状态序列化
function textOf(entry) {
	return (entry.model ?? [])
		.flatMap((m) => (Array.isArray(m.content) ? m.content : []))
		.filter((c) => c.type === "text")
		.map((c) => c.text)
		.join("");
}

/** 从 view 里抽 transcript + 实时状态。只读已在内存的 view，不碰 doc —— 所以能高频调。 */
function fromView(view) {
	const live = view.value.docs["pi.live"] ?? {};
	return {
		conversationId: root.id,
		entries: view.value.entries.map((e) => ({
			kind: e.kind,
			id: e.id,
			text: textOf(e).slice(0, 8000),
			tools: (e.model ?? [])
				.flatMap((m) => (Array.isArray(m.content) ? m.content : []))
				.filter((c) => c.type === "toolCall")
				.map((c) => ({ name: c.name, args: c.arguments, id: c.id })),
		})),
		live: {
			running: live.run !== undefined,
			// 字段是 generation.message（不是 partial）—— 已提交的限流部分答复。
			partial: live.generation?.message ? textOf({ model: [live.generation.message] }) : "",
			tools: Object.values(live.tools ?? {}).map((t) => ({ name: t.name, status: t.status })),
		},
	};
}

/**
 * 侧栏数据：自选股 / 档案 / 子 agent / 用量。
 * 这些要读好几个 doc，比较重，所以只在 run 结束或用户操作后才重算，
 * 不跟着流式帧一起推（不然会把打字机效果拖死）。
 */
async function fromDocs(view) {
	const usage = (await harness.usage(context)).models;
	const wl = await harness.snapshot(Watchlist, root.id, context);
	const fd = await harness.snapshot(Findings, root.id, context);
	const sa = await harness.snapshot(Subagents, root.id, context);

	const children = {};
	for (const [name, info] of Object.entries(sa?.agents ?? {})) {
		const handle = await harness.conversation(info.conversationId, context);
		if (!handle) continue;
		const cv = await handle.viewState(context);
		const last = [...cv.value.entries].reverse().find((e) => e.kind === "pi.assistant");
		children[name] = {
			conversationId: info.conversationId,
			entries: cv.value.entries.length,
			reported: info.reported.length,
			preview: last ? textOf(last).slice(0, 400) : "",
		};
	}

	return {
		watchlist: wl?.codes ?? [],
		findings: (fd?.items ?? []).slice(-50).reverse(),
		children,
		usage,
		// 有子 agent 在跑时侧栏也要刷新，所以带上任务数
		childCount: Object.keys(children).length,
	};
}

/** 完整快照：一个流式帧 + 一份重侧栏。用于首次加载和显式请求。 */
async function snapshot() {
	const view = await root.viewState(context);
	return { ...fromView(view), ...(await fromDocs(view)) };
}

// ------------------------------------------------------------------ SSE 广播
const clients = new Set();
let pushTimer;
let lastRunning = false;

function broadcast(payload) {
	const data = JSON.stringify(payload);
	for (const res of clients) {
		try {
			res.write(`data: ${data}\n\n`);
		} catch {
			clients.delete(res);
		}
	}
}

/**
 * 一帧 = 轻量实时部分（从 view 直接取）+ 可选的侧栏。
 * 关键：流式阶段只推轻量部分，不读 doc —— 否则打字机效果会被拖死。
 * 侧栏（自选/档案/子 agent）只在 run 开始、结束、或用户操作时重算。
 */
function schedulePush() {
	if (pushTimer) return;
	pushTimer = setTimeout(async () => {
		pushTimer = undefined;
		if (clients.size === 0) return;
		try {
			const view = await root.viewState(context);
			const cheap = fromView(view);
			// run 结束（running 从 true → false）时补一次重侧栏，其他时候只推轻的。
			const justStopped = lastRunning && !cheap.live.running;
			lastRunning = cheap.live.running;
			broadcast(justStopped ? { ...cheap, ...(await fromDocs(view)) } : cheap);
		} catch (e) {
			console.error("push 失败:", e.message);
		}
	}, 120);
}

const view = await root.viewState(context);
view.subscribe(() => schedulePush());

// ------------------------------------------------------------------ HTTP
function json(res, status, body) {
	const text = JSON.stringify(body);
	res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
	res.end(text);
}

async function readBody(req) {
	const chunks = [];
	for await (const c of req) chunks.push(c);
	return Buffer.concat(chunks).toString("utf8");
}

const server = createServer(async (req, res) => {
	try {
		const url = new URL(req.url, `http://${req.headers.host}`);

		// 前端页面
		if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
			const html = await readFile(join(HERE, "index.html"));
			res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
			res.end(html);
			return;
		}

		// 初始快照
		if (req.method === "GET" && url.pathname === "/api/state") {
			return json(res, 200, await snapshot());
		}

		// 实时事件流
		if (req.method === "GET" && url.pathname === "/api/stream") {
			res.writeHead(200, {
				"content-type": "text/event-stream; charset=utf-8",
				"cache-control": "no-cache",
				connection: "keep-alive",
			});
			res.write(": connected\n\n");
			clients.add(res);
			// 立刻给一份当前状态，不用等下一次 commit
			res.write(`data: ${JSON.stringify(await snapshot())}\n\n`);
			req.on("close", () => clients.delete(res));
			return;
		}

		// 发一句话给 agent
		if (req.method === "POST" && url.pathname === "/api/say") {
			const body = JSON.parse((await readBody(req)) || "{}");
			const content = String(body.content ?? "").trim();
			if (!content) return json(res, 400, { error: "空的" });
			// 不 await：submit 是持久的，答案会通过 SSE 推过去。
			root
				.submit({ type: "input", content }, context)
				.then(() => {
					// run 结束后侧栏（档案/子 agent）可能变了，补一帧全的。
					lastRunning = false;
					schedulePush();
				})
				.catch((e) => console.error("submit 失败:", e.message));
			return json(res, 200, { ok: true });
		}

		// 加自选（不走模型）
		if (req.method === "POST" && url.pathname === "/api/watch") {
			const body = JSON.parse((await readBody(req)) || "{}");
			const codes = (body.codes ?? []).map((c) => String(c).trim().toUpperCase()).filter(Boolean);
			const remove = body.action === "remove";
			await root.commit(async (tx) => {
				const list = await tx.doc(Watchlist, root.id);
				for (const c of codes) {
					const i = list.codes.indexOf(c);
					if (remove) {
						if (i >= 0) list.codes.splice(i, 1);
					} else if (i < 0) {
						list.codes.push(c);
					}
				}
			}, context);
			return json(res, 200, await snapshot());
		}

		// 停掉当前的 run
		if (req.method === "POST" && url.pathname === "/api/stop") {
			await root.abort(context);
			return json(res, 200, { ok: true });
		}

		json(res, 404, { error: "not found" });
	} catch (e) {
		console.error("请求失败:", e);
		json(res, 500, { error: String(e?.message ?? e) });
	}
});

server.listen(PORT, "127.0.0.1", () => {
	console.log(`A 股助理 Web UI: http://127.0.0.1:${PORT}`);
	console.log(`数据库 ${DB}，模型 ${PROVIDER}/${MODEL}`);
	console.log("注意：这个进程独占 storage，开着时不要再跑 agent.mjs。Ctrl-C 退出。");
});

// 关服务时把 harness 关干净，别留下半截 commit。
for (const sig of ["SIGINT", "SIGTERM"]) {
	process.on(sig, async () => {
		console.log("\n关闭中…");
		server.close();
		await harness.close(context).catch(() => {});
		process.exit(0);
	});
}
