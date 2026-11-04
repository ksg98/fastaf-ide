import { markdownProviderRegistry } from "../../plugins/markdownProviderRegistry";
import { mdTabsStore } from "../../stores/mdTabs";

markdownProviderRegistry.register("aichat-table", {
	provideContent: (uri) => uri.searchParams.get("source"),
});

/** A self-contained URI keeps the read-only document available after tab restoration. */
export function openChatTableDocument(source: string): void {
	const uri = new URL("aichat-table:table");
	uri.searchParams.set("source", source);
	mdTabsStore.addVirtual("AI Chat table", uri.toString());
}
