/** Known source/config/doc extensions — used in the path regex boundary. */
export const CODING_EXT =
	"rs|ts|tsx|js|jsx|mjs|cjs|py|go|java|kt|kts|swift|c|h|cpp|hpp|cc|cs|rb|php|lua|zig|nim|ex|exs|erl|hs|ml|mli|fs|fsx|scala|clj|cljs|r|R|jl|dart|v|sv|vhdl|sol|move|css|scss|sass|less|html|htm|vue|svelte|astro|json|jsonc|json5|yaml|yml|toml|ini|cfg|conf|env|xml|plist|csv|tsv|sql|graphql|gql|proto|thrift|avsc|md|mdx|txt|rst|tex|adoc|org|sh|bash|zsh|fish|ps1|psm1|bat|cmd|dockerfile|containerfile|tf|tfvars|hcl|nix|cmake|make|mk|gradle|sbt|cabal|gemspec|podspec|lock|sum|mod|workspace|editorconfig|gitignore|gitattributes|dockerignore|eslintrc|prettierrc|babelrc|nvmrc|tool-versions|pdf|png|jpg|jpeg|gif|webp|svg|avif|ico|bmp|mp4|webm|mov|ogg|mp3|wav|flac|aac|m4a|log";

/** Factory — returns a fresh RegExp (has lastIndex state, not safe to share). */
export function filePathRegex(): RegExp {
	return new RegExp(
		`(?:^|[\\s"'\`(\\[{])` +
			`((?:(?:~/|/|\\.\\.?/|[\\w@.-]+/)` +
			`[\\w./@-]*` +
			`|[\\w@.-]+)` +
			`\\.(?:${CODING_EXT})` +
			`(?::\\d+(?::\\d+)?)?)` +
			`(?=[\\s"'\`),;.!?:\\]}>]|$)`,
		"g",
	);
}

/** Factory — returns a fresh file:// URL regex. */
export function fileUrlRegex(): RegExp {
	return /\bfile:\/\/(\/[^\s"'`<>()[\]{}]+)/g;
}

/** Factory — returns a fresh http/https URL regex. */
export function webUrlRegex(): RegExp {
	return /https?:\/\/[^\s<>"{}|\\^`[\]]+/g;
}

/** Punctuation that ends a sentence rather than a URL. A terminal prints URLs
 *  inside prose — `see http://host:5000, then …` — and every one of these is
 *  legal in a URL, so the greedy match swallows it and `new URL()` then rejects
 *  the whole thing as malformed. The click silently did nothing. */
const SENTENCE_TAIL = new Set([".", ",", ";", ":", "!", "?", "'"]);

/** Drop trailing punctuation the surrounding sentence owns, not the URL.
 *  `)` is kept when the URL opened it — wiki links carry balanced parens. */
function trimUrlTail(url: string): string {
	let end = url.length;
	while (end > 0) {
		const last = url[end - 1];
		if (SENTENCE_TAIL.has(last)) {
			end--;
			continue;
		}
		if (last === ")") {
			const body = url.slice(0, end);
			const opened = body.split("(").length - 1;
			const closed = body.split(")").length - 1;
			if (closed > opened) {
				end--;
				continue;
			}
		}
		break;
	}
	return url.slice(0, end);
}

/** Every http/https URL in `text`, with sentence punctuation trimmed off.
 *  Single source of truth so the underlined span and the URL the click opens
 *  can never disagree. */
export function matchWebUrls(text: string): { text: string; index: number }[] {
	const re = webUrlRegex();
	const found: { text: string; index: number }[] = [];
	let match: RegExpExecArray | null;
	while ((match = re.exec(text)) !== null) {
		const trimmed = trimUrlTail(match[0]);
		// Trimming can leave a bare scheme (`http://,`) — that is not a link.
		if (/^https?:\/\/[^/]/.test(trimmed)) found.push({ text: trimmed, index: match.index });
	}
	return found;
}
