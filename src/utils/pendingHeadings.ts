import { isAbsolutePath, joinPath, normalizeSep } from "./pathUtils";

/** Anchors requested for Markdown tabs that have not finished loading yet, keyed by absolute path. */
const pendingHeadings = new Map<string, string>();

/** Remember the `#anchor` of a cross-file Markdown link so the tab it opens can scroll to it. */
export function setPendingHeading(root: string, link: { open_path: string; anchor?: string | null }): void {
	if (!link.anchor || !/\.mdx?$/i.test(link.open_path)) return;
	const tabPath = isAbsolutePath(link.open_path) ? link.open_path : joinPath(root, link.open_path);
	pendingHeadings.set(normalizeSep(tabPath), link.anchor);
}

/** Take (and forget) the anchor pending for an absolute, separator-normalised path. */
export function consumePendingHeading(absolutePath: string): string | undefined {
	const anchor = pendingHeadings.get(absolutePath);
	pendingHeadings.delete(absolutePath);
	return anchor;
}
