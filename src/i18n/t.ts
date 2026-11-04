import { createSignal } from "solid-js";
import en from "./en.json";

const [locale, setLocale] = createSignal("en");

/**
 * Message catalogs by locale code. `en.json` is generated from the call sites,
 * so an English lookup returns the same text the fallback already carries.
 * A locale with no catalog renders the fallbacks.
 */
const catalogs: Record<string, Record<string, string>> = { en };

export { locale, setLocale };

/**
 * Locale codes the UI may offer, derived from the catalogs above so that adding
 * a catalog is the only step needed to make a language selectable. A code with
 * no catalog is not offered: it would render the English fallbacks and so lie
 * about being translated.
 */
export const AVAILABLE_LOCALES: string[] = Object.keys(catalogs).sort();

/**
 * The name of a language written in that language ("Français", not "French"),
 * which is how a speaker finds their own entry in a list. Falls back to the raw
 * code when the runtime cannot name it.
 */
export function localeName(code: string): string {
	try {
		return new Intl.DisplayNames([code], { type: "language" }).of(code) ?? code;
	} catch {
		return code;
	}
}

export function t(key: string, fallback: string, params?: Record<string, string>): string {
	// Reading locale() here is what makes every t() call site re-render on a
	// language change.
	const message = catalogs[locale()]?.[key];
	let str = typeof message === "string" ? message : fallback;
	if (params) {
		for (const [k, v] of Object.entries(params)) {
			str = str.replace(new RegExp(`\\{${k}\\}`, "g"), v);
		}
	}
	return str;
}
