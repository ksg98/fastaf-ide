import { onCleanup, onMount } from "solid-js";
import { ContentRenderer } from "../../ui/ContentRenderer";

/** Keep reader-owned disclosure state when the provider refreshes the Markdown. */
export function TaskMarkdown(props: { content: string }) {
	let root: HTMLDivElement | undefined;
	const expanded = new Map<string, boolean>();
	const sections = () => Array.from(root?.querySelectorAll("details") ?? []);
	const key = (element: HTMLDetailsElement, index: number) =>
		`${index}:${element.querySelector("summary")?.textContent}`;
	onMount(() => {
		const remember = (event: Event) => {
			if (!(event.target instanceof HTMLDetailsElement) || !root?.contains(event.target)) return;
			const index = sections().indexOf(event.target);
			expanded.set(key(event.target, index), event.target.open);
		};
		const observer = new MutationObserver(() => {
			for (const [index, section] of sections().entries()) {
				const open = expanded.get(key(section, index));
				if (open !== undefined) section.open = open;
			}
		});
		if (root) {
			root.addEventListener("toggle", remember, true);
			observer.observe(root, { childList: true, subtree: true });
		}
		onCleanup(() => {
			observer.disconnect();
			root?.removeEventListener("toggle", remember, true);
		});
	});
	return (
		<div ref={root}>
			<ContentRenderer content={props.content} untrustedContent />
		</div>
	);
}
