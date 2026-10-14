/**
 * 指向本地模型网关（OpenAI Chat Completions 兼容）的 provider。
 *
 * 网关：http://127.0.0.1:3425/v1
 * 模型：group/auto-deepseek-v4-1-flash 等（/v1/models 可列）
 *
 * 复用 pi-ai 的 openAICompletionsApi（chat completions 协议），不自己写流。
 * 本地网关没有真实的定价信息，cost 全设 0（否则 usage 里的成本是假的）。
 */
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { createProvider } from "@earendil-works/pi-ai/models";

const BASE_URL = process.env.LOCAL_MODEL_BASE_URL ?? "http://127.0.0.1:3425/v1";
// 本地网关的 token，默认占位值。真网关请用 LOCAL_MODEL_TOKEN 覆盖。
const TOKEN = process.env.LOCAL_MODEL_TOKEN ?? "magpie";

/**
 * @param {string} id 模型 id，例如 "group/auto-deepseek-v4-1-flash"
 */
function modelDef(id, { contextWindow = 128000, reasoning = false } = {}) {
	return {
		id,
		name: id,
		provider: "local",
		api: "openai-completions",
		// 必须给每个 model 带上 baseUrl：api 的 detectCompat() 会直接读 model.baseUrl.includes(...)，
		// 缺了会在同步阶段就抛 "Cannot read properties of undefined (reading 'includes')"。
		baseUrl: BASE_URL,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow,
		maxTokens: 8192,
		...(reasoning ? { reasoning: true } : {}),
	};
}

export function localGatewayProvider({ modelIds } = {}) {
	const ids = modelIds ?? [process.env.LOCAL_MODEL_ID ?? "group/auto-deepseek-v4-1-flash"];
	const provider = createProvider({
		id: "local",
		name: "Local gateway",
		baseUrl: BASE_URL,
		auth: {
			apiKey: {
				name: "Local gateway token",
				// 固定 token，不需要环境变量里的 API key。
				resolve: async () => ({
					auth: { apiKey: TOKEN, baseUrl: BASE_URL },
					source: "LOCAL_MODEL_TOKEN",
				}),
			},
		},
		models: ids.map((id) => modelDef(id)),
		api: openAICompletionsApi(),
	});

	// pi-ai 1.2.0 的 openai-completions 有个坑（已最小复现）：
	// 传 model ref（{provider, modelId}）时它会把这个 ref 一路传到
	// transformMessages -> downgradeUnsupportedImages，那里读 model.input.includes(...)
	// 而 ref 上没有 input，于是抛 "Cannot read properties of undefined (reading 'includes')"。
	// 传完整 model 对象就正常。这里统一把 ref 解析成完整对象，绕开这个库缺陷。
	const resolve = (model) =>
		model && model.modelId !== undefined && model.input === undefined
			? (provider.getModels().find((m) => m.id === model.modelId) ?? model)
			: model;
	return {
		...provider,
		stream: (model, ctx, opts) => provider.stream(resolve(model), ctx, opts),
		streamSimple: (model, ctx, opts) => provider.streamSimple(resolve(model), ctx, opts),
	};
}

/** 从网关的 /v1/models 拉模型列表，方便挑。 */
export async function listLocalModels(fetchImpl = fetch) {
	const res = await fetchImpl(`${BASE_URL}/models`, {
		headers: { authorization: `Bearer ${TOKEN}` },
	});
	if (!res.ok) throw new Error(`列模型失败：HTTP ${res.status}`);
	const json = await res.json();
	return json.data.map((m) => ({
		id: m.id,
		name: m.display_name ?? m.id,
		contextWindow: m.context_window ?? m.context_length,
		modalities: m.modalities?.input,
	}));
}
