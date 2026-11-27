/**
 * The harness-facing contract (AC-05): what an embedding host relies on, stated
 * against a scripted Chat Completions endpoint. Every host has to pass it
 * unchanged, so a behavioural difference after a cut is attributable to the cut.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentSessionEvent } from "../../packages/coding-agent/src/core/agent-session.ts";
import type { ToolDefinition } from "../../packages/coding-agent/src/core/extensions/types.ts";
import type { ContractHost, ContractSession, ContractSessionOptions } from "./host.ts";
import { localHost } from "./host-local.ts";
import { upstreamHost } from "./host-upstream.ts";
import { StubServer } from "./stub-server.ts";

const HOSTS: Record<string, ContractHost> = { upstream: upstreamHost, local: localHost };
const hostName = process.env.PI_CONTRACT_HOST ?? "upstream";
const host = HOSTS[hostName];
if (!host) throw new Error(`unknown PI_CONTRACT_HOST ${hostName}`);

const API_KEY = "contract-key";
const SYSTEM_PROMPT = "You are the contract test agent.";
const MODEL = { id: "local-a", contextWindow: 32000, maxTokens: 2048 };
const OTHER_MODEL = { id: "local-b", contextWindow: 32000, maxTokens: 2048 };

type Message = { role: string; content: unknown; tool_calls?: unknown; tool_call_id?: string };

/** The text of a Chat Completions message, whichever of the two content encodings was used. */
function textOf(message: Message): string {
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content)) return "";
	return message.content.map((part: { text?: string }) => part.text ?? "").join("");
}

describe(`session contract (${hostName} host)`, () => {
	let stub: StubServer;
	let root: string;
	let cwd: string;
	let sessionDir: string;
	const live: ContractSession[] = [];

	async function open(overrides: Partial<ContractSessionOptions> = {}): Promise<ContractSession> {
		const created = await host({
			cwd,
			endpoint: stub.endpoint,
			apiKey: API_KEY,
			models: [MODEL, OTHER_MODEL],
			systemPrompt: SYSTEM_PROMPT,
			tools: ["read"],
			...overrides,
		});
		live.push(created);
		return created;
	}

	function record(created: ContractSession): AgentSessionEvent[] {
		const events: AgentSessionEvent[] = [];
		created.session.subscribe((event) => events.push(event));
		return events;
	}

	const sent = (index: number): Message[] => stub.requests[index].body.messages;

	beforeEach(async () => {
		stub = new StubServer();
		await stub.start();
		root = mkdtempSync(join(tmpdir(), "pi-contract-"));
		cwd = join(root, "workspace");
		sessionDir = join(root, "sessions");
		mkdirSync(cwd);
		mkdirSync(sessionDir);
	});

	afterEach(async () => {
		for (const created of live.splice(0)) created.session.dispose();
		await stub.stop();
		rmSync(root, { recursive: true, force: true });
		expect(stub.unexpected, "requests the test did not script").toEqual([]);
		expect(stub.pending, "scripted replies that were never requested").toBe(0);
	});

	it("answers a one-shot prompt and sends exactly what the host configured", async () => {
		stub.enqueue({ text: "four" });
		const { session } = await open();

		await session.prompt("two plus two?");

		expect(session.getLastAssistantText()).toBe("four");
		expect(stub.requests).toHaveLength(1);
		const [request] = stub.requests;
		expect(request.method).toBe("POST");
		expect(request.path).toBe("/v1/chat/completions");
		expect(request.headers.authorization).toBe(`Bearer ${API_KEY}`);
		expect(request.body.model).toBe(MODEL.id);
		expect(request.body.stream).toBe(true);
		expect(textOf(sent(0)[0])).toContain(SYSTEM_PROMPT);
		expect(textOf(sent(0).at(-1) as Message)).toBe("two plus two?");
	});

	it("streams text deltas and lifecycle events in order", async () => {
		stub.enqueue({ text: "streamed reply" });
		const created = await open();
		const events = record(created);

		await created.session.prompt("go");

		const deltas = events.flatMap((event) =>
			event.type === "message_update" && event.assistantMessageEvent.type === "text_delta"
				? [event.assistantMessageEvent.delta]
				: [],
		);
		expect(deltas.length).toBeGreaterThan(1);
		expect(deltas.join("")).toBe("streamed reply");
		const order = events.map((event) => event.type);
		expect(order.indexOf("agent_start")).toBeGreaterThanOrEqual(0);
		expect(order.indexOf("agent_start")).toBeLessThan(order.indexOf("message_update"));
		expect(order.lastIndexOf("message_end")).toBeLessThan(order.indexOf("agent_end"));
		expect(order.indexOf("agent_end")).toBeLessThan(order.indexOf("agent_settled"));
	});

	it("reports the endpoint's token usage on the assistant message", async () => {
		stub.enqueue({ text: "counted", usage: { prompt_tokens: 123, completion_tokens: 45 } });
		const created = await open();
		const events = record(created);

		await created.session.prompt("count");

		const end = events.findLast((event) => event.type === "message_end" && event.message.role === "assistant");
		if (end?.type !== "message_end" || end.message.role !== "assistant") throw new Error("no assistant message_end");
		expect(end.message.usage.input).toBe(123);
		expect(end.message.usage.output).toBe(45);
		expect(created.session.getSessionStats().tokens.input).toBe(123);
	});

	it("offers the model only the allowed tools", async () => {
		stub.enqueue({ text: "ok" }, { text: "ok" });
		const reader = await open({ tools: ["read"] });
		await reader.session.prompt("first");
		const none = await open({ tools: [] });
		await none.session.prompt("second");

		const names = (index: number) =>
			(stub.requests[index].body.tools ?? []).map((tool: { function: { name: string } }) => tool.function.name);
		expect(names(0)).toEqual(["read"]);
		expect(names(1)).toEqual([]);
	});

	it("runs a built-in tool in the session workspace and returns its result to the model", async () => {
		writeFileSync(join(cwd, "note.txt"), "the note says hello\n");
		stub.enqueue({ toolCalls: [{ name: "read", arguments: { path: "note.txt" } }] }, { text: "read it" });
		const created = await open();
		const events = record(created);

		await created.session.prompt("read the note");

		expect(stub.requests).toHaveLength(2);
		const toolResult = sent(1).find((message) => message.role === "tool");
		expect(toolResult?.tool_call_id).toBe("call_0");
		expect(textOf(toolResult as Message)).toContain("the note says hello");
		expect(events.some((event) => event.type === "tool_execution_start" && event.toolName === "read")).toBe(true);
		expect(events.some((event) => event.type === "tool_execution_end" && !event.isError)).toBe(true);
		expect(created.session.getLastAssistantText()).toBe("read it");
	});

	it("runs a host-supplied custom tool", async () => {
		const calls: string[] = [];
		const shout: ToolDefinition = {
			name: "shout",
			label: "Shout",
			description: "Upper-case a word.",
			parameters: Type.Object({ word: Type.String() }),
			execute: async (_id, params) => {
				const { word } = params as { word: string };
				calls.push(word);
				return { content: [{ type: "text", text: word.toUpperCase() }], details: {} };
			},
		};
		stub.enqueue({ toolCalls: [{ name: "shout", arguments: { word: "quiet" } }] }, { text: "done" });
		const { session } = await open({ tools: ["shout"], customTools: [shout] });

		await session.prompt("shout quiet");

		expect(calls).toEqual(["quiet"]);
		expect(textOf(sent(1).find((message) => message.role === "tool") as Message)).toBe("QUIET");
	});

	it("continues a conversation with its earlier turns", async () => {
		stub.enqueue({ text: "first answer" }, { text: "second answer" });
		const { session } = await open();

		await session.prompt("first question");
		await session.prompt("second question");

		const texts = sent(1).map(textOf);
		expect(texts).toContain("first question");
		expect(texts).toContain("first answer");
		expect(texts.at(-1)).toBe("second question");
	});

	it("resumes a persisted session by id", async () => {
		stub.enqueue({ text: "remembered" }, { text: "resumed answer" });
		const first = await open({ sessionDir });
		await first.session.prompt("remember blue");
		const id = first.session.sessionId;
		first.session.dispose();

		const resumed = await open({ sessionDir, resumeSessionId: id });

		expect(resumed.session.sessionId).toBe(id);
		expect(resumed.session.messages.map((message) => message.role)).toEqual(["system", "user", "assistant"]);
		await resumed.session.prompt("which colour?");
		const texts = sent(1).map(textOf);
		expect(texts).toContain("remember blue");
		expect(texts).toContain("remembered");
	});

	it("forks a persisted session into a new one that keeps the history", async () => {
		stub.enqueue({ text: "original" }, { text: "forked answer" });
		const first = await open({ sessionDir });
		await first.session.prompt("start here");
		const id = first.session.sessionId;
		first.session.dispose();

		const fork = await open({ sessionDir, forkFromSessionId: id });

		expect(fork.session.sessionId).not.toBe(id);
		await fork.session.prompt("carry on");
		expect(sent(1).map(textOf)).toContain("start here");
		const original = await open({ sessionDir, resumeSessionId: id });
		expect(original.session.messages.map((message) => message.role)).toEqual(["system", "user", "assistant"]);
	});

	it("keeps nothing on disk for an in-memory session", async () => {
		stub.enqueue({ text: "ephemeral" });
		const { session } = await open();

		await session.prompt("leave no trace");

		expect(session.sessionFile).toBeUndefined();
	});

	it("aborts an in-flight request and closes its connection", async () => {
		stub.enqueue({ hang: true });
		const created = await open();
		const events = record(created);

		const running = created.session.prompt("this will hang");
		await expect.poll(() => events.some((event) => event.type === "message_update")).toBe(true);
		await created.session.abort();
		await running;

		expect(created.session.isStreaming).toBe(false);
		await expect.poll(() => stub.disconnects).toBe(1);
		const last = created.session.messages.at(-1);
		expect(last?.role === "assistant" && last.stopReason).toBe("aborted");
	});

	it("retries a failed request and reports the retry", async () => {
		stub.enqueue({ status: 503 }, { text: "second try" });
		const created = await open({ retry: { enabled: true, maxRetries: 2, baseDelayMs: 10 } });
		const events = record(created);

		await created.session.prompt("flaky");

		expect(stub.requests).toHaveLength(2);
		expect(events.some((event) => event.type === "auto_retry_start")).toBe(true);
		expect(created.session.getLastAssistantText()).toBe("second try");
	});

	it("ends the run with an error when the stream is malformed", async () => {
		stub.enqueue({ malformed: true });
		const { session } = await open();

		await session.prompt("break");

		const last = session.messages.at(-1);
		expect(last?.role === "assistant" && last.stopReason).toBe("error");
		expect(session.isStreaming).toBe(false);
	});

	it("sends a forced compaction to the same endpoint and carries the summary forward", async () => {
		// Keeping almost nothing splits the last turn, so the compaction summarises twice:
		// once for the history and once for the head of the turn it cut.
		stub.enqueue(
			{ text: "answer one" },
			{ text: "answer two" },
			{ text: "SUMMARY of the earlier conversation" },
			{ text: "SUMMARY of the earlier conversation" },
			{ text: "after compaction" },
		);
		const created = await open({ compaction: { enabled: false, keepRecentTokens: 1 } });
		const events = record(created);
		await created.session.prompt("question one");
		await created.session.prompt("question two");

		await created.session.compact();

		const summaries = stub.requests.slice(2);
		expect(summaries).toHaveLength(2);
		for (const request of summaries) {
			expect(request.path).toBe("/v1/chat/completions");
			expect(request.body.model).toBe(MODEL.id);
			expect(textOf(request.body.messages[0])).toContain("summarization");
		}
		expect(events.some((event) => event.type === "compaction_end")).toBe(true);
		await created.session.prompt("question three");
		expect(sent(4).map(textOf).join("\n")).toContain("SUMMARY of the earlier conversation");
	});

	it("switches model and sends later requests under the new id", async () => {
		stub.enqueue({ text: "from a" }, { text: "from b" });
		const created = await open();

		await created.session.prompt("one");
		await created.setModel(OTHER_MODEL.id);
		await created.session.prompt("two");

		expect(stub.requests[0].body.model).toBe(MODEL.id);
		expect(stub.requests[1].body.model).toBe(OTHER_MODEL.id);
	});

	it("persists the transcript as JSONL under the host's session directory", async () => {
		stub.enqueue({ text: "written down" });
		const { session } = await open({ sessionDir });

		await session.prompt("persist me");

		expect(session.sessionFile?.startsWith(sessionDir)).toBe(true);
		const lines = readFileSync(session.sessionFile as string, "utf8").trim().split("\n");
		const roles = lines.map((line) => JSON.parse(line)).flatMap((entry) => (entry.message ? [entry.message.role] : []));
		expect(roles).toEqual(["system", "user", "assistant"]);
	});
});
