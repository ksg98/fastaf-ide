// @vitest-environment jsdom

import { fireEvent, render } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import { ContentRenderer } from "../../components/ui/ContentRenderer";

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function renderLinked(content: string, onLinkClick = vi.fn()) {
	const view = render(() => <ContentRenderer content={content} autoLinkFiles onLinkClick={onLinkClick} />);
	await settle();
	return { ...view, onLinkClick };
}

describe("ContentRenderer file auto-link", () => {
	// Catches: the walker skipping every <code>, so a backticked path is never clickable.
	it("links inline code that holds only a file path, with and without a line", async () => {
		const { container, onLinkClick } = await renderLinked("See `src/a.ts` and `src/b.ts:12` now.");
		const anchors = [...container.querySelectorAll<HTMLAnchorElement>("a[data-tuic-href]")];
		expect(anchors.map((a) => a.dataset.tuicHref)).toEqual(["src/a.ts", "src/b.ts:12"]);
		expect(anchors.every((a) => a.closest("code"))).toBe(true);
		fireEvent.click(anchors[1]);
		expect(onLinkClick).toHaveBeenCalledWith("src/b.ts:12");
	});

	// Catches: linking every inline code that merely contains a path-like token.
	it("leaves inline code alone when the path is only part of the text", async () => {
		const { container } = await renderLinked("Run `cat src/a.ts` or `npm run build` or `foo`.");
		expect(container.querySelector("a")).toBeNull();
	});

	// Catches: the fix leaking into fenced blocks.
	it("keeps fenced code blocks unlinked", async () => {
		const { container } = await renderLinked("```\nsrc/a.ts\n```\n");
		expect(container.querySelector("pre")?.textContent).toContain("src/a.ts");
		expect(container.querySelector("a")).toBeNull();
	});

	// Catches: inline code already inside a markdown link getting a nested anchor.
	it("does not nest an anchor inside an existing link", async () => {
		const { container } = await renderLinked("[`src/a.ts`](src/a.ts)");
		expect(container.querySelectorAll("a").length).toBe(1);
	});

	// Catches: the auto-link pass relinking a href that already failed to resolve.
	it("keeps a dead link as text after the content grows", async () => {
		const onLinkClick = vi.fn().mockResolvedValue(false);
		const [content, setContent] = createSignal("Open src/gone.ts now.");
		const { container } = render(() => <ContentRenderer content={content()} autoLinkFiles onLinkClick={onLinkClick} />);
		await settle();
		fireEvent.click(container.querySelector("a[data-tuic-href]") as HTMLAnchorElement);
		await settle();
		expect(container.querySelector("a")).toBeNull();
		setContent("Open src/gone.ts now.\n\nAlso src/live.ts and src/gone.ts again.");
		await settle();
		expect([...container.querySelectorAll("a")].map((a) => a.dataset.tuicHref)).toEqual(["src/live.ts"]);
	});

	// Catches: the failed-href memory being module-global, so one renderer's dead link hides another's.
	it("remembers a failed href per renderer only", async () => {
		const dead = vi.fn().mockResolvedValue(false);
		const first = render(() => <ContentRenderer content="Open src/gone.ts" autoLinkFiles onLinkClick={dead} />);
		await settle();
		fireEvent.click(first.container.querySelector("a[data-tuic-href]") as HTMLAnchorElement);
		await settle();
		const second = await renderLinked("Open src/gone.ts");
		expect(second.container.querySelectorAll("a[data-tuic-href]").length).toBe(1);
	});
});
