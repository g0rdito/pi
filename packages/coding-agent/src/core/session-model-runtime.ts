import type { ModelRuntime } from "./model-runtime.ts";

/**
 * What a session, its cache warmer and its extension-facing registry call on a
 * model runtime. `ModelRuntime` satisfies it. A host with one fixed inference
 * endpoint implements it directly, which keeps the provider catalog, OAuth and
 * credential storage behind `ModelRuntime` out of that host's module graph.
 */
export type SessionModelRuntime = Pick<
	ModelRuntime,
	| "checkAuth"
	| "classify"
	| "complete"
	| "generateImages"
	| "getAuth"
	| "getAvailableOfType"
	| "getAvailableSnapshot"
	| "getCompatibilityRequestConfig"
	| "getError"
	| "getModel"
	| "getModelOfType"
	| "getModels"
	| "getModelsOfType"
	| "getPhysicalModel"
	| "getProvider"
	| "getProviderAuthStatus"
	| "getRegisteredNativeProvider"
	| "getRegisteredProviderConfig"
	| "getRegisteredProviderIds"
	| "hasConfiguredAuth"
	| "isUsingOAuth"
	| "refresh"
	| "registerNativeProvider"
	| "registerProvider"
	| "registerVirtualModel"
	| "resolveModel"
	| "stream"
	| "streamSimple"
	| "unregisterProvider"
	| "unregisterVirtualModel"
>;
