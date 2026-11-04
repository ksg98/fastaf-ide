/** Browser presentation/interaction fixture. Synthetic recognition and PTY sink;
 * this does not prove microphone capture or Claude's native composer behavior. */
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { Transcript } from "../../components/AIChatPanel/Transcript";
import type { AcpTranscriptEntry } from "../../stores/acpTranscript";
import { CommandInput } from "../components/CommandInput";
import { TerminalKeybar } from "../components/TerminalKeybar";
import { clearDictationPartial } from "../utils/dictationPartial";
import "../mobile.css";

clearDictationPartial("dictation-evidence");

const sentence = "OMB è un assistente, un bot manager installato su Mac-mint.";
class Recognition {
	static current: Recognition;
	onresult: ((event: { results: { 0: { transcript: string }; isFinal: boolean }[] }) => void) | null = null;
	onend: (() => void) | null = null;
	constructor() {
		Recognition.current = this;
	}
	start() {}
	stop() {
		this.onend?.();
	}
	abort() {
		this.onend?.();
	}
}
Object.assign(window, {
	SpeechRecognition: Recognition,
	__dictationEvidence: {
		speak: () => {
			Recognition.current.onresult?.({ results: [{ 0: { transcript: sentence }, isFinal: true }] });
			Recognition.current.onend?.();
		},
	},
});
const [entries, setEntries] = createSignal<AcpTranscriptEntry[]>([
	{
		id: "command",
		kind: "user",
		text: `<command-message>wiz:work</command-message>\n<command-name>/wiz:work</command-name>\n<command-args>${sentence}</command-args>`,
	},
]);
let remoteDraft = "/wiz:work ";
const originalFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
	const path = new URL(String(input), location.href).pathname;
	if (path === "/dictation/config") return Response.json({ language: "it" });
	if (path === "/sessions/dictation-evidence/write") {
		const { data } = JSON.parse(String(init?.body));
		for (const char of data) {
			if (char === "\r") {
				setEntries((previous) => [...previous, { id: "dictated", kind: "user", text: remoteDraft }]);
				remoteDraft = "";
			} else if (char === "\x7f") remoteDraft = remoteDraft.slice(0, -1);
			else remoteDraft += char;
		}
		return Response.json({});
	}
	return originalFetch(input, init);
};
render(() => {
	let insert: ((text: string) => void) | undefined;
	return (
		<section style={{ height: "100dvh", display: "flex", "flex-direction": "column" }}>
			<header style={{ padding: "12px" }}>Mobile Chat — synthetic dictation check</header>
			<div style={{ flex: "1", "min-height": "0" }}>
				<Transcript
					terminalAgent="claude"
					mobile
					entries={entries}
					busy={() => false}
					emptyMessage=""
					observeToolDuration={false}
				/>
			</div>
			<TerminalKeybar sessionId="dictation-evidence" onSlashRequest={() => insert?.("/")} />
			<CommandInput
				sessionId="dictation-evidence"
				agentType="claude"
				ptyInputLine="/wiz:work "
				onRegisterInsertText={(fn) => {
					insert = fn;
				}}
			/>
		</section>
	);
}, document.getElementById("mobile-app")!);
