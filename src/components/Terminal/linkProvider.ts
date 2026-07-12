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
