import { createEffect, on } from "solid-js";
import { diffTabsStore } from "../stores/diffTabs";
import { editorTabsStore } from "../stores/editorTabs";
import { mdTabsStore } from "../stores/mdTabs";
import { terminalsStore } from "../stores/terminals";

/**
 * Keeps the four primary tab stores mutually exclusive after registration.
 * Initial state is intentionally left untouched; only later activations are
 * coordinated so persisted state can finish hydrating before user navigation.
 */
export function useTabActivationSync(): void {
	createEffect(
		on(
			() => mdTabsStore.state.activeId,
			(id) => {
				if (!id) return;
				terminalsStore.setActive(null);
				diffTabsStore.setActive(null);
				editorTabsStore.setActive(null);
			},
			{ defer: true },
		),
	);

	createEffect(
		on(
			() => diffTabsStore.state.activeId,
			(id) => {
				if (!id) return;
				terminalsStore.setActive(null);
				mdTabsStore.setActive(null);
				editorTabsStore.setActive(null);
			},
			{ defer: true },
		),
	);

	createEffect(
		on(
			() => editorTabsStore.state.activeId,
			(id) => {
				if (!id) return;
				terminalsStore.setActive(null);
				diffTabsStore.setActive(null);
				mdTabsStore.setActive(null);
			},
			{ defer: true },
		),
	);

	createEffect(
		on(
			() => terminalsStore.state.activeId,
			(id) => {
				if (!id) return;
				diffTabsStore.setActive(null);
				mdTabsStore.setActive(null);
				editorTabsStore.setActive(null);
			},
			{ defer: true },
		),
	);
}
