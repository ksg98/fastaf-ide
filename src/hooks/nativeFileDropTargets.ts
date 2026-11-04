/** Mounted editors can claim native file drops before the global pane/tab routing. */
type FileDropHandler = (paths: string[], point: { x: number; y: number }) => void;
const targets = new WeakMap<Element, FileDropHandler>();

export function registerNativeFileDropTarget(element: Element, handler: FileDropHandler): () => void {
	targets.set(element, handler);
	return () => targets.delete(element);
}

export function dispatchNativeFileDropTarget(
	element: Element | null,
	paths: string[],
	point: { x: number; y: number },
): boolean {
	for (let current = element; current; current = current.parentElement) {
		const handler = targets.get(current);
		if (!handler) continue;
		handler(paths, point);
		return true;
	}
	return false;
}
