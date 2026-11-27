/**
 * The model runtime of the local build: a fixed list of models behind one
 * OpenAI-compatible endpoint, with a key the host supplied. There is no
 * catalog, no provider registry, no stored credential and no OAuth.
 */
import type { Api, Model } from "@earendil-works/pi-ai";
import { normalizeContext } from "@earendil-works/pi-ai";
import { type OpenAICompletionsOptions, stream, streamSimple } from "@earendil-works/pi-ai/api/openai-completions";
import type { SessionModelRuntime } from "../../packages/coding-agent/src/core/session-model-runtime.ts";
import { createEgressFetch, type EgressOptions, type InferenceEndpoint } from "./egress-policy.ts";

/** The provider id every local model carries. It names the endpoint, not a vendor. */
export const LOCAL_PROVIDER = "local";

export interface LocalModelConfig {
	id: string;
	contextWindow: number;
	maxTokens: number;
	/** Whether the model accepts a reasoning effort. Default: false. */
	reasoning?: boolean;
}

export interface LocalModelRuntimeOptions {
	endpoint: InferenceEndpoint;
	apiKey: string;
	models: readonly LocalModelConfig[];
	egress?: EgressOptions;
}

export interface LocalModelRuntime {
	runtime: SessionModelRuntime;
	models: readonly Model<Api>[];
}

function describeModel(endpoint: InferenceEndpoint, config: LocalModelConfig): Model<"openai-completions"> {
	return {
		id: config.id,
		name: config.id,
		api: "openai-completions",
		provider: LOCAL_PROVIDER,
		baseUrl: endpoint.baseUrl,
		reasoning: config.reasoning ?? false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: config.contextWindow,
		maxTokens: config.maxTokens,
	};
}

function unsupported(operation: string): never {
	throw new Error(`${operation} is not available in the local build`);
}

export function createLocalModelRuntime(options: LocalModelRuntimeOptions): LocalModelRuntime {
	if (options.apiKey === "") throw new Error("the local model runtime needs an API key for its endpoint");
	if (options.models.length === 0) throw new Error("the local model runtime needs at least one model");

	const models = options.models.map((config) => describeModel(options.endpoint, config));
	const egressFetch = createEgressFetch(options.endpoint, options.egress);
	const isLocal = (providerId: string) => providerId === LOCAL_PROVIDER;
	const find = (providerId: string, modelId: string) =>
		isLocal(providerId) ? models.find((model) => model.id === modelId) : undefined;
	const ours = (model: Model<Api>): Model<"openai-completions"> =>
		find(model.provider, model.id) ?? unsupported(`model ${model.provider}/${model.id}`);
	// Every request leaves through the egress fetch with the host's key. Caller
	// headers and identity are dropped here; the egress fetch drops the rest.
	const pinned = { apiKey: options.apiKey, fetch: egressFetch, headers: undefined, identity: undefined };

	const runtime: SessionModelRuntime = {
		streamSimple: (model, context, streamOptions) =>
			streamSimple(ours(model), normalizeContext(context), { ...streamOptions, ...pinned }),
		// `ours()` has established the API, which the caller's option type cannot express.
		stream: (model, context, streamOptions) =>
			stream(ours(model), normalizeContext(context), {
				...(streamOptions as OpenAICompletionsOptions | undefined),
				...pinned,
			}),
		complete: (model, context, streamOptions) =>
			stream(ours(model), normalizeContext(context), {
				...(streamOptions as OpenAICompletionsOptions | undefined),
				...pinned,
			}).result(),

		getAuth: async (providerOrModel: string | { provider: string }) => {
			const providerId = typeof providerOrModel === "string" ? providerOrModel : providerOrModel.provider;
			return isLocal(providerId) ? { auth: { apiKey: options.apiKey }, source: "host" } : undefined;
		},
		checkAuth: async (providerId) => (isLocal(providerId) ? { type: "api_key", source: "host" } : undefined),
		hasConfiguredAuth: isLocal,
		isUsingOAuth: () => false,
		getProviderAuthStatus: (providerId) =>
			isLocal(providerId) ? { configured: true, source: "runtime" } : { configured: false },
		getCompatibilityRequestConfig: () => ({ authHeader: false }),

		getModel: find,
		getPhysicalModel: find,
		getModels: (providerId) => (providerId === undefined || isLocal(providerId) ? models : []),
		getAvailableSnapshot: () => models,
		getModelsOfType: ((type: string, providerId?: string) =>
			type === "chat" && (providerId === undefined || isLocal(providerId))
				? models
				: []) as SessionModelRuntime["getModelsOfType"],
		getModelOfType: ((type: string, providerId: string, modelId: string) =>
			type === "chat" ? find(providerId, modelId) : undefined) as SessionModelRuntime["getModelOfType"],
		getAvailableOfType: (async (type: string, providerId?: string) =>
			type === "chat" && (providerId === undefined || isLocal(providerId))
				? models
				: []) as SessionModelRuntime["getAvailableOfType"],

		getError: () => undefined,
		refresh: async () => ({ aborted: false, errors: new Map() }),
		getProvider: () => undefined,
		getRegisteredNativeProvider: () => undefined,
		getRegisteredProviderConfig: () => undefined,
		getRegisteredProviderIds: () => [],

		// There is nothing to route between and nothing to register: the model
		// list is fixed when the worker starts.
		resolveModel: async (model) => unsupported(`virtual model ${model.provider}/${model.id}`),
		registerProvider: () => unsupported("registering a provider"),
		registerNativeProvider: () => unsupported("registering a provider"),
		unregisterProvider: () => unsupported("unregistering a provider"),
		registerVirtualModel: () => unsupported("registering a virtual model"),
		unregisterVirtualModel: () => unsupported("unregistering a virtual model"),
		classify: async () => unsupported("classification"),
		generateImages: async () => unsupported("image generation"),
	};

	return { runtime, models };
}
