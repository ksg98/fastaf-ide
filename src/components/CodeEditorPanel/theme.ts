import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { tags } from "@lezer/highlight";

/** CodeMirror 6 theme using the app's CSS variables for consistent look */
const editorTheme = EditorView.theme(
	{
		"&": {
			width: "100%",
			height: "100%",
			fontSize: "13px",
		},
		".cm-scroller": {
			fontFamily: "var(--font-mono)",
			overflow: "auto",
			// Kill the macOS elastic rubber-band on horizontal overscroll — without this,
			// hitting the left edge bounces the whole scroller and drags the sticky
			// line-number gutter along with it.
			overscrollBehaviorX: "none",
		},
		// Scrollbar inherits the global ::-webkit-scrollbar rule (global.css) — single
		// source of truth shared with the sidebar, markdown preview and panels.
		".cm-content": {
			caretColor: "var(--accent)",
			padding: "8px 0",
		},
		".cm-cursor, .cm-dropCursor": {
			borderLeftColor: "var(--accent)",
		},
		"&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
			backgroundColor: "rgba(var(--accent-rgb), 0.2)",
		},
		".cm-activeLine": {
			backgroundColor: "var(--surface-hover)",
		},
		// Seamless Cursor-style gutter — same bg as the editor, no vertical divider.
		".cm-gutters": {
			backgroundColor: "var(--bg-primary)",
			color: "var(--fg-muted)",
			border: "none",
		},
		".cm-activeLineGutter": {
			backgroundColor: "var(--surface-hover)",
			color: "var(--fg-secondary)",
		},
		".cm-lineNumbers .cm-gutterElement": {
			padding: "0 8px 0 16px",
			minWidth: "3ch",
		},
		".cm-matchingBracket": {
			backgroundColor: "rgba(var(--accent-rgb), 0.25)",
			outline: "1px solid rgba(var(--accent-rgb), 0.5)",
		},
		".cm-searchMatch": {
			backgroundColor: "rgba(224, 175, 104, 0.3)",
		},
		".cm-searchMatch.cm-searchMatch-selected": {
			backgroundColor: "rgba(224, 175, 104, 0.5)",
		},
		// CodeMirror's default selection-match highlight is a bright yellow-green that
		// clashes with the orange search marks (it lights up every occurrence of the
		// selected word). Tone it down to a subtle accent tint.
		".cm-selectionMatch": {
			backgroundColor: "rgba(var(--accent-rgb), 0.15)",
		},
		// Autocomplete/hover popups adopt the app's glass overlay recipe so they
		// collapse to opaque when vibrancy is off and pick up the shared shadow.
		".cm-tooltip": {
			background: "var(--surface-overlay)",
			backdropFilter: "var(--blur-overlay)",
			WebkitBackdropFilter: "var(--blur-overlay)",
			border: "1px solid var(--border-subtle)",
			borderRadius: "var(--radius-lg)",
			boxShadow: "var(--highlight-inset), var(--shadow-dropdown)",
			color: "var(--fg-primary)",
		},
		/* Search/replace panel */
		".cm-panels": {
			backgroundColor: "var(--bg-secondary)",
			color: "var(--fg-primary)",
			borderTop: "1px solid var(--border)",
		},
		".cm-panels.cm-panels-bottom": {
			borderTop: "1px solid var(--border)",
			borderBottom: "none",
		},
		".cm-panels.cm-panels-top": {
			borderBottom: "1px solid var(--border)",
			borderTop: "none",
		},
		".cm-search": {
			padding: "4px 8px",
			gap: "4px",
			fontSize: "var(--font-sm)",
			fontFamily: "var(--font-ui)",
		},
		".cm-search label": {
			fontSize: "var(--font-xs)",
			color: "var(--fg-secondary)",
		},
		".cm-textfield": {
			backgroundColor: "var(--bg-tertiary)",
			border: "1px solid var(--border)",
			borderRadius: "var(--radius-sm)",
			color: "var(--fg-primary)",
			fontFamily: "var(--font-mono)",
			fontSize: "var(--font-sm)",
			outline: "none",
			padding: "2px 6px",
		},
		".cm-textfield:focus": {
			borderColor: "var(--accent)",
		},
		".cm-button": {
			backgroundColor: "var(--bg-tertiary)",
			border: "1px solid var(--border)",
			borderRadius: "var(--radius-sm)",
			color: "var(--fg-secondary)",
			fontSize: "var(--font-xs)",
			cursor: "pointer",
			padding: "2px 8px",
			backgroundImage: "none",
		},
		".cm-button:hover": {
			backgroundColor: "var(--bg-highlight)",
			color: "var(--fg-primary)",
		},
		".cm-button:active": {
			backgroundImage: "none",
		},
	},
	{ dark: true },
);

/** Syntax highlighting colors */
const highlightStyle = HighlightStyle.define([
	{ tag: tags.keyword, color: "#bb9af7" },
	{ tag: tags.controlKeyword, color: "#bb9af7" },
	{ tag: tags.operator, color: "#89ddff" },
	{ tag: tags.punctuation, color: "#a9b1d6" },
	{ tag: tags.string, color: "#9ece6a" },
	{ tag: tags.regexp, color: "#e0af68" },
	{ tag: tags.number, color: "#ff9e64" },
	{ tag: tags.bool, color: "#ff9e64" },
	{ tag: tags.null, color: "#ff9e64" },
	{ tag: tags.comment, color: "#565f89", fontStyle: "italic" },
	{ tag: tags.lineComment, color: "#565f89", fontStyle: "italic" },
	{ tag: tags.blockComment, color: "#565f89", fontStyle: "italic" },
	{ tag: tags.function(tags.variableName), color: "#7aa2f7" },
	{ tag: tags.definition(tags.variableName), color: "#c0caf5" },
	{ tag: tags.variableName, color: "#c0caf5" },
	{ tag: tags.typeName, color: "#2ac3de" },
	{ tag: tags.className, color: "#2ac3de" },
	{ tag: tags.propertyName, color: "#73daca" },
	{ tag: tags.tagName, color: "#f7768e" },
	{ tag: tags.attributeName, color: "#bb9af7" },
	{ tag: tags.heading, color: "#7aa2f7", fontWeight: "bold" },
	{ tag: tags.emphasis, fontStyle: "italic" },
	{ tag: tags.strong, fontWeight: "bold" },
	{ tag: tags.link, color: "#7aa2f7", textDecoration: "underline" },
]);

/** Combined theme extension for the code editor */
export const codeEditorTheme: Extension = [editorTheme, syntaxHighlighting(highlightStyle)];
