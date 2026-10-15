# pi-durable 用法笔记（v1.2.0，实测）

包存在且可用：`@earendil-works/pi-durable@1.2.0`（2026-10 前发布，experimental，API 无预告变动）。
依赖 `chord`（文档/取消）、`pi-ai`（模型）、`pi-codemode`（Code Mode）。要求 Node >= 22.19。

```bash
npm install @earendil-works/pi-durable @earendil-works/pi-ai @earendil-works/chord
```

## 心智模型

| 概念 | 是什么 |
|---|---|
| Harness | 一个 storage + 跑 agent 的机器。所有改动走同一条原子 commit 线，commit 落盘之前不对外可见 |
| Conversation | 一份 transcript（不可变 entry 的追加树）。`root()` 首次调用创建根对话 |
| Entry | 一条不可变记录：`pi.user` / `pi.assistant` / `pi.tool-result` / `pi.system` / `pi.reset` / 自定义 kind |
| Commit | 原子写。一次 commit 里可以同时追加 entry、改 document、建 task |
| Document | 类型化 JSON 状态，和 transcript 同处一地、同一次 commit 修改（`pi.agent`/`pi.live`/`pi.inbox`/`pi.usage` 都是内置 doc） |
| Task | 每步存 checkpoint 的持久状态机。崩溃后从最后一个 checkpoint 续跑 |
| Extension | 命名捆绑包：tools / sections / hooks / wraps / tasks。对话只存名字，不存代码 |
| Agent | 对话运行所依据的：model、thinking level、extensions、tools、instructions、cwd。每对话一份，存名字、用时才对着 registry 解析 |

## 最小可运行（已实测）

```typescript
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";

const context = BACKGROUND_CONTEXT;           // 所有异步调用都要一个 Context（带取消）
const models = createModels();
const harness = await Harness.open(new MemoryStorage(), { models, registry: createRegistry() }, context);
const root = await harness.root(context, { agent: { model: { provider: "openai", modelId: "gpt-6-sol" } } });

const sub = await root.submit({ type: "input", content: "hello" }, context);
const settled = await sub.wait(context);      // status: "done" | "unanswered"
await harness.close(context);
```

- `wait()` 只取消这次等待，绝不取消工作本身。
- 没有配 provider 时 settle 为 `unanswered` / reason `no_model`（实测）。

## 持久化 + 恢复（已实测，崩溃恢复真的работ）

```typescript
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

const harness = await Harness.open(await openNodeSqliteStorage("./session.sqlite"), { models, registry }, context);
const root = await harness.root(context);   // 重启后是同一个根对话
harness.resume();                           // 继续上个进程没跑完的 run
```

实测：在工具执行到一半 `process.exit(9)` 杀掉进程 → 重开同一 SQLite → `resume()` → 那个 tool 重新跑完（因为它声明了 `replay: "safe"`）→ 整个 run 最终 `status: "done"`，7 条 entry 完整。

**幂等**：同一个 `requestId` 重复 submit 返回同一个 submission（实测 `again.id === sub.id`）。这是崩溃后重试不重复执行的关键。

**replay 规则**：每个 tool call 都是独立 task，intent 在 `execute()` 之前就 commit 了。崩溃后：
- `replay: "safe"` → 重跑（只读类工具）
- 没声明 → 模型收到 `interrupted` 错误结果 + 目前已提交的输出，由模型决定怎么办（有副作用的工具必须这样）

## 三种 storage

| Backend | 导入 | 备注 |
|---|---|---|
| Memory | `MemoryStorage`（包根） | 不持久 |
| SQLite | `openNodeSqliteStorage(file)` | 单文件，WAL + `synchronous=NORMAL`：抗进程崩溃，断电可能丢最后一笔。长跑 agent 用这个 |
| JSONL | `openNodeJsonlStorage(dir, ctx)` | 追加式文件；`{fsync:true}` 每次 commit marker 前 flush；整个历史也留在内存 |
| CF DO | `openDurableObjectSqliteStorage(ctx.storage)` | Cloudflare SQLite-backed Durable Object |

SQLite/JSONL 的 portable 内核不用 Node API，加适配可跑 Bun / Cloudflare DO。
**一个 storage 同时只能被一个进程拥有**，没有跨进程锁。其他客户端 attach 到那个进程。

## 自带工具

`@earendil-works/pi-durable/tools` 提供 `read` / `write` / `edit` / `bash`，`CodingTools` 是包含四个的 extension。它们只通过 call 的 execution environment 碰文件与进程。

## 定义自己的 tool

```typescript
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";

const searchIssues = defineTool({
  name: "search_issues",
  description: "Search the issue tracker",
  parameters: Type.Object({ query: Type.String() }),
  replay: "safe",
  execute: async (args, api) => {
    api.output(`searching ${args.query}\n`);     // 流式输出，成为结果
    return { content: [{ type: "text", text: await tracker.search(args.query) }] };
  },
});
registry.install(defineExtension({ name: "ops", tools: [searchIssues] }));
```

- `args` 由 TypeBox schema 推导，harness 在 `execute()` 前校验。
- 结果的三个通道：`output`（给模型）、`structuredOutput`（给程序调用者）、`details`（给 UI）。transcript 只存 `output` 和 `details`。
- 可返回 `usage`（计入 cost）、`control: { terminate: true }`（本轮所有结果都要求就结束 run）、`control: { handoff }`（换新上下文）。
- `callers: ["model" | "tools"]` 控制谁能调；`deferred: true` 表示不直接给模型，靠 `tool_search` 加载。
- 同名 tool 后者覆盖前者；`wrapTool()` 装饰最终胜出的那个（例如给任意 bash 计时）。

### tool 调 tool

`api.executeTool("bash", { command: "npm test" }, context, { progress: false })` — 嵌套调用是独立的 tool task，属于调用者，走同样的校验/hook/限额/重放策略，结果返回给调用者而不进 transcript。调用者崩溃重跑时按 key 重新接上原来那些嵌套调用。

## Extension：prompt 段落 / hook / task

```typescript
const Coding = defineExtension({
  name: "coding",
  sections: [section("preamble", () => "You are a concise coding assistant.", { tag: false })],
  hooks: [hook(ToolTask, { beforeTool: (call) => (call.name === "bash" ? { block: "no bash here" } : undefined) })],
});
```

- 系统提示词**每次请求前**从各 section 重新渲染；只把变化的部分作为 `pi.system` 记进 transcript，保住 provider 的 prompt cache。
- Hooks：`GenerationTask` 的 `beforeRequest` / `afterResponse` / `onYield` / `afterTools`，`ToolTask` 的 `beforeTool` / `afterTool`。hook 会重跑，所以决策要写进 `api.memo`（首次写入生效）。
- **热替换**：`registry.install(ext)` 用已安装的名字就是一步替换。已开跑的调用继续用旧代码，下一次用新的。重启后重新 install 同样的 extension，pending task 就能续。

## 多对话 / fork / 子 agent

```typescript
const other = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
const fork  = await root.fork(entryId, { ownership: { kind: "ownerless" } }, context);
```

fork 看到父对话到 `entryId` 为止的历史，之后独立，拿到全新的 provider session 身份。

子 agent = 一个被 tool call 拥有的对话。关键点：
- 在 `api.commit()` 里 `tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } })`
- ownership 索引记得这个子对话，所以 tool 重跑时能找到同一个子 agent，而不是再建一个
- abort 这个 tool call 会 abort 子 agent（工作自底向上清理，每个 task 先撤销自己的副作用）
- `{ background: true }` 是边界：它拥有的工作能活过父的 abort，也不让父保持 busy

## 自己的持久状态（document）

```typescript
const Todos = defineDoc<{ items: string[] }>({
  kind: "app.todos", version: 1, scope: "conversation",
  history: "latest",   // 或 "rewindable"，可用 snapshotAsOf() 读旧值
  fork: "initial",     // fork 时给什么："initial" | "current" | "asOf"
  initial: () => ({ items: [] }),
});
await root.commit(async (tx) => { (await tx.doc(Todos, root.id)).items.push("write docs"); }, context);
```

`HarnessOptions.conversationCreated(tx, conversation)` 在每个创建/fork 对话的 commit 里跑，保证每个对话都拿到你的 document。

## 压缩 / reset / handoff

- 后台压缩：接近上限时后台总结，下一次请求放不下时才等。provider 报太长会自动压缩重试一次。旧消息永远留在 storage。
- 建议参数：`compaction: { reserveTokens: 16384, keepRecentTokens: 20000, backgroundTokens: 32768 }`。
- `root.compact("只保留失败测试名", ctx)` 手动压缩。
- `root.reset("handoff 说明", ctx)` 开新上下文；旧 entry 仍可用 `tx.scanEntries()` 搜。tool 可返回 `control: { handoff }` 触发同样效果。

## 多人 / 多客户端

UI 需要的一切都是已提交状态：

```typescript
const view = await root.viewState(context);
view.subscribe(v => render(v));          // v.entries / v.docs["pi.live"] / pi.inbox / pi.usage / pi.agent
const watch = await root.watch(context); // 精确的 Chord ops，适合发给远端客户端
watch.start(async (value, ops) => await send(ops));
```

- 慢客户端最多留 100 个未投递帧，之后被一整份最新 view 替换。迟到/重连的客户端从当前 view 开始，不重放。
- 流式输出默认每 100ms 提交一次（`settings.progress` 可调）。
- 插话：`submit(..., { whenBusy: "steer" })` 在当前工具轮之后加入正在跑的工作；默认是 `follow-up`；`"reject"` 会抛 `ConversationBusy`。
- `{ type: "write", entry: {...} }` 只写 entry 不问模型，立即追加（适合聊天消息）。
- 想要 coding-agent 风格事件流：`watchEvents(harness, root.id, ctx)`（`message_start` / `tool_execution_start` / ...），损失是线上字节更多。

## Code Mode（可选）

`createCodemodeExtension({ sandbox: new CodemodeSandbox({...}) })` 给对话加一个 `codemode` tool：模型写 JS，`await tools.<name>(args)` 调对话的工具，跑在 QuickJS 沙箱（`pi-codemode`），只有脚本输出到达模型。脚本本身也持久：崩溃后从头重跑，但 journal 里的结果按顺序喂回去，所以做的调用和参数都一样，再按 key 接回原来的嵌套调用。还带 `models.classify()` / `models.generateImages()`。

## 错误语义（三条规则）

1. **storage 错误终结整个 Harness**：之后所有等待都以 `SessionFailed` 拒绝，watch 以 `session_failed` 结束，然后自杀。不重试。重开即可恢复（commit 原子）。
2. **无效请求只坏那一次调用**（如坏游标、未知对话）。
3. **你的代码只坏它自己那个单元**：task phase 抛错 → 那个 task 失败；tool 抛错 → 得到 error result；hook 抛错 → 上报并跳过（`beforeTool` 里则阻断调用）；commit 回调抛错 → 回滚那次 commit。

```typescript
harness.closed.then(end => { if (end.reason === "failed") reopen(end.error); });
```

## 测试用 faux provider

不用真 API key 就能跑：

```typescript
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
const faux = fauxProvider();
models.setProvider(faux.provider);
faux.setResponses([
  fauxAssistantMessage([fauxToolCall("count", { n: 3 })], { stopReason: "toolUse" }),
  fauxAssistantMessage("done counting"),
]);
// agent 的 model 用 provider: "faux", modelId: faux.models[0].id  (faux-1)
```

坑：`models.setProvider(faux.provider)` 之后 provider 名是 `"faux"`（不是 `faux.provider.name`），modelId 是 `faux-1`。每个新进程都要重新 `setResponses`，否则模型请求以 `model_error` 结束——这是测试脚手架的问题，不是库的问题。

## 注意

- experimental，API 无预告变动。
- 包根加载 TypeBox，未打包时峰值 RSS 约 23MB（tree-shaken 后约 4MB）。
- 官方源码 `packages/durable`，30+ 个 example（`test/examples/14-chat.ts` 起，加上 `00`–`13` 的分层底层示例）。跑法：
  ```bash
  node --conditions=source --experimental-strip-types test/examples/14-chat.ts
  ```
