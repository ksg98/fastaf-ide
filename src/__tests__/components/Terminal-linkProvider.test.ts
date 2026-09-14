import { describe, expect, it } from "vitest";
import { CODING_EXT, filePathRegex, fileUrlRegex, matchWebUrls } from "../../components/Terminal/linkProvider";

describe("linkProvider regexes", () => {
	describe("filePathRegex", () => {
		function matchAll(text: string): string[] {
			const re = filePathRegex();
			const results: string[] = [];
			let m: RegExpExecArray | null;
			while ((m = re.exec(text)) !== null) results.push(m[1]);
			return results;
		}

		it("matches absolute paths", () => {
			expect(matchAll("open /usr/local/bin/test.rs")).toEqual(["/usr/local/bin/test.rs"]);
		});

		it("matches relative ./ paths", () => {
			expect(matchAll("edit ./src/main.ts")).toEqual(["./src/main.ts"]);
		});

		it("matches relative ../ paths", () => {
			expect(matchAll("see ../lib/utils.py")).toEqual(["../lib/utils.py"]);
		});

		it("matches ~/ home paths", () => {
			expect(matchAll("cat ~/Documents/notes.md")).toEqual(["~/Documents/notes.md"]);
		});

		it("matches word/ relative paths", () => {
			expect(matchAll("src/components/App.tsx is the entry")).toEqual(["src/components/App.tsx"]);
		});

		it("matches :line suffix", () => {
			expect(matchAll("error at /app/main.go:42")).toEqual(["/app/main.go:42"]);
		});

		it("matches :line:col suffix", () => {
			expect(matchAll("/src/index.ts:10:5 error")).toEqual(["/src/index.ts:10:5"]);
		});

		it("matches multiple paths in one line", () => {
			expect(matchAll("/a/b.rs and ./c/d.py")).toEqual(["/a/b.rs", "./c/d.py"]);
		});

		it("matches bare filenames with known extensions", () => {
			expect(matchAll("main.rs")).toEqual(["main.rs"]);
			expect(matchAll("README.md")).toEqual(["README.md"]);
			expect(matchAll("package.json")).toEqual(["package.json"]);
		});

		it("matches bare filenames inside parens (Claude Code output)", () => {
			expect(matchAll("Write(README.md)")).toEqual(["README.md"]);
			expect(matchAll("Edit(src/lib.rs)")).toEqual(["src/lib.rs"]);
			expect(matchAll("Read(docs/architecture.md)")).toEqual(["docs/architecture.md"]);
		});

		it("does not match bare words without known extensions", () => {
			expect(matchAll("hello world")).toEqual([]);
			expect(matchAll("version 2")).toEqual([]);
		});

		it("matches paths with @ in segments", () => {
			expect(matchAll("node_modules/@scope/pkg/index.js")).toEqual(["node_modules/@scope/pkg/index.js"]);
		});
	});

	describe("fileUrlRegex", () => {
		function matchAll(text: string): string[] {
			const re = fileUrlRegex();
			const results: string[] = [];
			let m: RegExpExecArray | null;
			while ((m = re.exec(text)) !== null) results.push(m[1]);
			return results;
		}

		it("matches file:///absolute/path", () => {
			expect(matchAll("open file:///home/user/test.rs")).toEqual(["/home/user/test.rs"]);
		});

		it("matches file://absolute/path (bare)", () => {
			expect(matchAll("see file:///tmp/out.log")).toEqual(["/tmp/out.log"]);
		});

		it("does not match file:// without absolute path", () => {
			expect(matchAll("file://relative/path.rs")).toEqual([]);
		});

		it("stops at whitespace", () => {
			expect(matchAll("file:///a/b.txt next")).toEqual(["/a/b.txt"]);
		});
	});

	describe("CODING_EXT", () => {
		it("includes common extensions", () => {
			for (const ext of ["rs", "ts", "tsx", "js", "py", "go", "md", "json", "yaml", "css", "html"]) {
				expect(CODING_EXT).toContain(ext);
			}
		});
	});
});

describe("matchWebUrls", () => {
	function urls(text: string): string[] {
		return matchWebUrls(text).map((u) => u.text);
	}

	it("matches a bare URL", () => {
		expect(urls("Running on http://192.168.0.165:5000")).toEqual(["http://192.168.0.165:5000"]);
	});

	it("drops the sentence comma that made the URL unopenable", () => {
		// The greedy match swallowed the comma, `new URL()` rejected
		// "http://192.168.0.165:5000," as malformed, and the click did nothing.
		expect(urls("see http://192.168.0.165:5000, then reload")).toEqual(["http://192.168.0.165:5000"]);
		for (const url of urls("see http://192.168.0.165:5000, then reload")) {
			expect(() => new URL(url)).not.toThrow();
		}
	});

	it("drops every other sentence tail", () => {
		expect(urls("go to https://example.com.")).toEqual(["https://example.com"]);
		expect(urls("go to https://example.com!")).toEqual(["https://example.com"]);
		expect(urls("go to https://example.com?")).toEqual(["https://example.com"]);
		expect(urls("go to https://example.com;")).toEqual(["https://example.com"]);
		expect(urls("go to https://example.com:")).toEqual(["https://example.com"]);
		expect(urls("go to https://example.com'")).toEqual(["https://example.com"]);
	});

	it("keeps a trailing slash and a query string", () => {
		expect(urls("* Running on http://127.0.0.1:5000/ (Press CTRL+C)")).toEqual(["http://127.0.0.1:5000/"]);
		expect(urls("open https://example.com/search?q=1&b=2")).toEqual(["https://example.com/search?q=1&b=2"]);
	});

	it("keeps a parenthesis the URL itself opened", () => {
		expect(urls("https://en.wikipedia.org/wiki/Rust_(programming_language)")).toEqual([
			"https://en.wikipedia.org/wiki/Rust_(programming_language)",
		]);
	});

	it("drops a parenthesis the sentence opened", () => {
		expect(urls("(see https://example.com/docs)")).toEqual(["https://example.com/docs"]);
	});

	it("reports the index of the untrimmed start", () => {
		const [match] = matchWebUrls("see http://example.com, ok");
		expect(match.index).toBe(4);
		expect(match.text).toBe("http://example.com");
	});

	it("finds several URLs on one line", () => {
		expect(urls("http://a.test, http://b.test.")).toEqual(["http://a.test", "http://b.test"]);
	});

	it("is not a link once trimming leaves a bare scheme", () => {
		expect(urls("http://,")).toEqual([]);
	});
});
