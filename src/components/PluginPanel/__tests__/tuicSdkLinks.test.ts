import { expect, it, vi } from "vitest";
import { TUIC_SDK_SCRIPT } from "../tuicSdk";

function clickInPlugin(href: string) {
	const doc = document.implementation.createHTMLDocument("Plugin");
	const postMessage = vi.fn();
	const script = TUIC_SDK_SCRIPT.slice(TUIC_SDK_SCRIPT.indexOf(">") + 1, TUIC_SDK_SCRIPT.lastIndexOf("</script>"));
	new Function("window", "document", "parent", script)({ addEventListener: vi.fn() }, doc, { postMessage });
	postMessage.mockClear();
	const link = doc.createElement("a");
	link.href = href;
	link.textContent = "Open link";
	doc.body.append(link);
	const click = new MouseEvent("click", { bubbles: true, cancelable: true });
	link.dispatchEvent(click);
	return { click, postMessage };
}

it("forwards an explicit external link click to the host without navigating the iframe", () => {
	const { click, postMessage } = clickInPlugin("https://example.org/help");
	expect(click.defaultPrevented).toBe(true);
	expect(postMessage).toHaveBeenCalledWith({ type: "tuic:open-url", url: "https://example.org/help" }, "*");
});

it("does not send a script URL to the host opener", () => {
	const { click, postMessage } = clickInPlugin("javascript:alert(1)");
	expect(click.defaultPrevented).toBe(true);
	expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "tuic:open-url" }), "*");
});

// Catches: the injected parser diverges from native tabs or retains a duplicate POSIX root.
it.each([
	["tuic://open///Users/boss/x.md", "tuic:open", "/Users/boss/x.md"],
	["tuic://edit///home/boss/x.rs", "tuic:edit", "/home/boss/x.rs"],
	["tuic://open/docs/x.md", "tuic:open", "docs/x.md"],
	["tuic://edit/C:/Users/boss/x.rs", "tuic:edit", "C:/Users/boss/x.rs"],
])("normalizes injected file-link parsing for %s", (href, type, path) => {
	const { click, postMessage } = clickInPlugin(href);
	expect(click.defaultPrevented).toBe(true);
	expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ type, path }), "*");
});
