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

| Path | Purpose |
|---|---|
| `FORK.md` | this file |
| `scripts/local/` | toolchain image and container wrapper |
| `tests/no-egress/inventory.mjs` | egress inventory over entry points |
| `tests/no-egress/baseline/` | inventory and model-data hashes at the pin |

## Upstream intake

1. Fetch the new upstream SHA; rebase `local-only` onto it.
2. Rebuild the toolchain image if the Node requirement moved; `npm ci --ignore-scripts`.
3. Run `tests/no-egress/inventory.mjs` and diff against `tests/no-egress/baseline/`.
4. Run every gate. A new file in the closure, a new external or a new network call site fails until reviewed.
5. Update the pin and this manifest in the same commit.
