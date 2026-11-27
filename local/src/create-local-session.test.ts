/**
 * What the local build guarantees beyond the shared session contract: what
 * goes on the wire, what the environment cannot change, and what a session
 * file cannot make it do.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StubServer } from "../../tests/contract/stub-server.ts";
import { createLocalHost, type LocalHost, type LocalSession } from "./create-local-session.ts";
import { EgressDeniedError } from "./egress-policy.ts";

const MODEL = { id: "local-a", contextWindow: 32000, maxTokens: 2048 };

describe("createLocalHost", () => {
	let stub: StubServer;
	let root: string;
	let cwd: string;
	let sessionDir: string;
	const live: LocalSession[] = [];

	const host = (): LocalHost => createLocalHost({ endpoint: stub.endpoint, apiKey: "host-key", models: [MODEL] });

	async function open(storage: Parameters<LocalHost["createSession"]>[0]["storage"] = { type: "memory" }) {
		const session = await host().createSession({
			cwd,
			model: MODEL.id,
			systemPrompt: "You are local.",
			tools: [],
			storage,
		});
		live.push(session);
		return session;
	}

	beforeEach(async () => {
		stub = new StubServer();
		await stub.start();
		root = mkdtempSync(join(tmpdir(), "pi-local-"));
		cwd = join(root, "workspace");
		sessionDir = join(root, "sessions");
		mkdirSync(cwd);
		mkdirSync(sessionDir);
	});

	afterEach(async () => {
		for (const session of live.splice(0)) session.dispose();
		await stub.stop();
		rmSync(root, { recursive: true, force: true });
	});

	it("puts only the approved headers on the wire", async () => {
		stub.enqueue({ text: "ok" });
		const session = await open();

		await session.prompt("hello");

		const sent = Object.keys(stub.requests[0].headers).sort();
		// The last five are set by Node's HTTP client, not by anything in the bundle.
		expect(sent).toEqual(
			[
				"accept",
				"authorization",
				"content-type",
				"accept-encoding",
				"accept-language",
				"connection",
				"content-length",
				"host",
				"sec-fetch-mode",
				"user-agent",
			].sort(),
		);
		expect(stub.requests[0].headers.authorization).toBe("Bearer host-key");
		expect(stub.requests[0].headers["user-agent"]).toBe("node");
	});

	it("sends the same request whatever OPENAI_* variables are set", async () => {
		stub.enqueue({ text: "ok" }, { text: "ok" });
		const clean = await open();
		await clean.prompt("hello");

		vi.stubEnv("OPENAI_BASE_URL", "https://api.openai.com/v1");
		vi.stubEnv("OPENAI_API_KEY", "sk-from-environment");
		vi.stubEnv("OPENAI_ORG_ID", "org-from-environment");
		vi.stubEnv("OPENAI_PROJECT_ID", "proj-from-environment");
		vi.stubEnv("OPENAI_CUSTOM_HEADERS", "X-Injected: yes");
		const poisoned = await open();
		await poisoned.prompt("hello");

		expect(stub.requests).toHaveLength(2);
		expect(stub.requests[1].path).toBe(stub.requests[0].path);
		expect(stub.requests[1].headers).toEqual(stub.requests[0].headers);
		expect(JSON.stringify(stub.requests[1])).not.toContain("from-environment");
		expect(stub.requests[1].headers["x-injected"]).toBeUndefined();
	});

	it.each([
		["a hostname", "http://litellm:4000/v1"],
		["OpenAI's API", "https://api.openai.com/v1"],
	])("refuses to start with %s as its endpoint", (_what, endpoint) => {
		expect(() => createLocalHost({ endpoint, apiKey: "k", models: [MODEL] })).toThrow(EgressDeniedError);
	});

	it("refuses a model the host was not started with", async () => {
		await expect(
			host().createSession({ cwd, model: "gpt-5", systemPrompt: "", tools: [], storage: { type: "memory" } }),
		).rejects.toThrow(/not one of this host's models/);
	});

	it("refuses a session id that is a path", async () => {
		await expect(open({ type: "directory", dir: sessionDir, resumeSessionId: "../../etc/passwd" })).rejects.toThrow(
			/Session id must/,
		);
	});

	it("does not resume a session file that is a symlink out of the session directory", async () => {
		stub.enqueue({ text: "ok" });
		const outside = join(root, "outside");
		mkdirSync(outside);
		const original = await open({ type: "directory", dir: outside });
		await original.prompt("planted");
		const id = original.sessionId;
		const [file] = readdirSync(outside);
		symlinkSync(join(outside, file), join(sessionDir, file));

		await expect(open({ type: "directory", dir: sessionDir, resumeSessionId: id })).rejects.toThrow(
			/not a regular file/,
		);
	});

	it("does not resume a session recorded for another workspace", async () => {
		stub.enqueue({ text: "ok" });
		const original = await open({ type: "directory", dir: sessionDir });
		await original.prompt("mine");
		const id = original.sessionId;
		original.dispose();
		const [file] = readdirSync(sessionDir);
		const path = join(sessionDir, file);
		const lines = readFileSync(path, "utf8").split("\n");
		const header = JSON.parse(lines[0]);
		lines[0] = JSON.stringify({ ...header, cwd: "/etc" });
		writeFileSync(path, lines.join("\n"));

		await expect(open({ type: "directory", dir: sessionDir, resumeSessionId: id })).rejects.toThrow(
			/no session .* for this workspace/,
		);
	});

	it("keeps the host's model when a resumed session recorded another one", async () => {
		stub.enqueue({ text: "ok" }, { text: "ok" });
		const original = await open({ type: "directory", dir: sessionDir });
		await original.prompt("first");
		const id = original.sessionId;
		original.dispose();
		const [file] = readdirSync(sessionDir);
		const path = join(sessionDir, file);
		writeFileSync(path, readFileSync(path, "utf8").replaceAll('"local-a"', '"gpt-5"').replaceAll('"local"', '"openai"'));

		const resumed = await open({ type: "directory", dir: sessionDir, resumeSessionId: id });
		await resumed.prompt("second");

		expect(stub.requests[1].body.model).toBe(MODEL.id);
		expect(stub.requests[1].path).toBe("/v1/chat/completions");
	});
});
