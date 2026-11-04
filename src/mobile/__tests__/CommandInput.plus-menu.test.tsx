import { cleanup, fireEvent, render, waitFor } from "@solidjs/testing-library";
import { afterEach, expect, it, vi } from "vitest";
import { CommandInput } from "../components/CommandInput";

vi.mock("../../transport", () => ({
	rpc: vi.fn(async () => ({ accepted: true, typed: false })),
	HttpRpcError: class extends Error {},
}));
vi.mock("../../services/uploadAttachment", () => ({ uploadAttachment: vi.fn() }));
vi.mock("../../stores/toasts", () => ({ toastsStore: { add: vi.fn() } }));

import { uploadAttachment } from "../../services/uploadAttachment";
import { rpc } from "../../transport";

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
	vi.unstubAllGlobals();
});

// Catches: terminal layout keeps the old paperclip or places mic outside the textarea box.
it("mobile plus terminal keeps +, textarea with mic, Send in order", () => {
	vi.stubGlobal("SpeechRecognition", class {});
	const view = render(() => <CommandInput sessionId="menu" />);
	const plus = view.getByRole("button", { name: "More composer actions" });
	const input = view.container.querySelector("textarea")!;
	const mic = view.getByRole("button", { name: "Dictate into draft" });
	const send = view.getByRole("button", { name: "Send" });
	expect(plus.compareDocumentPosition(input) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
	expect(input.parentElement?.contains(mic)).toBe(true);
	expect(input.compareDocumentPosition(send) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
	expect(view.queryByRole("button", { name: "Attach file" })).toBeNull();
	expect(view.queryByRole("button", { name: "Park draft" })).toBeNull();
});

// Catches: the + menu disconnects the upload picker, camera or enqueue action.
it("mobile plus terminal uploads a file then queues the accepted draft", async () => {
	vi.mocked(uploadAttachment).mockResolvedValue({ path: "/repo/notes.txt", size: 4 });
	const view = render(() => <CommandInput sessionId="menu" />);
	fireEvent.click(view.getByRole("button", { name: "More composer actions" }));
	expect(view.queryByRole("menuitem", { name: /Park|Commands/ })).toBeNull();
	const picker = view.getByLabelText("Choose attachment") as HTMLInputElement;
	const openPicker = vi.spyOn(picker, "click");
	fireEvent.click(view.getByRole("menuitem", { name: "Attach file" }));
	expect(openPicker).toHaveBeenCalledOnce();
	expect(view.queryByRole("menu")).toBeNull();
	fireEvent.change(picker, { target: { files: [new File(["note"], "notes.txt")] } });
	const input = view.container.querySelector("textarea")!;
	await waitFor(() => expect(input.value).toBe("@/repo/notes.txt"));
	fireEvent.click(view.getByRole("button", { name: "More composer actions" }));
	const camera = view.getByLabelText("Take photo") as HTMLInputElement;
	expect(camera.accept).toBe("image/*");
	expect(camera.getAttribute("capture")).toBe("environment");
	fireEvent.click(view.getByRole("menuitem", { name: "Queue" }));
	await waitFor(() => expect(input.value).toBe(""));
	expect(rpc).toHaveBeenCalledWith("enqueue_agent_command", {
		sessionId: "menu",
		text: "@/repo/notes.txt",
		expectedDraft: "@/repo/notes.txt",
	});
});

// Catches: Commands is a dead action, or dismissing the menu sends Escape into the terminal.
it.each([false, true])(
	"mobile plus terminal inserts slash before/after menu discovery (%s) and dismisses safely",
	(discovered) => {
		const view = render(() => (
			<CommandInput
				sessionId="menu"
				agentType="claude"
				slashItems={discovered ? [{ command: "/help", description: "Help", highlighted: false }] : []}
			/>
		));
		const plus = view.getByRole("button", { name: "More composer actions" });
		fireEvent.click(plus);
		fireEvent.keyDown(document, { key: "Escape" });
		expect(view.queryByRole("menu")).toBeNull();
		expect(rpc).not.toHaveBeenCalled();
		fireEvent.click(plus);
		fireEvent.pointerDown(document.body);
		expect(view.queryByRole("menu")).toBeNull();
		fireEvent.click(plus);
		fireEvent.click(view.getByRole("menuitem", { name: "Commands (/)" }));
		expect(view.container.querySelector("textarea")!.value).toBe("/");
		if (discovered) expect(view.getByText("/help")).toBeTruthy();
		expect(rpc).toHaveBeenCalledWith("write_pty", { sessionId: "menu", data: "/" });
	},
);
