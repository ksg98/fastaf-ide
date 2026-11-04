import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";

// Catches: the overlay intercepting normal browsing before arm or after Escape/Stop/timeout.
it("leaves browsing alone unless explicitly armed and removes the overlay on every cancellation", () => {
	vi.useFakeTimers();
	let receive: (message: { kind: string; multi?: boolean }) => void = () => {};
	const chrome = {
		runtime: {
			sendMessage: vi.fn(async () => {}),
			onMessage: {
				addListener: (listener: typeof receive) => {
					receive = listener;
				},
			},
		},
	};
	const extract = vi.fn(() => ({ selector: "#browse" }));
	new Function("chrome", "tuicExtract", readFileSync("browser-extension/design-mode/picker.js", "utf8"))(
		chrome,
		extract,
	);
	const button = document.createElement("button");
	button.id = "browse";
	document.body.append(button);
	const browse = vi.fn();
	button.addEventListener("click", browse);
	// happy-dom has no browser input driver. Mark DOM-dispatched events trusted
	// to exercise the same capture handler used for browser input.
	// A real press: pointerdown, pointerup and click in one task, then the queue drains.
	const click = () => {
		let event = new MouseEvent("click");
		for (const type of ["pointerdown", "pointerup", "click"]) {
			event = new (type === "click" ? MouseEvent : PointerEvent)(type, { bubbles: true, cancelable: true });
			Object.defineProperty(event, "isTrusted", { value: true });
			button.dispatchEvent(event);
		}
		vi.advanceTimersByTime(0);
		return event;
	};
	const assertBrowsing = () => {
		browse.mockClear();
		extract.mockClear();
		expect(click().defaultPrevented).toBe(false);
		expect(browse).toHaveBeenCalledOnce();
		expect(extract).not.toHaveBeenCalled();
	};
	assertBrowsing();
	for (const cancel of ["escape", "stop", "timeout", "pagehide"]) {
		receive({ kind: "arm", multi: true });
		browse.mockClear();
		expect(click().defaultPrevented).toBe(true);
		expect(browse).not.toHaveBeenCalled();
		expect(extract).toHaveBeenCalled();
		if (cancel === "escape") {
			window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		} else if (cancel === "stop") {
			receive({ kind: "stop" });
		} else if (cancel === "timeout") {
			vi.advanceTimersByTime(120000);
		} else {
			window.dispatchEvent(new Event("pagehide"));
		}
		assertBrowsing();
	}
	button.remove();
	vi.useRealTimers();
});

// Catches: picking on click, which Chromium never dispatches to a disabled control (only pointerdown/pointerup).
it("picks_on_press_and_page_never_sees_it", () => {
	vi.useFakeTimers();
	let receive: (message: { kind: string; multi?: boolean }) => void = () => {};
	const chrome = {
		runtime: {
			sendMessage: vi.fn(async () => {}),
			onMessage: { addListener: (listener: typeof receive) => (receive = listener) },
		},
	};
	const extract = vi.fn(function (this: Element) {
		return { selector: `#${this.id}` };
	});
	new Function("chrome", "tuicExtract", readFileSync("browser-extension/design-mode/picker.js", "utf8"))(
		chrome,
		extract,
	);
	const button = document.createElement("button");
	button.id = "send";
	document.body.append(button);
	const page = vi.fn();
	for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) button.addEventListener(type, page);
	const fire = (type: string) => {
		const event = new (type.startsWith("pointer") ? PointerEvent : MouseEvent)(type, {
			bubbles: true,
			cancelable: true,
		});
		Object.defineProperty(event, "isTrusted", { value: true });
		button.dispatchEvent(event);
	};

	receive({ kind: "arm" });
	// What Chromium delivers for a press on a disabled control: no mousedown, mouseup or click.
	fire("pointerdown");
	fire("pointerup");
	expect(extract).toHaveBeenCalledOnce();
	expect(extract.mock.contexts[0]).toBe(button);
	expect(page).not.toHaveBeenCalled();
	vi.advanceTimersByTime(30);
	expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
		expect.objectContaining({ kind: "pick", raw: { selector: "#send" } }),
	);

	// The press that picked is consumed whole; afterwards the page gets presses again.
	vi.advanceTimersByTime(1);
	fire("pointerdown");
	fire("click");
	expect(page).toHaveBeenCalledTimes(2);
	expect(extract).toHaveBeenCalledOnce();
	button.remove();
	vi.useRealTimers();
});

// Catches: picking the icon inside a disabled control: Chromium targets the child, not the disabled button.
it("picks_the_disabled_control_when_the_press_lands_on_its_icon", () => {
	vi.useFakeTimers();
	let receive: (message: { kind: string; multi?: boolean }) => void = () => {};
	const chrome = {
		runtime: {
			sendMessage: vi.fn(async () => {}),
			onMessage: { addListener: (listener: typeof receive) => (receive = listener) },
		},
	};
	const extract = vi.fn(function (this: Element) {
		return { selector: this.tagName.toLowerCase() };
	});
	new Function("chrome", "tuicExtract", readFileSync("browser-extension/design-mode/picker.js", "utf8"))(
		chrome,
		extract,
	);
	const press = (target: Element) => {
		const event = new PointerEvent("pointerdown", { bubbles: true, cancelable: true });
		Object.defineProperty(event, "isTrusted", { value: true });
		target.dispatchEvent(event);
		vi.advanceTimersByTime(1);
	};
	const make = (host: string, attrs: Record<string, string>) => {
		const control = document.createElement(host);
		for (const [name, value] of Object.entries(attrs)) control.setAttribute(name, value);
		const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
		control.append(icon);
		document.body.append(control);
		return { control, icon };
	};
	const cases = [make("button", { disabled: "" }), make("div", { "aria-disabled": "true" })];
	for (const { control, icon } of cases) {
		extract.mockClear();
		receive({ kind: "arm" });
		press(icon);
		expect(extract.mock.contexts[0]).toBe(control);
	}
	// Other elements keep the exact press target: an icon in an enabled button, a bare element.
	const enabled = make("button", {});
	extract.mockClear();
	receive({ kind: "arm" });
	press(enabled.icon);
	expect(extract.mock.contexts[0]).toBe(enabled.icon);
	const ariaFalse = make("div", { "aria-disabled": "false" });
	extract.mockClear();
	receive({ kind: "arm" });
	press(ariaFalse.icon);
	expect(extract.mock.contexts[0]).toBe(ariaFalse.icon);
	for (const { control } of [...cases, enabled, ariaFalse]) control.remove();
	vi.useRealTimers();
});
