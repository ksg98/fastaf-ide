// @vitest-environment jsdom
import { render } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { describe, expect, it } from "vitest";
import { ContentRenderer } from "../../../ui/ContentRenderer";

describe("provider content policy", () => {
	// Catches: tightening provider Markdown also removes intentional styles in existing trusted documents.
	it("trusted_documents_keep_inline_styles_but_provider_documents_cannot_set_them", () => {
		const content = '<p style="color:red">Text</p><style>body {display:none}</style>';
		const trusted = render(() => <ContentRenderer content={content} />);
		expect(trusted.container.querySelector("p")?.getAttribute("style")).toBe("color:red");
		const provider = render(() => <ContentRenderer content={content} untrustedContent />);
		expect(provider.container.querySelector("[style], style")).toBeNull();
		expect(provider.container.textContent).toContain("Text");
	});

	// Catches: a committed streaming prefix keeps CSS cached before switching to the provider policy.
	it("incremental_content_rebuilds_its_cache_when_the_trust_policy_changes", () => {
		const [untrusted, setUntrusted] = createSignal(false);
		const content = '<p style="color:red">Committed</p>\n\nTail';
		const { container } = render(() => (
			<ContentRenderer content={content} incremental untrustedContent={untrusted()} />
		));
		expect(container.querySelector("[style]")).not.toBeNull();
		setUntrusted(true);
		expect(container.querySelector("[style], style")).toBeNull();
		expect(container.textContent).toContain("Committed");
	});
});
