import { defineConfig, mergeConfig } from "vitest/config";
import baseConfig from "../vitest.base.ts";

export default mergeConfig(
	baseConfig,
	defineConfig({
		test: {
			environment: "node",
			include: ["src/**/*.test.ts"],
			testTimeout: 30000,
			unstubEnvs: true,
		},
	}),
);
