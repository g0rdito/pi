/**
 * The local build's session factory. It does what upstream's
 * `createAgentSession` does for a host that supplies everything, and nothing
 * else: no agent directory, no settings or credential files, no resource
 * discovery, no extensions, no model lookup.
 */
import { lstatSync } from "node:fs";
import { Agent, type ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { AgentSession, markRuntimeStreamFunction } from "../../packages/coding-agent/src/core/agent-session.ts";
import { createExtensionRuntime } from "../../packages/coding-agent/src/core/extensions/runtime.ts";
import type { ToolDefinition } from "../../packages/coding-agent/src/core/extensions/types.ts";
import { convertToLlm } from "../../packages/coding-agent/src/core/messages.ts";
import type { ResourceLoader } from "../../packages/coding-agent/src/core/resource-loader.ts";
import { assertValidSessionId, SessionManager } from "../../packages/coding-agent/src/core/session-manager.ts";
import type { SessionModelRuntime } from "../../packages/coding-agent/src/core/session-model-runtime.ts";
import { SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.ts";
import { type EgressOptions, parseInferenceEndpoint } from "./egress-policy.ts";
import { createLocalModelRuntime, type LocalModelConfig } from "./local-model-runtime.ts";

/** Fixed when the worker starts, by whoever launches it. A session cannot change any of it. */
export interface LocalHostOptions {
	/** `http(s)://<ip literal>:<port>[/path]` of the approved inference endpoint. */
	endpoint: string;
	apiKey: string;
	/** The models served at the endpoint. A session picks one of these by id. */
	models: readonly LocalModelConfig[];
	egress?: EgressOptions;
}

/** Where a session keeps its transcript. */
export type SessionStorage =
	| { type: "memory" }
	| {
			type: "directory";
			/** Host-owned directory holding one JSONL file per session. */
			dir: string;
			/** Continue this session. */
			resumeSessionId?: string;
			/** Start a new session from a copy of this one. */
			forkFromSessionId?: string;
	  };

export interface LocalSessionOptions {
	cwd: string;
	/** Id of one of the host's models. */
	model: string;
	systemPrompt: string;
	/** Names of the tools the model may call. */
	tools: readonly string[];
	customTools?: ToolDefinition[];
	storage: SessionStorage;
	retry?: { enabled: boolean; maxRetries?: number; baseDelayMs?: number };
	compaction?: { enabled: boolean; reserveTokens?: number; keepRecentTokens?: number };
}

export type LocalSession = AgentSession<SessionModelRuntime>;

export interface LocalHost {
	readonly models: readonly Model<Api>[];
	createSession(options: LocalSessionOptions): Promise<LocalSession>;
}

/** A resource loader that holds only what the host passed in and never looks anywhere. */
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

/**
 * Finds a session file by id, directly inside the host's directory. The id is
 * format-checked and the file must be a regular file, so neither a crafted id
 * nor a planted symlink can make a session load from somewhere else.
 */
function findSessionFile(cwd: string, dir: string, sessionId: string): string {
	assertValidSessionId(sessionId);
	const path = SessionManager.findById(cwd, sessionId, dir);
	if (!path) throw new Error(`no session ${sessionId} for this workspace in the session directory`);
	if (!lstatSync(path).isFile()) throw new Error(`session ${sessionId} is not a regular file`);
	return path;
}

function openSessionManager(cwd: string, storage: SessionStorage): SessionManager {
	if (storage.type === "memory") return SessionManager.inMemory(cwd);
	if (storage.resumeSessionId !== undefined && storage.forkFromSessionId !== undefined) {
		throw new Error("a session is either resumed or forked, not both");
	}
	if (storage.resumeSessionId !== undefined) {
		// The cwd override makes the host's workspace win over the one recorded in the file.
		return SessionManager.open(findSessionFile(cwd, storage.dir, storage.resumeSessionId), storage.dir, cwd);
	}
	if (storage.forkFromSessionId !== undefined) {
		return SessionManager.forkFrom(findSessionFile(cwd, storage.dir, storage.forkFromSessionId), cwd, storage.dir);
	}
	return SessionManager.create(cwd, storage.dir);
}

export function createLocalHost(hostOptions: LocalHostOptions): LocalHost {
	const { runtime, models } = createLocalModelRuntime({
		endpoint: parseInferenceEndpoint(hostOptions.endpoint),
		apiKey: hostOptions.apiKey,
		models: hostOptions.models,
		egress: hostOptions.egress,
	});

	const createSession = async (options: LocalSessionOptions): Promise<LocalSession> => {
		const model = models.find((candidate) => candidate.id === options.model);
		if (!model) throw new Error(`model ${options.model} is not one of this host's models`);

		const settingsManager = SettingsManager.inMemory({
			cacheWarming: "off",
			enableInstallTelemetry: false,
			retry: options.retry ?? { enabled: false },
			compaction: options.compaction ?? { enabled: false },
		});
		const sessionManager = openSessionManager(options.cwd, options.storage);
		const existing = sessionManager.buildSessionContext();
		const resumed = existing.messages.length > 0;
		// The model always comes from the host. A resumed transcript's recorded
		// provider and model are history, not configuration.
		const thinkingLevel: ThinkingLevel = "off";

		const agent = new Agent({
			initialState: { systemPrompt: "", model, thinkingLevel, tools: [], messages: existing.messages },
			convertToLlm,
			streamFn: async (requestModel, context, requestOptions) => {
				const providerRetry = settingsManager.getProviderRetrySettings();
				const idleTimeoutMs = settingsManager.getHttpIdleTimeoutMs();
				return runtime.streamSimple(requestModel, context, {
					...requestOptions,
					timeoutMs:
						requestOptions?.timeoutMs ??
						providerRetry.timeoutMs ??
						(idleTimeoutMs === 0 ? 2147483647 : idleTimeoutMs),
					maxRetries: requestOptions?.maxRetries ?? providerRetry.maxRetries,
					maxRetryDelayMs: requestOptions?.maxRetryDelayMs ?? providerRetry.maxRetryDelayMs,
				});
			},
			sessionId: sessionManager.getSessionId(),
			steeringMode: settingsManager.getSteeringMode(),
			followUpMode: settingsManager.getFollowUpMode(),
			transport: settingsManager.getTransport(),
			thinkingBudgets: settingsManager.getThinkingBudgets(),
			maxRetryDelayMs: settingsManager.getProviderRetrySettings().maxRetryDelayMs,
		});
		// The runtime attaches the host's key itself, so summaries must not resolve auth first.
		markRuntimeStreamFunction(agent.streamFunction, runtime);

		if (!resumed) {
			sessionManager.appendModelChange(model.provider, model.id);
			sessionManager.appendThinkingLevelChange(thinkingLevel);
		}

		const tools = [...options.tools];
		return new AgentSession<SessionModelRuntime>({
			agent,
			sessionManager,
			settingsManager,
			cwd: options.cwd,
			resourceLoader: staticResources(options.systemPrompt),
			customTools: options.customTools,
			modelRuntime: runtime,
			initialActiveToolNames: tools,
			usesDefaultTools: false,
			allowedToolNames: tools,
			extensionRunnerRef: {},
		});
	};

	return { models, createSession };
}
