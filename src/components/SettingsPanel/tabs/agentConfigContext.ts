import type { Accessor } from "solid-js";
import { createContext, useContext } from "solid-js";
import { type AgentConfigStore, agentConfigsFor } from "../../../stores/agentConfigs";
import type { LaunchInstructionsDefaults } from "../../../stores/settingsExpert";

export type { AgentConfigStore };

const AgentConfigContext = createContext<AgentConfigStore>();

export const AgentConfigProvider = AgentConfigContext.Provider;

export function useAgentConfig(): AgentConfigStore {
	const ctx = useContext(AgentConfigContext);
	if (!ctx) throw new Error("useAgentConfig must be used within AgentConfigProvider");
	return ctx;
}

/**
 * Which machine the surrounding settings tab is editing (`undefined` = this one).
 *
 * Separate from the store because the store is only half of a machine's agent
 * state: the hook toggle and the native-signal toggle are commands that install
 * files on a machine, and they have to be sent to the same one the run configs
 * came from.
 */
const MachineContext = createContext<() => string | undefined>(() => undefined);

export const MachineProvider = MachineContext.Provider;

export function useMachine(): () => string | undefined {
	return useContext(MachineContext);
}

/**
 * The store for one machine's run configs.
 *
 * Shares the registry with the launch path rather than building a private store:
 * editing a remote machine in Settings and launching a tab on it must read and
 * write the same copy, or a save would be invisible until the next reload.
 */
export function createRemoteAgentConfigStore(connectionId: string): AgentConfigStore {
	return agentConfigsFor(connectionId);
}

/** One backend preview snapshot shared by the global editor and all agent rows. */
const LaunchPreviewContext = createContext<Accessor<LaunchInstructionsDefaults | undefined>>(() => undefined);
export const LaunchPreviewProvider = LaunchPreviewContext.Provider;
export const useLaunchPreview = () => useContext(LaunchPreviewContext);
