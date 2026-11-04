/** Browser layout regression: real transcript/composers, inert session transport.
 * Inputs exercise rendering boundaries; no ACP service or PTY is simulated. */
import { render } from "solid-js/web";
import { Composer } from "../../components/AIChatPanel/Composer";
import { Transcript } from "../../components/AIChatPanel/Transcript";
import { createAcpChat } from "../../components/AIChatPanel/useAcpChat";
import type { AcpTranscriptEntry } from "../../stores/acpTranscript";
import { CommandInput } from "../components/CommandInput";
import screen from "../screens/MobileChatScreen.module.css";
import "../mobile.css";

const long = "repository_path_with_a_very_long_unbroken_token_".repeat(8);
const entries: AcpTranscriptEntry[] = [
	{ id: "user", kind: "user", text: "Check the mobile layout" },
	{ id: "tool", kind: "tool", call: { toolCallId: "layout", title: `search_tools ${long}`, status: "completed" } },
	{
		id: "agent",
		kind: "agent",
		text: `intent: Checking the phone layout (Layout check)\n\nCode and long content remain readable.\n\n\`\`\`ts\nconst path = "${long}";\n\`\`\`\n\n| Path | Status |\n| --- | --- |\n| ${long} | Complete |\n\nsuggest: [ Write code | Inspect ${long} | Answer questions ]`,
	},
];
const root = document.getElementById("mobile-app");
if (!root) throw new Error("Missing fixture root");
root.style.height = "100dvh";
render(() => {
	const chat = createAcpChat(
		() => null,
		() => true,
	);
	const session = new URLSearchParams(location.search).get("view") === "session";
	return (
		<section class={screen.screen} aria-label={session ? "Session chat" : "AI Chat"}>
			<header class={screen.header}>
				<strong>{session ? "Session chat" : "AI Chat"}</strong>
			</header>
			<Transcript mobile entries={() => entries} busy={() => false} emptyMessage="" onSuggestion={() => {}} />
			{session ? (
				<CommandInput sessionId="layout-only" sessionExists={false} />
			) : (
				<Composer chat={chat} mobileAttachments />
			)}
		</section>
	);
}, root);
