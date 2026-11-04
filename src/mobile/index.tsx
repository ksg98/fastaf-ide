/* @refresh reload */
import { ErrorBoundary, render } from "solid-js/web";
import { CrashScreen } from "../components/CrashScreen/CrashScreen";
import { appLogger } from "../stores/appLogger";
import MobileApp from "./MobileApp";
import { installResumeDiagnostics } from "./resumeDiagnostics";
import "./mobile.css";

installResumeDiagnostics();

// Global error handlers
window.addEventListener("error", (event) => {
	appLogger.error("app", `Uncaught: ${event.message}`, {
		filename: event.filename,
		lineno: event.lineno,
		colno: event.colno,
	});
});

window.addEventListener("unhandledrejection", (event) => {
	const reason = event.reason instanceof Error ? event.reason.message : String(event.reason);
	const stack = event.reason instanceof Error ? event.reason.stack : undefined;
	appLogger.error("app", `Unhandled rejection: ${reason}`, stack ? { stack } : undefined);
});

const root = document.getElementById("mobile-app");

if (!root) {
	throw new Error("Root element #mobile-app not found");
}

render(
	() => (
		<ErrorBoundary fallback={(err) => <CrashScreen title="FastAF Mobile crashed" error={err} />}>
			<MobileApp />
		</ErrorBoundary>
	),
	root,
);

// The shell in mobile.html shows a preloader until now; see its boot watchdog.
(window as unknown as { __tuicMobileReady?: boolean }).__tuicMobileReady = true;
document.getElementById("mobile-preloader")?.remove();
sessionStorage.removeItem("tuic-boot-delay");
