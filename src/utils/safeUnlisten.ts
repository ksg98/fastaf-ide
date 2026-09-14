/**
 * Tear down an event listener without letting a late/duplicate unregister
 * escape as an unhandled rejection.
 *
 * Tauri's `listen()` resolves to `async () => _unlisten(event, eventId)` — the
 * unlisten function is ASYNC and returns the promise. A `try { fn() } catch {}`
 * therefore guards nothing: `unregisterListener` throws
 * `undefined is not an object (evaluating 'listeners[eventId].handlerId')`
 * whenever the listener is already gone (teardown racing a reconnect, or the
 * same handle released twice), the throw becomes a rejected promise, and the
 * caller's catch block never sees it.
 *
 * Releasing a listener that is already released is not an error worth
 * surfacing — the desired end state (no listener) holds either way. Swallow
 * both failure shapes so component cleanup stays quiet.
 */
export function safeUnlisten(fn: (() => unknown) | undefined): void {
	if (!fn) return;
	try {
		Promise.resolve(fn()).catch(() => {
			/* listener already unregistered */
		});
	} catch {
		/* listener already unregistered (synchronous variant) */
	}
}
