import { describe, expect, it } from "vitest";
import {
	emptyRemoteForm,
	remoteStatusColor,
	remoteStatusLabel,
	transportSummary,
} from "../../../components/SettingsPanel/tabs/ServicesTab";

describe("ServicesTab remote machine presentation", () => {
	it.each([
		["connected", "Connected", "var(--accent-green, #22c55e)"],
		["connecting", "Connecting...", "var(--fg-warning, #e5a100)"],
		["error", "Error", "var(--accent-red, #ef4444)"],
		["disconnected", "Disconnected", "var(--fg-muted)"],
	])("maps %s status without changing its label or color", (status, label, color) => {
		expect(remoteStatusLabel(status)).toBe(label);
		expect(remoteStatusColor(status)).toBe(color);
	});

	it("summarizes both supported transports", () => {
		expect(
			transportSummary({
				type: "Ssh",
				ssh_host: "dev.example.test",
				ssh_port: 2222,
				ssh_user: "boss",
				identity_file: null,
				remote_daemon_port: 9876,
			}),
		).toBe("boss@dev.example.test:2222");
		expect(transportSummary({ type: "Direct", url: "https://dev.example.test" })).toBe("https://dev.example.test");
	});

	it("keeps the new-machine defaults stable", () => {
		expect(emptyRemoteForm()).toEqual({
			name: "",
			transportType: "Ssh",
			sshHost: "",
			sshPort: 22,
			sshUser: "",
			identityFile: "",
			remoteDaemonPort: 9876,
			directUrl: "",
			authUsername: "",
		});
	});
});
