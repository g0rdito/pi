# pi-local fork

A local-only, SDK-only distribution of Pi. Design: `pi_zero_egress_fork_plan.md` in the harness repo.

## Pin

| | |
|---|---|
| Upstream | `earendil-works/pi@7d073328e44337d3292a7db9b0f0308f679c5e97` |
| Branch | `local-only`, stacked step branches on top |
| Remote | `upstream`, fetch-only (push URL disabled) |
| Lockfile | root `package-lock.json` (v3), unchanged |

## Toolchain

Everything runs in the container built from `scripts/local/Dockerfile`.

| | |
|---|---|
| Base image | `node@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee` (`node:22-bookworm-slim`, multi-arch index) |
| Platform | `linux/arm64`, set explicitly by `scripts/local/run.sh` |
| Node / npm | 22.23.5 / 10.9.9 |
| Volumes | `pi-local-node-modules` (dependencies), `pi-local-npm-cache` |

```bash
docker build --platform linux/arm64 -t pi-local/toolchain:1 -f scripts/local/Dockerfile scripts/local
scripts/local/run.sh npm ci --ignore-scripts --no-audit --no-fund
scripts/local/run.sh npm run hydrate:model-data     # baseline only, needs network
scripts/local/run.sh npm run build:offline
scripts/local/run.sh node tests/no-egress/inventory.mjs
```

The Debian `fd` in the image is 8.6, older than upstream's `find` tool expects (`--no-require-git`).
The sandbox step has to provision a pinned `fd` and `rg` instead.

## Baseline at the pin

- **Build:** `build:offline` passes once model data is present.
- **Model data:** `packages/ai/src/providers/data/` is git-ignored and absent from a clean checkout.
  It was generated on 2026-11-15 by `hydrate:model-data`, which reads the live remote catalog, so it
  is newer than the pin. Hashes: `tests/no-egress/baseline/model-data.sha256`. The fork's release
  build must not depend on this data.
- **Tests** (as root, in the toolchain image), failing files / total:

| Package | Result | Cause of failures |
|---|---|---|
| `agent` | all pass | |
| `ai` | 1 / 187 | `together-models`: hydrated catalog differs from the value the test pins |
| `coding-agent` | 7 / 353 | `fd` too old (find tool, 2 regression files); permission tests defeated by root (edit, session file, config); `clipboard-command` needs `ps`; one `auth-storage` reload race |
| `schema`, `telemetry` and the rest of retained code | pass | |
| `chord`, `durable`, `env` | failures | not retained; not investigated |

## Delta from upstream

### Added

| Path | Purpose |
|---|---|
| `FORK.md` | this file |
| `local/src/` | the local build: egress policy, model runtime, session factory |
| `local/closure.json`, `local/closure-reasons.json` | what the local bundle contains, and why each call site is there |
| `scripts/local/` | toolchain image, container wrapper, closure gate |
| `tests/contract/` | the session contract, run against both upstream and the local build |
| `tests/no-egress/` | egress inventory, and its output at the pin |

The local build lives in `local/`, not under `packages/`: a new workspace package
changes `package-lock.json`, and the lockfile is kept identical to upstream's.

### Changed in upstream files

Each change removes an import edge from `core/agent-session.ts` to code the local
build must not ship. Upstream behaviour is unchanged: `core/sdk.ts` imports
`core/session-features-default.ts`, which installs everything that became optional.

| Upstream file | Change |
|---|---|
| `core/agent-session.ts` | Generic over its model runtime (`SessionModelRuntime`, default `ModelRuntime`). Imports helpers from `pi-ai`, not `pi-ai/compat`; imports the extension runner, wrapper and types directly, not through the `extensions/index.ts` barrel. HTML export, bug-report summary, the legacy stream check and the provider-registry reset go through `core/session-features.ts`. |
| `core/compaction/compaction.ts` | The `completeSimple` fallback for a summary requested without a stream function goes through `session-features`. The local build installs none, so every summary uses the session's stream function. |
| `core/extensions/runner.ts` | The TUI theme handed to extensions goes through `session-features`. |
| `core/extensions/loader.ts` | `createExtensionRuntime` moved to `core/extensions/runtime.ts`; re-exported. |
| `core/mcp-servers.ts` | Tool-name matching moved to `core/tool-names.ts`, `McpServerRegistry` to `core/mcp-server-registry.ts`; both re-exported. |
| `core/model-registry.ts` | Takes a `SessionModelRuntime`. No longer re-exports `clearApiKeyCache` (import it from `provider-composer.ts`). |
| `core/http-dispatcher.ts`, `core/settings-manager.ts` | Idle-timeout parsing moved to `core/http-idle-timeout.ts`, so settings no longer import `undici`. |
| `core/sdk.ts` | Imports `session-features-default.ts`. |
| `vitest.config.ts`, `test/setup-session-features.ts` | Upstream tests build sessions without `sdk.ts`, so a setup file installs the features. |
| `test/model-registry.test.ts` | Follows the `clearApiKeyCache` move. |

### Gates

```bash
scripts/local/run.sh --net none node scripts/local/check-closure.mjs
scripts/local/run.sh --net none sh -c 'cd local && npx vitest run'
scripts/local/run.sh --net none sh -c 'cd tests/contract && PI_CONTRACT_HOST=local npx vitest run'
```

Run upstream's suites with `--net none` too. A test that mocks a provider and
misses will otherwise make a live request.

## Upstream intake

1. Fetch the new upstream SHA; rebase `local-only` onto it.
2. Rebuild the toolchain image if the Node requirement moved; `npm ci --ignore-scripts`.
3. Run `tests/no-egress/inventory.mjs` and diff against `tests/no-egress/baseline/`.
4. Run every gate. A new file in the closure, a new external or a new network call site fails until reviewed.
5. Update the pin and this manifest in the same commit.
