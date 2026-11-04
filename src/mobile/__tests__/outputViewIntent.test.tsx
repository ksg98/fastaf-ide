import { render } from "@solidjs/testing-library";
import { afterEach, expect, it, vi } from "vitest";
import { hiddenMarkerRows, planSuggestOverlay } from "../../components/Terminal/suggestOverlay";
import fixture from "../../dev/fixtures/claude-intent-2019.json";
import joinedFixture from "../../dev/fixtures/ego-intent-2060.json";
import { OutputView } from "../components/OutputView";

vi.mock("../../transport", () => ({ subscribePty: vi.fn(async () => () => {}) }));
vi.mock("../resumeTrail", () => ({ recordMobileSocketState: vi.fn() }));
afterEach(() => vi.unstubAllGlobals());

it("keeps the Claude intent head and soft-wrapped tail visible in one tinted block", async () => {
	// Catches: mobile loses the marker head or tints only one physical row.
	const chars = [...fixture.text];
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => ({
			ok: true,
			json: async () => ({
				lines: [],
				total_lines: 0,
				screen: [
					{ spans: [{ text: chars.slice(0, 40).join("") }], cols: 40, wrapped: true },
					{ spans: [{ text: chars.slice(40).join("") }], cols: 40, wrapped: false },
					{ spans: [{ text: "ordinary output" }], cols: 40, wrapped: false },
				],
			}),
		})),
	);
	vi.stubGlobal("requestAnimationFrame", () => 0);
	const { container } = render(() => <OutputView sessionId="recorded-claude-intent" />);
	await vi.waitFor(() => expect(container.textContent).toContain("ordinary output"));
	const tint = container.querySelector('[data-terminal-marker="intent"]');
	expect(tint?.textContent?.replaceAll("\uFE0E", "")).toBe(fixture.text);
	expect(tint?.textContent).not.toContain("ordinary output");
});

it("gives desktop the same visible two-row Claude intent without tinting subsequent output", () => {
	// Catches: one transport hides intent rows or assigns its tail to ordinary output.
	const chars = [...fixture.text];
	const rows = [
		{ text: chars.slice(0, 40).join(""), isWrapped: false },
		{ text: chars.slice(40).join(""), isWrapped: true },
		{ text: "ordinary output", isWrapped: false },
	];
	const plan = planSuggestOverlay(rows.length, (index) => rows[index] ?? null);
	expect(plan.blocks).toEqual([
		{ row: 0, kind: "intent" },
		{ row: 1, kind: "intent" },
	]);
	expect(hiddenMarkerRows(plan.blocks).size).toBe(0);
	expect(
		rows
			.slice(0, 2)
			.map((row) => row.text)
			.join(""),
	).toBe(fixture.text);
});

it("ends the mobile tint at the recorded title without dropping the joined sentence", async () => {
	// Catches: normal prose sharing the title row inheriting the intent tint or disappearing.
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => ({
			ok: true,
			json: async () => ({
				lines: [],
				total_lines: 0,
				screen: [{ spans: [{ text: joinedFixture.text }], cols: 500, wrapped: false }],
			}),
		})),
	);
	vi.stubGlobal("requestAnimationFrame", () => 0);
	const { container } = render(() => <OutputView sessionId="recorded-joined-ego-intent" />);
	await vi.waitFor(() => expect(container.textContent).toContain("Criteri di riuscita"));
	const tint = container.querySelector('[data-terminal-marker="intent"]');
	expect(tint?.textContent).toBe(
		"intent: Verificando l’ultima release e riconciliando main senza perdere il lavoro locale (Allineamento Agent2)",
	);
	expect(container.textContent).toBe(joinedFixture.text);
	expect(tint?.textContent).not.toContain("Criteri");
});

it("ends desktop wrapped tint at the same title and leaves subsequent soft wraps plain", () => {
	// Catches: the title closing on a continuation row tinting later soft-wrapped prose.
	const end = joinedFixture.text.indexOf("Criteri");
	const first = end - 7;
	const snapshots = [
		{ text: joinedFixture.text.slice(0, first), isWrapped: false },
		{ text: joinedFixture.text.slice(first, end + 12), isWrapped: true },
		{ text: joinedFixture.text.slice(end + 12), isWrapped: true },
	];
	const plan = planSuggestOverlay(snapshots.length, (index) => snapshots[index] ?? null);
	expect(plan.blocks).toEqual([
		{ row: 0, kind: "intent" },
		{ row: 1, kind: "intent", endColumn: 7 },
	]);
	expect(hiddenMarkerRows(plan.blocks).size).toBe(0);
	expect(snapshots.map((row) => row.text).join("")).toBe(joinedFixture.text);
});
