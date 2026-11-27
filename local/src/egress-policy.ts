/**
 * The one place the local build may open a connection from.
 *
 * This is the in-process half of the egress contract. It keeps honest code on
 * a single request shape; it cannot stop code that never calls it, which is
 * why the worker also runs under an OS network policy.
 */
export class EgressDeniedError extends Error {
	constructor(reason: string) {
		super(`egress denied: ${reason}`);
		this.name = "EgressDeniedError";
	}
}

/** An inference endpoint an administrator approved: a literal address and port, never a hostname. */
export interface InferenceEndpoint {
	/** Base URL the transport is configured with, without a trailing slash. */
	baseUrl: string;
	/** The only URL a request may target. */
	completionsUrl: string;
}

export interface EgressOptions {
	maxRequestBytes?: number;
}

export const DEFAULT_MAX_REQUEST_BYTES = 16 * 1024 * 1024;

const FORWARDED_HEADERS = ["authorization", "content-type", "accept"];

/**
 * Whether a hostname the URL parser produced is an address. The parser has
 * already done the validation: it only keeps brackets around a valid IPv6
 * address, and it rewrites every IPv4 spelling (decimal, hex, short forms) to
 * a dotted quad. Checking the parsed form avoids importing `node:net` here.
 */
function isIpLiteral(hostname: string): boolean {
	return hostname.startsWith("[") || /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname);
}

/**
 * Accepts `http(s)://<ip literal>:<port>[/path]`. A hostname is refused because
 * resolving it is a second destination (the resolver) and lets the answer change
 * after approval.
 */
export function parseInferenceEndpoint(value: string): InferenceEndpoint {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new EgressDeniedError(`inference endpoint is not a URL: ${value}`);
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new EgressDeniedError(`inference endpoint must be http or https, not ${url.protocol}`);
	}
	if (!isIpLiteral(url.hostname)) {
		throw new EgressDeniedError(`inference endpoint host must be an IP literal, not "${url.hostname}"`);
	}
	if (url.port === "") throw new EgressDeniedError("inference endpoint must name its port");
	if (url.username || url.password) throw new EgressDeniedError("inference endpoint must not carry credentials");
	if (url.search || url.hash) throw new EgressDeniedError("inference endpoint must not carry a query or fragment");

	const baseUrl = `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
	return { baseUrl, completionsUrl: `${baseUrl}/chat/completions` };
}

function requestUrl(input: Parameters<typeof fetch>[0]): string {
	if (typeof input === "string") return input;
	if (input instanceof URL) return input.href;
	return input.url;
}

/**
 * A `fetch` that performs exactly one kind of request: a bounded POST to the
 * endpoint's chat completions URL, carrying only the allowlisted headers and
 * refusing redirects. Everything else throws before any socket is opened.
 */
export function createEgressFetch(endpoint: InferenceEndpoint, options: EgressOptions = {}): typeof fetch {
	const maxRequestBytes = options.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES;

	return async (input, init = {}) => {
		if (typeof input !== "string" && !(input instanceof URL)) {
			throw new EgressDeniedError("request must be given as a URL, not a Request object");
		}
		const target = requestUrl(input);
		if (new URL(target).href !== new URL(endpoint.completionsUrl).href) {
			throw new EgressDeniedError(`${target} is not the approved inference URL`);
		}
		const method = (init.method ?? "GET").toUpperCase();
		if (method !== "POST") throw new EgressDeniedError(`method ${method} is not allowed`);
		if (typeof init.body !== "string") throw new EgressDeniedError("request body must be a string");
		const size = Buffer.byteLength(init.body);
		if (size > maxRequestBytes) {
			throw new EgressDeniedError(`request body is ${size} bytes, over the ${maxRequestBytes} byte limit`);
		}

		// Built from the allowlist, not filtered from the caller's set, so a header
		// added upstream or by an SDK cannot ride along by default.
		const incoming = new Headers(init.headers);
		const headers = new Headers();
		for (const name of FORWARDED_HEADERS) {
			const headerValue = incoming.get(name);
			if (headerValue !== null) headers.set(name, headerValue);
		}

		return fetch(endpoint.completionsUrl, {
			method: "POST",
			headers,
			body: init.body,
			signal: init.signal,
			redirect: "error",
		});
	};
}
