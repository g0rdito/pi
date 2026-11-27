import { createServer, type IncomingHttpHeaders, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface StubUsage {
	prompt_tokens: number;
	completion_tokens: number;
}

/** One scripted reply. The stub answers requests in the order steps were enqueued. */
export type StubStep =
	| { text: string; usage?: StubUsage }
	| { toolCalls: Array<{ name: string; arguments: Record<string, unknown> }>; usage?: StubUsage }
	| { status: number; body?: string }
	/** A stream that starts, then sends a chunk that is not JSON. */
	| { malformed: true }
	/** A stream that starts and never finishes; it ends when the client disconnects. */
	| { hang: true };

export interface StubRequest {
	method: string;
	path: string;
	headers: IncomingHttpHeaders;
	// biome-ignore lint/suspicious/noExplicitAny: request bodies are asserted on loosely by tests
	body: any;
}

const DEFAULT_USAGE: StubUsage = { prompt_tokens: 11, completion_tokens: 7 };

/** A scripted OpenAI Chat Completions server: the only endpoint a contract test may reach. */
export class StubServer {
	readonly requests: StubRequest[] = [];
	/** Requests that arrived with nothing scripted. A passing test leaves this empty. */
	readonly unexpected: StubRequest[] = [];
	disconnects = 0;
	private readonly steps: StubStep[] = [];
	private readonly open = new Set<ServerResponse>();
	private server: Server | undefined;

	enqueue(...steps: StubStep[]): void {
		this.steps.push(...steps);
	}

	get pending(): number {
		return this.steps.length;
	}

	get endpoint(): string {
		const address = this.server?.address() as AddressInfo | null;
		if (!address) throw new Error("stub server is not listening");
		return `http://127.0.0.1:${address.port}/v1`;
	}

	async start(): Promise<void> {
		this.server = createServer((req, res) => {
			const chunks: Buffer[] = [];
			req.on("data", (chunk: Buffer) => chunks.push(chunk));
			req.on("end", () => {
				const raw = Buffer.concat(chunks).toString("utf8");
				const request: StubRequest = {
					method: req.method ?? "",
					path: req.url ?? "",
					headers: req.headers,
					body: raw ? JSON.parse(raw) : undefined,
				};
				this.requests.push(request);
				this.reply(request, res);
			});
		});
		await new Promise<void>((resolve) => this.server?.listen(0, "127.0.0.1", resolve));
	}

	async stop(): Promise<void> {
		for (const res of this.open) res.destroy();
		// The client keeps finished connections alive; without this, close() waits for them to idle out.
		this.server?.closeAllConnections();
		await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
	}

	private reply(request: StubRequest, res: ServerResponse): void {
		const step = this.steps.shift();
		if (!step || request.method !== "POST" || request.path !== "/v1/chat/completions") {
			this.unexpected.push(request);
			res.writeHead(500, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: { message: "stub: nothing scripted for this request" } }));
			return;
		}
		if ("status" in step) {
			res.writeHead(step.status, { "content-type": "application/json" });
			res.end(step.body ?? JSON.stringify({ error: { message: `stub status ${step.status}` } }));
			return;
		}

		const model = request.body?.model ?? "stub";
		const send = (payload: unknown) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
		const chunk = (delta: unknown, finish: string | null = null) =>
			send({
				id: "chatcmpl-stub",
				object: "chat.completion.chunk",
				created: 0,
				model,
				choices: [{ index: 0, delta, finish_reason: finish }],
			});

		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
		this.open.add(res);
		res.on("close", () => {
			this.open.delete(res);
			if (!res.writableFinished) this.disconnects += 1;
		});

		if ("hang" in step) {
			chunk({ role: "assistant", content: "partial" });
			return;
		}
		if ("malformed" in step) {
			chunk({ role: "assistant", content: "before the fault" });
			res.write("data: {not json\n\n");
			res.end();
			return;
		}

		if ("text" in step) {
			const middle = Math.ceil(step.text.length / 2);
			chunk({ role: "assistant", content: step.text.slice(0, middle) });
			chunk({ content: step.text.slice(middle) });
			chunk({}, "stop");
		} else {
			step.toolCalls.forEach((call, index) => {
				const args = JSON.stringify(call.arguments);
				const middle = Math.ceil(args.length / 2);
				chunk({
					role: "assistant",
					tool_calls: [{ index, id: `call_${index}`, type: "function", function: { name: call.name, arguments: "" } }],
				});
				chunk({ tool_calls: [{ index, function: { arguments: args.slice(0, middle) } }] });
				chunk({ tool_calls: [{ index, function: { arguments: args.slice(middle) } }] });
			});
			chunk({}, "tool_calls");
		}
		const usage = step.usage ?? DEFAULT_USAGE;
		send({
			id: "chatcmpl-stub",
			object: "chat.completion.chunk",
			created: 0,
			model,
			choices: [],
			usage: { ...usage, total_tokens: usage.prompt_tokens + usage.completion_tokens },
		});
		res.write("data: [DONE]\n\n");
		res.end();
	}
}
