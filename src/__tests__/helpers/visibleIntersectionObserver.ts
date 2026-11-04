/** A mounted, visible viewport for component tests that do not exercise hiding. */
export class VisibleIntersectionObserver {
	constructor(private callback: IntersectionObserverCallback) {}

	observe(target: Element): void {
		this.callback(
			[{ target, isIntersecting: true, time: performance.now() } as IntersectionObserverEntry],
			this as unknown as IntersectionObserver,
		);
	}

	disconnect(): void {}
}
