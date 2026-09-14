import { openUrl } from "@tauri-apps/plugin-opener";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	authFromUpstreamForm,
	shouldShowAuthorize,
	startAuthorizeFlow,
} from "../../../components/SettingsPanel/tabs/ServicesTab";
import { mockInvoke } from "../../mocks/tauri";

describe("startAuthorizeFlow", () => {
	beforeEach(() => {
		mockInvoke.mockReset();
		vi.mocked(openUrl).mockClear();
	});

	it("opens the authorization URL only after the in-app confirmation resolves true", async () => {
		mockInvoke.mockResolvedValueOnce({
			authorization_url: "https://auth.example.com/oauth?state=nonce",
			state: "nonce",
			cross_domain_as: false,
		});
		const confirmAuthorization = vi.fn().mockResolvedValue(true);

		await startAuthorizeFlow("example", confirmAuthorization);

		expect(confirmAuthorization).toHaveBeenCalledWith("https://auth.example.com", "example", false);
		expect(openUrl).toHaveBeenCalledWith("https://auth.example.com/oauth?state=nonce");
	});

	it("cancels the pending backend flow when confirmation is declined", async () => {
		mockInvoke
			.mockResolvedValueOnce({
				authorization_url: "https://auth.example.com/oauth?state=nonce",
				state: "nonce",
				cross_domain_as: false,
			})
			.mockResolvedValueOnce(undefined);

		await startAuthorizeFlow("example", vi.fn().mockResolvedValue(false));

		expect(mockInvoke).toHaveBeenLastCalledWith("cancel_mcp_upstream_oauth", { name: "example" });
		expect(openUrl).not.toHaveBeenCalled();
	});

	it("forwards the cross-domain flag so the dialog can warn instead of blocking", async () => {
		mockInvoke.mockResolvedValueOnce({
			authorization_url: "https://auth.example-idp.com/authorize?state=nonce",
			state: "nonce",
			cross_domain_as: true,
		});
		const confirmAuthorization = vi.fn().mockResolvedValue(true);

		await startAuthorizeFlow("gateway", confirmAuthorization);

		expect(confirmAuthorization).toHaveBeenCalledWith("https://auth.example-idp.com", "gateway", true);
		expect(openUrl).toHaveBeenCalledWith("https://auth.example-idp.com/authorize?state=nonce");
	});
});

describe("shouldShowAuthorize", () => {
	it("shows button when auth type is oauth2 (explicit config)", () => {
		expect(shouldShowAuthorize("oauth2", "ready", true)).toBe(true);
	});

	it("shows button when status is needs_auth regardless of auth config", () => {
		expect(shouldShowAuthorize(undefined, "needs_auth", true)).toBe(true);
	});

	it("shows button when needs_auth with no auth (DCR case)", () => {
		expect(shouldShowAuthorize(undefined, "needs_auth", true)).toBe(true);
	});

	it("shows button when authenticating (flow in progress)", () => {
		expect(shouldShowAuthorize(undefined, "authenticating", true)).toBe(true);
	});

	it("shows button when oauth2 and authenticating", () => {
		expect(shouldShowAuthorize("oauth2", "authenticating", true)).toBe(true);
	});

	it("hides button when bearer auth and not needs_auth", () => {
		expect(shouldShowAuthorize("bearer", "ready", true)).toBe(false);
	});

	it("hides button when no auth config and status is connected", () => {
		expect(shouldShowAuthorize(undefined, "ready", true)).toBe(false);
	});

	it("hides button when no auth config and status is connecting", () => {
		expect(shouldShowAuthorize(undefined, "connecting", true)).toBe(false);
	});

	it("hides button when no auth config and status is undefined", () => {
		expect(shouldShowAuthorize(undefined, undefined, true)).toBe(false);
	});

	it("hides button for a disabled oauth2 upstream (cannot authorize what is off)", () => {
		expect(shouldShowAuthorize("oauth2", "ready", false)).toBe(false);
	});

	it("hides button for a disabled upstream even when status is needs_auth", () => {
		expect(shouldShowAuthorize(undefined, "needs_auth", false)).toBe(false);
	});

	it("hides button for a disabled upstream mid-authentication", () => {
		expect(shouldShowAuthorize("oauth2", "authenticating", false)).toBe(false);
	});
});

describe("authFromUpstreamForm", () => {
	const form = {
		transportType: "http" as const,
		authMethod: "oauth2" as const,
		oauthClientId: "",
		oauthClientSecret: "",
		oauthScopes: "",
	};

	it("clears a previous Bearer block when OAuth uses DCR", () => {
		expect(authFromUpstreamForm(form, { type: "bearer", token: "old" })).toBeUndefined();
	});

	it("persists explicit OAuth configuration", () => {
		expect(authFromUpstreamForm({ ...form, oauthClientId: "client", oauthScopes: "read write" })).toEqual({
			type: "oauth2",
			client_id: "client",
			scopes: ["read", "write"],
		});
	});
});
