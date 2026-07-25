import QRCode from "qrcode";
import { type Component, createEffect, createResource, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { t } from "../../../i18n";
import { appLogger } from "../../../stores/appLogger";
import { rpc } from "../../../transport";
import { cx } from "../../../utils";
import { writeClipboard } from "../../../utils/clipboard";
import { updateAppConfig } from "../../../utils/updateAppConfig";
import { SettingInput, SettingSelect, SettingToggle } from "../SettingFields";
import s from "../Settings.module.css";
import { RemoteMachinesPanel } from "./services/RemoteMachinesPanel";
import { UpstreamMcpPanel } from "./services/UpstreamMcpPanel";

export {
	emptyRemoteForm,
	remoteStatusColor,
	remoteStatusLabel,
	transportSummary,
} from "./services/RemoteMachinesPanel";
export { authFromUpstreamForm, shouldShowAuthorize, startAuthorizeFlow } from "./services/UpstreamMcpPanel";

interface McpStatus {
	enabled: boolean;
	running: boolean;
	remote_port: number | null;
	active_sessions: number;
	/** Connected MCP protocol clients (reaped after 1h idle) */
	mcp_clients: number;
	max_sessions: number;
	/** null = remote disabled, true = TCP reachable, false = likely firewalled */
	reachable?: boolean | null;
}

interface ServerConfig {
	enabled: boolean;
	port: number;
	ipv6_enabled: boolean;
}

interface AuthConfig {
	username: string;
	password_hash: string;
	session_token_duration_secs: number;
	session_token_exists?: boolean;
	lan_auth_bypass: boolean;
}

interface RelayConfig {
	enabled: boolean;
	url: string;
	token?: string;
	token_exists?: boolean;
	session_id: string;
}

interface ServicesConfig {
	server: ServerConfig;
	auth: AuthConfig;
	relay: RelayConfig;
}

interface AppConfig {
	shell: string | null;
	font_family: string;
	font_size: number;
	theme: string;
	mcp_server_enabled: boolean;
	services: ServicesConfig;
	disabled_native_tools: string[];
	collapse_tools: boolean;
}

interface RelayStatus {
	enabled: boolean;
	connected: boolean;
	url: string;
	session_id: string;
}

interface LocalIpEntry {
	ip: string;
	label: string;
}

/** Static definition of native TUIC tools exposed via MCP */
const NATIVE_TOOLS: { name: string; description: string; actions: string }[] = [
	{
		name: "session",
		description: "PTY terminal panes (tmux replacement)",
		actions: "list, create, input, output, resize, close, kill, pause, resume",
	},
	{
		name: "agent",
		description: "AI agents + inter-agent messaging",
		actions: "spawn, detect, stats, metrics, register, list_peers, send, inbox",
	},
	{
		name: "repo",
		description: "Repos, GitHub PRs, worktrees",
		actions: "list, active, prs, status, worktree_list, worktree_create, worktree_remove",
	},
	{ name: "ui", description: "Panel tabs + notifications", actions: "tab, toast, confirm" },
	{
		name: "plugin_dev_guide",
		description: "Plugin authoring reference",
		actions: "Returns full plugin authoring guide",
	},
	{ name: "config", description: "Read and write app config", actions: "get, save" },
	{ name: "knowledge", description: "Cross-repo knowledge base (mdkb)", actions: "search, code_graph, status, setup" },
	{
		name: "debug",
		description: "Diagnostics + plugin guide",
		actions: "agent_detection, logs, invoke_js, plugin_guide",
	},
];

const LocalServicesPanel: Component = () => {
	const [status, setStatus] = createSignal<McpStatus | null>(null);
	const [localIps] = createResource(() => rpc<LocalIpEntry[]>("get_local_ips"));
	const [selectedIp, setSelectedIp] = createSignal<string>("");

	// Remote access form state
	const [raEnabled, setRaEnabled] = createSignal(false);
	const [raPort, setRaPort] = createSignal(9876);
	const [raUsername, setRaUsername] = createSignal("");
	const [raPassword, setRaPassword] = createSignal("");
	const [raHasPassword, setRaHasPassword] = createSignal(false);
	const [raShowPassword, setRaShowPassword] = createSignal(false);
	const [qrDataUrl, setQrDataUrl] = createSignal<string | null>(null);
	const [tokenDuration, setTokenDuration] = createSignal(86400);
	const [ipv6Enabled, setIpv6Enabled] = createSignal(false);
	const [lanAuthBypass, setLanAuthBypass] = createSignal(false);
	const [urlCopied, setUrlCopied] = createSignal(false);
	const [regenerating, setRegenerating] = createSignal(false);
	const [disabledNativeTools, setDisabledNativeTools] = createSignal<string[]>([]);
	const [collapseTools, setCollapseTools] = createSignal<boolean>(false);
	const [bridgeInfo, setBridgeInfo] = createSignal<{ bridge_path: string; config_snippet: string } | null>(null);
	const [bridgeInfoOpen, setBridgeInfoOpen] = createSignal(false);
	const [snippetCopied, setSnippetCopied] = createSignal(false);

	// Tailscale state (mirrors Rust TailscaleState enum serialization)
	type TailscaleStatus =
		| { state: "NotInstalled" }
		| { state: "NotRunning" }
		| { state: "Running"; fqdn: string; https_enabled: boolean };

	const [tailscaleState, setTailscaleState] = createSignal<TailscaleStatus | null>(null);

	// Relay state
	const [relayEnabled, setRelayEnabled] = createSignal(false);
	const [relayUrl, setRelayUrl] = createSignal("wss://relay.tuicommander.com");
	const [relayToken, setRelayToken] = createSignal("");
	const [relaySessionId, setRelaySessionId] = createSignal("");
	const [relayConnected, setRelayConnected] = createSignal(false);

	// Auto-select best IP when list loads (prefer Tailscale, then LAN/Wi-Fi)
	createEffect(() => {
		const ips = localIps();
		if (!ips?.length || selectedIp()) return;
		const preferred =
			ips.find((e) => e.label.includes("Tailscale")) ??
			ips.find((e) => e.label.includes("Wi-Fi") || e.label.includes("LAN")) ??
			ips[0];
		setSelectedIp(preferred.ip);
	});

	const activeIp = () => selectedIp() || localIps()?.[0]?.ip;

	// Connect URL fetched from backend (token never reaches JS)
	const [connectUrl, setConnectUrl] = createSignal<string | null>(null);
	// Bumped after token regeneration to re-fetch the URL
	const [qrVersion, setQrVersion] = createSignal(0);

	/** Fetch connect URL from backend so the raw token stays server-side. */
	createEffect(() => {
		const ip = activeIp();
		void qrVersion(); // subscribe — re-run after token regeneration
		if (!ip) {
			setConnectUrl(null);
			setQrDataUrl(null);
			return;
		}
		let cancelled = false;
		onCleanup(() => {
			cancelled = true;
		});
		rpc<string>("get_connect_url", { ip })
			.then((url) => {
				if (cancelled) return;
				setConnectUrl(url);
				return QRCode.toDataURL(url, { width: 160, margin: 2, color: { dark: "#ffffff", light: "#1e1e1e" } });
			})
			.then((dataUrl) => {
				if (!cancelled && dataUrl) setQrDataUrl(dataUrl);
			})
			.catch(() => {
				if (cancelled) return;
				setConnectUrl(null);
				setQrDataUrl(null);
			});
	});

	const refreshStatus = async () => {
		try {
			const s = await rpc<McpStatus>("get_mcp_status");
			setStatus(s);
		} catch (e) {
			// Transient poll failures are normal during app startup
			appLogger.debug("config", "MCP status refresh failed", e);
		}
		try {
			const rs = await rpc<RelayStatus>("get_relay_status");
			setRelayConnected(rs.connected);
		} catch {
			// Relay status not available
		}
	};

	const loadRemoteConfig = async () => {
		try {
			const config = await rpc<AppConfig>("load_config");
			setRaEnabled(config.services.server.enabled);
			setRaPort(config.services.server.port);
			setRaUsername(config.services.auth.username);
			setRaHasPassword(config.services.auth.password_hash.length > 0);
			setTokenDuration(config.services.auth.session_token_duration_secs ?? 86400);
			setIpv6Enabled(config.services.server.ipv6_enabled ?? false);
			setLanAuthBypass(config.services.auth.lan_auth_bypass ?? false);
			setDisabledNativeTools(config.disabled_native_tools ?? []);
			setCollapseTools(config.collapse_tools ?? false);
			setRelayEnabled(config.services.relay.enabled ?? false);
			setRelayUrl(config.services.relay.url || "wss://relay.tuicommander.com");
			setRelayToken(config.services.relay.token ?? "");
			setRelaySessionId(config.services.relay.session_id ?? "");
		} catch (e) {
			appLogger.warn("config", "Failed to load remote access config, using defaults", e);
		}
	};

	onMount(async () => {
		refreshStatus();
		loadRemoteConfig();
		const interval = setInterval(refreshStatus, 3000);
		onCleanup(() => clearInterval(interval));

		// Load Tailscale status
		try {
			const ts = await rpc<TailscaleStatus>("get_tailscale_status");
			setTailscaleState(ts);
		} catch {
			/* Tailscale detection not available */
		}
	});

	/** Save a single config field (load-modify-save pattern matching other tabs) */
	const saveConfigField = async (updater: (config: AppConfig) => void) => {
		try {
			await updateAppConfig<AppConfig>(updater);
		} catch (e) {
			appLogger.error("config", "Failed to save config", e);
		}
	};

	/** Hash and save a new password */
	const savePassword = async (password: string) => {
		if (!password) return;
		try {
			const hash = await rpc<string>("hash_password", { password });
			await saveConfigField((c) => {
				c.services.auth.password_hash = hash;
			});
			setRaPassword("");
			setRaHasPassword(true);
		} catch (e) {
			appLogger.error("config", "Failed to hash password", e);
		}
	};

	const copyUrl = async () => {
		const url = connectUrl();
		if (!url) return;
		try {
			await writeClipboard(url);
			setUrlCopied(true);
			setTimeout(() => setUrlCopied(false), 2000);
		} catch {
			// Fallback: select text for manual copy
		}
	};

	const regenerateToken = async () => {
		setRegenerating(true);
		try {
			await rpc("regenerate_session_token");
			setQrVersion((v) => v + 1); // re-fetch QR URL with new token
			await refreshStatus();
		} catch (e) {
			appLogger.error("config", "Failed to regenerate token", e);
		} finally {
			setRegenerating(false);
		}
	};

	/** Token duration options */
	const TOKEN_DURATIONS = [
		{ value: 3600, label: t("services.tokenDuration.1h", "1 hour") },
		{ value: 86400, label: t("services.tokenDuration.24h", "24 hours") },
		{ value: 604800, label: t("services.tokenDuration.7d", "7 days") },
		{ value: 31536000, label: t("services.tokenDuration.never", "Never") },
	];

	return (
		<>
			<h3>{t("services.heading.httpApiServer", "HTTP API Server")}</h3>

			<div class={s.group}>
				<p class={s.hint}>
					{t(
						"services.hint.httpDescription",
						"Serves the REST API and MCP protocol for AI agents and automation tools",
					)}
				</p>
			</div>

			<div class={s.group}>
				<label>{t("services.label.serverStatus", "Server Status")}</label>
				<div class={s.mcpStatusRow}>
					<span class={cx(s.mcpStatusDot, status()?.running && s.running)} />
					<span class={s.mcpStatusText}>
						{status()?.running ? t("services.status.running", "Running") : t("services.status.starting", "Starting...")}
					</span>
					<Show when={status()?.running}>
						<span class={s.mcpStatusPort}>{t("services.label.socket", "Socket")}</span>
					</Show>
				</div>
			</div>

			<div class={s.group}>
				<label>{t("services.label.mcpConnection", "MCP Connection")}</label>
				<p class={s.hint}>
					{t(
						"services.hint.mcpConnection",
						"AI agents connect via the tuic-bridge sidecar. MCP configs are auto-installed in supported agents (Claude Code, Cursor, etc.).",
					)}
				</p>
			</div>

			<h3>{t("services.heading.remoteAccess", "Remote Access")}</h3>

			<SettingToggle
				checked={raEnabled()}
				onChange={(val) => {
					setRaEnabled(val);
					saveConfigField((c) => {
						c.services.server.enabled = val;
					});
				}}
				label={t("services.toggle.enableRemoteAccess", "Enable remote access")}
				hint={t(
					"services.hint.remoteAccessWarning",
					"Warning: exposes a web interface on your local network. Secure with a strong password.",
				)}
				hintStyle={{ color: "var(--warning, #e5c07b)" }}
			/>

			<Show when={raEnabled()}>
				<div class={s.raBody}>
					<div class={s.raFields}>
						<div class={s.group}>
							<label>{t("services.label.port", "Port")}</label>
							<input
								type="number"
								class={s.input}
								value={raPort()}
								min={1024}
								max={65535}
								onInput={(e) => setRaPort(parseInt(e.currentTarget.value, 10) || 9876)}
								onChange={() =>
									saveConfigField((c) => {
										c.services.server.port = raPort();
									})
								}
							/>
							<p class={s.hint}>{t("services.hint.port", "TCP port for the remote access web server")}</p>
						</div>

						{/* Username + Password side by side */}
						<div class={s.credentialsRow}>
							<div class={s.group} style={{ flex: "1", "min-width": 0 }}>
								<label>{t("services.label.username", "Username")}</label>
								<input
									type="text"
									class={s.input}
									value={raUsername()}
									placeholder={t("services.placeholder.username", "admin")}
									onInput={(e) => setRaUsername(e.currentTarget.value)}
									onChange={() =>
										saveConfigField((c) => {
											c.services.auth.username = raUsername();
										})
									}
								/>
							</div>
							<div class={s.group} style={{ flex: "1", "min-width": 0 }}>
								<label>{t("services.label.password", "Password")}</label>
								<div class={s.passwordRow}>
									<input
										type={raShowPassword() ? "text" : "password"}
										class={s.input}
										value={raPassword()}
										placeholder={
											raHasPassword()
												? t("services.placeholder.passwordSet", "Password set — enter to change")
												: t("services.placeholder.passwordEnter", "Enter password")
										}
										onInput={(e) => setRaPassword(e.currentTarget.value)}
										onChange={() => savePassword(raPassword())}
									/>
									<button
										class={s.toggleBtn}
										onClick={() => setRaShowPassword(!raShowPassword())}
										title={
											raShowPassword()
												? t("services.btn.hidePassword", "Hide password")
												: t("services.btn.showPassword", "Show password")
										}
									>
										{raShowPassword() ? (
											/* eye-slash */ <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
												<path d="M13.359 11.238C15.06 9.72 16 8 16 8s-3-5.5-8-5.5a7.028 7.028 0 0 0-2.79.588l.77.771A5.944 5.944 0 0 1 8 3.5c2.12 0 3.879 1.168 5.168 2.457A13.134 13.134 0 0 1 14.828 8c-.058.087-.122.183-.195.288-.335.48-.83 1.12-1.465 1.755-.165.165-.337.328-.517.486l.708.709z" />
												<path d="M11.297 9.176a3.5 3.5 0 0 0-4.474-4.474l.823.823a2.5 2.5 0 0 1 2.829 2.829l.822.822zm-2.943 1.299.822.822a3.5 3.5 0 0 1-4.474-4.474l.823.823a2.5 2.5 0 0 0 2.829 2.829z" />
												<path d="M3.35 5.47c-.18.16-.353.322-.518.487A13.134 13.134 0 0 0 1.172 8l.195.288c.335.48.83 1.12 1.465 1.755C4.121 11.332 5.881 12.5 8 12.5c.716 0 1.39-.133 2.02-.36l.77.772A7.029 7.029 0 0 1 8 13.5C3 13.5 0 8 0 8s.939-1.721 2.641-3.238l.708.709zm10.296 8.884-12-12 .708-.708 12 12-.708.708z" />
											</svg>
										) : (
											/* eye */ <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
												<path d="M16 8s-3-5.5-8-5.5S0 8 0 8s3 5.5 8 5.5S16 8 16 8zM1.173 8a13.133 13.133 0 0 1 1.66-2.043C4.12 4.668 5.88 3.5 8 3.5c2.12 0 3.879 1.168 5.168 2.457A13.133 13.133 0 0 1 14.828 8c-.058.087-.122.183-.195.288-.335.48-.83 1.12-1.465 1.755C11.879 11.332 10.119 12.5 8 12.5c-2.12 0-3.879-1.168-5.168-2.457A13.134 13.134 0 0 1 1.172 8z" />
												<path d="M8 5.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zM4.5 8a3.5 3.5 0 1 1 7 0 3.5 3.5 0 0 1-7 0z" />
											</svg>
										)}
									</button>
								</div>
								<p class={s.hint}>
									{t("services.hint.passwordLeaveBlank", "Leave blank to keep the current password")}
								</p>
							</div>
						</div>

						<Show when={raEnabled()}>
							<div class={s.group}>
								<label>{t("services.label.networkInterface", "Network Interface")}</label>
								<Show when={(localIps()?.length ?? 0) > 1} fallback={<code class={s.url}>{activeIp() ?? "…"}</code>}>
									<select class={s.input} value={selectedIp()} onChange={(e) => setSelectedIp(e.currentTarget.value)}>
										<For each={localIps()}>
											{(entry) => (
												<option value={entry.ip}>
													{entry.label} — {entry.ip}
												</option>
											)}
										</For>
									</select>
								</Show>
								<p class={s.hint} style={{ "margin-top": "4px" }}>
									{t("services.hint.qrScan", "Scan the QR code to connect from another device")}
								</p>
								<Show when={status()?.reachable === false}>
									<p class={s.hint} style={{ color: "var(--warning, #e5c07b)", "margin-top": "4px" }}>
										{t("services.hint.firewallWarning", "Port may be blocked by a firewall")}
									</p>
								</Show>
								<Show when={status()?.reachable === true}>
									<p class={s.hint} style={{ color: "var(--green, #98c379)", "margin-top": "4px" }}>
										{t("services.hint.serverReachable", "Server is reachable from the network")}
									</p>
								</Show>
							</div>
						</Show>

						<SettingSelect
							label={t("services.label.tokenDuration", "Session Token Duration")}
							value={String(tokenDuration())}
							onChange={(v) => {
								const val = parseInt(v, 10);
								setTokenDuration(val);
								saveConfigField((c) => {
									c.services.auth.session_token_duration_secs = val;
								});
							}}
							options={TOKEN_DURATIONS.map((o) => ({ value: String(o.value), label: o.label }))}
							hint={t(
								"services.hint.tokenDuration",
								"How long remote sessions stay authenticated. Token always resets on app restart.",
							)}
						/>

						<div class={s.group}>
							<button class={s.testBtn} disabled={regenerating()} onClick={regenerateToken}>
								{regenerating()
									? t("services.btn.regenerating", "Regenerating...")
									: t("services.btn.regenerateToken", "Regenerate Token")}
							</button>
							<p class={s.hint}>
								{t("services.hint.regenerateToken", "Generates a new token, disconnecting all active remote sessions")}
							</p>
						</div>
					</div>

					<Show when={connectUrl()}>
						<div class={s.qr}>
							<Show when={qrDataUrl()}>
								{(url) => (
									<img
										src={url()}
										width={120}
										height={120}
										alt={t("services.alt.qrCode", "QR code")}
										title={t("services.title.qrCode", "Scan to connect")}
									/>
								)}
							</Show>
							<span class={s.qrLabel}>{t("services.label.scanToConnect", "Scan to connect")}</span>
							{/* Connection URL right under QR code */}
							<div class={s.urlCopyRow} style={{ "margin-top": "8px", "max-width": "200px" }}>
								<code class={s.urlFull} style={{ "font-size": "10px", "word-break": "break-all" }}>
									{connectUrl()}
								</code>
								<button class={s.copyBtn} onClick={copyUrl} title={t("services.btn.copyUrl", "Copy URL to clipboard")}>
									{urlCopied() ? (
										<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
											<path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.75.75 0 0 1 1.06-1.06L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0z" />
										</svg>
									) : (
										<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
											<path d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 0 1 0 1.5h-1.5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 9.25 16h-7.5A1.75 1.75 0 0 1 0 14.25Z" />
											<path d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0 1 14.25 11h-7.5A1.75 1.75 0 0 1 5 9.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z" />
										</svg>
									)}
								</button>
							</div>
						</div>
					</Show>
				</div>

				<SettingToggle
					checked={ipv6Enabled()}
					onChange={(val) => {
						setIpv6Enabled(val);
						saveConfigField((c) => {
							c.services.server.ipv6_enabled = val;
						});
					}}
					label={t("services.toggle.enableIpv6", "Enable IPv6 (dual-stack)")}
					hint={t(
						"services.hint.ipv6Description",
						"Binds the server to both IPv4 and IPv6 addresses. Requires save + server restart.",
					)}
				/>

				<SettingToggle
					checked={lanAuthBypass()}
					onChange={(val) => {
						setLanAuthBypass(val);
						saveConfigField((c) => {
							c.services.auth.lan_auth_bypass = val;
						});
					}}
					label={t("services.toggle.lanAuthBypass", "Allow LAN access without authentication")}
					hint={
						lanAuthBypass()
							? t(
									"services.hint.lanAuthBypassWarning",
									"Devices on your local network can access without a password. Only use on trusted networks.",
								)
							: t(
									"services.hint.lanAuthBypassDescription",
									"Skips authentication for private/LAN IP addresses (RFC1918, Tailscale, IPv6 ULA)",
								)
					}
					hintStyle={lanAuthBypass() ? { color: "var(--warning, #e5c07b)" } : undefined}
				/>
			</Show>

			{/* ── Tailscale TLS ── */}
			<Show when={tailscaleState()}>
				{(() => {
					const ts = tailscaleState()!;
					const statusText =
						ts.state === "Running"
							? ts.https_enabled
								? `HTTPS active (${ts.fqdn})`
								: "Running (HTTPS not enabled)"
							: ts.state === "NotRunning"
								? "Not running"
								: "Not installed";
					const showHint = ts.state === "Running" && !ts.https_enabled;
					return (
						<>
							<h3>Tailscale HTTPS</h3>
							<div class={s.group}>
								<div class={s.row}>
									<span class={s.label}>{t("services.label.tailscaleStatus", "Status")}</span>
									<span class={s.value}>
										{statusText}
										<button
											class={s.inlineBtn}
											onClick={async () => {
												try {
													const updated = await rpc<TailscaleStatus>("recheck_tailscale_status");
													setTailscaleState(updated);
												} catch (e) {
													appLogger.error("tailscale", "Recheck failed", e);
												}
											}}
											title={t("services.action.recheckTailscale", "Recheck Tailscale status")}
										>
											{t("services.action.recheck", "Recheck")}
										</button>
									</span>
								</div>
								<Show when={showHint}>
									<p class={s.hint}>
										{t(
											"services.hint.tailscaleEnableHttps",
											"Enable HTTPS certificates in your Tailscale admin console to serve the PWA over HTTPS.",
										)}
									</p>
								</Show>
							</div>
						</>
					);
				})()}
			</Show>

			{/* ── Cloud Relay ── */}
			<h3>{t("services.heading.cloudRelay", "Cloud Relay")}</h3>

			<SettingToggle
				checked={relayEnabled()}
				onChange={(val) => {
					setRelayEnabled(val);
					if (val && !relaySessionId()) {
						const id = crypto.randomUUID();
						setRelaySessionId(id);
						saveConfigField((c) => {
							c.services.relay.enabled = val;
							c.services.relay.session_id = id;
						});
					} else {
						saveConfigField((c) => {
							c.services.relay.enabled = val;
						});
					}
				}}
				label={t("services.toggle.enableRelay", "Enable cloud relay")}
				hint={t(
					"services.hint.relayDescription",
					"Connect from anywhere via an encrypted WebSocket relay. No port forwarding or VPN needed. Note: traffic is encrypted in transit, but the relay operator can derive the key — this is not end-to-end encryption.",
				)}
			/>

			<Show when={relayEnabled()}>
				<div class={s.group}>
					<div class={s.mcpStatusRow}>
						<span class={cx(s.mcpStatusDot, relayConnected() && s.running)} />
						<span class={s.mcpStatusText}>
							{relayConnected()
								? t("services.relay.connected", "Connected")
								: t("services.relay.disconnected", "Disconnected")}
						</span>
					</div>
					<p class={s.hint} style={{ color: "var(--warning, #e5c07b)" }}>
						{t("services.hint.relayRestart", "Changes require an app restart to take effect.")}
					</p>
				</div>

				<SettingInput
					label={t("services.label.relayUrl", "Relay Server URL")}
					value={relayUrl()}
					onInput={(v) => {
						setRelayUrl(v);
						saveConfigField((c) => {
							c.services.relay.url = v;
						});
					}}
					placeholder="wss://relay.tuicommander.com"
				/>

				<SettingInput
					label={t("services.label.relayToken", "Bearer Token")}
					value={relayToken()}
					onInput={(v) => {
						setRelayToken(v);
						saveConfigField((c) => {
							c.services.relay.token = v;
							c.services.relay.token_exists = v.length > 0;
						});
					}}
					type="password"
					placeholder={t("services.placeholder.relayToken", "Paste token from relay server registration")}
					hint={t(
						"services.hint.relayToken",
						"Obtained from the relay server's /register endpoint. Used for both authentication and encryption key derivation — because the relay receives this token, it can derive the key, so traffic is not end-to-end encrypted.",
					)}
				/>

				<div class={s.group}>
					<label>{t("services.label.relaySessionId", "Session ID")}</label>
					<div class={s.passwordRow}>
						<input type="text" class={s.input} value={relaySessionId()} readOnly />
						<button
							class={s.toggleBtn}
							onClick={() => {
								const id = crypto.randomUUID();
								setRelaySessionId(id);
								saveConfigField((c) => {
									c.services.relay.session_id = id;
								});
							}}
							title={t("services.btn.regenerateSessionId", "Generate new session ID")}
						>
							<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
								<path d="M8 3a5 5 0 1 0 4.546 2.914.5.5 0 0 1 .908-.417A6 6 0 1 1 8 2z" />
								<path d="M8 4.466V.534a.25.25 0 0 1 .41-.192l2.36 1.966c.12.1.12.284 0 .384L8.41 4.658A.25.25 0 0 1 8 4.466" />
							</svg>
						</button>
					</div>
					<p class={s.hint}>
						{t(
							"services.hint.relaySessionId",
							"Shared with the mobile client to join the same relay room. Regenerating disconnects the current mobile session.",
						)}
					</p>
				</div>
			</Show>

			{/* ── TUIC Tools ── */}
			<h3>TUIC Tools</h3>
			<div class={s.group}>
				<p class={s.hint}>Native tools exposed via MCP. Disable tools to restrict what AI agents can access.</p>
			</div>

			<div class={s.group}>
				<button
					class={s.mcpDisclosure}
					onClick={() => {
						const opening = !bridgeInfoOpen();
						setBridgeInfoOpen(opening);
						if (opening && !bridgeInfo()) {
							rpc<{ bridge_path: string; config_snippet: string }>("get_mcp_bridge_info")
								.then(setBridgeInfo)
								.catch((e) => appLogger.warn("config", "Failed to fetch bridge info", e));
						}
					}}
				>
					<span class={s.mcpDisclosureArrow}>{bridgeInfoOpen() ? "▼" : "▶"}</span>
					Manual MCP configuration
				</button>
				<Show when={bridgeInfoOpen() && bridgeInfo()}>
					<div class={s.mcpDisclosureBody}>
						<p class={s.hint} style={{ margin: "0 0 4px" }}>
							Bridge path: <code class={s.mcpCode}>{bridgeInfo()!.bridge_path}</code>
						</p>
						<p class={s.hint} style={{ margin: "0 0 6px" }}>
							Add this to your MCP client config (e.g. <code class={s.mcpCode}>~/.claude.json</code> under{" "}
							<code class={s.mcpCode}>mcpServers</code>):
						</p>
						<div class={s.mcpSnippetWrap}>
							<pre class={s.mcpSnippetPre}>{bridgeInfo()!.config_snippet}</pre>
							<button
								class={s.mcpSnippetCopy}
								onClick={() => {
									writeClipboard(bridgeInfo()!.config_snippet)
										.then(() => {
											setSnippetCopied(true);
											setTimeout(() => setSnippetCopied(false), 2000);
										})
										.catch((err) => {
											appLogger.warn("settings", "Clipboard write failed", { error: String(err) });
										});
								}}
							>
								{snippetCopied() ? "Copied" : "Copy"}
							</button>
						</div>
					</div>
				</Show>
			</div>

			<div class={s.group} style={{ display: "flex", "align-items": "center", gap: "8px", padding: "4px 0" }}>
				<div class={s.toggle} style={{ "margin-right": "4px" }}>
					<input
						type="checkbox"
						checked={collapseTools()}
						onChange={(e) => {
							const enabled = e.currentTarget.checked;
							setCollapseTools(enabled);
							saveConfigField((c) => {
								(c as AppConfig & { collapse_tools: boolean }).collapse_tools = enabled;
							});
						}}
					/>
				</div>
				<div style={{ display: "flex", "align-items": "center", gap: "6px" }}>
					<span style={{ "font-weight": 500, "font-size": "13px" }}>
						Collapse tools — Speakeasy MCP (reduces AI context ~98%)
					</span>
					<span class={s.infoBadge}>
						?
						<span class={s.infoBadgeTip}>
							When enabled, MCP clients only see three meta-tools (search_tools, get_tool_schema, call_tool) and
							discover the full tool set on demand. Drastically reduces token usage for clients that don't need every
							tool upfront.
						</span>
					</span>
				</div>
			</div>
			<For each={NATIVE_TOOLS}>
				{(tool) => {
					const disabled = () => disabledNativeTools().includes(tool.name);
					return (
						<div class={s.group} style={{ display: "flex", "align-items": "center", gap: "8px", padding: "4px 0" }}>
							<div class={s.toggle} style={{ "margin-right": "4px" }}>
								<input
									type="checkbox"
									checked={!disabled()}
									onChange={(e) => {
										const enabled = e.currentTarget.checked;
										const updated = enabled
											? disabledNativeTools().filter((n) => n !== tool.name)
											: [...disabledNativeTools(), tool.name];
										setDisabledNativeTools(updated);
										saveConfigField((c) => {
											(c as AppConfig & { disabled_native_tools: string[] }).disabled_native_tools = updated;
										});
									}}
								/>
							</div>
							<div style={{ display: "flex", "align-items": "center", gap: "6px" }}>
								<span style={{ "font-weight": 500, "font-size": "13px", "font-family": "monospace" }}>{tool.name}</span>
								<span class={s.hint} style={{ margin: 0 }}>
									{tool.description}
								</span>
								<span class={s.infoBadge}>
									?<span class={s.infoBadgeTip}>{tool.actions}</span>
								</span>
							</div>
						</div>
					);
				}}
			</For>
		</>
	);
};

export const ServicesTab: Component = () => (
	<div class={s.section}>
		<LocalServicesPanel />
		<UpstreamMcpPanel />
		<RemoteMachinesPanel />
		<p class={s.hint} style={{ "margin-top": "16px", color: "var(--text-dimmed)" }}>
			{t("services.hint.autoSave", "Settings are saved automatically when changed")}
		</p>
	</div>
);
