import { rpc } from "../transport";

const STORAGE_KEY = "tuic-mobile-resume-trail";
const MAX_EVENTS = 30;

type SocketState = "connecting" | "open" | "reconnecting" | "paused" | "closed" | "failed";
interface SocketSnapshot {
	sessionId: string;
	state: SocketState;
}
interface TrailEvent {
	type: string;
	timestamp: number;
	visibilityState: DocumentVisibilityState;
	persisted?: boolean;
	rootChildCount: number;
	shellRect: { top: number; left: number; width: number; height: number } | null;
	visualViewport: { height: number; width: number; offsetTop: number; offsetLeft: number } | null;
	appHeight: string;
	appTop: string;
	socket: SocketSnapshot | null;
}
interface PendingTrail {
	id: string;
	href: string;
	events: TrailEvent[];
}
interface Journal {
	version: 1;
	href: string;
	events: TrailEvent[];
	cleanPagehide: boolean;
	hidden: boolean;
	pending?: PendingTrail;
}

// The mobile entry installs one recorder. Observe only its own terminal stream,
// never replace WebSocket or retain socket objects, URLs, tokens or terminal data.
let socketRecorder: ((socket: SocketSnapshot) => void) | undefined;
export function recordMobileSocketState(sessionId: string, state: SocketState): void {
	socketRecorder?.({ sessionId, state });
}

function readJournal(): Journal | undefined {
	try {
		const raw = sessionStorage.getItem(STORAGE_KEY);
		if (!raw || raw.length > 128_000) return;
		const value = JSON.parse(raw) as Journal;
		if (value?.version !== 1 || !Array.isArray(value.events) || value.events.length > MAX_EVENTS) return;
		if (value.pending && (!Array.isArray(value.pending.events) || value.pending.events.length > MAX_EVENTS)) return;
		return value;
	} catch {
		// Storage can be denied or reclaimed. Diagnostics must never block boot.
	}
}

/** Preserve synchronous evidence even when the document cannot paint again. */
export function installResumeTrail(): () => void {
	const previous = readJournal();
	const journal: Journal = {
		version: 1,
		// Do not persist credentials, query tokens or fragments from the URL.
		href: location.origin + location.pathname,
		events: [],
		cleanPagehide: false,
		hidden: document.visibilityState === "hidden",
		pending:
			previous?.pending ??
			(previous && (!previous.cleanPagehide || previous.hidden)
				? { id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, href: previous.href, events: previous.events }
				: undefined),
	};
	let socket: SocketSnapshot | null = null;
	let disposed = false;
	let sending = false;
	const save = () => {
		try {
			sessionStorage.setItem(STORAGE_KEY, JSON.stringify(journal));
		} catch {
			// Keep recording in memory when storage is unavailable.
		}
	};
	const record = (type: string, persisted?: boolean) => {
		const root = document.getElementById("mobile-app");
		const rect = root?.querySelector<HTMLElement>("[data-mobile-shell]")?.getBoundingClientRect();
		const viewport = window.visualViewport;
		const style = getComputedStyle(document.documentElement);
		journal.events.push({
			type,
			timestamp: Date.now(),
			visibilityState: document.visibilityState,
			persisted,
			rootChildCount: root?.childElementCount ?? 0,
			shellRect: rect ? { top: rect.top, left: rect.left, width: rect.width, height: rect.height } : null,
			visualViewport: viewport
				? {
						height: viewport.height,
						width: viewport.width,
						offsetTop: viewport.offsetTop,
						offsetLeft: viewport.offsetLeft,
					}
				: null,
			appHeight: style.getPropertyValue("--app-height").trim().slice(0, 80),
			appTop: style.getPropertyValue("--app-top").trim().slice(0, 80),
			socket,
		});
		if (journal.events.length > MAX_EVENTS) journal.events.shift();
		journal.hidden = document.visibilityState === "hidden";
		save();
	};
	const upload = () => {
		const pending = journal.pending;
		if (!pending || sending || disposed) return;
		sending = true;
		// Await the existing log transport's acknowledgement before discarding
		// the prior document. appLogger's fire-and-forget mirror cannot do that.
		void rpc("push_log", {
			level: "warn",
			source: "app",
			message: "Mobile previous document lifecycle trail",
			dataJson: JSON.stringify(pending),
			audience: "diagnostic",
		})
			.then(() => {
				if (disposed) return;
				journal.pending = undefined;
				save();
			})
			.catch(() => {
				// Preserve pending evidence; retry on online/resume or next boot.
			})
			.finally(() => {
				sending = false;
			});
	};
	const onPagehide = (event: PageTransitionEvent) => {
		journal.cleanPagehide = true;
		record("pagehide", event.persisted);
	};
	const onPageshow = (event: PageTransitionEvent) => {
		journal.cleanPagehide = false;
		record("pageshow", event.persisted);
		upload();
	};
	const onVisibility = () => {
		record("visibilitychange");
		if (document.visibilityState !== "hidden") upload();
	};
	const onFreeze = () => record("freeze");
	const onResume = () => {
		record("resume");
		upload();
	};
	const onSocket = (state: SocketSnapshot) => {
		socket = state;
		record("websocket");
	};
	socketRecorder = onSocket;
	window.addEventListener("pagehide", onPagehide);
	window.addEventListener("pageshow", onPageshow);
	window.addEventListener("online", upload);
	document.addEventListener("visibilitychange", onVisibility);
	document.addEventListener("freeze", onFreeze);
	document.addEventListener("resume", onResume);
	record("boot");
	upload();
	return () => {
		disposed = true;
		if (socketRecorder === onSocket) socketRecorder = undefined;
		window.removeEventListener("pagehide", onPagehide);
		window.removeEventListener("pageshow", onPageshow);
		window.removeEventListener("online", upload);
		document.removeEventListener("visibilitychange", onVisibility);
		document.removeEventListener("freeze", onFreeze);
		document.removeEventListener("resume", onResume);
	};
}
