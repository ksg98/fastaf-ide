import { ANSWER_MARKER_RE } from "../components/Terminal/suggestOverlay";

/** Match the rendered answer prefixes, not emoji used inside prose or fenced examples. */
export function stripAnswerMarkers(text: string): string {
	let fence: string | null = null;
	return text
		.split(/(\r?\n)/)
		.map((line) => {
			const delimiter = /^[ \t]*(`{3,}|~{3,})/.exec(line)?.[1];
			if (delimiter) {
				if (!fence) fence = delimiter;
				else if (delimiter[0] === fence[0] && delimiter.length >= fence.length && /^[ \t]*(`+|~+)[ \t]*$/.test(line))
					fence = null;
				return line;
			}
			if (fence) return line;
			const prefix = ANSWER_MARKER_RE.exec(line)?.[0];
			if (!prefix) return line;
			return prefix.slice(0, -"💬".length) + line.slice(prefix.length).replace(/^[ \t]+/, "");
		})
		.join("");
}
