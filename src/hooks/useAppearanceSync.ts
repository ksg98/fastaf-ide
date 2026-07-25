import { createEffect } from "solid-js";
import { settingsStore } from "../stores/settings";
import { applyAppTheme, applyFontFamily, themesLoaded } from "../themes";

/** Synchronizes reactive appearance settings with document-level CSS and theme state. */
export function useAppearanceSync(): void {
	createEffect(() => {
		const theme = settingsStore.state.theme;
		if (themesLoaded()) applyAppTheme(theme);
	});
	createEffect(() => applyFontFamily(settingsStore.state.font));
}
