import { createRoot } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Tablet "+" long press (#1329-a31a). Each case names the bug it catches.

vi.mock("../hooks/useMouseDrag", async (importActual) => ({
	...(await importActual<typeof import("../hooks/useMouseDrag")>()),
	initMouseDrag: vi.fn(),
}));

import { createAgentLaunchMenu } from "../components/ContextMenu/createAgentLaunchMenu";
import { useSidebarDragDrop } from "../components/Sidebar/useSidebarDragDrop";
import { initMouseDrag } from "../hooks/useMouseDrag";

const pointer = (target: Element, pointerType: string) =>
	({ target, currentTarget: target, pointerType, button: 0 }) as unknown as PointerEvent;

describe("repo drag arming on touch", () => {
	let section: HTMLElement;
	let button: HTMLElement;

	beforeEach(() => {
		vi.mocked(initMouseDrag).mockClear();
		document.body.innerHTML = `<div data-sidebar-repo="/r"><span id="bg"></span><button id="plus"></button></div>`;
		section = document.querySelector("#bg") as HTMLElement;
		button = document.querySelector("#plus") as HTMLElement;
	});

	afterEach(() => {
		document.body.innerHTML = "";
	});

	// Catches: a touch hold on "+" arms the repo drag, which captures the pointer and
	// cancels the + long press (agent list) before it fires.
	it("does not arm a repo drag from a button on touch", () => {
		createRoot((dispose) => {
			useSidebarDragDrop().handleRepoMouseDrag(pointer(button, "touch"), "/r");
			dispose();
		});
		expect(initMouseDrag).not.toHaveBeenCalled();
	});

	it("arms a repo drag from the section background on touch", () => {
		createRoot((dispose) => {
			useSidebarDragDrop().handleRepoMouseDrag(pointer(section, "touch"), "/r");
			dispose();
		});
		expect(initMouseDrag).toHaveBeenCalledOnce();
	});

	// Catches: the button guard leaking to the mouse, which dragged from buttons before.
	it("keeps mouse drag from a button", () => {
		createRoot((dispose) => {
			useSidebarDragDrop().handleRepoMouseDrag(pointer(button, "mouse"), "/r");
			dispose();
		});
		expect(initMouseDrag).toHaveBeenCalledOnce();
	});
});

describe("agent list opened by a touch long press", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => {
		vi.useRealTimers();
		document.body.innerHTML = "";
	});

	const press = (pointerType: string) => {
		const btn = document.createElement("button");
		document.body.append(btn);
		let handlers!: ReturnType<typeof createAgentLaunchMenu>["buttonHandlers"];
		let dispose!: () => void;
		createRoot((d) => {
			dispose = d;
			handlers = createAgentLaunchMenu(() => [{ label: "Claude", action: () => {} }]).buttonHandlers;
		});
		handlers.onPointerDown({ button: 0, currentTarget: btn } as unknown as PointerEvent & {
			currentTarget: HTMLElement;
		});
		vi.advanceTimersByTime(600);
		handlers.onPointerUp({ pointerType } as PointerEvent & { currentTarget: HTMLElement });
		return dispose;
	};

	// Catches: the emulated mousedown that follows the finger lifting closing the list
	// at once (ContextMenu closes on any outside mousedown).
	it("hides the release mousedown from the menu's outside-click listener", () => {
		const outside = vi.fn();
		document.addEventListener("mousedown", outside);
		const dispose = press("touch");
		document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
		expect(outside).not.toHaveBeenCalled();
		document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
		expect(outside).toHaveBeenCalledOnce();
		document.removeEventListener("mousedown", outside);
		dispose();
	});

	it("leaves a later outside mousedown alone when the browser sent none on release", () => {
		const outside = vi.fn();
		document.addEventListener("mousedown", outside);
		const dispose = press("touch");
		vi.advanceTimersByTime(600);
		document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
		expect(outside).toHaveBeenCalledOnce();
		document.removeEventListener("mousedown", outside);
		dispose();
	});

	it("does not touch mousedown after a mouse long press", () => {
		const outside = vi.fn();
		document.addEventListener("mousedown", outside);
		const dispose = press("mouse");
		document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
		expect(outside).toHaveBeenCalledOnce();
		document.removeEventListener("mousedown", outside);
		dispose();
	});
});
