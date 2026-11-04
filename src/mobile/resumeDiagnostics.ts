import { appLogger } from "../stores/appLogger";
import { installResumeTrail } from "./resumeTrail";

/** Record a broken resumed document without changing or reloading it. */
export function installResumeDiagnostics(): () => void {
	const disposeTrail = installResumeTrail();
	let frame = 0;
	let hidden = document.visibilityState === "hidden";
	let lastError: { message: string; filename: string; lineno: number; colno: number; stack?: string } | null = null;
	const onError = (event: ErrorEvent) => {
		lastError = {
			message: event.message,
			filename: event.filename,
			lineno: event.lineno,
			colno: event.colno,
			stack: event.error instanceof Error ? event.error.stack : undefined,
		};
	};
	const onHide = () => {
		if (!hidden) lastError = null;
		hidden = true;
		cancelAnimationFrame(frame);
	};
	const inspect = () => {
		cancelAnimationFrame(frame);
		frame = requestAnimationFrame(() => {
			if (document.visibilityState === "hidden") return;
			const root = document.getElementById("mobile-app");
			const shell = root?.querySelector<HTMLElement>("[data-mobile-shell]");
			const rect = shell?.getBoundingClientRect();
			const viewport = window.visualViewport;
			const top = viewport?.offsetTop ?? 0;
			const left = viewport?.offsetLeft ?? 0;
			const height = viewport?.height ?? window.innerHeight;
			const width = viewport?.width ?? window.innerWidth;
			const empty = !root?.childElementCount;
			const offScreen =
				rect &&
				(rect.width <= 0 ||
					rect.height <= 0 ||
					rect.bottom <= top ||
					rect.top >= top + height ||
					rect.right <= left ||
					rect.left >= left + width);
			if (!empty && !offScreen) return;
			appLogger.warn("app", "Mobile resume has an empty or off-screen shell", {
				href: location.href,
				rootChildCount: root?.childElementCount ?? 0,
				shellRect: rect
					? {
							top: rect.top,
							left: rect.left,
							right: rect.right,
							bottom: rect.bottom,
							width: rect.width,
							height: rect.height,
						}
					: null,
				visualViewport: viewport ? { height: viewport.height, offsetTop: viewport.offsetTop } : null,
				visibilityState: document.visibilityState,
				lastError,
			});
		});
	};
	const onShow = () => {
		hidden = false;
		inspect();
	};
	const onVisibility = () => {
		if (document.visibilityState === "hidden") onHide();
		else onShow();
	};
	window.addEventListener("error", onError);
	window.addEventListener("pagehide", onHide);
	window.addEventListener("pageshow", onShow);
	document.addEventListener("visibilitychange", onVisibility);
	return () => {
		disposeTrail();
		cancelAnimationFrame(frame);
		window.removeEventListener("error", onError);
		window.removeEventListener("pagehide", onHide);
		window.removeEventListener("pageshow", onShow);
		document.removeEventListener("visibilitychange", onVisibility);
	};
}
