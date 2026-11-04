import { createContext, type JSX, useContext } from "solid-js";
import inventory from "./contextualHelp.json";
import { InfoBadge } from "./InfoBadge";

const aliases: Record<string, Record<string, string>> = {
	voice: {
		"whisper model": "Whisper models",
		"voice tuning": "Test recording",
		"manage pocket tts voices": "Pocket TTS voices",
	},
};
const HelpPage = createContext<string>();
export function SettingsHelpScope(props: { page: string; children: JSX.Element }) {
	return <HelpPage.Provider value={props.page}>{props.children}</HelpPage.Provider>;
}

/** Match only approved labels in the current page, never infer help from a default. */
export function contextualHelp(page: string | undefined, label: string, hint?: string): string | undefined {
	if (!page) return undefined;
	const canonical = aliases[page]?.[label.toLowerCase()] ?? label;
	const entry = inventory.find((item) => item.page === page && item.label.toLowerCase() === canonical.toLowerCase());
	return entry && entry.text.trim() !== hint?.trim() ? entry.text : undefined;
}

export function ContextualHelp(props: { label: string; hint?: string }) {
	const page = useContext(HelpPage);
	const text = () => contextualHelp(page, props.label, props.hint);
	return <>{text() && <InfoBadge label={`Explain ${props.label}`}>{text()}</InfoBadge>}</>;
}
