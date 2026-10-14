# A 股分析 agent

一个跑得久、崩溃能续、状态持久化的 A 股分析 agent，用 LLM 调工具拿真实行情和指标。

**只分析中国 A 股**（沪市 / 深市 / 创业板 / 科创板 / 北交所 + 主要指数）。
不需要任何数据源的 API key。

基于 [`@earendil-works/pi-durable`](https://www.npmjs.com/package/@earendil-works/pi-durable)（durable agent harness）+ `pi-ai`。

> ⚠️ 仅供研究学习，**不构成投资建议**。数据来自非官方公开接口，准确性不保证。

## 跑

```bash
npm install

npm test                                        # 指标公式自检（不联网）
node src/agent/agent.mjs --add 600519 300750    # 加自选（不走模型）
node src/agent/agent.mjs "看看我的自选股"         # 问模型，它会调工具拿真实数据
node src/agent/agent.mjs "宁德时代现在什么情况"    # 单只分析
node src/agent/agent.mjs "今天大盘怎么样"          # 主要指数
node src/agent/agent.mjs --history                # 看 transcript / 自选 / 用量
```

也可以走 npm scripts：

```bash
npm start -- --add 600519          # = node src/agent/agent.mjs --add 600519
npm run recovery                   # 崩溃恢复演示（先阶段一杀进程，再跑一次续跑）
```

## 目录结构

```
src/
  data/
    market.mjs        取数：实时行情 + 前复权日线（腾讯公开接口）
    indicators.mjs    指标：纯函数，MA/RSI/MACD/波动率/回撤
  agent/
    tools.mjs         六个 agent 工具 + 自选股 document
    agent.mjs         CLI 入口
  model/
    local-provider.mjs  本地 OpenAI 兼容网关 provider
test/
  market.test.mjs     指标公式断言自检
  recovery-test.mjs   崩溃恢复演示
```

状态存在 `stock.sqlite`，删掉就归零。指数、指标公式都是实测过的。

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
| 工具是独立 durable task | 每个 `defineTool` |
| 崩溃恢复 | `harness.resume()` + `replay: "safe"` |
| 提交幂等 | `requestId` |
| 应用状态与 transcript 同一次原子提交 | `defineDoc(Watchlist)` + `api.commit` |
| 系统提示词实时反映状态 | `section("watchlist", ...)` 每次请求重渲染 |
| 可观测 | `viewState` / `snapshot` / `usage` / `taskGraph` |

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
