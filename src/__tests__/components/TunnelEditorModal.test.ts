import { render } from "@solidjs/testing-library";
import { createComponent } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import {
	convertForwardType,
	normalizeForwardForType,
	TunnelEditorModal,
} from "../../components/TunnelsPanel/TunnelEditorModal";
import type { ForwardSpec, TunnelProfile } from "../../stores/tunnels";

vi.mock("../../invoke", () => ({ invoke: vi.fn().mockResolvedValue(null) }));

describe("TunnelEditorModal forward shaping", () => {
	it("normalizes Remote forwards to the backend local_host/local_port shape", () => {
		const staleRemoteForward: ForwardSpec = {
			type: "Remote",
			bind_port: 9090,
			remote_host: "127.0.0.1",
			remote_port: 3000,
		};

		expect(normalizeForwardForType(staleRemoteForward)).toEqual({
			type: "Remote",
			bind_port: 9090,
			local_host: "127.0.0.1",
			local_port: 3000,
		});
	});

	it("converts Local forwards to Remote without carrying remote-only field names", () => {
		const localForward: ForwardSpec = {
			type: "Local",
			bind_port: 5432,
			remote_host: "db.internal",
			remote_port: 5432,
		};

		expect(convertForwardType(localForward, "Remote")).toEqual({
			type: "Remote",
			bind_port: 5432,
			local_host: "127.0.0.1",
			local_port: 5432,
		});
	});

	it("converts Remote forwards to Local with the current SSH host as the default target", () => {
		const remoteForward: ForwardSpec = {
			type: "Remote",
			bind_port: 8080,
			local_host: "127.0.0.1",
			local_port: 8080,
		};

		expect(convertForwardType(remoteForward, "Local", "example.com")).toEqual({
			type: "Local",
			bind_port: 8080,
			remote_host: "example.com",
			remote_port: 8080,
		});
	});
});

describe("TunnelEditorModal forward row", () => {
	// Catches: forward-row fields left at the 36px default beside the 22px "x" remove button.
	it("sizes the type select and every port/host field compact, like the remove button", () => {
		const profile: TunnelProfile = {
			id: "p1",
			name: "db",
			host: "bastion",
			port: 22,
			user: "me",
			identity_file: null,
			forwards: [{ type: "Local", bind_port: 5432, remote_host: "db.internal", remote_port: 5432 }],
			options: {} as TunnelProfile["options"],
			auto_connect: false,
		};
		const { container } = render(() => createComponent(TunnelEditorModal, { profile, onClose: () => {} }));
		const row = container.querySelector('input[placeholder="bind"]')?.parentElement as HTMLElement;
		const fields = [...row.querySelectorAll("select, input")];
		expect(fields).toHaveLength(4);
		for (const field of fields) expect(field.className).toMatch(/compact/);
	});
});
