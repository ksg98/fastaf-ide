import { render, waitFor } from "@solidjs/testing-library";
import { afterEach, expect, it, vi } from "vitest";
import { CodeEditorTab } from "../../components/CodeEditorPanel/CodeEditorTab";
import { editorTabsStore } from "../../stores/editorTabs";
import { nextAnimationFrame } from "../helpers/animationFrame";

vi.mock("../../invoke", () => ({
	invoke: vi.fn(async (command: string) => {
		if (command === "read_editor_file") return "const value = 1;";
		if (command === "stat_path") return { exists: true, modified_at: 1, size: 16 };
		if (command === "mdkb_outline" || command === "get_gutter_changes" || command === "get_file_blame") return [];
		return undefined;
	}),
}));
vi.mock("../../hooks/useFileBrowser", () => ({ useFileBrowser: () => ({ writeFile: vi.fn() }) }));

afterEach(async () => {
	// Let real editor measurement/focus frames settle after the test unmounts.
	await nextAnimationFrame();
	editorTabsStore.clearAll();
	document.body.innerHTML = "";
});

it("changes the mounted editor font when its tab is zoomed", async () => {
	const id = editorTabsStore.add("/repo", "main.rs");
	const { container, unmount } = render(() => <CodeEditorTab id={id} repoPath="/repo" filePath="main.rs" />);
	await waitFor(() => expect(container.querySelector(".cm-editor")).not.toBeNull());
	const editorHost = container.querySelector<HTMLElement>(".cm-editor")!.parentElement!;
	expect(editorHost.style.fontSize).toBe("13px");
	editorTabsStore.zoomIn(13);
	await waitFor(() => expect(editorHost.style.fontSize).toBe("15px"));
	unmount();
});
