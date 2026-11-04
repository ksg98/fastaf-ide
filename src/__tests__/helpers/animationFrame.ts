/** Let focus, CodeMirror measurement and iframe-load frames finish before teardown. */
export function nextAnimationFrame(): Promise<void> {
	return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}
