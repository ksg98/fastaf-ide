import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/** Load the real cascade: Vitest otherwise replaces CSS module imports with class names. */
export function loadChatTypography(): () => void {
	const styles = [
		"src/styles/chat-tokens.css",
		"src/components/AIChatPanel/AIChatPanel.module.css",
		"src/components/Terminal/TerminalChatView.module.css",
	].map((path) => {
		const style = document.createElement("style");
		style.textContent = readFileSync(resolve(process.cwd(), path), "utf8");
		document.head.append(style);
		return style;
	});
	return () => styles.forEach((style) => style.remove());
}

/** DOM emulators do not resolve inherited var()/calc()/clamp() font sizes.
 * Resolve declarations from the actual matching stylesheet rules and inline cascade,
 * not from terminal state or a duplicate of the component's zoom formula.
 */
export function chatFontSize(body: HTMLElement): string {
	function property(element: HTMLElement, name: string): string {
		const inline = element.style.getPropertyValue(name);
		let value = "";
		for (const sheet of Array.from(document.styleSheets)) {
			for (const rule of Array.from(sheet.cssRules)) {
				if (!(rule instanceof CSSStyleRule)) continue;
				try {
					if (element.matches(rule.selectorText)) value = rule.style.getPropertyValue(name) || value;
				} catch {
					// CSS module :global selectors are not native DOM selectors.
				}
			}
		}
		value = inline || value;
		if (!value || value === "inherit") {
			if (!element.parentElement) throw new Error(`No declaration for ${name}`);
			return property(element.parentElement, name);
		}
		return value.replace(/var\((--[\w-]+)(?:,\s*([^()]+))?\)/g, (_, variable: string, fallback: string) => {
			try {
				return property(element, variable);
			} catch (error) {
				if (fallback !== undefined) return fallback;
				throw error;
			}
		});
	}
	let size = property(body, "font-size").trim();
	size = size.replace(
		/calc\(\s*(-?[\d.]+)px\s*\+\s*(-?[\d.]+)px\s*\)/g,
		(_, base, delta) => `${Number(base) + Number(delta)}px`,
	);
	size = size.replace(
		/clamp\(\s*([\d.]+)px,\s*(-?[\d.]+)px,\s*([\d.]+)px\s*\)/g,
		(_, min, value, max) => `${Math.min(Number(max), Math.max(Number(min), Number(value)))}px`,
	);
	if (!/^\d+(?:\.\d+)?px$/.test(size)) throw new Error(`Unresolved body font size: ${size}`);
	return size;
}
