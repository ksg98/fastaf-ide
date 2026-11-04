import type { TerminalData } from "../../stores/terminals";

/**
 * How the dock delivers a prompt to its terminal.
 *
 * "queue" hands it to the backend's idle gate; "now" types it into the agent.
 * ⌥Enter asks to queue, which only an agent can do. In the Chat view the agent's
 * own input box is out of sight, so a prompt sent while the agent works waits
 * in the queue the transcript shows, the way upstream's Chat composer sent it.
 * An agent asking a question takes the answer right away.
 */
export function dockSendMode(
	term: Pick<TerminalData, "agentType" | "viewMode" | "shellState" | "awaitingInput">,
	requested: "now" | "queue",
): "now" | "queue" {
	if (!term.agentType) return "now";
	if (requested === "queue") return "queue";
	return term.viewMode === "chat" && term.shellState === "busy" && !term.awaitingInput ? "queue" : "now";
}
