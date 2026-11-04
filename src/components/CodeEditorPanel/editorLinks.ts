import { filePathRegex, matchWebUrls } from "../Terminal/linkProvider";

export interface EditorLink {
	from: number;
	to: number;
	target: string;
	web: boolean;
}

/** Find the link under a CodeMirror document offset, using the terminal's path
 * and URL recognition. Markdown labels and targets share one clickable range. */
export function editorLinkAt(line: string, column: number): EditorLink | null {
	const markdown = /\[([^\]\n]+)\]\(([^\s)]+)\)/g;
	let match: RegExpExecArray | null;
	while ((match = markdown.exec(line)) !== null) {
		if (column >= match.index && column < match.index + match[0].length) {
			return {
				from: match.index,
				to: match.index + match[0].length,
				target: match[2],
				web: /^https?:\/\//i.test(match[2]),
			};
		}
	}
	for (const url of matchWebUrls(line)) {
		if (column >= url.index && column < url.index + url.text.length) {
			return { from: url.index, to: url.index + url.text.length, target: url.text, web: true };
		}
	}
	const paths = filePathRegex();
	while ((match = paths.exec(line)) !== null) {
		const from = line.indexOf(match[1], match.index);
		if (column >= from && column < from + match[1].length) {
			return { from, to: from + match[1].length, target: match[1], web: false };
		}
	}
	return null;
}
