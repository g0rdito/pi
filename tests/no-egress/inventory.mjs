#!/usr/bin/env node
/**
 * Egress inventory: what each entry point can reach, and where it can open a
 * connection, start a process or load code at runtime.
 *
 * Two sources, because neither is sufficient alone. The esbuild metafile gives
 * the resolved module graph (static, dynamic and require edges, npm packages
 * included). The syntax scan finds what is not an import: global `fetch`,
 * `WebSocket`, computed `import()` / `require()`.
 *
 * Usage: node tests/no-egress/inventory.mjs [--out file] [name=entry ...]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { builtinModules, createRequire } from "node:module";
import { dirname, extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
// The root `typescript` is the native 7.x compiler, which has no parser API. This copy does.
const ts = createRequire(resolve(ROOT, "apps/p2/package.json"))("typescript");

const DEFAULT_ENTRIES = {
	"coding-agent": "packages/coding-agent/src/index.ts",
	sdk: "packages/coding-agent/src/core/sdk.ts",
	"agent-session": "packages/coding-agent/src/core/agent-session.ts",
	"extensions-index": "packages/coding-agent/src/core/extensions/index.ts",
	"extensions-runner": "packages/coding-agent/src/core/extensions/runner.ts",
	"agent-core": "packages/agent/src/index.ts",
	"ai-compat": "packages/ai/src/compat.ts",
	"ai-openai-completions": "packages/ai/src/api/openai-completions.ts",
};

const NETWORK_BUILTINS = new Set(["net", "tls", "http", "https", "http2", "dns", "dns/promises", "dgram"]);
const PROCESS_BUILTINS = new Set(["child_process", "worker_threads", "cluster"]);
const FLAGGED_PACKAGES = [
	/^undici$/,
	/^ws$/,
	/^node-fetch$/,
	/^openai$/,
	/^https?-proxy-agent$/,
	/^cross-spawn$/,
	/^jiti$/,
	/^@anthropic-ai\//,
	/^@aws-sdk\//,
	/^@smithy\//,
	/^@google\//,
	/^@mistralai\//,
	/^@earendil-works\/pi-(telemetry|mcp|codemode|tui)$/,
];
const WORKSPACE_NAMES = {
	agent: "@earendil-works/pi-agent-core",
	ai: "@earendil-works/pi-ai",
	"coding-agent": "@earendil-works/pi-coding-agent",
	codemode: "@earendil-works/pi-codemode",
	mcp: "@earendil-works/pi-mcp",
	schema: "@earendil-works/pi-schema",
	telemetry: "@earendil-works/pi-telemetry",
	tui: "@earendil-works/pi-tui",
};

function packageOf(file) {
	const marker = "node_modules/";
	const at = file.lastIndexOf(marker);
	if (at >= 0) {
		const parts = file.slice(at + marker.length).split("/");
		return parts[0].startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0];
	}
	const workspace = /^(?:packages|apps)\/([^/]+)\//.exec(file);
	return workspace ? (WORKSPACE_NAMES[workspace[1]] ?? `workspace:${workspace[1]}`) : "(root)";
}

function builtinName(path) {
	const name = path.startsWith("node:") ? path.slice(5) : path;
	return path.startsWith("node:") || builtinModules.includes(name) ? name : undefined;
}

const SCRIPT_KINDS = { ".ts": "TS", ".mts": "TS", ".cts": "TS", ".tsx": "TSX", ".jsx": "JSX" };
const CONSTRUCTORS = new Set(["WebSocket", "EventSource", "XMLHttpRequest", "Worker"]);
const GLOBAL_OBJECTS = new Set(["globalThis", "self", "window", "global"]);

/** Identifier is a value reference, not the name half of a declaration or member access. */
function isValueReference(node) {
	const parent = node.parent;
	if (!parent) return false;
	if (ts.isPropertyAccessExpression(parent)) return parent.expression === node;
	if (ts.isShorthandPropertyAssignment(parent)) return true;
	if (parent.name === node) return false;
	if (ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent)) return false;
	for (let up = parent; up; up = up.parent) if (ts.isTypeNode(up)) return false;
	return true;
}

function scanSource(file, text) {
	const kind = ts.ScriptKind[SCRIPT_KINDS[extname(file)] ?? "JS"];
	const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
	const sites = [];
	const env = new Set();
	const at = (node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
	const add = (node, what) => sites.push({ line: at(node), kind: what });
	const literal = (node) => node && (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node));

	const visit = (node) => {
		if (ts.isCallExpression(node)) {
			const callee = node.expression;
			if (callee.kind === ts.SyntaxKind.ImportKeyword && !literal(node.arguments[0])) add(node, "import-computed");
			else if (ts.isIdentifier(callee) && callee.text === "require" && !literal(node.arguments[0]))
				add(node, "require-computed");
		} else if (ts.isNewExpression(node) && ts.isIdentifier(node.expression)) {
			if (CONSTRUCTORS.has(node.expression.text)) add(node, `new-${node.expression.text}`);
		} else if (ts.isIdentifier(node) && node.text === "fetch" && isValueReference(node)) {
			add(node, ts.isCallExpression(node.parent) && node.parent.expression === node ? "fetch-call" : "fetch-ref");
		} else if (ts.isPropertyAccessExpression(node)) {
			const object = node.expression;
			if (node.name.text === "fetch" && ts.isIdentifier(object) && GLOBAL_OBJECTS.has(object.text))
				add(node, "fetch-call");
			if (ts.isPropertyAccessExpression(object) && object.name.text === "env" && object.expression.getText(source) === "process")
				env.add(node.name.text);
		}
		ts.forEachChild(node, visit);
	};
	visit(source);
	return { sites, env: [...env] };
}

export async function inventory(entry) {
	const unresolved = [];
	const result = await build({
		absWorkingDir: ROOT,
		entryPoints: [entry],
		bundle: true,
		write: false,
		metafile: true,
		outdir: "/tmp/inventory-out",
		platform: "node",
		format: "esm",
		target: "node22",
		tsconfig: resolve(ROOT, "tsconfig.json"),
		logLevel: "silent",
		loader: { ".node": "empty", ".wasm": "empty", ".html": "text", ".css": "text", ".md": "text", ".png": "empty" },
		plugins: [
			{
				name: "record-unresolved",
				setup(b) {
					b.onResolve({ filter: /.*/ }, async (args) => {
						if (args.pluginData?.inner) return undefined;
						const found = await b.resolve(args.path, {
							resolveDir: args.resolveDir,
							kind: args.kind,
							importer: args.importer,
							with: args.with,
							pluginData: { inner: true },
						});
						if (found.errors.length === 0) return found;
						unresolved.push({ path: args.path, from: relative(ROOT, args.importer), kind: args.kind });
						return { path: args.path, external: true };
					});
				},
			},
		],
	});

	const inputs = result.metafile.inputs;
	const files = Object.keys(inputs).filter((file) => !file.startsWith("<"));
	const retained = {};
	for (const output of Object.values(result.metafile.outputs))
		for (const [file, info] of Object.entries(output.inputs)) retained[file] = (retained[file] ?? 0) + info.bytesInOutput;

	// Shortest import chain from the entry, so every flagged file can be traced to the edge that pulls it in.
	const parent = new Map([[entry, undefined]]);
	const queue = [entry];
	for (let file = queue.shift(); file !== undefined; file = queue.shift())
		for (const edge of inputs[file]?.imports ?? [])
			if (!edge.external && !parent.has(edge.path)) {
				parent.set(edge.path, file);
				queue.push(edge.path);
			}
	const chain = (file) => {
		const out = [];
		for (let at = file; at !== undefined; at = parent.get(at)) out.unshift(at);
		return out;
	};

	// What each direct import of the entry costs on its own: the carve map.
	const closureOf = (start) => {
		const seen = new Set([start]);
		const stack = [start];
		for (let file = stack.pop(); file !== undefined; file = stack.pop())
			for (const edge of inputs[file]?.imports ?? [])
				if (!edge.external && !seen.has(edge.path)) {
					seen.add(edge.path);
					stack.push(edge.path);
				}
		return seen;
	};
	const flaggedIn = (set) => [...new Set([...set].map(packageOf))].filter((pkg) => FLAGGED_PACKAGES.some((rule) => rule.test(pkg))).sort();
	const reachesBuiltin = (set, names) =>
		[...set].some((file) => (inputs[file]?.imports ?? []).some((edge) => edge.external && names.has(builtinName(edge.path) ?? "")));
	const directImports = (inputs[entry]?.imports ?? [])
		.filter((edge) => !edge.external)
		.map((edge) => {
			const closure = closureOf(edge.path);
			return {
				path: edge.path,
				kind: edge.kind,
				files: closure.size,
				flagged: flaggedIn(closure),
				network: reachesBuiltin(closure, NETWORK_BUILTINS),
				process: reachesBuiltin(closure, PROCESS_BUILTINS),
			};
		})
		.sort((a, b) => b.files - a.files);

	const packages = {};
	const builtins = {};
	const allBuiltins = new Set();
	const externals = {};
	const dynamicImports = [];
	const sites = [];
	const env = {};
	for (const file of files) {
		const pkg = packageOf(file);
		const entryFor = (packages[pkg] ??= { files: 0, bytesIn: 0, bytesRetained: 0 });
		entryFor.files += 1;
		entryFor.bytesIn += inputs[file].bytes;
		entryFor.bytesRetained += retained[file] ?? 0;

		for (const edge of inputs[file].imports) {
			if (edge.kind === "dynamic-import" && !edge.external) dynamicImports.push({ from: file, to: edge.path });
			if (!edge.external) continue;
			const builtin = builtinName(edge.path);
			if (builtin === undefined) (externals[edge.path] ??= []).push(file);
			else if ((retained[file] ?? 0) > 0) allBuiltins.add(builtin);
			if (builtin !== undefined && (NETWORK_BUILTINS.has(builtin) || PROCESS_BUILTINS.has(builtin)))
				(builtins[builtin] ??= []).push(file);
		}

		const scanned = scanSource(file, readFileSync(resolve(ROOT, file), "utf8"));
		for (const site of scanned.sites) sites.push({ file, ...site });
		for (const key of scanned.env) (env[key] ??= []).push(file);
	}

	const flaggedPackages = Object.keys(packages).filter((pkg) => FLAGGED_PACKAGES.some((rule) => rule.test(pkg)));
	const flaggedFiles = new Set([...sites.map((site) => site.file), ...Object.values(builtins).flat()]);
	const firstFileOf = (pkg) => files.find((file) => packageOf(file) === pkg);

	return {
		entry,
		files: files.length,
		bytesIn: files.reduce((sum, file) => sum + inputs[file].bytes, 0),
		bytesRetained: Object.values(retained).reduce((sum, bytes) => sum + bytes, 0),
		packages: Object.fromEntries(Object.entries(packages).sort(([a], [b]) => a.localeCompare(b))),
		flaggedPackages: Object.fromEntries(flaggedPackages.sort().map((pkg) => [pkg, chain(firstFileOf(pkg))])),
		builtins: Object.fromEntries(Object.entries(builtins).sort(([a], [b]) => a.localeCompare(b))),
		// What ends up in the bundle, as opposed to what is merely reachable: tree shaking
		// drops a file whose exports nothing uses.
		retainedFiles: files.filter((file) => (retained[file] ?? 0) > 0).sort(),
		retainedBuiltins: [...allBuiltins].sort(),
		externals,
		unresolved,
		directImports,
		dynamicImports,
		sites,
		env: Object.fromEntries(Object.entries(env).sort(([a], [b]) => a.localeCompare(b))),
		chains: Object.fromEntries([...flaggedFiles].sort().map((file) => [file, chain(file)])),
	};
}

export { FLAGGED_PACKAGES, NETWORK_BUILTINS, PROCESS_BUILTINS, packageOf, ROOT };

if (process.argv[1] === fileURLToPath(import.meta.url)) await main(process.argv.slice(2));

async function main(args) {
	let out = "tests/no-egress/baseline/egress-inventory.json";
	const entries = {};
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--out") out = args[++i];
		else {
			const [name, entry] = args[i].split("=");
			entries[name] = entry;
		}
	}
	const selected = Object.keys(entries).length > 0 ? entries : DEFAULT_ENTRIES;

	const report = { entries: {} };
	for (const [name, entry] of Object.entries(selected)) {
		const data = await inventory(entry);
		report.entries[name] = data;
		printSummary(name, data);
	}
	writeFileSync(resolve(ROOT, out), `${JSON.stringify(report, null, "\t")}\n`);
	console.log(`wrote ${out}`);
}

function printSummary(name, data) {
	const count = (kind) => data.sites.filter((site) => site.kind.startsWith(kind)).length;
	console.log(
		[
			name.padEnd(22),
			`${data.files} files`.padStart(11),
			`${(data.bytesRetained / 1024).toFixed(0)} KiB`.padStart(10),
			`pkgs ${Object.keys(data.packages).length}`.padStart(8),
			`flagged ${Object.keys(data.flaggedPackages).length}`.padStart(11),
			`net ${Object.entries(data.builtins).filter(([k]) => NETWORK_BUILTINS.has(k)).reduce((n, [, v]) => n + v.length, 0)}`.padStart(7),
			`proc ${Object.entries(data.builtins).filter(([k]) => PROCESS_BUILTINS.has(k)).reduce((n, [, v]) => n + v.length, 0)}`.padStart(8),
			`fetch ${count("fetch")}`.padStart(9),
			`dyn ${data.dynamicImports.length}+${count("import-computed") + count("require-computed")}`.padStart(10),
			`unresolved ${data.unresolved.length}`.padStart(14),
		].join(" "),
	);
}
