// Upstream tests build sessions without going through `sdk.ts`, which is what
// installs the optional features in the full SDK. Install them here so the
// suite exercises the same session it did before the features became optional.
import "../src/core/session-features-default.ts";
import { installSessionFeatures } from "../src/core/session-features.ts";

// A module imported by a setup file is cached before a test file's `vi.mock`
// runs, so the `completeSimple` installed above is always the real one and a
// test that mocks it would reach a live provider. Resolving it at call time
// goes through the mock.
installSessionFeatures({
	completeSimple: (async (...args: unknown[]) => {
		const compat = await import("@earendil-works/pi-ai/compat");
		return (compat.completeSimple as (...inner: unknown[]) => unknown)(...args);
	}) as typeof import("@earendil-works/pi-ai/compat").completeSimple,
});
