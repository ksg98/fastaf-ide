import { filePathRegex, fileUrlRegex, matchWebUrls } from "../../components/Terminal/linkProvider";

import { parseTuicFilePath } from "../../utils/tuicFilePath";

export interface OutputLink {
	start: number;
	end: number;
	text: string;
	kind: "web" | "markdown";
	candidate?: string;
	line?: number;
}

const MARKDOWN_PATH = /\.md(?::\d+(?::\d+)?)?$/i;
const TUIC_OPEN_URL = /\btuic:\/\/open\/[^\s"'`<>()[\]{}]+/g;

function lineFrom(path: string): number | undefined {
	const number = path.match(/:([1-9]\d*)(?::\d+)?$/)?.[1];
	if (!number) return undefined;
	const line = Number(number);
	return Number.isSafeInteger(line) ? line : undefined;
}

function trimSentenceTail(value: string): string {
	return value.replace(/[.,;!?]+$/, "");
}

/** Use the desktop terminal's detectors; only Markdown paths become file controls. */
export function detectOutputLinks(text: string): OutputLink[] {
	const matches: OutputLink[] = [];
	for (const url of matchWebUrls(text)) {
		matches.push({ start: url.index, end: url.index + url.text.length, text: url.text, kind: "web" });
	}

	for (const match of text.matchAll(TUIC_OPEN_URL)) {
		const label = trimSentenceTail(match[0]);
		try {
			const parsed = new URL(label);
			const candidate = parseTuicFilePath(parsed.pathname);
			if (!MARKDOWN_PATH.test(candidate)) continue;
			const queryLine = Number(parsed.searchParams.get("line"));
			matches.push({
				start: match.index,
				end: match.index + label.length,
				text: label,
				kind: "markdown",
				candidate,
				line: Number.isSafeInteger(queryLine) && queryLine > 0 ? queryLine : lineFrom(candidate),
			});
		} catch {
			// Malformed deep links remain plain terminal text.
		}
	}

	for (const match of text.matchAll(fileUrlRegex())) {
		const label = trimSentenceTail(match[0]);
		const candidate = label.slice("file://".length);
		if (MARKDOWN_PATH.test(candidate)) {
			matches.push({
				start: match.index,
				end: match.index + label.length,
				text: label,
				kind: "markdown",
				candidate,
				line: lineFrom(candidate),
			});
		}
	}

	for (const match of text.matchAll(filePathRegex())) {
		const candidate = match[1];
		if (!MARKDOWN_PATH.test(candidate)) continue;
		const start = match.index + match[0].indexOf(candidate);
		matches.push({
			start,
			end: start + candidate.length,
			text: candidate,
			kind: "markdown",
			candidate,
			line: lineFrom(candidate),
		});
	}

	// Full URLs begin before their embedded path. Keep one control for the whole
	// printed reference, rather than a second path control inside it.
	matches.sort((a, b) => a.start - b.start || b.end - a.end);
	const accepted: OutputLink[] = [];
	for (const match of matches) {
		if (match.start >= (accepted.at(-1)?.end ?? 0)) accepted.push(match);
	}
	return accepted;
}
