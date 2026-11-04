import { render } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Before the selector, the machine a settings tab edited was implied by whichever
 * repository the settings nav was standing on — which cannot express "edit the
 * VPS while I stand on a local repo", and silently showed this machine's config
 * when it could not.
 */
const { connections } = vi.hoisted(() => ({ connections: { value: {} as Record<string, unknown> } }));
vi.mock("../../../stores/remoteConnections", () => ({
	remoteConnectionsStore: { getConnections: () => connections.value },
}));

import { MachineSelector } from "../../../components/SettingsPanel/MachineSelector";

const VPS = {
	connection: { id: "vps", name: "Hetzner", transport: { type: "Direct", url: "" }, auth_username: "", enabled: true },
	status: "connected",
};
const LAPTOP = {
	connection: {
		id: "laptop",
		name: "Mac mini",
		transport: { type: "Direct", url: "" },
		auth_username: "",
		enabled: true,
	},
	status: "disconnected",
};

describe("MachineSelector", () => {
	beforeEach(() => {
		connections.value = {};
	});

	it("renders nothing when there is only one machine", () => {
		const { container } = render(() => <MachineSelector value={undefined} onChange={() => {}} />);

		expect(container.querySelector("select")).toBeNull();
	});

	it("offers this machine first, then every registered connection", () => {
		connections.value = { vps: VPS, laptop: LAPTOP };

		const { container } = render(() => <MachineSelector value={undefined} onChange={() => {}} />);
		const options = [...container.querySelectorAll("option")];

		expect(options.map((o) => o.value)).toEqual(["", "vps", "laptop"]);
		expect(options[0].textContent).toBe("This machine");
	});

	/** A machine that is down is still editable, but it must not look connected. */
	it("says so when a machine is not connected", () => {
		connections.value = { laptop: LAPTOP };

		const { container } = render(() => <MachineSelector value={undefined} onChange={() => {}} />);

		expect([...container.querySelectorAll("option")][1].textContent).toContain("(disconnected)");
	});

	it("reports the picked machine, and an empty pick as this machine", () => {
		connections.value = { vps: VPS };
		const [picked, setPicked] = createSignal<string | undefined>(undefined);
		const seen: (string | undefined)[] = [];

		const { container } = render(() => (
			<MachineSelector
				value={picked()}
				onChange={(id) => {
					seen.push(id);
					setPicked(id);
				}}
			/>
		));
		const select = container.querySelector("select") as HTMLSelectElement;

		select.value = "vps";
		select.dispatchEvent(new Event("change", { bubbles: true }));
		select.value = "";
		select.dispatchEvent(new Event("change", { bubbles: true }));

		expect(seen).toEqual(["vps", undefined]);
	});

	it("uses the caller's label, so each tab says what it is scoping", () => {
		connections.value = { vps: VPS };

		const { container } = render(() => <MachineSelector value={undefined} label="Upstreams on" onChange={() => {}} />);

		expect(container.querySelector("label")?.textContent).toBe("Upstreams on");
	});
});
