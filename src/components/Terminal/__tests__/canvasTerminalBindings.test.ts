import { describe, expect, it, vi } from "vitest";
import { createCanvasTerminalBindings } from "../canvasTerminalBindings";

describe("canvas terminal bindings", () => {
	it("owns element and document listeners and removes them once", () => {
		const bindings = createCanvasTerminalBindings();
		const element = document.createElement("input");
		const onInput = vi.fn();
		const onMouseMove = vi.fn();
		bindings.listen(element, "input", onInput);
		bindings.listen(document, "mousemove", onMouseMove);

		element.dispatchEvent(new InputEvent("input"));
		document.dispatchEvent(new MouseEvent("mousemove"));
		expect(onInput).toHaveBeenCalledTimes(1);
		expect(onMouseMove).toHaveBeenCalledTimes(1);

		bindings.dispose();
		bindings.dispose();
		element.dispatchEvent(new InputEvent("input"));
		document.dispatchEvent(new MouseEvent("mousemove"));
		expect(onInput).toHaveBeenCalledTimes(1);
		expect(onMouseMove).toHaveBeenCalledTimes(1);
	});

	it("does not register listeners after disposal", () => {
		const bindings = createCanvasTerminalBindings();
		const element = document.createElement("button");
		const listener = vi.fn();
		bindings.dispose();
		bindings.listen(element, "click", listener);
		element.click();
		expect(listener).not.toHaveBeenCalled();
	});
});
