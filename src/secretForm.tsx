/* This form module deliberately does not import App, debugGlobals, appLogger, stores,
 * heartbeat, crash handlers, plugins or the terminal. Only explicit link actions can copy or open HTTP(S) URLs. */

import { invoke } from "@tauri-apps/api/core";
import { render } from "solid-js/web";
import { type PrivateForm, SecretForm, type SecretSubmission } from "./components/SecretForm/SecretForm";
import "./global.css";

const native = "__TAURI_INTERNALS__" in window && !(window as unknown as Record<string, unknown>).__TAURI_SHIM__;
let nonce = new URLSearchParams(window.location.hash.split("?")[1]).get("nonce");
// Remove the capability from address/history before sending any request.
if (!native) history.replaceState(null, "", `${window.location.pathname}#/secret-form`);

export async function startSecretForm(root: HTMLElement): Promise<void> {
	try {
		const form: PrivateForm = native ? await invoke<PrivateForm>("secret_form_bootstrap") : await readForm();
		render(
			() => (
				<SecretForm
					form={form}
					submit={submit}
					copyUrl={native ? (url) => invoke("write_clipboard_text", { text: url }) : undefined}
					openUrl={native ? (url) => invoke("open_default_app", { target: url, kind: "url" }) : undefined}
				/>
			),
			root,
		);
	} catch {
		root.textContent = "Private form unavailable or expired. Ask for a new request.";
	}
}
async function readForm(): Promise<PrivateForm> {
	if (nonce?.length !== 64) throw new Error("Unknown form");
	const response = await fetch(`/secrets/forms/${encodeURIComponent(nonce)}`, {
		cache: "no-store",
		credentials: "same-origin",
		referrerPolicy: "no-referrer",
	});
	if (!response.ok) throw new Error("Expired form");
	const value: unknown = await response.json();
	if (!isPrivateForm(value)) throw new Error("Invalid form schema");
	return value;
}
async function submit(submission: SecretSubmission): Promise<void> {
	if (native) await invoke("secret_form_submit", { submission });
	else {
		const response = await fetch("/secrets/forms/submit", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(submission),
			cache: "no-store",
			credentials: "same-origin",
			referrerPolicy: "no-referrer",
		});
		if (!response.ok) throw new Error("Submission rejected");
	}
	nonce = null;
}

function isPrivateForm(value: unknown): value is PrivateForm {
	if (
		!value ||
		typeof value !== "object" ||
		!("id" in value) ||
		typeof value.id !== "string" ||
		!("nonce" in value) ||
		typeof value.nonce !== "string" ||
		!("reason" in value) ||
		typeof value.reason !== "string" ||
		!("fields" in value) ||
		!Array.isArray(value.fields) ||
		!("argv" in value)
	)
		return false;
	return (
		(value.argv === null || (Array.isArray(value.argv) && value.argv.every((arg) => typeof arg === "string"))) &&
		value.fields.every(
			(field: unknown) =>
				!!field &&
				typeof field === "object" &&
				"name" in field &&
				typeof field.name === "string" &&
				"kind" in field &&
				["username", "password", "otp", "sso"].includes(String(field.kind)),
		)
	);
}
