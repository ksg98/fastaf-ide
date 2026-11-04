const PREFIX = "markdown-tab-";

export const markdownDocumentPanelId = (tabId: string) => `${PREFIX}${tabId}`;

export const markdownDocumentTabId = (panelId: string): string | null =>
	panelId.startsWith(`${PREFIX}md-`) ? panelId.slice(PREFIX.length) : null;
