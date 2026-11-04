import { For } from "solid-js";
import { remoteAcpStore } from "../../stores/remoteAcp";
import s from "./AIChatPanel.module.css";
import { Interactions } from "./Interactions";

export const RemoteInteractions = () => (
	<For each={Object.entries(remoteAcpStore.state.entries)}>
		{([key, entry]) => (
			<section aria-label={`Remote AI Chat: ${entry.name}`}>
				<div class={s.approvalText}>
					[{entry.name}] {entry.connectionId}
				</div>
				<Interactions
					interactions={() => entry.interactions}
					onPermission={(id, optionId) =>
						void remoteAcpStore.answerPermission(key, id, { outcome: "selected", optionId })
					}
					onPermissionDismissed={(id) => void remoteAcpStore.answerPermission(key, id, { outcome: "cancelled" })}
					onElicitationAccepted={(id, content) =>
						void remoteAcpStore.answerElicitation(key, id, { action: "accept", content })
					}
					onElicitationDeclined={(id) => void remoteAcpStore.answerElicitation(key, id, { action: "decline" })}
					onElicitationCancelled={(id) => void remoteAcpStore.answerElicitation(key, id, { action: "cancel" })}
				/>
			</section>
		)}
	</For>
);
