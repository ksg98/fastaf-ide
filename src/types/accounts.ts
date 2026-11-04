/** Shared core account reply. Credentials are write-only; status is the only read surface. */
export type AccountAuthKind = "bearer" | "basic" | "oauth_device" | "ambient";
export type AccountSecretStatus = "set" | "unset" | "unavailable";

export interface AccountView {
	id: string;
	provider: string;
	site_id: string;
	host: string;
	kind: AccountAuthKind;
	label: string;
	login: string | null;
	username: string | null;
	created_at: number;
	auth_source: string | null;
	secret: { status: AccountSecretStatus };
}

export interface AccountSite {
	id: string;
	provider: string;
	host: string;
	label: string;
}

/** Metadata-only launch. The private native window supplies the token to Rust. */
export type AccountSecretRequest =
	| {
			action: "add";
			account: { provider: string; host: string; kind: AccountAuthKind; label: string; username?: string | null };
	  }
	| { action: "rotate"; id: string };
export interface AccountSecretFormStatus {
	names: string[];
	status: "stored" | "declined" | "failed";
}
