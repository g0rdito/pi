import type { Api, Model } from "@earendil-works/pi-ai";
import { AuthStorage } from "../../packages/coding-agent/src/core/auth-storage.ts";
import { createExtensionRuntime } from "../../packages/coding-agent/src/core/extensions/loader.ts";
import { ModelRuntime } from "../../packages/coding-agent/src/core/model-runtime.ts";
import type { ResourceLoader } from "../../packages/coding-agent/src/core/resource-loader.ts";
import { createAgentSession } from "../../packages/coding-agent/src/core/sdk.ts";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.ts";
import { SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.ts";
import type { ContractHost, ContractModel, ContractSessionOptions } from "./host.ts";

const PROVIDER = "contract";

function staticResources(systemPrompt: string): ResourceLoader {
	const extensions = { extensions: [], errors: [], runtime: createExtensionRuntime() };
	return {
		getExtensions: () => extensions,
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () => systemPrompt,
		getSystemPromptSource: () => undefined,
		getAppendSystemPrompt: () => [],
		getAppendSystemPromptSources: () => [],
		extendResources: () => {},
		reload: async () => {},
	};
}

function sessionManagerFor(options: ContractSessionOptions): SessionManager {
	const { cwd, sessionDir } = options;
	if (!sessionDir) return SessionManager.inMemory(cwd);
	const existing = options.resumeSessionId ?? options.forkFromSessionId;
	if (!existing) return SessionManager.create(cwd, sessionDir);
	const path = SessionManager.findById(cwd, existing, sessionDir);
	if (!path) throw new Error(`no session ${existing} under ${sessionDir}`);
	return options.resumeSessionId
		? SessionManager.open(path, sessionDir, cwd)
		: SessionManager.forkFrom(path, cwd, sessionDir);
}

/** Unmodified upstream `createAgentSession`, configured the way upstream documents full host control. */
export const upstreamHost: ContractHost = async (options) => {
	const modelRuntime = await ModelRuntime.create({
		credentials: AuthStorage.inMemory({ [PROVIDER]: { type: "api_key", key: options.apiKey } }),
		modelsPath: null,
		allowModelNetwork: false,
	});
	const describe = (model: ContractModel): Model<Api> => ({
		id: model.id,
		name: model.id,
		api: "openai-completions",
		provider: PROVIDER,
		baseUrl: options.endpoint,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
	});
	const models = options.models.map(describe);
	modelRuntime.registerProvider(PROVIDER, {
		baseUrl: options.endpoint,
		api: "openai-completions",
		apiKey: options.apiKey,
		models: models.map(({ id, name, reasoning, input, cost, contextWindow, maxTokens }) => ({
			id,
			name,
			reasoning,
			input,
			cost,
			contextWindow,
			maxTokens,
		})),
	});

	const { session } = await createAgentSession({
		cwd: options.cwd,
		agentDir: `${options.cwd}/.contract-agent-dir`,
		model: models[0],
		thinkingLevel: "off",
		modelRuntime,
		settingsManager: SettingsManager.inMemory({
			cacheWarming: "off",
			enableInstallTelemetry: false,
			retry: options.retry ?? { enabled: false },
			compaction: options.compaction ?? { enabled: false },
		}),
		sessionManager: sessionManagerFor(options),
		resourceLoader: staticResources(options.systemPrompt),
		tools: options.tools,
		customTools: options.customTools,
	});

	return {
		session,
		setModel: async (id) => {
			const model = models.find((candidate) => candidate.id === id);
			if (!model) throw new Error(`model ${id} was not offered to this session`);
			await session.setModel(model);
		},
	};
};
