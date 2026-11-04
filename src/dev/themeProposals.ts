/**
 * Proposed theme edits, shown by the theme gallery next to the shipped theme.
 *
 * Each entry is a partial override merged over the shipped JSON: `appChrome`
 * keys over `appChrome`, every other key over the top-level ANSI/terminal
 * colors. The shipped files in src-tauri/src/themes/ stay untouched until a
 * proposal is accepted and copied into them. Vite HMR repaints the gallery
 * when this file changes.
 */
export interface ThemeProposal {
	/** Why the theme changes, shown above the proposed card. */
	note: string;
	/** Proposed for deletion from the bundled set. */
	remove?: boolean;
	appChrome?: Record<string, string>;
	colors?: Record<string, string>;
}

// The 2026-09-22 review was applied to the shipped themes; its state before
// the edits is kept in docs/design/theme-gallery-2026-09-22/.
export const THEME_PROPOSALS: Record<string, ThemeProposal> = {};
