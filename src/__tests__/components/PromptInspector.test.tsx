import { fireEvent, render, waitFor } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PromptInspector, type PromptReceipt } from "../../components/PromptInspector/PromptInspector";
import { invoke } from "../../invoke";

vi.mock("../../invoke", () => ({ invoke: vi.fn() }));
const receipt: PromptReceipt = {
	sections: [
		{
			label: "Launch brief",
			source: "stored generator",
			bytes: 42,
			text: "é🦀",
			status: "sent",
			truncated: false,
			count: 1,
			firstSeenMs: 1,
			lastSeenMs: 1,
		},
		{
			label: "Agent-loaded instructions",
			source: "not observable by TUIC",
			bytes: null,
			text: "Not observable by TUIC",
			status: "not_observable",
			truncated: false,
			count: 1,
			firstSeenMs: 1,
			lastSeenMs: 1,
		},
	],
	captureLimited: false,
};

describe("PromptInspector", () => {
	// Catches: removing narration also removes real observation values or contextual warnings.
	it("rejects permanent explanation while retaining receipt values and warnings", async () => {
		vi.mocked(invoke).mockResolvedValue({
			...receipt,
			sections: [{ ...receipt.sections[0], truncated: true }],
			captureLimited: true,
		});
		const view = render(() => <PromptInspector sessionId="concise" onClose={() => {}} />);
		await waitFor(() => expect(view.getByText("42 bytes")).toBeTruthy());
		expect(view.getByText("stored generator")).toBeTruthy();
		expect(view.getByText("é🦀")).toBeTruthy();
		expect(view.getByText(/Truncated redacted preview/)).toBeTruthy();
		expect(view.getByText(/Additional sections omitted/)).toBeTruthy();
		expect(view.queryByText(/Launch-time observations from this session/)).toBeNull();
	});

	beforeEach(() => vi.clearAllMocks());
	// Catches: computing counts from rendered/redacted text or hiding stored provenance.
	it("renders stored source and original byte count in collapsible sections", async () => {
		vi.mocked(invoke).mockResolvedValue(receipt);
		const close = vi.fn();
		const view = render(() => <PromptInspector sessionId="launch-1" onClose={close} />);
		await waitFor(() => expect(view.getByText("42 bytes")).toBeTruthy());
		expect(invoke).toHaveBeenCalledWith("get_prompt_receipt", { sessionId: "launch-1" });
		expect(view.container.querySelectorAll("details")).toHaveLength(2);
		expect(view.getByText("stored generator")).toBeTruthy();
		expect(view.getByText("Size unknown")).toBeTruthy();
		expect(view.getByText("é🦀")).toBeTruthy();
		fireEvent.click(view.getByText("Close"));
		expect(close).toHaveBeenCalledOnce();
	});
	// Catches: a previous session's launch text shown while the new request is pending/failed.
	it("hides the previous session receipt on switch and shows a failed read", async () => {
		vi.mocked(invoke).mockResolvedValueOnce(receipt).mockRejectedValueOnce(new Error("Session not found"));
		const [id, setId] = createSignal<string | null>("launch-1");
		const view = render(() => <PromptInspector sessionId={id()} onClose={() => setId(null)} />);
		await waitFor(() => expect(view.getByText("42 bytes")).toBeTruthy());
		setId("launch-2");
		await waitFor(() => expect(view.getByRole("alert")).toBeTruthy());
		expect(view.queryByText("é🦀")).toBeNull();
		setId(null);
		expect(view.queryByRole("dialog")).toBeNull();
	});
	// Catches: presenting queued/capped content as the complete delivered prompt.
	it("labels queued and truncated previews and the capture limit", async () => {
		vi.mocked(invoke).mockResolvedValue({
			sections: [{ ...receipt.sections[0], status: "queued", truncated: true }],
			captureLimited: true,
		});
		const view = render(() => <PromptInspector sessionId="queued" onClose={() => {}} />);
		await waitFor(() => expect(view.getByText("Queued — not yet sent")).toBeTruthy());
		expect(view.getByText(/Truncated redacted preview/)).toBeTruthy();
		expect(view.getByText(/Additional sections omitted/)).toBeTruthy();
	});
	// Catches: a generic sentence hiding why the receipt failed.
	it("inspector_shows_backend_error_text_for_session_not_found", async () => {
		vi.mocked(invoke).mockRejectedValue("Session not found");
		const view = render(() => <PromptInspector sessionId="gone" onClose={() => {}} />);
		await waitFor(() => expect(view.getByRole("alert").textContent).toContain("Session not found"));
		vi.mocked(invoke).mockRejectedValue(new Error("HTTP 404"));
		const http = render(() => <PromptInspector sessionId="gone-2" onClose={() => {}} />);
		await waitFor(() => expect(http.getAllByRole("alert").some((a) => a.textContent?.includes("HTTP 404"))).toBe(true));
	});
	// Catches: a deduplicated served row hiding how often and when it was served.
	it("shows the count and last-seen time of a deduplicated served row", async () => {
		const seen = new Date(2026, 9, 12, 8, 30).getTime();
		vi.mocked(invoke).mockResolvedValue({
			sections: [{ ...receipt.sections[0], status: "served", count: 7, lastSeenMs: seen }],
			captureLimited: false,
		});
		const view = render(() => <PromptInspector sessionId="dedup" onClose={() => {}} />);
		await waitFor(() => expect(view.getByText(/Served 7 times/)).toBeTruthy());
		expect(view.getByText(/Served 7 times/).textContent).toContain(new Date(seen).toLocaleString());
	});
	// Catches: a single observation claiming a repeat count.
	it("omits the count note for a row seen once", async () => {
		vi.mocked(invoke).mockResolvedValue(receipt);
		const view = render(() => <PromptInspector sessionId="once" onClose={() => {}} />);
		await waitFor(() => expect(view.getByText("42 bytes")).toBeTruthy());
		expect(view.queryByText(/Served \d+ times/)).toBeNull();
	});
});
