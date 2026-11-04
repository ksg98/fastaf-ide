import { invoke } from "../invoke";
import { applyAppTheme, loadThemes, themesLoaded } from "../themes";

export type MobileTheme = "commander" | "vscode-light";

let currentTheme: MobileTheme = "commander";

function supportedTheme(value: unknown): MobileTheme {
	return value === "vscode-light" ? "vscode-light" : "commander";
}

export function mobileTheme(): MobileTheme {
	return currentTheme;
}

export async function loadMobileTheme(): Promise<MobileTheme> {
	const [prefs] = await Promise.all([
		invoke<Record<string, unknown>>("load_ui_prefs"),
		themesLoaded() ? Promise.resolve() : loadThemes(),
	]);
	currentTheme = supportedTheme(prefs.mobile_theme);
	applyAppTheme(currentTheme, false);
	return currentTheme;
}

export async function setMobileTheme(theme: MobileTheme): Promise<void> {
	const base = await invoke<Record<string, unknown>>("load_ui_prefs");
	await invoke("save_ui_prefs", { base, config: { ...base, mobile_theme: theme } });
	currentTheme = theme;
	applyAppTheme(theme, false);
}
