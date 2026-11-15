#!/bin/sh
# Runs a command in the toolchain container (scripts/local/Dockerfile).
# Usage: [PI_LOCAL_DOCKER_ARGS="..."] scripts/local/run.sh [--net none] <cmd...>
# The platform is explicit because the sandbox and syscall-trace gates need a native container,
# and a host-wide DOCKER_DEFAULT_PLATFORM would otherwise pick an emulated one.
set -eu
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
IMAGE=${PI_LOCAL_IMAGE:-pi-local/toolchain:1}
PLATFORM=${PI_LOCAL_PLATFORM:-linux/arm64}
NET=bridge
if [ "${1:-}" = "--net" ]; then NET=$2; shift 2; fi
# shellcheck disable=SC2086
exec docker run --rm --platform "$PLATFORM" --network "$NET" ${PI_LOCAL_DOCKER_ARGS:-} \
	-v "$ROOT:/src" \
	-v pi-local-node-modules:/src/node_modules \
	-v pi-local-npm-cache:/root/.npm \
	-e npm_config_update_notifier=false \
	-w /src "$IMAGE" "$@"
