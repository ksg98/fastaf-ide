/**
 * The two things the Providers tab asks of ego's command line.
 *
 * Thin on purpose. Which commands are run, how their three answers are joined,
 * and what counts as a usable provider are decided in `ego_cli.rs` — the tab
 * renders one finished payload, and a browser over HTTP gets the same one.
 */

import { invoke } from "../invoke";
import type { EgoPerimeterView, EgoProviders, EgoRootsEdit } from "../types/ego";

export interface EgoPerimeterClient {
	perimeter(): Promise<EgoPerimeterView>;
	setRoots(roots: EgoRootsEdit): Promise<EgoPerimeterView>;
	setNetwork(enabled: boolean): Promise<EgoPerimeterView>;
}

export const egoPerimeterCli: EgoPerimeterClient = {
	perimeter: () => invoke<EgoPerimeterView>("ego_perimeter"),
	setRoots: (roots) => invoke<EgoPerimeterView>("ego_set_perimeter_roots", { roots }),
	setNetwork: (enabled) => invoke<EgoPerimeterView>("ego_set_perimeter_network", { enabled }),
};

export interface EgoCliClient {
	providers(refresh: boolean): Promise<EgoProviders>;
	setDefaultModel(model: string): Promise<EgoProviders>;
}

export const egoCli: EgoCliClient = {
	/**
	 * Read the providers.
	 *
	 * `refresh` is the only thing on this surface that reaches a provider over
	 * the network, and it is ego that reaches it. Off unless a person asked, so
	 * opening Settings is not a round of provider requests.
	 */
	providers(refresh: boolean): Promise<EgoProviders> {
		return invoke<EgoProviders>("ego_providers", { refresh });
	},

	/**
	 * Write ego's default model and get the whole tab back as ego now holds it.
	 *
	 * The answer is a fresh read rather than the value that was sent, so what
	 * the tab shows after a write is what ego persisted.
	 */
	setDefaultModel(model: string): Promise<EgoProviders> {
		return invoke<EgoProviders>("ego_set_default_model", { model });
	},
};
