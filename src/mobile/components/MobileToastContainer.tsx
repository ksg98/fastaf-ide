import type { Component } from "solid-js";
import { ToastList } from "../../components/ToastContainer/ToastList";
import { type Toast, toastsStore } from "../../stores/toasts";
import { pathBasename } from "../../utils/pathUtils";

function dismiss(toast: Toast): void {
	toastsStore.remove(toast.id);
}

/** Mobile has no desktop terminal registry; session navigation belongs to its router. */
export const MobileToastContainer: Component = () => (
	<div aria-live="polite" aria-relevant="additions text">
		<ToastList onDismiss={dismiss} repoName={(toast) => (toast.repoPath ? pathBasename(toast.repoPath) : null)} />
	</div>
);
