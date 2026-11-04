/** The dictated draft of a session, kept so a PWA reload does not lose what was said. */
const keyFor = (sessionId: string) => `tuic-mobile-dictation-partial:${sessionId}`;

export function loadDictationPartial(sessionId: string): string {
	return localStorage.getItem(keyFor(sessionId)) ?? "";
}

export function saveDictationPartial(sessionId: string, text: string): void {
	localStorage.setItem(keyFor(sessionId), text);
}

export function clearDictationPartial(sessionId: string): void {
	localStorage.removeItem(keyFor(sessionId));
}
