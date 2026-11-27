/**
 * The registry of MCP servers extensions register. Kept apart from MCP server
 * configuration so that holding an (empty) registry does not import the MCP package.
 */
import type { McpServerConfig } from "./mcp-servers.ts";

/** A server an extension registered with `pi.registerMcpServer()`. */
export interface RegisteredMcpServer {
	name: string;
	config: McpServerConfig;
	/** Path of the extension that registered the server. */
	extensionPath: string;
}

/** Servers registered by the extensions of one runtime. */
export class McpServerRegistry {
	private readonly servers = new Map<string, RegisteredMcpServer>();
	private changeListener: (() => void) | undefined;

	/** Register or replace a server. The caller checks ownership. */
	register(server: RegisteredMcpServer): void {
		this.servers.set(server.name, server);
		this.changeListener?.();
	}

	/** Remove a server registered by `extensionPath`. Servers of other extensions are left alone. */
	unregister(name: string, extensionPath: string): void {
		if (this.servers.get(name)?.extensionPath !== extensionPath) return;
		this.servers.delete(name);
		this.changeListener?.();
	}

	get(name: string): RegisteredMcpServer | undefined {
		return this.servers.get(name);
	}

	/** Copies of the registered servers, in registration order. */
	list(): RegisteredMcpServer[] {
		return [...this.servers.values()].map((server) => ({ ...server, config: structuredClone(server.config) }));
	}

	/** Called after every change. The runner sets it when it binds, to emit `mcp_servers_change`. */
	setChangeListener(listener: (() => void) | undefined): void {
		this.changeListener = listener;
	}
}
