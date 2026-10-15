/**
 * 背景子 agent（Pi Durable）。
 *
 * 模型通过 subagent 工具派出子 agent：每个子 agent 是一个独立的 durable conversation，
 * 有自己的 transcript、自己的模型、自己的上下文。子 agent 的对话由「锚任务」拥有，
 * 而锚任务是 background 的：所以子 agent 的工作能活过主 agent 的一轮回答，
 * 主 agent 不会被它拖住；`--stop-all` 仍然能一次性停掉全部。
 *
 * 形态完全照着 pi-durable 的 test/examples/23-subagent-background.ts，
 * 那边实测过的模式：spawn / message / wait / stop / list。
 */
import { Type } from "@earendil-works/pi-ai";
import { AssistantEntry, defineDoc, defineExtension, defineTool } from "@earendil-works/pi-durable";

/** 子 agent 的锚任务 id 和已汇报的 entry，存在主对话里。 */
export const Subagents = defineDoc({
	kind: "stock.subagents",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial", // fork 主对话时不带子 agent
	initial: () => ({ agents: {} }),
});

const nameParam = Type.String({ description: "子 agent 的名字，如「茅台分析」「大盘」" });

// ── 锚任务说明 ────────────────────────────────────────────────────────────
// 子 agent 的对话归「派它的那个工具调用」这个 task 所有（ownership: { kind: "task", taskId: api.taskId }）。
// 这样：调用被 abort，子 agent 也被 abort；调用要等子 agent 完成才算完。
// pi-durable 1.2.0 的自定义 defineTask 在自循环时有 storage 索引 bug（已实测），
// 所以这里不自己写 background anchor task，用 tool task 的所有权，由库的内置机制驱动。
// shortcut: 需要「子 agent 活过父的整轮、且父不等待」时，要换成 background anchor task。

/** 让子 agent 干一件事，或给它追加指令。 */
const subagent = defineTool({
	name: "subagent",
	description:
		"派一个子 agent 做独立的分析任务，或给已有的子 agent 追加指令。子 agent 有自己的对话，能自己调工具。返回它的答案。",
	parameters: Type.Object({
		name: nameParam,
		task: Type.String({ description: "要子 agent 做什么，说清楚目标和要回答的问题" }),
		wait: Type.Optional(Type.Boolean({ description: "true = 等它答完再返回（默认 true）；false = 派出去就返回" })),
	}),
	replay: "safe", // 重跑时靠 requestId 找回同一个子对话和同一个提交
	execute: async ({ name, task, wait }, api, ctx) => {
		// 子对话的创建和登记在同一次 commit，跑在它自己的 api.commit 里。
		const child = await api.commit(async (tx) => {
			const doc = await tx.doc(Subagents, api.conversationId);
			const existing = doc.agents[name];
			if (existing) return existing.conversationId;
			// 子 agent 的对话归这个工具调用的 task 所有：调用被 abort，子 agent 也被 abort。
			const created = await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
			doc.agents[name] = { conversationId: created.id, reported: [] };
			return created.id;
		}, ctx);

		// 让主对话的 UI 能挂到子对话上看它的实时输出。
		await api.details({ conversationId: child, name }, ctx);

		const handle = await api.conversation(child, ctx);
		if (!handle) throw new Error(`子 agent「${name}」的对话找不到了`);

		const request = {
			type: "input",
			content: task,
			// 用名字做 requestId：重跑时找到同一个提交，而不是重发一次。
			requestId: `subagent:${api.taskId}`,
		};
		const submission = await handle.submit(request, ctx);

		if (wait === false) {
			return { output: [{ type: "text", text: `已派「${name}」去做，可以在后台跑。用 subagent_check 看结果。` }] };
		}

		const settled = await submission.wait(ctx);
		if (settled.status !== "done") {
			return { output: [{ type: "text", text: `子 agent「${name}」没做完：${settled.status}${settled.reason ? " / " + settled.reason : ""}` }] };
		}
		// 记下这次回答已经汇报过，避免重复。
		await api.commit(async (tx) => {
			const doc = await tx.doc(Subagents, api.conversationId);
			if (doc.agents[name]) doc.agents[name].reported.push(settled.answer);
		}, ctx);

		const entry = await api.commit((tx) => tx.entry(AssistantEntry, settled.answer), ctx);
		const text = entry
			? (entry.model ?? []).flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((c) => c.type === "text").map((c) => c.text).join("")
			: "";
		return { output: [{ type: "text", text: text || "（子 agent 没有返回文字）" }], details: { conversationId: child, name } };
	},
});

/** 看某个子 agent 最新说了什么（不打扰它）。 */
const subagentCheck = defineTool({
	name: "subagent_check",
	description: "看一个子 agent 最近的输出，或者列出所有子 agent",
	parameters: Type.Object({
		name: Type.Optional(nameParam),
	}),
	replay: "safe",
	execute: async ({ name }, api, ctx) => {
		const agents = await api.commit(async (tx) => {
			const doc = await tx.doc(Subagents, api.conversationId);
			return Object.entries(doc.agents).map(([k, v]) => ({ name: k, ...v }));
		}, ctx);
		if (agents.length === 0) return { output: [{ type: "text", text: "还没有派过子 agent。" }] };

		if (!name) {
			return {
				output: [{ type: "text", text: agents.map((a) => `- ${a.name}（对话 ${a.conversationId}，已汇报 ${a.reported.length} 次）`).join("\n") }],
			};
		}
		const found = agents.find((a) => a.name === name);
		if (!found) return { output: [{ type: "text", text: `没有叫「${name}」的子 agent。` }] };
		const handle = await api.conversation(found.conversationId, ctx);
		if (!handle) return { output: [{ type: "text", text: `「${name}」的对话不见了。` }] };
		const view = await handle.viewState(ctx);
		const texts = view.value.entries
			.filter((e) => e.kind === "pi.assistant")
			.slice(-3)
			.map((e) => (e.model ?? []).flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((c) => c.type === "text").map((c) => c.text).join(""));
		return { output: [{ type: "text", text: texts.join("\n---\n") || "（还没输出）" }] };
	},
});

/** 停掉一个子 agent。 */
const subagentStop = defineTool({
	name: "subagent_stop",
	description: "停掉一个正在跑的子 agent",
	parameters: Type.Object({ name: nameParam }),
	execute: async ({ name }, api, ctx) => {
		const child = await api.commit(async (tx) => {
			const doc = await tx.doc(Subagents, api.conversationId);
			return doc.agents[name]?.conversationId;
		}, ctx);
		if (child === undefined) return { output: [{ type: "text", text: `没有叫「${name}」的子 agent。` }] };
		const handle = await api.conversation(child, ctx);
		if (handle) await handle.abort(ctx);
		return { output: [{ type: "text", text: `已停「${name}」。` }] };
	},
});

export const SubagentTools = defineExtension({
	name: "subagent-stock",
	tools: [subagent, subagentCheck, subagentStop],
});
