import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { filePathRegex } from "../../components/Terminal/linkProvider";
import { editorTabsStore } from "../../stores/editorTabs";
import { mdTabsStore } from "../../stores/mdTabs";
import { repositoriesStore } from "../../stores/repositories";
import { openTerminalFilePath } from "../../utils/filePreview";
import { testInScope } from "../helpers/store";
import "../mocks/tauri";

describe("terminal file opening", () => {
	beforeEach(() => {
		mdTabsStore.clearAll();
		editorTabsStore.clearAll();
		for (const path of repositoriesStore.getPaths()) repositoriesStore.remove(path);
	});
	afterEach(() => repositoriesStore._testCancelPendingSave());

	it("opens a printed dot-directory Markdown path outside the active repository", () => {
		testInScope(() => {
			repositoriesStore.add({ path: "/repo", displayName: "repo" });
			repositoriesStore.setActive("/repo");
			const path = "/Users/stefano.straus/Gits/.tmp/results/ego-coordinator-proposal-1790494800.md";
			expect(filePathRegex().exec(`Open ${path}`)?.[1]).toBe(path);
			openTerminalFilePath(path);
			expect(mdTabsStore.getActive()).toMatchObject({ type: "file", filePath: path });
		});
	});

	it("opens an external source file in the editor and keeps registered files with their owner", () => {
		testInScope(() => {
			repositoriesStore.add({ path: "/repo", displayName: "repo" });
			repositoriesStore.setActive("/repo");
			openTerminalFilePath("/Users/boss/Gits/.tmp/results/build.log");
			expect(editorTabsStore.getActive()).toMatchObject({
				repoPath: "",
				filePath: "/Users/boss/Gits/.tmp/results/build.log",
			});
			openTerminalFilePath("/repo/docs/readme.md");
			expect(mdTabsStore.getActive()).toMatchObject({ repoPath: "/repo", filePath: "docs/readme.md" });
		});
	});

	it("opens a terminal file link at its printed line, including a numbered Markdown file", () => {
		testInScope(() => {
			repositoriesStore.add({ path: "/repo", displayName: "repo" });
			repositoriesStore.setActive("/repo");
			openTerminalFilePath("/repo/src/main.rs", undefined, 42);
			expect(editorTabsStore.getActive()).toMatchObject({ filePath: "src/main.rs", initialLine: 42 });
			openTerminalFilePath("/repo/docs/notes.md", undefined, 7);
			expect(editorTabsStore.getActive()).toMatchObject({ filePath: "docs/notes.md", initialLine: 7 });
		});
	});

	it("passes a terminal :line:col target to a new editor tab", () => {
		testInScope(() => {
			repositoriesStore.add({ path: "/repo", displayName: "repo" });
			openTerminalFilePath("/repo/src/main.rs", undefined, 12, 6);
			expect(editorTabsStore.getActive()).toMatchObject({
				filePath: "src/main.rs",
				initialLine: 12,
				initialCol: 6,
			});
		});
	});
});
