import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, fireEvent, render, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The "?" badge on the Providers page's Headless slot, rendered through the real
// ProvidersTab: the assertions read the DOM a user hovers, not the InfoBadge
// module. (Upstream checked the General tab's ego heading, which FastAF does
// not render: its AI Chat runs on the built-in engine, not on ego.)

const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn() }));

vi.mock("../../../invoke", () => ({
	invoke: mockInvoke,
	listen: vi.fn().mockResolvedValue(vi.fn()),
}));

vi.mock("../../../stores/appLogger", () => ({
	appLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const registry = vi.hoisted(() => ({
	state: {
		registry: { schema_version: 1, providers: [], models: [], slots: {}, features: {} },
		keyStatus: {},
		loaded: true,
	},
	resolveSlot: () => null,
	setSlot: () => {},
	clearSlot: () => {},
}));

vi.mock("../../../stores/providerRegistry", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../stores/providerRegistry")>()),
	providerRegistryStore: registry,
}));

import { ProvidersTab } from "../tabs/ProvidersTab";

// vitest returns no CSS for modules, so read the stylesheet the app ships.
const settingsCss = readFileSync(join(__dirname, "../Settings.module.css"), "utf8");

const VIEWPORT_WIDTH = 1024;
const TIP_WIDTH = 320;

const rect = (left: number, width: number, top = 100, height = 16) =>
	({ left, right: left + width, top, bottom: top + height, width, height, x: left, y: top }) as DOMRect;

/** Render Providers and return the Headless slot's badge and tip. */
async function renderSlotBadge() {
	const { container } = render(() => <ProvidersTab />);
	const selector = '[data-testid="slot-row-headless"] [role="button"][aria-describedby]';
	await waitFor(() => expect(container.querySelector(selector)).not.toBeNull());
	const badge = container.querySelector(selector) as HTMLElement;
	return { badge, tip: badge.lastElementChild as HTMLElement };
}

describe("Providers page slot info badge", () => {
	let originalWidth: number;
	beforeEach(() => {
		mockInvoke.mockResolvedValue(undefined);
		originalWidth = window.innerWidth;
		Object.defineProperty(window, "innerWidth", { value: VIEWPORT_WIDTH, configurable: true });
	});
	afterEach(() => {
		cleanup();
		for (const el of document.head.querySelectorAll("style[data-test-css]")) el.remove();
		Object.defineProperty(window, "innerWidth", { value: originalWidth, configurable: true });
	});

	/** Hover a badge whose layout box is faked: happy-dom has no layout engine. */
	async function hoverBadgeAt(left: number) {
		const { badge, tip } = await renderSlotBadge();
		badge.getBoundingClientRect = () => rect(left, 16);
		tip.getBoundingClientRect = () => rect(0, TIP_WIDTH, 0, 60);
		fireEvent.mouseEnter(badge);
		const tipLeft = Number.parseFloat(tip.style.left);
		return { tipLeft, tipRight: tipLeft + TIP_WIDTH };
	}

	it("keeps the tip inside the viewport for a badge near the right edge", async () => {
		// catches: tip anchored at the badge's left edge, overflowing right and clipped by the scroller
		const { tipRight } = await hoverBadgeAt(VIEWPORT_WIDTH - 40);
		expect(tipRight).toBeLessThanOrEqual(VIEWPORT_WIDTH);
	});

	it("keeps the tip inside the viewport for a badge near the left edge", async () => {
		// catches: a right-anchored fix that brings back the left-edge clipping of 341414d4f
		const { tipLeft } = await hoverBadgeAt(4);
		expect(tipLeft).toBeGreaterThanOrEqual(0);
	});

	it("anchors the tip at the badge when there is room", async () => {
		// catches: an over-eager clamp that moves every tip to the viewport edge
		const { tipLeft } = await hoverBadgeAt(300);
		expect(tipLeft).toBe(300);
	});

	it("shows the tip while the badge is hovered and hides it otherwise", async () => {
		// Catches: measured hover placement never exposes the tip or leaves it visible after exit.
		const style = document.createElement("style");
		style.setAttribute("data-test-css", "");
		style.textContent = settingsCss;
		document.head.appendChild(style);
		const { badge, tip } = await renderSlotBadge();
		const shown = () => {
			const css = getComputedStyle(tip);
			return css.visibility !== "hidden" && css.display !== "none";
		};
		expect(shown()).toBe(false);
		fireEvent.mouseEnter(badge);
		expect(shown()).toBe(true);
		fireEvent.mouseLeave(badge);
		expect(shown()).toBe(false);
	});
});
