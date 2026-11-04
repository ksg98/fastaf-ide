import { createStore } from "solid-js/store";
import { invoke } from "../invoke";
import { runSerializedConfigWrite } from "../utils/updateAppConfig";
import { appLogger } from "./appLogger";
import { settingsStore } from "./settings";

export interface CloseRequest {
	kind: "ask" | "confirm_quit";
	sessions: number;
	background_available?: boolean;
}
export type CloseChoice = "background" | "quit" | "cancel";
const [state, setState] = createStore({
	request: null as CloseRequest | null,
	remember: false,
	saving: false,
	error: "",
});

let requestId = 0;

export const closeDialogStore = {
	state,
	present(request: CloseRequest) {
		requestId += 1;
		setState({ request, remember: false, error: "" });
	},
	setRemember(remember: boolean) {
		setState("remember", remember);
	},
	async answer(choice: CloseChoice) {
		if (!state.request || state.saving) return;
		const answeredRequestId = requestId;
		const remember = state.request.kind === "ask" && state.remember && choice !== "cancel";
		setState({ saving: true, error: "" });
		try {
			await runSerializedConfigWrite(async () => {
				await invoke("resolve_close", { choice, remember });
				if (remember) await settingsStore.hydrate();
			});
			if (requestId === answeredRequestId) setState("request", null);
		} catch (error) {
			if (requestId === answeredRequestId) setState("error", String(error));
			appLogger.error("app", "Close decision failed", error);
		} finally {
			setState("saving", false);
		}
	},
};
