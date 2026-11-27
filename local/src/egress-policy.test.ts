import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEgressFetch, EgressDeniedError, parseInferenceEndpoint } from "./egress-policy.ts";

describe("parseInferenceEndpoint", () => {
	it("accepts an address and port, with or without a path", () => {
		expect(parseInferenceEndpoint("http://10.0.0.5:4000/v1")).toEqual({
			baseUrl: "http://10.0.0.5:4000/v1",
			completionsUrl: "http://10.0.0.5:4000/v1/chat/completions",
		});
		expect(parseInferenceEndpoint("http://[::1]:4000/").completionsUrl).toBe("http://[::1]:4000/chat/completions");
	});

	it.each([
		["a hostname", "http://litellm:4000/v1"],
		["a public hostname", "https://api.openai.com/v1"],
		["no port", "http://10.0.0.5/v1"],
		["credentials", "http://user:pass@10.0.0.5:4000/v1"],
		["a query", "http://10.0.0.5:4000/v1?x=1"],
		["another scheme", "ftp://10.0.0.5:4000/v1"],
		["not a URL", "10.0.0.5:4000"],
	])("refuses %s", (_what, value) => {
		expect(() => parseInferenceEndpoint(value)).toThrow(EgressDeniedError);
	});
});

describe("createEgressFetch", () => {
	let server: Server;
	let origin: string;
	let seen: Array<{ method?: string; url?: string; headers: IncomingHttpHeaders; body: string }>;

	beforeEach(async () => {
		seen = [];
		server = createServer((req, res) => {
			let body = "";
			req.on("data", (chunk) => {
				body += chunk;
			});
			req.on("end", () => {
				seen.push({ method: req.method, url: req.url, headers: req.headers, body });
				if (req.url === "/redirect/chat/completions") {
					res.writeHead(307, { location: `${origin}/elsewhere` }).end();
					return;
				}
				res.writeHead(200, { "content-type": "application/json" }).end("{}");
			});
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	});

	afterEach(async () => {
		await new Promise((resolve) => server.close(resolve));
	});

	const post = (headers: Record<string, string> = {}) => ({ method: "POST", body: "{}", headers });

	it("sends the approved request with only the allowlisted headers", async () => {
		const endpoint = parseInferenceEndpoint(`${origin}/v1`);
		const egress = createEgressFetch(endpoint);

		const response = await egress(
			endpoint.completionsUrl,
			post({
				authorization: "Bearer key",
				"content-type": "application/json",
				"user-agent": "pi/1.5.0",
				"x-stainless-os": "Linux",
				"openai-organization": "org-123",
				"http-referer": "https://pi.dev",
			}),
		);

		expect(response.status).toBe(200);
		expect(seen).toHaveLength(1);
		const { headers } = seen[0];
		expect(headers.authorization).toBe("Bearer key");
		expect(headers["content-type"]).toBe("application/json");
		expect(headers["user-agent"]).not.toContain("pi/");
		expect(headers["x-stainless-os"]).toBeUndefined();
		expect(headers["openai-organization"]).toBeUndefined();
		expect(headers["http-referer"]).toBeUndefined();
	});

	it.each([
		["another path on the endpoint", (base: string) => `${base}/models`, post()],
		["another port", () => "http://127.0.0.1:1/v1/chat/completions", post()],
		["another host", () => "https://api.openai.com/v1/chat/completions", post()],
		["a GET", (base: string) => `${base}/chat/completions`, { method: "GET" }],
		["a body that is not a string", (base: string) => `${base}/chat/completions`, { method: "POST", body: new Blob(["{}"]) }],
	])("refuses %s without connecting", async (_what, target, init) => {
		const endpoint = parseInferenceEndpoint(`${origin}/v1`);
		const egress = createEgressFetch(endpoint);

		await expect(egress(target(endpoint.baseUrl), init as RequestInit)).rejects.toThrow(EgressDeniedError);
		expect(seen).toEqual([]);
	});

	it("refuses a body over the size limit", async () => {
		const endpoint = parseInferenceEndpoint(`${origin}/v1`);
		const egress = createEgressFetch(endpoint, { maxRequestBytes: 8 });

		await expect(egress(endpoint.completionsUrl, { method: "POST", body: "123456789" })).rejects.toThrow(
			/over the 8 byte limit/,
		);
		expect(seen).toEqual([]);
	});

	it("does not follow a redirect", async () => {
		const endpoint = parseInferenceEndpoint(`${origin}/redirect`);
		const egress = createEgressFetch(endpoint);

		await expect(egress(endpoint.completionsUrl, post())).rejects.toThrow();
		expect(seen.map((request) => request.url)).toEqual(["/redirect/chat/completions"]);
	});
});
