import { type Component, lazy, Suspense } from "solid-js";
import type { GithubOpsTab as GithubOpsTabData, MdTabData, PrDiffTab as PrDiffTabData } from "../../stores/mdTabs";

const ClaudeUsageDashboard = lazy(() =>
	import("../ClaudeUsageDashboard").then((module) => ({ default: module.ClaudeUsageDashboard })),
);
const CommandOverview = lazy(() =>
	import("../CommandOverview").then((module) => ({ default: module.CommandOverview })),
);
const GithubOpsDashboard = lazy(() =>
	import("../GithubOpsDashboard").then((module) => ({ default: module.GithubOpsDashboard })),
);
const HtmlPreviewTab = lazy(() => import("../HtmlPreviewTab").then((module) => ({ default: module.HtmlPreviewTab })));
const MarkdownTab = lazy(() => import("../MarkdownTab").then((module) => ({ default: module.MarkdownTab })));
const PluginPanel = lazy(() => import("../PluginPanel").then((module) => ({ default: module.PluginPanel })));
const PrDiffTab = lazy(() => import("../PrDiffTab").then((module) => ({ default: module.PrDiffTab })));

/** Renders the correct component for a given MdTab type. Shared between TerminalArea and PaneTree. */
export const MdTabContent: Component<{ tab: MdTabData; onClose: () => void; visible?: () => boolean }> = (props) => {
	const tab = props.tab;
	return (
		<Suspense>
			{(() => {
				if (tab.type === "claude-usage") return <ClaudeUsageDashboard />;
				if (tab.type === "github-ops") return <GithubOpsDashboard repoPath={(tab as GithubOpsTabData).repoPath} />;
				if (tab.type === "command-overview") return <CommandOverview />;
				if (tab.type === "plugin-panel")
					return <PluginPanel tab={tab} onClose={props.onClose} visible={props.visible} />;
				if (tab.type === "pr-diff") {
					const pr = tab as PrDiffTabData;
					return <PrDiffTab prNumber={pr.prNumber} prTitle={pr.prTitle} diff={pr.diff} />;
				}
				if (tab.type === "html-preview") return <HtmlPreviewTab tab={tab} onClose={props.onClose} />;
				return <MarkdownTab tab={tab} onClose={props.onClose} />;
			})()}
		</Suspense>
	);
};
