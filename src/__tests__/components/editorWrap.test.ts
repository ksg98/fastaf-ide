import { describe, expect, it } from "vitest";
import { editorWrapKind } from "../../components/CodeEditorPanel/languageDetection";

describe("editor wrap kind", () => {
	it.each(["notes.txt", "service.log", "README.md", "README.mdx", "unknown.extension", "untitled"])(
		"treats %s as text",
		(file) => expect(editorWrapKind(file)).toBe("text"),
	);
	it.each(["main.rs", "app.tsx", "Makefile"])("treats %s as code", (file) => expect(editorWrapKind(file)).toBe("code"));
});
