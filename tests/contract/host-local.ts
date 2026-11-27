import { createLocalHost, type SessionStorage } from "../../local/src/index.ts";
import type { ContractHost, ContractSessionOptions } from "./host.ts";

function storageFor(options: ContractSessionOptions): SessionStorage {
	if (!options.sessionDir) return { type: "memory" };
	return {
		type: "directory",
		dir: options.sessionDir,
		resumeSessionId: options.resumeSessionId,
		forkFromSessionId: options.forkFromSessionId,
	};
}

/** The local build. The endpoint, key and model list belong to the host; a session only picks from them. */
export const localHost: ContractHost = async (options) => {
	const host = createLocalHost({ endpoint: options.endpoint, apiKey: options.apiKey, models: options.models });
	const session = await host.createSession({
		cwd: options.cwd,
		model: options.models[0].id,
		systemPrompt: options.systemPrompt,
		tools: options.tools,
		customTools: options.customTools,
		storage: storageFor(options),
		retry: options.retry,
		compaction: options.compaction,
	});

	return {
		session,
		setModel: async (id) => {
			const model = host.models.find((candidate) => candidate.id === id);
			if (!model) throw new Error(`model ${id} was not offered to this session`);
			await session.setModel(model);
		},
	};
};
