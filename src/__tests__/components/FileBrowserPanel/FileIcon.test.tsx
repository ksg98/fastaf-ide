import { render } from "@solidjs/testing-library";
import { For } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileIcon } from "../../../components/FileBrowserPanel/FileIcon";
import { fileIconRegistry } from "../../../plugins/fileIconRegistry";

const ICON = `<svg viewBox="0 0 16 16" fill="currentColor"><path d="M1 1h14v14H1z"/></svg>`;
const OTHER_ICON = `<svg viewBox="0 0 16 16" fill="currentColor"><circle cx="8" cy="8" r="7"/></svg>`;

/**
 * Counts the SVG parses a render performs. Every `innerHTML = "<svg…>"` is one
 * parse of ~1.2 KB of markup; Solid's own element templates never contain an
 * `<svg>` in this component, so filtering on the tag isolates icon parsing.
 *
 * Both prototypes are counted on purpose. happy-dom gives `HTMLTemplateElement`
 * its own `innerHTML` accessor, so watching only `Element` would let a fix that
 * parses into a `<template>` per row report zero parses while still doing them.
 */
const countSvgParses = () => {
	let parses = 0;
	const spies = [HTMLTemplateElement, Element]
		.filter((ctor) => Object.getOwnPropertyDescriptor(ctor.prototype, "innerHTML")?.set)
		.map((ctor) => {
			const original = Object.getOwnPropertyDescriptor(ctor.prototype, "innerHTML")?.set as (v: string) => void;
			return vi
				.spyOn(ctor.prototype as unknown as { innerHTML: string }, "innerHTML", "set")
				.mockImplementation(function (this: Element, html) {
					if (typeof html === "string" && html.includes("<svg")) parses += 1;
					original.call(this, html);
				});
		});
	if (spies.length === 0) throw new Error("innerHTML is not an accessor — cannot count parses");
	return {
		get count() {
			return parses;
		},
		restore: () => {
			for (const spy of spies) spy.mockRestore();
		},
	};
};

const names = Array.from({ length: 40 }, (_, i) => `file-${i}.ts`);

beforeEach(() => {
	fileIconRegistry.clear();
});

afterEach(() => {
	fileIconRegistry.clear();
});

describe("FileIcon", () => {
	it("parses an icon's SVG once, not once per row", () => {
		fileIconRegistry.register({ resolveFileIcon: () => ICON });

		const parses = countSvgParses();
		try {
			const { container } = render(() => (
				<For each={names}>{(name) => <FileIcon name={name} isDir={false} class="entryIcon" />}</For>
			));

			expect(container.querySelectorAll("svg").length).toBe(names.length);
			expect(parses.count).toBe(1);
		} finally {
			parses.restore();
		}
	});

	// The cache is keyed by SVG source and lives for the process, so this case
	// needs icons no earlier test has warmed.
	it("parses each distinct icon once", () => {
		const coldA = `<svg viewBox="0 0 16 16"><rect width="3" height="3"/></svg>`;
		const coldB = `<svg viewBox="0 0 16 16"><rect width="4" height="4"/></svg>`;
		fileIconRegistry.register({
			resolveFileIcon: (name) => (name.endsWith("0.ts") ? coldA : coldB),
		});

		const parses = countSvgParses();
		try {
			render(() => <For each={names}>{(name) => <FileIcon name={name} isDir={false} />}</For>);
			expect(parses.count).toBe(2);
		} finally {
			parses.restore();
		}
	});

	// The sizing rule is `.entryIcon svg`, so the icon must stay a child element of
	// the class-carrying span — the markup contract the CSS depends on.
	it("keeps the icon as the only child of the class-carrying span", () => {
		fileIconRegistry.register({ resolveFileIcon: () => ICON });

		const { container } = render(() => <FileIcon name="index.ts" isDir={false} class="entryIcon" />);

		const span = container.querySelector("span.entryIcon");
		expect(span).not.toBeNull();
		expect(span?.children.length).toBe(1);
		expect(span?.firstElementChild?.tagName.toLowerCase()).toBe("svg");
	});

	it("renders independent nodes per row, so one row cannot mutate another", () => {
		fileIconRegistry.register({ resolveFileIcon: () => ICON });

		const { container } = render(() => (
			<For each={["a.ts", "b.ts"]}>{(name) => <FileIcon name={name} isDir={false} />}</For>
		));

		const icons = Array.from(container.querySelectorAll("svg"));
		expect(icons.length).toBe(2);
		expect(icons[0]).not.toBe(icons[1]);

		icons[0].setAttribute("data-touched", "yes");
		expect(icons[1].hasAttribute("data-touched")).toBe(false);
	});

	it("falls back to the default icon and re-renders when a provider registers", () => {
		const { container } = render(() => <FileIcon name="index.ts" isDir={false} />);
		expect(container.querySelector("svg")).not.toBeNull();
		expect(container.querySelector("circle")).toBeNull();

		fileIconRegistry.register({ resolveFileIcon: () => OTHER_ICON });
		expect(container.querySelector("circle")).not.toBeNull();
	});

	it("distinguishes files from folders", () => {
		fileIconRegistry.register({
			resolveFileIcon: (_name, isDir) => (isDir ? OTHER_ICON : ICON),
		});

		const { container } = render(() => (
			<>
				<FileIcon name="src" isDir={true} />
				<FileIcon name="index.ts" isDir={false} />
			</>
		));

		expect(container.querySelectorAll("circle").length).toBe(1);
		expect(container.querySelectorAll("path").length).toBe(1);
	});
});
