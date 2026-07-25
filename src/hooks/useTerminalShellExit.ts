import { onCleanup } from "solid-js";
import { terminalsStore } from "../stores/terminals";

/** Closes plain shell tabs after their backend session exits. */
export function useTerminalShellExit(closeTerminal: (id: string, skipConfirm?: boolean) => void | Promise<void>): void {
	const dispose = terminalsStore.onShellExit((id) => void closeTerminal(id, true));
	onCleanup(dispose);
}
