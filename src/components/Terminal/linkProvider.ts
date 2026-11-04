/** Known source/config/doc extensions — used in the path regex boundary. */
export const CODING_EXT =
	"rs|ts|tsx|js|jsx|mjs|cjs|py|go|java|kt|kts|swift|c|h|cpp|hpp|cc|cs|rb|php|lua|zig|nim|ex|exs|erl|hs|ml|mli|fs|fsx|scala|clj|cljs|r|R|jl|dart|v|sv|vhdl|sol|move|css|scss|sass|less|html|htm|vue|svelte|astro|json|jsonc|json5|yaml|yml|toml|ini|cfg|conf|env|xml|plist|csv|tsv|sql|graphql|gql|proto|thrift|avsc|md|mdx|txt|rst|tex|adoc|org|sh|bash|zsh|fish|ps1|psm1|bat|cmd|dockerfile|containerfile|tf|tfvars|hcl|nix|cmake|make|mk|gradle|sbt|cabal|gemspec|podspec|lock|sum|mod|workspace|editorconfig|gitignore|gitattributes|dockerignore|eslintrc|prettierrc|babelrc|nvmrc|tool-versions|pdf|png|jpg|jpeg|gif|webp|svg|avif|ico|bmp|mp4|webm|mov|ogg|mp3|wav|flac|aac|m4a|log";

/** Box-drawing block, as a regex class fragment: an agent TUI glues its panel borders to the text. */
const BOX_DRAWING = "\\u2500-\\u257F";

/** Factory — returns a fresh RegExp (has lastIndex state, not safe to share). */
export function filePathRegex(): RegExp {
	return new RegExp(
		`(?:^|[\\s"'\`(\\[{${BOX_DRAWING}])` +
			// Each form takes `:line`, `:line:col`, or a `:start-end` line range (agents cite ranges).
			`((?:[A-Za-z]:[\\\\/][\\w.\\\\/@-]+(?::\\d+(?::\\d+|-\\d+)?)?` +
			`|(?:~/|/|\\.\\.?/|[\\w@.-]+/)[\\w./@-]+(?::\\d+(?::\\d+|-\\d+)?)?` +
			`|[\\w@.-]+\\.(?:${CODING_EXT})(?::\\d+(?::\\d+|-\\d+)?)?))` +
			// Exclude sentence periods, but keep a final parent-directory segment.
			`(?:(?<!\\.)|(?<=[/\\\\]\\.\\.))(?=[\\s"'\`),;.!?:\\]}>${BOX_DRAWING}]|$)`,
		"g",
	);
}

/** A file path found in a row of terminal text. `text` is what the row shows
 *  (the span to underline and hit-test); `candidate` is what to resolve on
 *  disk — the same string with shell backslash-escapes removed. */
export interface FilePathMatch {
	index: number;
	text: string;
	candidate: string;
}

/** Where a path that may hold spaces can begin: an absolute or `~/` path after
 *  the same boundary characters `filePathRegex` accepts. */
const SPACED_PATH_START_SOURCE = `(?:^|[\\s"'\`([{${BOX_DRAWING}])(~/|/)`;
/** A known extension plus optional `:line[:col|-end]`, then a boundary. */
const PATH_END_SOURCE = `\\.(?:${CODING_EXT})(?::\\d+(?::\\d+|-\\d+)?)?(?=[\\s"'\`),;.!?:\\]}>${BOX_DRAWING}]|$)`;
/** `"…"`, `'…'` or a backticked path holding at least one space. */
const QUOTED_PATH_SOURCE = `(["'\`])([^"'\`\\n]*\\s[^"'\`\\n]*?\\.(?:${CODING_EXT})(?::\\d+(?::\\d+|-\\d+)?)?)\\1`;
/** Past these a "path" is prose: no real file name runs this long or this spaced. */
const SPACED_PATH_MAX_LEN = 300;
const SPACED_PATH_MAX_SPACES = 10;

/**
 * Every file path candidate in `text`, for the resolver to confirm or drop.
 *
 * `filePathRegex` stops at a space, so `Screenshot 2026-10-19 at 9.41.02 PM.png`
 * — the name macOS gives every screenshot — came out as `PM.png`, which never
 * resolves, and no image path with a space ever became a link. On top of its
 * matches this offers, for each absolute or `~/` path, every stretch up to a
 * known extension that holds a space (`/a/My File.png`, escaped `/a/My\ File.png`),
 * plus quoted paths with spaces. Spaces make that ambiguous — `/a/x.png and
 * /b/y.png` is also one stretch — so a candidate is only a guess: the caller
 * shows it as a link once `resolve_terminal_path(s)` finds it on disk.
 *
 * Sorted by position, longest first at a shared start, so the first match that
 * covers a column is the most complete one.
 */
export function matchFilePaths(text: string): FilePathMatch[] {
	const found: FilePathMatch[] = [];
	const seen = new Set<string>();
	const add = (index: number, span: string) => {
		const key = `${index}:${span.length}`;
		if (seen.has(key)) return;
		seen.add(key);
		found.push({ index, text: span, candidate: span.includes("\\") ? span.replace(/\\(.)/g, "$1") : span });
	};

	const plain = filePathRegex();
	let m: RegExpExecArray | null;
	while ((m = plain.exec(text)) !== null) add(text.indexOf(m[1], m.index), m[1]);

	const starts = new RegExp(SPACED_PATH_START_SOURCE, "g");
	const end = new RegExp(PATH_END_SOURCE, "g");
	while ((m = starts.exec(text)) !== null) {
		const start = m.index + m[0].length - m[1].length;
		end.lastIndex = start;
		let e: RegExpExecArray | null;
		while ((e = end.exec(text)) !== null) {
			const span = text.slice(start, e.index + e[0].length);
			// Two spaces in a row, a tab or a quote mark is column layout or prose.
			if (span.length > SPACED_PATH_MAX_LEN || /\s{2}|\t|["'`]/.test(span)) break;
			if ((span.match(/ /g)?.length ?? 0) > SPACED_PATH_MAX_SPACES) break;
			if (/[ \\]/.test(span)) add(start, span);
		}
	}

	const quoted = new RegExp(QUOTED_PATH_SOURCE, "g");
	while ((m = quoted.exec(text)) !== null) add(m.index + 1, m[2]);

	return found.sort((a, b) => a.index - b.index || b.text.length - a.text.length);
}

/** True when the whole text, ignoring surrounding whitespace, is a single file path. */
export function isWholeFilePath(text: string): boolean {
	const trimmed = text.trim();
	return [...trimmed.matchAll(filePathRegex())].some((match) => match[1] === trimmed);
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
