import { cleanup, render } from "@solidjs/testing-library";
import { afterEach, expect, it } from "vitest";
import { Transcript } from "../../components/AIChatPanel/Transcript";

afterEach(cleanup);

const command =
	"<command-message>wiz:work</command-message>\n<command-name>/wiz:work</command-name>\n<command-args>OMB è un assistente.</command-args>";
function mount(text: string) {
	return render(() => (
		<Transcript
			terminalAgent="claude"
			mobile
			entries={() => [{ id: "u", kind: "user", text }]}
			busy={() => false}
			emptyMessage=""
			observeToolDuration={false}
		/>
	));
}

// Catches: Claude command envelopes being printed as raw XML in terminal user bubbles.
it("renders slash-command user messages as command name and arguments without XML", () => {
	const view = mount(command);
	expect(view.getByText("/wiz:work", { selector: "code" })).toBeTruthy();
	expect(view.container.textContent).toContain("OMB è un assistente.");
	expect(view.container.textContent).not.toContain("<command-");
});

// Catches: no-argument commands disappearing or printing empty protocol tags.
it("renders a command without arguments", () => {
	const view = mount("<command-message>help</command-message>\n<command-name>/help</command-name>");
	expect(view.getByText("/help", { selector: "code" })).toBeTruthy();
	expect(view.container.textContent).not.toContain("<command-");
});

// Catches: stripping literal XML examples or incomplete envelopes from ordinary user prose.
it.each(["Explain " + command, "<command-name>/help", "<command-name>not-a-command</command-name>"])(
	"preserves non-envelope text %s",
	(text) => {
		const view = mount(text);
		expect(view.container.textContent).toContain(text);
	},
);
