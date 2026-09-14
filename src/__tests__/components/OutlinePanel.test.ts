import { describe, expect, it } from "vitest";
import { nestLevel, type OutlineSymbol } from "../../components/OutlinePanel/OutlinePanel";

function symbol(scopeContext: string | null): OutlineSymbol {
	return {
		name: "foo",
		kind: "Function",
		filePath: "src/lib.rs",
		lineStart: 1,
		lineEnd: 10,
		signature: "fn foo()",
		scopeContext,
	};
}

describe("OutlinePanel nesting", () => {
	it("indents type members and nothing else", () => {
		// mdkb renders scopeContext with Rust's Debug formatter, so these are
		// the literal strings the backend sends.
		expect(nestLevel(symbol("ClassMember { class_name: None }"))).toBe(1);
		expect(nestLevel(symbol('ClassMember { class_name: Some("Repo") }'))).toBe(1);
		expect(nestLevel(symbol("Module"))).toBe(0);
		expect(nestLevel(symbol(null))).toBe(0);
	});

	it("does not read scopeContext as a '::' path", () => {
		// Regression: splitting on "::" never matched anything mdkb sends, so
		// every symbol with any scope got the same indent and the outline read
		// flat. A "::" in a scope name must not be treated as depth.
		expect(nestLevel(symbol("crate::repo::Repo"))).toBe(0);
	});
});
