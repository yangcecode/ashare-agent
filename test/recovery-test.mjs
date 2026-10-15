// 起一个 run，在工具执行中杀掉进程，验证 resume 能续
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { Harness, createRegistry } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { StockTools } from "./src/agent/tools.mjs";
import { SubagentTools } from "./src/agent/subagent.mjs";
import { localGatewayProvider } from "./src/model/local-provider.mjs";
const context = BACKGROUND_CONTEXT;
const models = createModels(); models.setProvider(localGatewayProvider());
const registry = createRegistry(); registry.install(StockTools); registry.install(SubagentTools);
const h = await Harness.open(await openNodeSqliteStorage("./crash-test.sqlite"), { models, registry }, context);
const root = await h.root(context);
const JOB = { type: "input", content: "查 600519 和 510300 的指标和新闻，汇总", requestId: "crash-job" };
if (process.argv.includes("--crash")) {
  await root.submit(JOB, context);
  for (let i=0;i<400;i++) {
    await new Promise(r=>setTimeout(r,100));
    const g = (await h.taskGraph(context)).value.tasks;
    const running = Object.values(g).filter(n=>n.kind==="pi.tool" && n.state.status==="running");
    if (running.length) { console.log("工具执行中:", running.map(n=>n.id).join(","), "→ kill -9"); process.exit(9); }
  }
  console.log("没等到工具"); process.exit(9);
}
h.resume();
const sub = await root.submit(JOB, context);
const s = await sub.wait(context);
console.log("重开后 status:", s.status);
await h.close(context);
