/**
 * Tool name matching. Kept apart from MCP server configuration so that a host
 * without MCP can match tool names without importing the MCP package.
 */

/**
 * Regular expression for a tool name pattern where `*` matches any characters, as `toolExposure`,
 * `--tools`, and `--exclude-tools` accept them.
 */
export function toolPatternRegExp(pattern: string): RegExp {
	const source = pattern
		.split("*")
		.map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
		.join(".*");
	return new RegExp(`^${source}$`);
}

/** Whether a tool name matches any of the entries, each an exact name or a pattern. */
export function createToolNameMatcher(entries: readonly string[]): (name: string) => boolean {
	const names = new Set(entries.filter((entry) => !entry.includes("*")));
	const patterns = entries.filter((entry) => entry.includes("*")).map(toolPatternRegExp);
	return (name) => names.has(name) || patterns.some((pattern) => pattern.test(name));
}

/** MCP resource tools, which reach every server with resources. */
export const LIST_MCP_RESOURCES_TOOL = "list_mcp_resources";
export const LIST_MCP_RESOURCE_TEMPLATES_TOOL = "list_mcp_resource_templates";
export const READ_MCP_RESOURCE_TOOL = "read_mcp_resource";

const MCP_RESOURCE_TOOLS: ReadonlySet<string> = new Set([
	LIST_MCP_RESOURCES_TOOL,
	LIST_MCP_RESOURCE_TEMPLATES_TOOL,
	READ_MCP_RESOURCE_TOOL,
]);

/** Whether a tool comes from MCP: a server tool (`mcp__<server>__<tool>`) or a resource tool. */
export function isMcpToolName(name: string): boolean {
	return name.startsWith("mcp__") || MCP_RESOURCE_TOOLS.has(name);
}
