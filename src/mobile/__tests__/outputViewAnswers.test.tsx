import { readFileSync } from "node:fs";
import { cleanup, render } from "@solidjs/testing-library";
import { afterEach, expect, it, vi } from "vitest";
import recorded from "../../components/Terminal/__tests__/fixtures/codex-answer-paragraphs-1872.json";
import { OutputView } from "../components/OutputView";

vi.mock("../../transport", () => ({ subscribePty: vi.fn(async () => () => {}) }));
vi.mock("../resumeTrail", () => ({ recordMobileSocketState: vi.fn() }));
afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

it("condenses recorded mobile answer bubbles into a continuous desktop gutter", async () => {
	// Catches: mobile shows protocol bubbles and drops the gutter between answer paragraphs.
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => ({
			ok: true,
			json: async () => ({
				lines: recorded.rows.map((text) => ({ spans: [{ text }], wrapped: false })),
				total_lines: recorded.rows.length,
			}),
		})),
	);
	vi.stubGlobal("requestAnimationFrame", () => 0);
	const { container } = render(() => <OutputView sessionId="recorded-codex-1872" />);
	await vi.waitFor(() => expect(container.textContent).toContain("Raw copy text remains untouched."));
	const answers = [...container.querySelectorAll('[data-terminal-marker="answer"]')];
	expect(answers).toHaveLength(5);
	for (const line of answers) {
		const rule = line.querySelector<HTMLElement>('[aria-hidden="true"]');
		expect(rule?.style.boxShadow).toBe("inset 3px 0 0 var(--answer-rule)");
	}
	expect(answers.map((line) => line.textContent)).toEqual([
		"•\uFE0E The answer highlight runs continuously across the full response.",
		"",
		"  Blank paragraph spacing stays preserved.",
		"",
		"  Raw copy text remains untouched.",
	]);
	// A quoted marker in the submitted prompt is not protocol output.
	expect(container.textContent).toContain("each starting with 💬");
});

it("preserves literal answer prefixes in standalone fenced examples", async () => {
	// Catches: a copied protocol example loses its literal prefix without an answer before the fence.
	const lines = ["⏺ Example protocol output:", "  ```text", "  💬 Keep this literal prefix", "  ```"];
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => ({ ok: true, json: async () => ({ lines, total_lines: lines.length }) })),
	);
	vi.stubGlobal("requestAnimationFrame", () => 0);
	const { container } = render(() => <OutputView sessionId="standalone-code-example" />);
	await vi.waitFor(() => expect(container.textContent).toContain("Keep this literal prefix"));
	expect(container.textContent).toContain("💬 Keep this literal prefix");
});

it("keeps answer links and span styles without marking prompts, tools or literal code bubbles", async () => {
	// Catches: global emoji stripping corrupts literal code and link offsets after the marker.
	const lines = [
		{ spans: [{ text: "❯ Show 💬 literally" }] },
		{ spans: [{ text: "⏺ 💬 " }, { text: "Read https://example.com", bold: true }] },
		{ spans: [{ text: "  ```text" }] },
		{ spans: [{ text: "  💬 literal" }] },
		{ spans: [{ text: "  ```" }] },
		{ spans: [{ text: "⏺ Tool output" }] },
	];
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => ({ ok: true, json: async () => ({ lines, total_lines: lines.length }) })),
	);
	vi.stubGlobal("requestAnimationFrame", () => 0);
	const { container } = render(() => <OutputView sessionId="answer-boundaries" />);
	await vi.waitFor(() => expect(container.textContent).toContain("Tool output"));
	const answer = container.querySelector('[data-terminal-marker="answer"]');
	expect(answer?.textContent).toBe("⏺\uFE0E Read https://example.com");
	expect(answer?.querySelector("a")?.href).toBe("https://example.com/");
	expect(answer?.querySelector("a span")?.getAttribute("style")).toContain("font-weight: 600");
	expect(container.textContent).toContain("❯ Show 💬 literally");
	expect(container.textContent).toContain("💬 literal");
	expect(container.querySelectorAll('[data-terminal-marker="answer"]')).toHaveLength(4);
});

it("a mobile CLI render test with an ego-style tinted message row that starts at column 0", async () => {
	// Catches: the answer bar paints over a column-zero glyph or adds a second Claude text margin.
	const lines = [
		"💬Ego starts at column zero",
		"",
		"⏺ 💬 Claude keeps its dot margin",
		"  Continued answer",
		"⏺ Tool output",
	];
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => ({ ok: true, json: async () => ({ lines, total_lines: lines.length }) })),
	);
	vi.stubGlobal("requestAnimationFrame", () => 0);
	const sheet = document.createElement("style");
	sheet.textContent = readFileSync("src/mobile/components/OutputView.module.css", "utf8");
	document.head.append(sheet);
	try {
		const { container } = render(() => <OutputView sessionId="column-zero-gutter" />);
		await vi.waitFor(() => expect(container.textContent).toContain("Ego starts at column zero"));
		const answers = [...container.querySelectorAll<HTMLElement>('[data-terminal-marker="answer"]')];
		expect(answers[0].textContent).toBe("Ego starts at column zero");
		expect(answers[2].textContent).toBe("⏺\uFE0E Claude keeps its dot margin");
		for (const row of answers) {
			expect(row.style.boxShadow).toBe("");
			const rule = row.querySelector<HTMLElement>('[aria-hidden="true"]');
			expect(rule, "answer needs its own non-text gutter").not.toBeNull();
			const style = getComputedStyle(rule!);
			expect(style.position).toBe("absolute");
			expect(Number.parseFloat(style.left) + Number.parseFloat(style.width)).toBeLessThan(0);
			// Happy-dom leaves the initial zero padding unresolved as an empty string.
			expect(getComputedStyle(row).paddingLeft || "0px").toBe("0px");
		}
		expect(container.textContent).toContain("⏺\uFE0E Tool output");
	} finally {
		sheet.remove();
	}
});
