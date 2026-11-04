/**
 * Report an element's rendered width now and on every change, and 0 once
 * stopped. The resize handle mutates `style.width` directly, so the DOM is the
 * only place the docked panel's width exists; a hidden panel (`display: none`)
 * measures 0, which is what "no panel to avoid" means to the consumer.
 */
export function trackPanelWidth(element: HTMLElement, report: (width: number) => void): () => void {
	const measure = () => report(element.getBoundingClientRect().width);
	const observer = new ResizeObserver(measure);
	observer.observe(element);
	measure();
	return () => {
		observer.disconnect();
		report(0);
	};
}
