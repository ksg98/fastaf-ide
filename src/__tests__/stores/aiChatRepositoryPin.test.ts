import { beforeEach, expect, it } from "vitest";
import { aiChatTabs } from "../../stores/aiChatTabs";

beforeEach(() => {
	localStorage.clear();
	aiChatTabs.resetMemory();
});

it("persists repository pins per conversation — catches a pin following the selected tab", () => {
	aiChatTabs.add("global", "first");
	aiChatTabs.pinRepo("global", "first", "/repo/first");
	aiChatTabs.add("global", "second");
	expect(aiChatTabs.pinnedRepo("global", "second")).toBeNull();
	aiChatTabs.resetMemory();
	aiChatTabs.refresh();
	expect(aiChatTabs.pinnedRepo("global", "first")).toBe("/repo/first");
	aiChatTabs.pinRepo("global", "first", null);
	aiChatTabs.resetMemory();
	aiChatTabs.refresh();
	expect(aiChatTabs.pinnedRepo("global", "first")).toBeNull();
});
