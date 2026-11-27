#!/usr/bin/env node
/**
 * Closure gate for the local build.
 *
 * Bundles `local/src/index.ts` and compares what the bundle contains with two
 * files:
 *
 *   - `local/closure.json`, generated: the files in the bundle, the Node
 *     built-ins they import, and their network, process and dynamic-loading
 *     call sites.
 *   - `local/closure-reasons.json`, written by hand: why each call site is
 *     there. A reason starts with `KEEP:` or with `PENDING <step>:` for a
 *     site a later step removes.
 *
 * Both are allowlists, so the gate fails on anything new until someone has
 * looked at it: a new file, a new built-in, a new call site, or a call site
 * without a reason.
 *
 * Some things fail whatever the manifest says: a package on the forbidden
 * list, a network built-in, an import left external, an unresolved import.
 *
 * Usage: node scripts/local/check-closure.mjs [--update]
 * `--update` rewrites `local/closure.json` to match the bundle. It never
 * writes reasons.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { inventory, NETWORK_BUILTINS, packageOf, ROOT } from "../../tests/no-egress/inventory.mjs";

const ENTRY = "local/src/index.ts";
const MANIFEST = resolve(ROOT, "local/closure.json");
const REASONS = resolve(ROOT, "local/closure-reasons.json");
const REASON_FORMAT = /^(KEEP|PENDING [a-z0-9-]+): \S/;

/** Never allowed in the bundle, reviewed or not. */
const FORBIDDEN_PACKAGES = [
	/^@anthropic-ai\//,
	/^@aws-sdk\//,
	/^@smithy\//,
	/^@google\//,
	/^@mistralai\//,
	/^undici$/,
	/^ws$/,
	/^node-fetch$/,
	/^https?-proxy-agent$/,
	/^jiti$/,
	/^@earendil-works\/pi-(mcp|codemode)$/,
];

const update = process.argv.includes("--update");
const data = await inventory(ENTRY);
const retained = new Set(data.retainedFiles);

// Call sites in files the bundle keeps, grouped so a line-number shift does not look like a change.
const siteCounts = new Map();
for (const site of data.sites) {
	if (!retained.has(site.file)) continue;
	const key = `${site.file} ${site.kind}`;
	siteCounts.set(key, (siteCounts.get(key) ?? 0) + 1);
}
for (const [builtin, files] of Object.entries(data.builtins)) {
	for (const file of files) {
		if (retained.has(file)) siteCounts.set(`${file} imports-${builtin}`, 1);
	}
}

let manifest = { files: [], builtins: [], sites: [] };
try {
	manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
} catch (error) {
	if (!update) throw new Error(`cannot read ${MANIFEST}: ${error.message}`);
}
const reasons = JSON.parse(readFileSync(REASONS, "utf8"));

if (update) {
	const sites = [...siteCounts.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([key, count]) => {
			const [file, kind] = key.split(" ");
			return { file, kind, count };
		});
	const next = { files: data.retainedFiles, builtins: data.retainedBuiltins, sites };
	writeFileSync(MANIFEST, `${JSON.stringify(next, null, "\t")}\n`);
	manifest = next;
	console.log(`wrote local/closure.json: ${next.files.length} files, ${next.builtins.length} built-ins, ${sites.length} call sites`);
}

const failures = [];
const fail = (message) => failures.push(message);

for (const [path, importers] of Object.entries(data.externals)) fail(`external import "${path}" from ${importers[0]}`);
for (const miss of data.unresolved) fail(`unresolved import "${miss.path}" from ${miss.from}`);
for (const file of data.retainedFiles) {
	const pkg = packageOf(file);
	if (FORBIDDEN_PACKAGES.some((rule) => rule.test(pkg))) fail(`forbidden package ${pkg}: ${file}`);
}
for (const builtin of data.retainedBuiltins) {
	if (NETWORK_BUILTINS.has(builtin)) fail(`network built-in node:${builtin} is imported`);
}

const approvedFiles = new Set(manifest.files);
for (const file of data.retainedFiles) if (!approvedFiles.has(file)) fail(`new file in the bundle: ${file}`);
for (const file of manifest.files) if (!retained.has(file)) fail(`stale manifest entry (no longer bundled): ${file}`);

const approvedBuiltins = new Set(manifest.builtins);
for (const builtin of data.retainedBuiltins) if (!approvedBuiltins.has(builtin)) fail(`new built-in: node:${builtin}`);

const approvedSites = new Map(manifest.sites.map((site) => [`${site.file} ${site.kind}`, site]));
for (const [key, count] of siteCounts) {
	const approved = approvedSites.get(key);
	if (!approved) fail(`new call site: ${key}`);
	else if (approved.count !== count) fail(`call site count changed (${approved.count} -> ${count}): ${key}`);
	if (!REASON_FORMAT.test(reasons[key] ?? "")) fail(`call site has no reason in closure-reasons.json: ${key}`);
}
for (const key of approvedSites.keys()) if (!siteCounts.has(key)) fail(`stale call site entry: ${key}`);
for (const key of Object.keys(reasons)) if (!siteCounts.has(key)) fail(`stale reason (no such call site): ${key}`);

const packages = new Set(data.retainedFiles.map(packageOf));
const pending = [...siteCounts.keys()].filter((key) => (reasons[key] ?? "").startsWith("PENDING"));
console.log(
	`local bundle: ${data.retainedFiles.length} files from ${packages.size} packages, ${(data.bytesRetained / 1024).toFixed(0)} KiB, ${siteCounts.size} call sites (${pending.length} pending removal)`,
);
for (const key of pending) console.log(`  pending  ${key}  ${reasons[key].slice(0, reasons[key].indexOf(":"))}`);
if (failures.length > 0) {
	for (const message of failures.slice(0, 60)) console.error(`  FAIL ${message}`);
	if (failures.length > 60) console.error(`  ... and ${failures.length - 60} more`);
	console.error(`closure gate failed: ${failures.length} problem(s)`);
	process.exit(1);
}
console.log("closure gate passed");
