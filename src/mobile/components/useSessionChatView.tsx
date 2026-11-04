import { createEffect, createSignal, Show } from "solid-js";
import type { AgentType } from "../../agents";
import { TerminalChatTranscript } from "../../components/Terminal/TerminalChatTranscript";
import { SegmentedControl } from "../../components/ui";
import { type ChatViewWake, chatViewStore, supportsTerminalChatView } from "../../stores/chatView";
import { mobileChatReadingStyle } from "../mobileFontSize";
import styles from "./SessionChatView.module.css";

/** Mode belongs to a PTY, not to its polled SessionInfo object. */
const modes = new Map<string, "cli" | "chat">();
export function useSessionChatView(props: {
	sessionId: () => string;
	agentType: () => string | undefined;
	sessionExists: () => boolean;
	busy?: () => boolean;
	awaitingInput?: () => boolean;
	activityRevision?: () => string | number | null | undefined;
	subscribeWake: ChatViewWake;
}) {
	const [atBottom, setAtBottom] = createSignal(true);
	let jump: (() => void) | undefined;
	const [mode, setMode] = createSignal<"cli" | "chat">(modes.get(props.sessionId()) ?? "cli");
	createEffect(() => setMode(modes.get(props.sessionId()) ?? "cli"));
	const select = (next: "cli" | "chat") => {
		modes.set(props.sessionId(), next);
		setMode(next);
	};
	// SessionInfo has no transcript binding: chat_view_snapshot remains the authority.
	const available = () => supportsTerminalChatView(props.agentType()) && props.sessionExists();
	createEffect(() => {
		if (mode() === "chat" && !available()) {
			chatViewStore.markUnavailable(props.sessionId(), "No agent is running in this terminal");
			select("cli");
		}
	});
	const active = () => mode() === "chat" && available();
	const openChat = () => {
		chatViewStore.clearUnavailable(props.sessionId());
		select("chat");
	};
	const Toggle = () => (
		<Show when={available()}>
			<SegmentedControl
				class={styles.toggle}
				aria-label="Terminal view"
				options={[
					{ id: "cli", label: "CLI" },
					{ id: "chat", label: "Chat" },
				]}
				value={active() ? "chat" : "cli"}
				onChange={(value) => (value === "chat" ? openChat() : select("cli"))}
			/>
		</Show>
	);
	const View = () => (
		<>
			<Show when={!active() && chatViewStore.unavailableReason(props.sessionId())}>
				{(reason) => (
					<div class={styles.notice} role="status">
						Chat view closed: {reason()}
					</div>
				)}
			</Show>
			<Show when={active() && props.sessionId()} keyed>
				{(sessionId) => (
					<div class={styles.reading} data-mobile-reading style={mobileChatReadingStyle()}>
						<TerminalChatTranscript
							sessionId={sessionId}
							busy={props.busy?.()}
							awaitingInput={props.awaitingInput?.()}
							activityRevision={props.activityRevision?.()}
							terminalAgent={props.agentType() as AgentType}
							mobile
							onAtBottomChange={setAtBottom}
							onRegisterScrollToBottom={(fn) => {
								jump = fn;
								setAtBottom(true);
							}}
							subscribeWake={props.subscribeWake}
							onUnavailable={() => select("cli")}
						/>
					</div>
				)}
			</Show>
		</>
	);
	return { active, available, openChat, Toggle, View, atBottom, scrollToBottom: () => jump?.() };
}
