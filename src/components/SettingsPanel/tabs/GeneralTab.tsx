import { type Component, createSignal, For, onMount, Show } from "solid-js";
import { AVAILABLE_LOCALES, localeName, t } from "../../../i18n";
import { invoke } from "../../../invoke";
import { isMacOS } from "../../../platform";
import { appLogger } from "../../../stores/appLogger";
import type {
	CloseBehavior,
	CustomLauncher,
	IdeType,
	TrayIconPreference,
	UpdateChannel,
} from "../../../stores/settings";
import { IDE_NAMES, settingsStore } from "../../../stores/settings";
import { updaterStore } from "../../../stores/updater";
import { isTauri } from "../../../transport";
import { Button } from "../../ui/Button";
import { Input } from "../../ui/Input";
import { Textarea } from "../../ui/Textarea";
import { ExpertSetting } from "../ExpertSetting";
import { SettingInput, SettingSelect, SettingSlider, SettingToggle } from "../SettingFields";
import s from "../Settings.module.css";
import { SectionCard, SettingPageHeader, SettingRow, StatusSummary } from "../SettingsPrimitives";

interface CliStatus {
	installed: boolean;
	path: string | null;
	version_match: boolean;
	auto_updatable: boolean;
	prompt_dismissed: boolean;
}

interface MdkbStatus {
	available: boolean;
	connected: boolean;
	binaryPath: string | null;
	version: string | null;
}

export const GeneralTab: Component = () => {
	const [cliStatus, setCliStatus] = createSignal<CliStatus | null>(null);
	const [cliInstalling, setCliInstalling] = createSignal(false);
	const [mdkbStatus, setMdkbStatus] = createSignal<MdkbStatus | null>(null);
	const [mdkbError, setMdkbError] = createSignal<string | null>(null);

	const refreshCliStatus = async () => {
		if (!isTauri()) return;
		try {
			const status = await invoke<CliStatus>("get_cli_status");
			setCliStatus(status);
		} catch (err) {
			appLogger.error("app", "Failed to get CLI status", err);
		}
	};

	const refreshMdkbStatus = async () => {
		if (!isTauri()) return;
		try {
			const status = await invoke<MdkbStatus>("mdkb_status");
			setMdkbStatus(status);
		} catch (err) {
			appLogger.error("app", "Failed to get mdkb status", err);
		}
	};

	onMount(() => {
		refreshCliStatus();
		refreshMdkbStatus();
	});

	const handleInstallCli = async () => {
		setCliInstalling(true);
		try {
			await invoke<string>("install_cli");
			await refreshCliStatus();
		} catch (err) {
			appLogger.error("app", "Failed to install CLI", err);
		} finally {
			setCliInstalling(false);
		}
	};

	const handleUninstallCli = async () => {
		try {
			await invoke("uninstall_cli");
			await refreshCliStatus();
		} catch (err) {
			appLogger.error("app", "Failed to uninstall CLI", err);
		}
	};

	const handleUninstallMdkb = async () => {
		setMdkbError(null);
		try {
			await invoke("uninstall_mdkb");
			await refreshMdkbStatus();
		} catch (err) {
			const msg = typeof err === "string" ? err : String(err);
			setMdkbError(msg);
			appLogger.error("app", "Failed to uninstall mdkb", err);
		}
	};

	const ideOptions = Object.entries(IDE_NAMES).map(([value, label]) => ({ value, label }));

	// --- Custom launchers (GH #71) ---
	const launchers = (): CustomLauncher[] => settingsStore.state.customLaunchers;
	const updateLauncher = (id: string, patch: Partial<CustomLauncher>) =>
		settingsStore.setCustomLaunchers(launchers().map((l) => (l.id === id ? { ...l, ...patch } : l)));
	const addLauncher = () =>
		settingsStore.setCustomLaunchers([
			...launchers(),
			{ id: crypto.randomUUID(), name: "New tool", executable: "", args: [], enabled: true },
		]);
	const removeLauncher = (id: string) => settingsStore.setCustomLaunchers(launchers().filter((l) => l.id !== id));

	const languageOptions = AVAILABLE_LOCALES.map((value) => ({ value, label: localeName(value) }));

	const updateChannelOptions = [
		{ value: "stable", label: t("general.channel.stable", "Stable") },
		{ value: "nightly", label: t("general.channel.nightly", "Nightly") },
	];

	return (
		<div class={`${s.section} ${s.applicationPage}`}>
			<SettingPageHeader title="General" breadcrumb="Application / General" scope="Application defaults" />
			<SectionCard title={t("general.heading.updates", "Updates")}>
				<StatusSummary
					label="Update status"
					actions={
						<Button
							data-non-setting="Explicit update discovery; does not change update preferences"
							class={s.testBtn}
							onClick={() => {
								updaterStore
									.checkForUpdate()
									.catch((err: unknown) => appLogger.debug("app", "Update check failed", err));
							}}
							disabled={updaterStore.state.checking || updaterStore.state.downloading}
						>
							{updaterStore.state.checking
								? t("general.btn.checking", "Checking...")
								: t("general.btn.checkNow", "Check Now")}
						</Button>
					}
					details={
						<>
							{" "}
							<Show when={updaterStore.state.available && updaterStore.state.version}>
								<p class={s.hint} style={{ color: "var(--success)" }}>
									{t("general.hint.updateAvailable", "Version {version} is available!", {
										version: updaterStore.state.version ?? "",
									})}
								</p>
							</Show>
							<Show
								when={
									!updaterStore.state.available &&
									!updaterStore.state.checking &&
									!updaterStore.state.error &&
									!updaterStore.state.noRelease &&
									!updaterStore.state.unsupported
								}
							>
								<p class={s.hint}>{t("general.hint.latestVersion", "You are on the latest version")}</p>
							</Show>
							<Show when={updaterStore.state.unsupported}>
								<p class={s.hint} style={{ color: "var(--fg-muted)" }}>
									{updaterStore.state.unsupported}
								</p>
							</Show>
							<Show when={updaterStore.state.noRelease}>
								<p class={s.hint} style={{ color: "var(--fg-muted)" }}>
									{t("general.hint.noRelease", "No {channel} releases published yet", {
										channel: settingsStore.state.updateChannel,
									})}
								</p>
							</Show>
							<Show when={updaterStore.state.error}>
								<p class={s.hint} style={{ color: "var(--accent-red, #f44747)" }}>
									{updaterStore.state.error}
								</p>
							</Show>
						</>
					}
				/>
				<SettingToggle
					settingId="app.auto_update_enabled"
					row
					checked={settingsStore.state.autoUpdateEnabled}
					onChange={(v) => settingsStore.setAutoUpdateEnabled(v)}
					label={t("general.toggle.autoUpdateEnabled", "Automatically check for updates")}
					hint={t("general.hint.autoUpdateEnabled", "Download and install updates in the background")}
				/>

				<SettingToggle
					settingId="app.defer_update_relaunch"
					row
					checked={settingsStore.state.deferUpdateRelaunch}
					onChange={(v) => settingsStore.setDeferUpdateRelaunch(v)}
					label={t("general.toggle.deferUpdateRelaunch", "Wait for agents before restarting")}
					hint={t(
						"general.hint.deferUpdateRelaunch",
						"After an update installs, restart only when no session is busy or waiting for input",
					)}
				/>

				<SettingToggle
					settingId="app.eager_resume_after_update"
					row
					checked={settingsStore.state.eagerResumeAfterUpdate}
					onChange={(v) => settingsStore.setEagerResumeAfterUpdate(v)}
					label={t("general.toggle.eagerResumeAfterUpdate", "Resume all agents after an update")}
					hint={t(
						"general.hint.eagerResumeAfterUpdate",
						"After the app restarts for an update, resume every agent tab with a confirmed session on every branch, without visiting each one",
					)}
				/>

				<ExpertSetting configKey="app.update_channel" value={settingsStore.state.updateChannel}>
					<SettingSelect
						settingId="app.update_channel"
						row
						label={t("general.label.updateChannel", "Update Channel")}
						value={settingsStore.state.updateChannel}
						onChange={(v) => settingsStore.setUpdateChannel(v as UpdateChannel)}
						options={updateChannelOptions}
						hint={
							settingsStore.state.updateChannel !== "stable"
								? t("general.hint.updateChannelWarning", "Nightly builds may be unstable")
								: t("general.hint.updateChannel", "Choose which release channel to receive updates from")
						}
						hintStyle={
							settingsStore.state.updateChannel !== "stable" ? { color: "var(--warning, #e5c07b)" } : undefined
						}
					/>
				</ExpertSetting>
			</SectionCard>
			<Show when={isTauri()}>
				<SectionCard title="Local tools">
					<Show when={isTauri() && cliStatus()}>
						<SettingRow
							label={t("general.heading.cli", "fastaf CLI")}
							hint={
								cliStatus()?.installed
									? `${t("general.hint.cliInstalled", "Installed at {path}", { path: cliStatus()?.path ?? "/usr/local/bin/fastaf" })}${!cliStatus()?.version_match ? ` ${cliStatus()?.auto_updatable ? t("general.hint.cliOutdated", "(update pending — restart to apply)") : t("general.hint.cliUpdateAvailable", "(update available)")}` : ""}`
									: t(
											"general.hint.cliNotInstalled",
											"Install the fastaf CLI to control FastAF from any terminal or script. Open files and URLs as tabs, manage PTY sessions, and query repository status. Useful for scripting automation.",
										)
							}
							help={t("general.hint.cliInfo", "Control terminals, tabs and repositories from scripts.")}
						>
							{() => (
								<div>
									<Show when={!cliStatus()?.installed || !cliStatus()?.version_match}>
										<Button
											data-non-setting="Install, update or remove an optional CLI binary; not a stored setting"
											class={s.testBtn}
											onClick={handleInstallCli}
											disabled={cliInstalling()}
										>
											{cliInstalling()
												? t("general.btn.installing", "Installing...")
												: cliStatus()?.installed
													? t("general.btn.updateCli", "Update")
													: t("general.btn.installCli", "Install fastaf CLI")}
										</Button>
									</Show>
									<Show when={cliStatus()?.installed}>
										<Button
											data-non-setting="Install, update or remove an optional CLI binary; not a stored setting"
											class={s.testBtn}
											onClick={handleUninstallCli}
										>
											{t("general.btn.uninstallCli", "Uninstall")}
										</Button>
									</Show>
								</div>
							)}
						</SettingRow>
					</Show>
					<Show when={isTauri()}>
						<SettingRow
							label={t("general.heading.codeIntelligence", "Code Intelligence")}
							hint={
								mdkbStatus()?.available
									? `${t("general.hint.mdkbInstalled", "Installed at {path}", { path: mdkbStatus()?.binaryPath ?? "unknown" })}${mdkbStatus()?.version ? ` v${mdkbStatus()?.version}` : ""}`
									: t(
											"general.hint.mdkbNotInstalled",
											"Install mdkb on your PATH to enable outline, go-to-definition and find references in the code editor. FastAF picks it up on its own.",
										)
							}
							error={mdkbError() ?? undefined}
							help={t("general.hint.codeIntelligenceInfo", "Code navigation, symbol outlines and agent memory.")}
						>
							{() => (
								<Show when={mdkbStatus()?.available}>
									<Button
										data-non-setting="Install, update or remove an optional CLI binary; not a stored setting"
										class={s.testBtn}
										onClick={handleUninstallMdkb}
									>
										{t("general.btn.uninstallMdkb", "Uninstall")}
									</Button>
								</Show>
							)}
						</SettingRow>
					</Show>
					<Show when={isTauri()}>
						<>
							<div>
								<SettingRow
									label={t("general.heading.customLaunchers", "Custom Launchers")}
									help={
										<>
											{t(
												"general.hint.customLaunchers",
												'Define your own tools for the "Open in" menu. Each argument may use {path}, {file}, {fileDir}, {repo}, {cwd}, {home}, {line}, {column} placeholders. One argument per line.',
											)}
										</>
									}
									hint={launchers().length ? `${launchers().length} custom launchers` : "No custom launchers"}
								>
									{() => (
										<Button
											data-non-setting="Create or remove a stable custom-launcher record through its owner"
											class={s.testBtn}
											onClick={addLauncher}
										>
											{t("general.btn.addLauncher", "Add launcher")}
										</Button>
									)}
								</SettingRow>
								<For each={launchers()}>
									{(launcher) => (
										<div
											class={s.group}
											style={{
												border: "1px solid var(--border)",
												"border-radius": "var(--radius-md)",
												padding: "8px",
												"margin-bottom": "8px",
											}}
										>
											<div style={{ display: "flex", gap: "8px", "align-items": "center", "margin-bottom": "6px" }}>
												<input
													data-setting-id="app.custom_launchers.{id}.enabled"
													type="checkbox"
													checked={launcher.enabled}
													title={t("general.label.launcherEnabled", "Enabled")}
													onChange={(e) => updateLauncher(launcher.id, { enabled: e.currentTarget.checked })}
												/>
												<Input
													data-setting-id="app.custom_launchers.{id}.name"
													type="text"
													value={launcher.name}
													placeholder={t("general.placeholder.launcherName", "Name")}
													onInput={(e) => updateLauncher(launcher.id, { name: e.currentTarget.value })}
													style={{ flex: "1" }}
												/>
												<Button
													data-non-setting="Create or remove a stable custom-launcher record through its owner"
													class={s.testBtn}
													onClick={() => removeLauncher(launcher.id)}
												>
													{t("general.btn.remove", "Remove")}
												</Button>
											</div>
											<Input
												data-setting-id="app.custom_launchers.{id}.executable"
												type="text"
												value={launcher.executable}
												placeholder={t(
													"general.placeholder.launcherExec",
													"Executable (e.g. code, or /usr/local/bin/code)",
												)}
												onInput={(e) => updateLauncher(launcher.id, { executable: e.currentTarget.value })}
												style={{ width: "100%", "margin-bottom": "6px" }}
											/>
											<Textarea
												data-setting-id="app.custom_launchers.{id}.args"
												value={launcher.args.join("\n")}
												placeholder={"--goto\n{file}:{line}:{column}"}
												rows={3}
												onInput={(e) => updateLauncher(launcher.id, { args: e.currentTarget.value.split("\n") })}
												style={{ width: "100%", "font-family": "var(--font-mono)", "font-size": "var(--font-sm)" }}
											/>
										</div>
									)}
								</For>
							</div>
						</>
					</Show>
				</SectionCard>
			</Show>
			<SectionCard title={t("general.heading.general", "General")}>
				{/* A picker with one option is not a choice. */}
				<Show when={AVAILABLE_LOCALES.length > 1}>
					<SettingSelect
						settingId="app.language"
						row
						label={t("general.label.language", "Language")}
						value={settingsStore.state.language}
						onChange={(v) => settingsStore.setLanguage(v)}
						options={languageOptions}
						hint={t("general.hint.language", "Language of the FastAF interface")}
					/>
				</Show>

				<SettingToggle
					settingId="app.show_last_prompt"
					row
					checked={settingsStore.state.showLastPrompt}
					onChange={(v) => settingsStore.setShowLastPrompt(v)}
					label="Show agent context bar"
					hint="Display the model's current intent, its orchestrator-assigned task, and the last prompt sent to an agent"
				/>

				<SettingToggle
					settingId="app.import_tools_enabled"
					row
					checked={settingsStore.state.importToolsEnabled}
					onChange={(v) => settingsStore.setImportToolsEnabled(v)}
					label={t("general.toggle.importToolsEnabled", "Import from other tools")}
					hint={t(
						"general.hint.importToolsEnabled",
						"Show 'Import from Claude Code / Codex / Cursor / superset.sh' in the Add Repository menu",
					)}
				/>
			</SectionCard>
			<SectionCard title={t("general.heading.confirmations", "Confirmations")}>
				<Show when={isTauri()}>
					<SettingSelect
						settingId="app.close_behavior"
						unavailableValues={settingsStore.state.trayIcon === "never" ? ["background"] : []}
						row
						label={t("general.label.closeBehavior", "When closing the main window")}
						value={settingsStore.state.closeBehavior}
						onChange={(value) => settingsStore.setCloseBehavior(value as CloseBehavior)}
						options={[
							{ value: "ask", label: t("general.closeBehavior.ask", "Ask") },
							{ value: "background", label: t("general.closeBehavior.background", "Background") },
							{ value: "quit", label: t("general.closeBehavior.quit", "Quit") },
						]}
						hint={t(
							"general.hint.closeBehavior",
							"Background hides visible windows and keeps sessions running. Quit still confirms when enabled.",
						)}
					/>
				</Show>

				<Show when={isTauri()}>
					<SettingSelect
						settingId="app.background.tray_icon"
						row
						label={t("general.label.trayIcon", "Tray and menu-bar icon")}
						value={settingsStore.state.trayIcon}
						onChange={(value) => settingsStore.setTrayIcon(value as TrayIconPreference)}
						options={[
							{ value: "always", label: t("general.trayIcon.always", "Always") },
							{ value: "background_only", label: t("general.trayIcon.backgroundOnly", "Only in background") },
							{ value: "never", label: t("general.trayIcon.never", "Never") },
						]}
						hint={t(
							"general.hint.trayIcon",
							"Never disables Background. Without a tray host, including stock GNOME, closing minimizes the window so it remains reachable.",
						)}
					/>
				</Show>

				<Show when={isTauri() && isMacOS()}>
					<SettingToggle
						settingId="app.background.hide_dock_icon"
						row
						checked={settingsStore.state.hideDockIcon}
						onChange={(enabled) => settingsStore.setHideDockIcon(enabled)}
						label={t("general.toggle.hideDockIcon", "Hide Dock icon in background")}
						hint={t("general.hint.hideDockIcon", "Restore the Dock icon when FastAF is shown again")}
					/>
				</Show>
				<SettingToggle
					settingId="app.confirm_before_quit"
					row
					checked={settingsStore.state.confirmBeforeQuit}
					onChange={(v) => settingsStore.setConfirmBeforeQuit(v)}
					label={t("general.toggle.confirmBeforeQuit", "Confirm before quitting")}
					hint={t("general.hint.confirmBeforeQuit", "Confirm real quit when terminal sessions are active")}
				/>

				<SettingToggle
					settingId="app.confirm_before_closing_tab"
					row
					checked={settingsStore.state.confirmBeforeClosingTab}
					onChange={(v) => settingsStore.setConfirmBeforeClosingTab(v)}
					label={t("general.toggle.confirmBeforeClosingTab", "Confirm before closing a tab")}
					hint={t("general.hint.confirmBeforeClosingTab", "Show a confirmation dialog when closing a terminal tab")}
				/>
			</SectionCard>
			<SectionCard title={t("general.heading.powerManagement", "Power Management")}>
				<SettingToggle
					settingId="app.prevent_sleep_when_busy"
					row
					checked={settingsStore.state.preventSleepWhenBusy}
					onChange={(v) => settingsStore.setPreventSleepWhenBusy(v)}
					label={t("general.toggle.preventSleepWhenBusy", "Prevent sleep when busy")}
					hint={t("general.hint.preventSleepWhenBusy", "Keep the system awake while scripts are running")}
				/>

				<ExpertSetting configKey="app.standby_timeout_minutes" value={settingsStore.state.standbyTimeoutMinutes}>
					<SettingSlider
						settingId="app.standby_timeout_minutes"
						row
						label="Auto-Standby Timeout"
						value={settingsStore.state.standbyTimeoutMinutes}
						onChange={(v) => settingsStore.setStandbyTimeoutMinutes(v)}
						min={0}
						max={60}
						step={1}
						formatValue={(v) => (v === 0 ? "Off" : `${v} min`)}
						hint="Pause idle background sessions after this duration to save resources. 0 = disabled."
					/>
				</ExpertSetting>

				<ExpertSetting configKey="app.index_strategy" value={settingsStore.state.indexStrategy}>
					<SettingSelect
						settingId="app.index_strategy"
						row
						label="Content Indexing"
						value={settingsStore.state.indexStrategy}
						onChange={(v) =>
							settingsStore.setIndexStrategy(v as "active_only" | "active_and_switch" | "all_sequential" | "disabled")
						}
						options={[
							{ value: "disabled", label: "Disabled" },
							{ value: "active_only", label: "Active repo only" },
							{ value: "active_and_switch", label: "Active + on switch" },
							{ value: "all_sequential", label: "All repos at boot" },
						]}
						hint="When to build search indexes. Set to Disabled to turn off background indexing entirely."
					/>
				</ExpertSetting>
			</SectionCard>
			<SectionCard title="Resource Limits">
				<ExpertSetting configKey="app.index_memory_budget_mb" value={settingsStore.state.indexMemoryBudgetMb}>
					<SettingInput
						settingId="app.index_memory_budget_mb"
						row
						type="number"
						label="Content index memory budget (MB)"
						value={String(settingsStore.state.indexMemoryBudgetMb)}
						onInput={(value) => value.trim() !== "" && settingsStore.setIndexMemoryBudgetMb(Number(value))}
						hint="Total memory available for content search indexes before older indexes are dropped."
					/>
				</ExpertSetting>
				<ExpertSetting configKey="app.attachment_max_bytes" value={settingsStore.state.attachmentMaxBytes}>
					<SettingInput
						settingId="app.attachment_max_bytes"
						row
						type="number"
						label="Maximum attachment size (bytes)"
						value={String(settingsStore.state.attachmentMaxBytes)}
						onInput={(value) => value.trim() !== "" && settingsStore.setAttachmentMaxBytes(Number(value))}
						hint="Maximum size of one attachment. Existing attachments are not changed."
					/>
				</ExpertSetting>
				<Show when={isTauri()}>
					<ExpertSetting
						configKey="app.background.webview_unload_minutes"
						value={settingsStore.state.webviewUnloadMinutes}
					>
						<SettingInput
							settingId="app.background.webview_unload_minutes"
							row
							type="number"
							label="Background WebView unload delay (minutes)"
							value={String(settingsStore.state.webviewUnloadMinutes)}
							onInput={(value) => value.trim() !== "" && settingsStore.setWebviewUnloadMinutes(Number(value))}
							hint="Unload the hidden WebView after this delay. Zero keeps it loaded; terminal sessions keep running."
						/>
					</ExpertSetting>
				</Show>
			</SectionCard>

			<SectionCard title={t("developerTools.heading.ide", "IDE")}>
				<SettingSelect
					settingId="app.ide"
					row
					label={t("general.label.defaultIde", "Default IDE")}
					value={settingsStore.state.ide}
					onChange={(v) => settingsStore.setIde(v as IdeType)}
					options={ideOptions}
					hint={t("general.hint.defaultIde", "IDE used to open repositories")}
				/>
			</SectionCard>

			<SectionCard title={t("general.heading.experimental", "Experimental Features")}>
				<div class={s.group}>
					<p class={s.warning}>
						{t("general.hint.experimentalWarning", "These features are under active development and may be unstable.")}
					</p>
					<SettingToggle
						settingId="app.experimental_features_enabled"
						row
						checked={settingsStore.state.experimentalFeaturesEnabled}
						onChange={(enabled) => settingsStore.setExperimentalFeaturesEnabled(enabled)}
						label={t("general.toggle.experimentalFeatures", "Enable experimental features")}
						hint={t(
							"general.hint.experimentalFeatures",
							"Opt in to features under active development: the AI Chat panel and SSH Tunnels.",
						)}
					/>
					<Show when={settingsStore.state.experimentalFeaturesEnabled}>
						<SettingToggle
							settingId="app.ai_chat_enabled"
							row
							checked={settingsStore.state.aiChatEnabled}
							onChange={(v) => settingsStore.setAiChatEnabled(v)}
							label={t("general.toggle.aiChat", "AI Chat")}
							hint={t("general.hint.aiChat", "Enable the AI Chat panel, keyboard shortcut, and command palette entry.")}
						/>
					</Show>
				</div>
			</SectionCard>
		</div>
	);
};
