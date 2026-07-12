import { describe, expect, it } from "vitest";
import { convertForwardType, normalizeForwardForType } from "../../components/TunnelsPanel/TunnelEditorModal";
import type { ForwardSpec } from "../../stores/tunnels";

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
