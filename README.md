# A 股研究助理（durable agent）

一个**长跑的 durable agent 助理**：你给它目标，它自己决定调什么工具、要不要派子 agent、记什么进档案。
不是固定流水线——**循环和决策都是模型的事**，代码只提供工具和持久状态。

状态（transcript / 自选股 / 档案 / 子 agent）全在 `stock.sqlite` 里，随时中断、重跑，从断点续。

**只分析中国 A 股**（沪市 / 深市 / 创业板 / 科创板 / 北交所 + 场内 ETF）。
不需要任何数据源的 API key。

基于 [`@earendil-works/pi-durable`](https://www.npmjs.com/package/@earendil-works/pi-durable)（durable agent harness）+ `pi-ai`。

> ⚠️ 仅供研究学习，**不构成投资建议**。数据来自非官方公开接口，准确性不保证。

## 跑

```bash
npm install

npm test                                        # 指标公式自检（不联网）
npm run recovery                                # 崩溃恢复演示：工具跑一半杀进程，重开续跑

node src/agent/agent.mjs --add 600519 510300    # 加自选（不走模型）
node src/agent/agent.mjs "看看我的自选，有异动的深挖一下"
node src/agent/agent.mjs "派子 agent 分别深挖茅台和沪深300"
node src/agent/agent.mjs --watch                # 常驻：开市时段整点自动检查
node src/agent/agent.mjs --history              # 看 transcript / 自选 / 档案 / 子 agent / 用量
```

## 它怎么工作

一次典型的自动检查（`--watch` 每小时一条，或你手动问）：

```
你：看看我的自选，有异动的深挖一下
  ├─ market_status      现在开市吗
  ├─ quote              自选股实时行情
  ├─ indicators         技术指标（模型自己决定用多少根日线）
  ├─ market_overview    大盘环境，判断是否逆市
  ├─ disclosures        新闻+公告（去重，只给新的）
  ├─ subagent           派子 agent 深挖（可选，子 agent 有独立对话）
  └─ save_finding       值得记的结论进长期档案
→ 一段自的分析 + 档案里多了几条
```

**关键**：调什么、调几次、记不记、要不要派子 agent，都是模型看数据后决定的。
代码里**没有**「每只股票都调一次 LLM」这种写死的流程。

## Web 界面

浏览器里用，比终端舒服。**本地跑，不需要 Cloudflare。**

```bash
npm run web
# 打开 http://127.0.0.1:8420
```

页面上能做这些：

- **对话** — 下面输入框发一句，助理流式回答（打字机效果），工具调用以标签显示
- **自选股** — 右侧直接加/删，不走模型
- **档案** — 助理记下的结论，带倾向标签和 tags
- **子 agent** — 派出去的子 agent 及它们的最新输出
- 顶部有「运行中/空闲」和「停」按钮，底部显示 token 用量

**重要**：一个 storage 同时只能被一个进程拥有。所以：

- Web 服务开着时，**不要再跑 `npm start` 或 `npm run watch`**
- 要跑 CLI，先把 Web 服务 Ctrl-C 停掉
- 端口被占：`PORT=9000 npm run web`

### 它是怎么推的

用 SSE（`/api/stream`）。**不是**每次都全量重推：

| 帧 | 内容 | 何时 |
|---|---|---|
| 轻量帧 | transcript + `pi.live`（正在跑的生成/工具/部分答复） | 每次 commit，120ms 合并 |
| 完整帧 | 上面 + 自选股 / 档案 / 子 agent / 用量 | run 开始、结束、或你手动操作后 |

分开的原因：读 doc（档案、子 agent）比读 view 慢得多，跟着流式帧一起推会把打字机效果拖死——实测从 3 帧变 16 帧。

## 目录结构

```
src/
  data/
    market.mjs        取数：实时行情 + 前复权日线（腾讯公开接口）
    indicators.mjs    指标：纯函数，MA/RSI/MACD/波动率/回撤
  agent/
    tools.mjs         采集工具 + 自选股/档案/去重 document + 系统提示词段落
    subagent.mjs      背景子 agent：spawn / check / stop（每个子 agent 一个独立对话）
    agent.mjs         CLI 入口：问一句 / 常驻 / 加自选 / 看历史
  model/
    local-provider.mjs  本地 OpenAI 兼容网关 provider
  web/
    server.mjs        HTTP 服务：SSE 推状态 + 收指令（本地，独占 storage）
    index.html        单页前端，原生 JS，无构建步骤
  monitor/
    schedule.mjs      开市时段判断 + 整点对齐（纯函数）
    news.mjs          新闻 + 公告采集（东财，带 id 去重）
test/
  market.test.mjs     指标公式断言自检
  recovery-test.mjs   崩溃恢复：工具跑一半杀进程，重开续跑
```

状态存在 `stock.sqlite`（transcript + document 同一次原子 commit）。删掉就归零。

## 支持什么

**A 股代码**（自动识别交易所）：

| 输入 | 市场 | 涨跌停 |
|---|---|---|
| `600519`、`601398` | 沪市主板 | ±10% |
| `688981` | 科创板 | ±20% |
| `000001`、`002415` | 深市主板 | ±10% |
| `300750` | 创业板 | ±20% |
| `830799` | 北交所 | ±30% |
| `上证` `深证` `创业板` | 指数 | — |

非 A 股代码（如 `AAPL`）会被明确拒绝。

**工具**：

| 工具 | 干什么 |
|---|---|
| `quote` | 实时行情：价格、涨跌幅、成交额、换手率、PE/PB、市值、涨跌停价 |
| `indicators` | MA5/10/20/60、RSI14、MACD、年化波动率、最大回撤、距区间高低点 + 信号摘要 |
| `watch` / `unwatch` | 自选股增删（持久保存） |
| `scan_watchlist` | 一次查完自选股全部 |
| `market_overview` | 上证/深证/创业板指数 |

**数据源**：腾讯公开接口（`qt.gtimg.cn`、`web.ifzq.gtimg.cn`），不需要 API key。
实时行情自带 PE/PB/市值/换手率/涨跌停价；日线是**前复权**的。

## 这个 demo 演示了 Pi Durable 的什么

| 机制 | 在哪里 |
|---|---|
| 工具是独立 durable task | 每个 `defineTool`；只读的 `replay: "safe"` |
| 有副作用的工具不自动重放 | `watch` / `save_finding` 不声明 `replay` |
| **子 agent = 工具调用拥有的子对话** | `subagent.mjs`：`tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } })` |
| 子对话重跑时复用而非重建 | `tx.scanConversations({ ownerTaskId: api.taskId })` |
| 崩溃恢复 | `harness.resume()`，已实测：工具跑一半 `exit(9)` → 重开 `status: done` |
| 提交幂等 | `requestId`（子 agent 用 `subagent:${api.taskId}`） |
| 应用状态与 transcript 同一次原子提交 | `defineDoc(Watchlist/Findings/SeenItems)` + `api.commit` |
| 系统提示词实时反映状态 | `section("watchlist")` / `section("findings")` 每次请求重渲染 |
| 可观测 | `viewState` / `snapshot` / `usage` / `taskGraph` |

## 已知的库限制（实测）

**pi-durable 1.2.0 的自定义 `defineTask` 自循环会崩 storage。**
一个 `defineTask` 在单个调用里反复 commit `running → running`（比如写个定时循环 task），
会让 `SessionFailed: storage error`（`storage/memory.js` 的 `taskIdsByStatus` 索引未维护），
而 storage 错误按库的设计**终结整个 Harness**。

所以这里**不用自定义 task 驱动循环**——循环是模型驱动的（它调工具、调子 agent），
走的是库内置的 `pi.generation` / `pi.tool` task，那些是好的。
这也正好是想要的形态：**循环是模型的事，不是代码的事**。

## 模型

默认用**本地网关**（`local-provider.mjs`）：

```
http://127.0.0.1:3425/v1   OpenAI Chat Completions 兼容
模型 group/auto-deepseek-v4-1-flash
```

换模型：

```bash
STOCK_MODEL=group/auto-gpt-5-4 node src/agent/agent.mjs "看看自选"
LOCAL_MODEL_BASE_URL=http://127.0.0.1:8000/v1 LOCAL_MODEL_TOKEN=xxx node src/agent/agent.mjs "..."
```

`local-provider.mjs` 用 `openAICompletionsApi()` 复用 pi-ai 的 chat completions 实现，不自己写协议。

## 踩过的坑（都实测确认过）

1. **pi-ai 1.2.0 的 bug**：`openai-completions` 传 model **ref**（`{provider, modelId}`）时会崩
   （`Cannot read properties of undefined (reading 'includes')`），因为 ref 被一路传到
   `transformMessages → downgradeUnsupportedImages`，那里读 `model.input.includes(...)`。
   传完整 model 对象正常。已在 `local-provider.mjs` 里统一把 ref 解析成完整对象绕过（有最小复现）。

2. **自定义 provider 的 model 必须带 `baseUrl`**：api 的 `detectCompat()` 直接读 `model.baseUrl.includes(...)`，
   只设 provider 级的 `baseUrl` 不够。

3. **`api.commit` 的回调结束后返回值会失效**：返回 document 的 live proxy（或它的成员）再读会报
   `Cannot use a settled overlay`。要在回调**内部**把值拷出来（`.slice()`）。

4. **`section(key, render, options)` 的 `tag` 是 boolean**，不是字符串。

5. **`defineTool` 的幂等键必须自己定**：`replay: "safe"` 只保证重跑，不保证副作用只发生一次。
   `api.taskId` / `api.callId` 在重跑后都是新值。

## 注意

- 腾讯接口是**非官方**的，随时可能改字段或限流。真做盯盘要自己加缓存、重试、超时。
- 数据仅供研究，**不构成投资建议**。这个 agent 的提示词里也明确禁止给买卖建议。
- Pi Durable 是 experimental，API 无预告变动。本 demo 在 `@earendil-works/pi-durable@1.2.0` + Node v22.22.0 上实测通过。

## License

MIT
