/**
 * Features a session can use but does not import.
 *
 * Each of these reaches code a headless, local-only host must not ship: the
 * global pi-ai provider registry, the TUI theme and HTML exporter, and the
 * bug-report summariser. A host that wants them installs them once at load
 * (`sdk.ts` does); a host that does not gets a session without those edges in
 * its module graph.
 */
import type { AgentState } from "@earendil-works/pi-agent-core";
import type { ExtensionRunner } from "./extensions/runner.ts";
import type { ToolDefinition } from "./extensions/types.ts";
import type { SessionManager } from "./session-manager.ts";

type CompleteSimple = typeof import("@earendil-works/pi-ai/compat").completeSimple;
type GenerateBugReportSummary = typeof import("./bug-report.ts").generateBugReportSummary;

export interface HtmlExportContext {
	sessionManager: SessionManager;
	state: AgentState;
	extensionRunner: ExtensionRunner;
	getToolDefinition: (name: string) => ToolDefinition | undefined;
	/** Theme names to try in order; the first one that exists is used. */
	themeCandidates: Array<string | undefined>;
	outputPath?: string;
}

export interface SessionFeatures {
	/** pi-ai's global `streamSimple`, so a session can tell when an agent still uses it. */
	legacyStreamSimple?: unknown;
	/** Rebuilds pi-ai's global API provider registry after a reload. */
	resetApiProviders?: () => void;
	/** pi-ai's global `completeSimple`, for summaries requested without a stream function. */
	completeSimple?: CompleteSimple;
	/** The TUI theme handed to extensions when no UI is attached. */
	theme?: unknown;
	exportToHtml?: (context: HtmlExportContext) => Promise<string>;
	generateBugReportSummary?: GenerateBugReportSummary;
}

const features: SessionFeatures = {};

export function installSessionFeatures(next: SessionFeatures): void {
	Object.assign(features, next);
}

export function sessionFeatures(): Readonly<SessionFeatures> {
	return features;
}

export function requireSessionFeature<K extends keyof SessionFeatures>(name: K): NonNullable<SessionFeatures[K]> {
	const feature = features[name];
	if (feature === undefined) throw new Error(`${name} is not available in this build`);
	return feature as NonNullable<SessionFeatures[K]>;
}
