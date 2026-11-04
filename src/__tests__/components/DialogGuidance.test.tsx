import { cleanup, render } from "@solidjs/testing-library";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("../../transport", () => ({
	subscribeEvents: vi.fn(async () => () => {}),
	rpc: vi.fn(async (command: string) =>
		command === "get_local_ips" ? [] : { services: { server: { enabled: true } } },
	),
}));

import { RemoteQrDialog } from "../../components/RemoteQrDialog/RemoteQrDialog";
import { VariableInputDialog } from "../../components/SmartPromptsDropdown/VariableInputDialog";

afterEach(cleanup);

// Catches: the variable form reintroduces its redundant required-values subtitle.
it("renders prompt variables without invented guidance", () => {
	const view = render(() => (
		<VariableInputDialog variables={["value"]} promptName="Prompt" onSubmit={() => {}} onCancel={() => {}} />
	));
	expect(view.getByRole("button", { name: "Run" })).not.toBeNull();
	expect(view.container.textContent).not.toContain("Fill in the required values");
});

// Catches: the remote QR header reintroduces an always-visible scanning subtitle.
it("renders the remote QR dialog without invented guidance", () => {
	const view = render(() => <RemoteQrDialog onClose={() => {}} />);
	expect(view.getByRole("heading", { name: "Remote Mobile Connection" })).not.toBeNull();
	expect(view.container.textContent).not.toContain("Scan with your phone to connect");
});
