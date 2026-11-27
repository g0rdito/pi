import type { AgentSession } from "../../packages/coding-agent/src/core/agent-session.ts";
import type { ToolDefinition } from "../../packages/coding-agent/src/core/extensions/types.ts";
import type { SessionModelRuntime } from "../../packages/coding-agent/src/core/session-model-runtime.ts";

export interface ContractModel {
	id: string;
	contextWindow: number;
	maxTokens: number;
}

/**
 * Everything a contract test tells a host. A host turns it into a session; the
 * tests then use the session API directly, so both hosts are held to the same
 * observable behaviour.
 */
export interface ContractSessionOptions {
	cwd: string;
	endpoint: string;
	apiKey: string;
	/** The first model is the session's model; the rest are available to switch to. */
	models: [ContractModel, ...ContractModel[]];
	systemPrompt: string;
	tools: string[];
	customTools?: ToolDefinition[];
	/** Persist under this directory. Absent means the session is in memory only. */
	sessionDir?: string;
	resumeSessionId?: string;
	forkFromSessionId?: string;
	retry?: { enabled: boolean; maxRetries?: number; baseDelayMs?: number };
	compaction?: { enabled: boolean; reserveTokens?: number; keepRecentTokens?: number };
}

export interface ContractSession {
	session: AgentSession<SessionModelRuntime>;
	/** Switch to another model from `models`, by id. */
	setModel(id: string): Promise<void>;
}

export type ContractHost = (options: ContractSessionOptions) => Promise<ContractSession>;
