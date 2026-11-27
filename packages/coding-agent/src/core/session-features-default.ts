/**
 * Installs every optional session feature. Imported for its side effect by the
 * full SDK entry; the local-only entry does not import it.
 */
import { completeSimple, resetApiProviders, streamSimple } from "@earendil-works/pi-ai/compat";
import { getThemeByName, theme } from "../modes/interactive/theme/theme.ts";
import { generateBugReportSummary } from "./bug-report.ts";
import { exportSessionToHtml } from "./export-html/index.ts";
import { createToolHtmlRenderer } from "./export-html/tool-renderer.ts";
import { installSessionFeatures } from "./session-features.ts";

installSessionFeatures({
	legacyStreamSimple: streamSimple,
	resetApiProviders,
	completeSimple,
	theme,
	generateBugReportSummary,
	exportToHtml: async (context) => {
		const themeName = context.themeCandidates.find(
			(candidate) => candidate !== undefined && getThemeByName(candidate) !== undefined,
		);
		// Create tool renderer if we have an extension runner (for custom tool HTML rendering)
		const toolRenderer = createToolHtmlRenderer({
			getToolRenderers: (name) =>
				context.extensionRunner.resolveToolRenderers(name, () => context.getToolDefinition(name)),
			theme,
			cwd: context.sessionManager.getCwd(),
		});
		return await exportSessionToHtml(context.sessionManager, context.state, {
			outputPath: context.outputPath,
			themeName,
			toolRenderer,
		});
	},
});
