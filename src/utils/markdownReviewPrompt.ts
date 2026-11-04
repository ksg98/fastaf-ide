/** The review contract shared by desktop and mobile Markdown views. */
export function buildMarkdownReviewPrompt(path: string, count: number): string {
	const noun = count === 1 ? "comment" : "comments";
	const tweaks = count > 0 ? `apply the ${count} embedded tweak review ${noun}, ` : "";
	const cleanup = count > 0 ? "remove each resolved tweak marker, and leave" : "and leave";
	return `Open ${path.replace(/[\r\n\0]/g, "")}, re-read the whole file: ${tweaks}treat every other change since your last write (checkbox toggles, edited text) as the user's answer, ${cleanup} unrelated files unchanged.`;
}
