import { fireEvent, render } from "@solidjs/testing-library";
import { describe, expect, it, vi } from "vitest";
import type { ContextMenuItem } from "../../components/ContextMenu/ContextMenu";
import { ContextMenu, createContextMenu } from "../../components/ContextMenu/ContextMenu";
import { testInScope } from "../helpers/store";

const sampleItems: ContextMenuItem[] = [
	{ label: "Copy", shortcut: "\u2318C", action: vi.fn() },
	{ label: "Paste", shortcut: "\u2318V", action: vi.fn() },
	{ label: "Delete", action: vi.fn(), disabled: true },
];

describe("ContextMenu", () => {
	it("renders nothing when not visible", () => {
		const { baseElement } = render(() => (
			<ContextMenu items={sampleItems} x={100} y={200} visible={false} onClose={() => {}} />
		));
		const menu = baseElement.querySelector(".menu");
		expect(menu).toBeNull();
	});

	it("renders menu items when visible", () => {
		const { baseElement } = render(() => (
			<ContextMenu items={sampleItems} x={100} y={200} visible={true} onClose={() => {}} />
		));
		const items = baseElement.querySelectorAll(".item");
		expect(items.length).toBe(3);
	});

	it("renders labels correctly", () => {
		const { baseElement } = render(() => (
			<ContextMenu items={sampleItems} x={0} y={0} visible={true} onClose={() => {}} />
		));
		const labels = baseElement.querySelectorAll(".label");
		expect(labels[0].textContent).toBe("Copy");
		expect(labels[1].textContent).toBe("Paste");
		expect(labels[2].textContent).toBe("Delete");
	});

	it("renders shortcuts when provided", () => {
		const { baseElement } = render(() => (
			<ContextMenu items={sampleItems} x={0} y={0} visible={true} onClose={() => {}} />
		));
		const shortcuts = baseElement.querySelectorAll(".shortcut");
		expect(shortcuts.length).toBe(2); // Copy and Paste have shortcuts
		expect(shortcuts[0].textContent).toBe("\u2318C");
	});

	it("fires action and closes on item click", () => {
		const action = vi.fn();
		const handleClose = vi.fn();
		const items: ContextMenuItem[] = [{ label: "Run", action }];
		const { baseElement } = render(() => (
			<ContextMenu items={items} x={0} y={0} visible={true} onClose={handleClose} />
		));
		const btn = baseElement.querySelector(".item")!;
		fireEvent.click(btn);
		expect(action).toHaveBeenCalledOnce();
		expect(handleClose).toHaveBeenCalledOnce();
	});

	it("does not fire action on disabled item click", () => {
		const action = vi.fn();
		const items: ContextMenuItem[] = [{ label: "Disabled", action, disabled: true }];
		const { baseElement } = render(() => <ContextMenu items={items} x={0} y={0} visible={true} onClose={() => {}} />);
		const btn = baseElement.querySelector(".item")!;
		fireEvent.click(btn);
		expect(action).not.toHaveBeenCalled();
	});

	it("renders the item AND a trailing divider when a real item sets separator", () => {
		const items: ContextMenuItem[] = [
			{ label: "Above", action: vi.fn(), separator: true },
			{ label: "Below", action: vi.fn() },
		];
		const { baseElement } = render(() => <ContextMenu items={items} x={0} y={0} visible={true} onClose={() => {}} />);
		// `separator` on a real item is a trailing-divider MODIFIER — "Above"
		// must still render its button, not be replaced by the divider.
		const labels = Array.from(baseElement.querySelectorAll(".label")).map((el) => el.textContent);
		expect(labels).toEqual(["Above", "Below"]);
		expect(baseElement.querySelectorAll(".separator").length).toBe(1);
	});

	it("separator renders only a divider — no selectable button row", () => {
		const items: ContextMenuItem[] = [
			{ label: "Top", action: vi.fn() },
			{ label: "", action: vi.fn(), separator: true },
			{ label: "Bottom", action: vi.fn() },
		];
		const { baseElement } = render(() => <ContextMenu items={items} x={0} y={0} visible={true} onClose={() => {}} />);
		// Two real items only — the separator must NOT produce a hoverable .item button.
		expect(baseElement.querySelectorAll(".item").length).toBe(2);
		expect(baseElement.querySelectorAll(".itemWrap").length).toBe(2);
		expect(baseElement.querySelectorAll(".separator").length).toBe(1);
	});

	it("a real item with separator renders its label plus a trailing divider", () => {
		// Regression guard: commit 2f032261 treated `separator` as exclusive
		// (divider OR item), silently dropping every FileBrowser item that
		// requested a trailing divider — New File, Paste, Delete, Add to
		// .gitignore all vanished. A non-empty label must ALWAYS render.
		const items: ContextMenuItem[] = [
			{ label: "Delete", action: vi.fn(), separator: true },
			{ label: "Reveal", action: vi.fn() },
		];
		const { baseElement } = render(() => <ContextMenu items={items} x={0} y={0} visible={true} onClose={() => {}} />);
		const labels = Array.from(baseElement.querySelectorAll(".label")).map((el) => el.textContent);
		expect(labels).toEqual(["Delete", "Reveal"]);
		expect(baseElement.querySelectorAll(".separator").length).toBe(1);
	});

	it("suppresses a trailing separator on the LAST item (no dangling divider)", () => {
		// Every context menu renders through this component; a modifier separator
		// on the final item must NOT paint a divider with nothing after it.
		const items: ContextMenuItem[] = [
			{ label: "First", action: vi.fn() },
			{ label: "Last", action: vi.fn(), separator: true },
		];
		const { baseElement } = render(() => <ContextMenu items={items} x={0} y={0} visible={true} onClose={() => {}} />);
		const labels = Array.from(baseElement.querySelectorAll(".label")).map((el) => el.textContent);
		expect(labels).toEqual(["First", "Last"]);
		expect(baseElement.querySelectorAll(".separator").length).toBe(0);
	});

	it("suppresses a pure separator row when it is the LAST item", () => {
		const items: ContextMenuItem[] = [
			{ label: "Only", action: vi.fn() },
			{ label: "", action: vi.fn(), separator: true },
		];
		const { baseElement } = render(() => <ContextMenu items={items} x={0} y={0} visible={true} onClose={() => {}} />);
		expect(baseElement.querySelectorAll(".item").length).toBe(1);
		expect(baseElement.querySelectorAll(".separator").length).toBe(0);
	});

	it("closes on Escape key", () => {
		const handleClose = vi.fn();
		render(() => <ContextMenu items={sampleItems} x={0} y={0} visible={true} onClose={handleClose} />);
		fireEvent.keyDown(document, { key: "Escape" });
		expect(handleClose).toHaveBeenCalled();
	});

	it("closes on click outside menu", () => {
		const handleClose = vi.fn();
		render(() => (
			<div>
				<div data-testid="outside">Outside</div>
				<ContextMenu items={sampleItems} x={0} y={0} visible={true} onClose={handleClose} />
			</div>
		));
		fireEvent.mouseDown(document.body);
		expect(handleClose).toHaveBeenCalled();
	});

	it("clamps position to viewport bounds", async () => {
		// Set a small viewport
		Object.defineProperty(window, "innerWidth", { value: 200, writable: true, configurable: true });
		Object.defineProperty(window, "innerHeight", { value: 100, writable: true, configurable: true });

		const { baseElement } = render(() => (
			<ContextMenu items={[{ label: "Test", action: vi.fn() }]} x={190} y={90} visible={true} onClose={() => {}} />
		));
		// Position is adjusted after a requestAnimationFrame
		await new Promise((r) => requestAnimationFrame(r));
		const menu = baseElement.querySelector(".menu") as HTMLElement;
		// x should be clamped: 200 - 180 - 8 = 12
		expect(parseInt(menu.style.left, 10)).toBeLessThan(190);
		// y should be clamped (menu grows upward from click point)
		expect(parseInt(menu.style.top, 10)).toBeLessThan(90);

		// Restore
		Object.defineProperty(window, "innerWidth", { value: 1024, writable: true, configurable: true });
		Object.defineProperty(window, "innerHeight", { value: 768, writable: true, configurable: true });
	});

	it("constrains an oversized menu to the visible viewport", async () => {
		Object.defineProperty(window, "innerWidth", { value: 120, writable: true, configurable: true });
		Object.defineProperty(window, "innerHeight", { value: 80, writable: true, configurable: true });

		try {
			const items: ContextMenuItem[] = Array.from({ length: 20 }, (_, i) => ({
				label: `Item ${i}`,
				action: vi.fn(),
			}));
			const { baseElement } = render(() => (
				<ContextMenu items={items} x={110} y={70} visible={true} onClose={() => {}} />
			));

			await new Promise((r) => requestAnimationFrame(r));
			const menu = baseElement.querySelector(".menu") as HTMLElement;

			expect(menu.style.left).toBe("8px");
			expect(menu.style.top).toBe("8px");
			expect(menu.style.maxWidth).toBe("104px");
			expect(menu.style.maxHeight).toBe("64px");
		} finally {
			Object.defineProperty(window, "innerWidth", { value: 1024, writable: true, configurable: true });
			Object.defineProperty(window, "innerHeight", { value: 768, writable: true, configurable: true });
		}
	});

	// A `backdrop-filter` ancestor becomes the containing block for position: fixed
	// descendants (same as `filter`), so a menu left inside a glass panel resolved
	// its client coordinates against the panel box and was then clipped away by the
	// panel's `overflow: hidden` — right-click looked dead in the file browser.
	it("escapes a filtered ancestor so fixed positioning stays viewport-relative", () => {
		let panel!: HTMLDivElement;
		const { baseElement } = render(() => (
			<div ref={panel} style={{ "backdrop-filter": "blur(24px)", overflow: "hidden" }}>
				<ContextMenu items={sampleItems} x={100} y={200} visible={true} onClose={() => {}} />
			</div>
		));
		const menu = baseElement.querySelector(".menu");
		expect(menu).not.toBeNull();
		expect(panel.contains(menu)).toBe(false);
	});

	it("positions menu at x,y coordinates", () => {
		const { baseElement } = render(() => (
			<ContextMenu items={[{ label: "Test", action: vi.fn() }]} x={150} y={250} visible={true} onClose={() => {}} />
		));
		const menu = baseElement.querySelector(".menu") as HTMLElement;
		expect(menu.style.left).toBe("150px");
		expect(menu.style.top).toBe("250px");
	});
});

describe("ContextMenu submenus", () => {
	it("items with children render submenu arrow indicator", () => {
		const items: ContextMenuItem[] = [
			{ label: "Normal", action: vi.fn() },
			{
				label: "Move to Group",
				action: vi.fn(),
				children: [
					{ label: "Work", action: vi.fn() },
					{ label: "Personal", action: vi.fn() },
				],
			},
		];
		const { baseElement } = render(() => <ContextMenu items={items} x={0} y={0} visible={true} onClose={() => {}} />);
		const arrows = baseElement.querySelectorAll(".arrow");
		expect(arrows.length).toBe(1);
	});

	it("hovering parent shows submenu", async () => {
		const items: ContextMenuItem[] = [
			{
				label: "Move to Group",
				action: vi.fn(),
				children: [{ label: "Work", action: vi.fn() }],
			},
		];
		const { baseElement } = render(() => <ContextMenu items={items} x={0} y={0} visible={true} onClose={() => {}} />);
		const parentWrap = baseElement.querySelector(".itemWrap")!;
		fireEvent.mouseEnter(parentWrap);
		const submenu = baseElement.querySelector(".submenu");
		expect(submenu).not.toBeNull();
	});

	it("clicking submenu item fires action and closes all menus", () => {
		const childAction = vi.fn();
		const handleClose = vi.fn();
		const items: ContextMenuItem[] = [
			{
				label: "Move to Group",
				action: vi.fn(),
				children: [{ label: "Work", action: childAction }],
			},
		];
		const { baseElement } = render(() => (
			<ContextMenu items={items} x={0} y={0} visible={true} onClose={handleClose} />
		));
		// Show submenu
		const parentWrap = baseElement.querySelector(".itemWrap")!;
		fireEvent.mouseEnter(parentWrap);
		// Click submenu item
		const submenuItem = baseElement.querySelector(".submenu .item")!;
		fireEvent.click(submenuItem);
		expect(childAction).toHaveBeenCalledOnce();
		expect(handleClose).toHaveBeenCalledOnce();
	});

	it("disabled item with children does not open submenu on hover", () => {
		const items: ContextMenuItem[] = [
			{
				label: "Agents",
				action: vi.fn(),
				disabled: true,
				children: [{ label: "Claude Code", action: vi.fn() }],
			},
		];
		const { baseElement } = render(() => <ContextMenu items={items} x={0} y={0} visible={true} onClose={() => {}} />);
		const parentWrap = baseElement.querySelector(".itemWrap")!;
		fireEvent.mouseEnter(parentWrap);
		const submenu = baseElement.querySelector(".submenu");
		expect(submenu).toBeNull();
	});

	it("clicking parent item with children does not fire parent action", () => {
		const parentAction = vi.fn();
		const items: ContextMenuItem[] = [
			{
				label: "Move to Group",
				action: parentAction,
				children: [{ label: "Work", action: vi.fn() }],
			},
		];
		const { baseElement } = render(() => <ContextMenu items={items} x={0} y={0} visible={true} onClose={() => {}} />);
		const parentItem = baseElement.querySelector(".item")!;
		fireEvent.click(parentItem);
		expect(parentAction).not.toHaveBeenCalled();
	});

	it("constrains oversized submenus to the visible viewport", async () => {
		Object.defineProperty(window, "innerWidth", { value: 180, writable: true, configurable: true });
		Object.defineProperty(window, "innerHeight", { value: 100, writable: true, configurable: true });
		const originalRect = HTMLElement.prototype.getBoundingClientRect;
		try {
			HTMLElement.prototype.getBoundingClientRect = function () {
				const el = this as HTMLElement;
				if (el.className.includes("itemWrap")) {
					return {
						left: 140,
						right: 170,
						top: 80,
						bottom: 104,
						width: 30,
						height: 24,
						x: 140,
						y: 80,
						toJSON: () => ({}),
					} as DOMRect;
				}
				if (el.className.includes("submenu")) {
					return {
						left: 0,
						right: 220,
						top: 0,
						bottom: 220,
						width: 220,
						height: 220,
						x: 0,
						y: 0,
						toJSON: () => ({}),
					} as DOMRect;
				}
				return originalRect.call(this);
			};

			const items: ContextMenuItem[] = [
				{
					label: "Move to Group",
					action: vi.fn(),
					children: Array.from({ length: 20 }, (_, i) => ({ label: `Group ${i}`, action: vi.fn() })),
				},
			];
			const { baseElement } = render(() => <ContextMenu items={items} x={0} y={0} visible={true} onClose={() => {}} />);
			fireEvent.mouseEnter(baseElement.querySelector(".itemWrap")!);
			await new Promise((r) => requestAnimationFrame(r));

			const submenu = baseElement.querySelector(".submenu") as HTMLElement;
			expect(submenu.style.left).toBe("8px");
			expect(submenu.style.top).toBe("8px");
			expect(submenu.style.maxWidth).toBe("164px");
			expect(submenu.style.maxHeight).toBe("84px");
		} finally {
			HTMLElement.prototype.getBoundingClientRect = originalRect;
			Object.defineProperty(window, "innerWidth", { value: 1024, writable: true, configurable: true });
			Object.defineProperty(window, "innerHeight", { value: 768, writable: true, configurable: true });
		}
	});
});

describe("createContextMenu", () => {
	it("initializes with visible=false", () => {
		testInScope(() => {
			const menu = createContextMenu();
			expect(menu.visible()).toBe(false);
			expect(menu.position().x).toBe(0);
			expect(menu.position().y).toBe(0);
		});
	});

	it("open sets visible and position from mouse event", () => {
		testInScope(() => {
			const menu = createContextMenu();
			const mockEvent = {
				preventDefault: vi.fn(),
				clientX: 300,
				clientY: 400,
			} as unknown as MouseEvent;

			menu.open(mockEvent);

			expect(menu.visible()).toBe(true);
			expect(menu.position().x).toBe(300);
			expect(menu.position().y).toBe(400);
			expect(mockEvent.preventDefault).toHaveBeenCalled();
		});
	});

	it("openAt sets visible and position from coordinates", () => {
		testInScope(() => {
			const menu = createContextMenu();
			menu.openAt(250, 350);

			expect(menu.visible()).toBe(true);
			expect(menu.position().x).toBe(250);
			expect(menu.position().y).toBe(350);
		});
	});

	it("close sets visible to false", async () => {
		testInScope(() => {
			const menu = createContextMenu();
			const mockEvent = {
				preventDefault: vi.fn(),
				clientX: 100,
				clientY: 100,
			} as unknown as MouseEvent;

			menu.open(mockEvent);
			expect(menu.visible()).toBe(true);

			menu.close();
			expect(menu.visible()).toBe(false);
		});
		// Flush happy-dom's setImmediate-based requestAnimationFrame from close()
		await new Promise((r) => setImmediate(r));
	});
});
