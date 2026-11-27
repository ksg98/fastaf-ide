import { cleanup, fireEvent, render } from "@solidjs/testing-library";
import { createSignal, type JSX } from "solid-js";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DropdownItem } from "../../components/ui/Dropdown";
import { Dropdown } from "../../components/ui/Dropdown";

const sampleItems: DropdownItem[] = [
	{ id: "a", label: "Alpha" },
	{ id: "b", label: "Beta" },
	{ id: "c", label: "Gamma", disabled: true },
];

describe("Dropdown", () => {
	it("renders nothing when visible is false", () => {
		const { container } = render(() => (
			<Dropdown items={sampleItems} visible={false} onSelect={() => {}} onClose={() => {}} />
		));
		const dropdown = container.querySelector("[data-testid='dropdown']");
		expect(dropdown).toBeNull();
	});

	it("renders items when visible is true", () => {
		const { container } = render(() => (
			<Dropdown items={sampleItems} visible={true} onSelect={() => {}} onClose={() => {}} />
		));
		const items = container.querySelectorAll("[data-testid='dropdown-item']");
		expect(items.length).toBe(3);
		expect(items[0].querySelector("[data-testid='dropdown-item-label']")!.textContent).toBe("Alpha");
		expect(items[1].querySelector("[data-testid='dropdown-item-label']")!.textContent).toBe("Beta");
	});

	it("applies selected class to selected item", () => {
		const { container } = render(() => (
			<Dropdown items={sampleItems} selected="b" visible={true} onSelect={() => {}} onClose={() => {}} />
		));
		const items = container.querySelectorAll("[data-testid='dropdown-item']");
		expect(items[0].hasAttribute("data-selected")).toBe(false);
		expect(items[1].hasAttribute("data-selected")).toBe(true);
	});

	it("calls onSelect when non-disabled item is clicked", () => {
		const handleSelect = vi.fn();
		const { container } = render(() => (
			<Dropdown items={sampleItems} visible={true} onSelect={handleSelect} onClose={() => {}} />
		));
		const items = container.querySelectorAll("[data-testid='dropdown-item']");
		fireEvent.click(items[0]);
		expect(handleSelect).toHaveBeenCalledWith("a");
	});

	it("does not call onSelect for disabled items", () => {
		const handleSelect = vi.fn();
		const { container } = render(() => (
			<Dropdown items={sampleItems} visible={true} onSelect={handleSelect} onClose={() => {}} />
		));
		const items = container.querySelectorAll("[data-testid='dropdown-item']");
		fireEvent.click(items[2]); // disabled item
		expect(handleSelect).not.toHaveBeenCalled();
	});

	it("applies disabled class to disabled items", () => {
		const { container } = render(() => (
			<Dropdown items={sampleItems} visible={true} onSelect={() => {}} onClose={() => {}} />
		));
		const items = container.querySelectorAll("[data-testid='dropdown-item']");
		expect(items[2].hasAttribute("data-disabled")).toBe(true);
	});

	it("closes on Escape key", () => {
		const handleClose = vi.fn();
		render(() => <Dropdown items={sampleItems} visible={true} onSelect={() => {}} onClose={handleClose} />);
		fireEvent.keyDown(document, { key: "Escape" });
		expect(handleClose).toHaveBeenCalled();
	});

	it("closes on click outside", async () => {
		const handleClose = vi.fn();
		render(() => (
			<div>
				<div data-testid="outside">Outside</div>
				<Dropdown items={sampleItems} visible={true} onSelect={() => {}} onClose={handleClose} />
			</div>
		));
		// The click-outside handler is delayed by setTimeout(0)
		await vi.waitFor(() => {
			fireEvent.click(document.body);
			expect(handleClose).toHaveBeenCalled();
		});
	});

	it("renders with top position class", () => {
		const { container } = render(() => (
			<Dropdown items={sampleItems} visible={true} onSelect={() => {}} onClose={() => {}} position="top" />
		));
		const dropdown = container.querySelector("[data-testid='dropdown']");
		expect(dropdown!.getAttribute("data-position")).toBe("top");
	});

	it("renders items with icons", () => {
		const itemsWithIcon: DropdownItem[] = [{ id: "a", label: "Alpha", icon: (<span>icon</span>) as JSX.Element }];
		const { container } = render(() => (
			<Dropdown items={itemsWithIcon} visible={true} onSelect={() => {}} onClose={() => {}} />
		));
		const icon = container.querySelector("[data-testid='dropdown-item-icon']");
		expect(icon).not.toBeNull();
	});

	it("renders dividers", () => {
		const itemsWithDivider: DropdownItem[] = [
			{ id: "a", label: "Alpha" },
			{ id: "div", label: "", divider: true },
			{ id: "b", label: "Beta" },
		];
		const { container } = render(() => (
			<Dropdown items={itemsWithDivider} visible={true} onSelect={() => {}} onClose={() => {}} />
		));
		const dividers = container.querySelectorAll("[data-testid='dropdown-divider']");
		expect(dividers.length).toBe(1);
	});
});

// An anchored menu (the Automations timezone picker, the chat's message menu) is placed
// by measuring; jsdom has no layout, so each row is given a height and the window a size.
describe("Dropdown anchored to a trigger", () => {
	/** 3 rows: 360px of content, plus a 1px border on each side. */
	const ROW = 100;
	const CHROME = 60;
	const BORDER = 2;
	const anchorAt = (top: number) => () =>
		({ top, bottom: top + 28, left: 100, right: 300, width: 200, height: 28 }) as DOMRect;
	const placed = async (top: number, extra: { searchLabel?: string; position?: "top" | "bottom" } = {}) => {
		render(() => (
			<Dropdown
				items={sampleItems}
				visible={true}
				anchor={anchorAt(top)}
				onSelect={() => {}}
				onClose={() => {}}
				{...extra}
			/>
		));
		await Promise.resolve();
		return document.querySelector<HTMLElement>("[data-testid='dropdown']")!.style;
	};
	const contentHeight = (el: HTMLElement) => el.querySelectorAll('[role="menuitem"]').length * ROW + CHROME;

	beforeEach(() => {
		Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
			configurable: true,
			get(this: HTMLElement) {
				return contentHeight(this);
			},
		});
		Object.defineProperty(HTMLElement.prototype, "clientHeight", {
			configurable: true,
			get(this: HTMLElement) {
				return contentHeight(this);
			},
		});
		Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
			configurable: true,
			get(this: HTMLElement) {
				return contentHeight(this) + BORDER;
			},
		});
		vi.stubGlobal("innerHeight", 1000);
	});
	afterEach(() => {
		for (const prop of ["scrollHeight", "clientHeight", "offsetHeight"]) {
			delete (HTMLElement.prototype as unknown as Record<string, unknown>)[prop];
		}
		vi.unstubAllGlobals();
		cleanup();
	});

	it("opens under its trigger while there is room", async () => {
		const style = await placed(100);
		expect(style.top).toBe("132px");
		expect(style.bottom).toBe("auto");
		expect(style.maxHeight).toBe("860px");
	});

	// Catches: the menu clamped back into the window, on top of the trigger and the fields beside it.
	it("opens above its trigger when the room below is too short", async () => {
		const style = await placed(870);
		// Its bottom edge is 4px above the trigger: 870 - 4 - the 362px it is drawn at.
		expect(style.top).toBe("504px");
		expect(style.bottom).toBe("auto");
	});

	it("takes the roomier side, cut to that room, when it fits on neither", async () => {
		vi.stubGlobal("innerHeight", 500);
		const style = await placed(300);
		expect(style.maxHeight).toBe("288px");
		expect(style.top).toBe("8px");
	});

	it("honours position top when the menu fits above", async () => {
		const style = await placed(500, { position: "top" });
		expect(style.top).toBe("134px");
	});

	it("covers the trigger only when neither side has usable room", async () => {
		vi.stubGlobal("innerHeight", 200);
		const style = await placed(90);
		expect(style.top).toBe("8px");
		expect(style.maxHeight).toBe("184px");
	});

	// Catches: a menu that opened upward left hanging above its trigger once the filter
	// shortens it, or jumping below the trigger (with the field being typed in) because
	// the shorter list now fits there.
	it("stays above and against its trigger when a filter shortens a menu that opened upward", async () => {
		// 260px under the trigger: not enough for three rows (360px), enough for one (162px).
		const style = await placed(700, { searchLabel: "Timezone" });
		expect(style.top).toBe(`${700 - 4 - 360}px`);
		fireEvent.input(document.querySelector<HTMLInputElement>('input[aria-label="Timezone"]')!, {
			target: { value: "alp" },
		});
		await Promise.resolve();
		expect(document.querySelectorAll('[role="menuitem"]')).toHaveLength(1);
		expect(style.top).toBe(`${700 - 4 - (ROW + CHROME + BORDER)}px`);
	});

	it("chooses its side again when it is opened again", async () => {
		const [top, setTop] = createSignal(870);
		const [visible, setVisible] = createSignal(true);
		render(() => (
			<Dropdown
				items={sampleItems}
				visible={visible()}
				anchor={() => ({ top: top(), bottom: top() + 28, left: 100, right: 300, width: 200, height: 28 }) as DOMRect}
				onSelect={() => {}}
				onClose={() => {}}
			/>
		));
		await Promise.resolve();
		const menu = () => document.querySelector<HTMLElement>("[data-testid='dropdown']")!;
		expect(menu().style.top).toBe("504px");
		setVisible(false);
		setTop(100);
		setVisible(true);
		await Promise.resolve();
		expect(menu().style.top).toBe("132px");
	});
});

// Settle the shared UI persistence owner imported by the control utilities.
import { activityStore } from "../../stores/activityStore";

beforeAll(() => activityStore.hydrate());
