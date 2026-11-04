import { cleanup, render, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), convertFileSrc: (p: string) => p }));
vi.mock("../../invoke", () => ({ invoke: vi.fn() }));

import { IdeasPanel } from "../../components/IdeasPanel/IdeasPanel";
import { invoke } from "../../invoke";
import { ideasStore } from "../../stores/ideas";

afterEach(cleanup);

beforeEach(() => {
	for (const n of [...ideasStore.state.ideas]) ideasStore.removeIdea(n.id);
	vi.mocked(invoke).mockReset();
	vi.mocked(invoke)
		.mockResolvedValueOnce("/img/1.png" as never)
		.mockResolvedValueOnce("/img/2.png" as never);
});

function pasteImage(el: HTMLElement): Event {
	const e = new Event("paste", { bubbles: true, cancelable: true });
	Object.defineProperty(e, "clipboardData", {
		value: {
			items: [
				{
					kind: "file",
					type: "image/png",
					getAsFile: () => new File([new Uint8Array([1])], "x", { type: "image/png" }),
				},
			],
		},
	});
	el.dispatchEvent(e);
	return e;
}

describe("IdeasPanel paste after the shared-helper refactor (critic 1350)", () => {
	it("keeps one asset id across pastes and attaches both images — catches the id closure being re-minted per paste", async () => {
		const { container } = render(() => (
			<IdeasPanel visible={true} repoPath={null} onClose={() => {}} onSendToTerminal={() => {}} />
		));
		const ta = container.querySelector("textarea") as HTMLTextAreaElement;
		expect(pasteImage(ta).defaultPrevented).toBe(true);
		await waitFor(() => expect(container.querySelectorAll("img").length).toBe(1));
		pasteImage(ta);
		await waitFor(() => expect(container.querySelectorAll("img").length).toBe(2));
		const ids = vi.mocked(invoke).mock.calls.map((c) => (c[1] as { noteId: string }).noteId);
		expect(ids[0]).toBe(ids[1]);
	});

	it("does not mint a pending id or touch invoke on text paste — catches getNoteId being called before an image is found", () => {
		const { container } = render(() => (
			<IdeasPanel visible={true} repoPath={null} onClose={() => {}} onSendToTerminal={() => {}} />
		));
		const ta = container.querySelector("textarea") as HTMLTextAreaElement;
		const e = new Event("paste", { bubbles: true, cancelable: true });
		Object.defineProperty(e, "clipboardData", {
			value: { items: [{ kind: "string", type: "text/plain", getAsFile: () => null }] },
		});
		ta.dispatchEvent(e);
		expect(e.defaultPrevented).toBe(false);
		expect(invoke).not.toHaveBeenCalled();
	});

	it("saves no image when the clipboard carries text/plain with an image — catches a cell copy attaching a picture over its text", () => {
		const { container } = render(() => (
			<IdeasPanel visible={true} repoPath={null} onClose={() => {}} onSendToTerminal={() => {}} />
		));
		const ta = container.querySelector("textarea") as HTMLTextAreaElement;
		const e = new Event("paste", { bubbles: true, cancelable: true });
		Object.defineProperty(e, "clipboardData", {
			value: {
				items: [
					{
						kind: "file",
						type: "image/png",
						getAsFile: () => new File([new Uint8Array([1])], "x", { type: "image/png" }),
					},
					{ kind: "string", type: "text/plain", getAsFile: () => null },
				],
			},
		});
		ta.dispatchEvent(e);
		expect(e.defaultPrevented).toBe(false);
		expect(invoke).not.toHaveBeenCalled();
	});

	it("attaches the image when text/plain is only the image's file name — catches a Finder file copy pasting the name", async () => {
		const { container } = render(() => (
			<IdeasPanel visible={true} repoPath={null} onClose={() => {}} onSendToTerminal={() => {}} />
		));
		const ta = container.querySelector("textarea") as HTMLTextAreaElement;
		const e = new Event("paste", { bubbles: true, cancelable: true });
		Object.defineProperty(e, "clipboardData", {
			value: {
				items: [
					{ kind: "string", type: "text/plain", getAsFile: () => null },
					{
						kind: "file",
						type: "image/png",
						getAsFile: () => new File([new Uint8Array([1])], "x", { type: "image/png" }),
					},
				],
				getData: (t: string) => (t === "text/plain" ? "/Users/me/Desktop/shot.png" : ""),
			},
		});
		ta.dispatchEvent(e);
		expect(e.defaultPrevented).toBe(true);
		await waitFor(() => expect(container.querySelectorAll("img").length).toBe(1));
	});
});
