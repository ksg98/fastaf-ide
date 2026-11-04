import { type Component, createSignal, For, Show } from "solid-js";
import { t } from "../../../i18n";
import { multiviewStore } from "../../../stores/multiview";
import type { RepoGroup } from "../../../stores/repositories";
import { repositoriesStore } from "../../../stores/repositories";
import { settingsStore } from "../../../stores/settings";
import { transcriptPreferences } from "../../../stores/transcriptPreferences";
import { uiStore } from "../../../stores/ui";
import { getThemeNames } from "../../../themes";
import { syncVibrancy } from "../../../vibrancy";
import { applyAppZoom } from "../../../zoom";
import { ZOOM_MAX, ZOOM_MIN } from "../../../zoomLevels";
import { UiLegend } from "../../HelpPanel/UiLegend";
import { ColorSwatchPicker } from "../../shared/ColorSwatchPicker";
import { DEFAULT_COLOR_PRESETS } from "../../shared/colorPresets";
import { Button } from "../../ui/Button";
import { Input } from "../../ui/Input";
import { SettingSelect, SettingSlider, SettingToggle } from "../SettingFields";
import s from "../Settings.module.css";
import { SectionCard, SettingPageHeader } from "../SettingsPrimitives";

/** Preset colors for groups and sidebar */
export { DEFAULT_COLOR_PRESETS as PRESET_COLORS } from "../../shared/colorPresets";

/** Single group row in the settings list */
const GroupSettingsItem: Component<{
	group: RepoGroup;
}> = (props) => {
	const [editing, setEditing] = createSignal(false);
	const [editName, setEditName] = createSignal(props.group.name);
	const [nameError, setNameError] = createSignal("");

	const commitRename = () => {
		const name = editName().trim();
		if (!name) {
			setNameError(t("groups.error.nameEmpty", "Name cannot be empty"));
			return;
		}
		const ok = repositoriesStore.renameGroup(props.group.id, name);
		if (!ok) {
			setNameError(t("groups.error.nameExists", "A group with this name already exists"));
			return;
		}
		setNameError("");
		setEditing(false);
	};

	const cancelEdit = () => {
		setEditName(props.group.name);
		setNameError("");
		setEditing(false);
	};

	return (
		<div class={s.groupItem}>
			<div class={s.groupRow}>
				<Show
					when={editing()}
					fallback={
						<span class={s.groupName} onDblClick={() => setEditing(true)}>
							{props.group.name}
						</span>
					}
				>
					<Input
						data-setting-id="repositories_registration.groups.{id}.name"
						class={s.groupNameInput}
						aria-label={`Group name: ${props.group.name}`}
						aria-invalid={!!nameError()}
						value={editName()}
						onInput={(e) => {
							setEditName(e.currentTarget.value);
							setNameError("");
						}}
						onKeyDown={(e) => {
							if (e.key === "Enter") commitRename();
							if (e.key === "Escape") cancelEdit();
						}}
						autofocus
					/>
				</Show>
				<Button
					variant="ghost"
					data-non-setting="Create or remove a stable repository group through its owner"
					class={s.groupDeleteBtn}
					onClick={() => repositoriesStore.deleteGroup(props.group.id)}
					title={t("groups.btn.deleteGroup", "Delete group")}
					aria-label={`${t("groups.btn.deleteGroup", "Delete group")}: ${props.group.name}`}
				>
					×
				</Button>
			</div>
			<Show when={nameError()}>
				<div class={s.groupNameError}>{nameError()}</div>
			</Show>
			<ColorSwatchPicker
				settingId="repositories_registration.groups.{id}.color"
				color={props.group.color}
				presets={DEFAULT_COLOR_PRESETS}
				onChange={(c) => repositoriesStore.setGroupColor(props.group.id, c)}
			/>
		</div>
	);
};

const themeOptions = () => Object.entries(getThemeNames()).map(([value, label]) => ({ value, label }));

export const AppearanceTab: Component = () => {
	const groups = () =>
		repositoriesStore.state.groupOrder.map((id) => repositoriesStore.state.groups[id]).filter(Boolean);

	return (
		<div class={`${s.section} ${s.applicationPage}`}>
			<SettingPageHeader title="Appearance" breadcrumb="Application / Appearance" scope="Application defaults" />
			{/* The theme sets the whole app's look (Codex Dark, Cursor Dark…), terminals
			    included, so it opens Appearance rather than sitting under Terminal. */}
			<SectionCard title={t("appearance.heading.theme", "Theme")}>
				<SettingSelect
					settingId="app.theme"
					row
					label={t("appearance.label.appTheme", "App theme")}
					value={settingsStore.state.theme}
					onChange={(v) => settingsStore.setTheme(v)}
					options={themeOptions()}
					hint={t("appearance.hint.appTheme", "The look of the whole app: chrome, panels and terminals")}
				/>
				<Show when={/Mac/.test(navigator.platform)}>
					<SettingToggle
						settingId="app.reduce_transparency"
						row
						checked={settingsStore.state.reduceTransparency}
						onChange={(v) => {
							settingsStore.setReduceTransparency(v);
							// Live: an opaque body fully hides the native material, so
							// no window-level change is needed.
							syncVibrancy();
						}}
						label={t("appearance.label.reduceTransparency", "Reduce Transparency")}
						hint={t(
							"appearance.hint.reduceTransparency",
							"Keep the window opaque instead of letting the desktop show through the frame",
						)}
					/>
				</Show>

				<SettingSlider
					settingId="app.app_zoom"
					row
					label={t("appearance.label.appZoom", "App Zoom")}
					value={Math.round(settingsStore.state.appZoom * 100)}
					onChange={(v) => {
						settingsStore.setAppZoom(v / 100);
						void applyAppZoom(settingsStore.state.appZoom);
					}}
					min={Math.round(ZOOM_MIN * 100)}
					max={Math.round(ZOOM_MAX * 100)}
					step={5}
					suffix="%"
					hint={t("appearance.hint.appZoom", "Scales the entire interface, including terminals (Cmd +/-)")}
				/>
			</SectionCard>
			<SectionCard title={t("appearance.heading.tabs", "Tabs")}>
				<SettingSelect
					settingId="app.split_tab_mode"
					row
					label={t("appearance.label.splitTabMode", "Split Tab Mode")}
					value={settingsStore.state.splitTabMode}
					onChange={(v) => {
						if (v === "separate" || v === "unified") settingsStore.setSplitTabMode(v);
					}}
					options={[
						{ value: "separate", label: t("appearance.splitTabMode.separate", "Separate") },
						{ value: "unified", label: t("appearance.splitTabMode.unified", "Unified") },
					]}
					hint={t("appearance.hint.splitTabMode", "How worktree tabs are arranged in the tab bar")}
				/>

				<SettingSelect
					settingId="app.tab_ordering_mode"
					row
					label={t("appearance.label.tabOrderingMode", "Tab Ordering")}
					value={settingsStore.state.tabOrderingMode}
					onChange={(v) => {
						if (v === "grouped-by-type" || v === "terminals-first" || v === "free") settingsStore.setTabOrderingMode(v);
					}}
					options={[
						{ value: "grouped-by-type", label: t("appearance.tabOrderingMode.grouped", "Grouped by Type") },
						{ value: "terminals-first", label: t("appearance.tabOrderingMode.terminalsFirst", "Terminals First") },
						{ value: "free", label: t("appearance.tabOrderingMode.free", "Free") },
					]}
					hint={t(
						"appearance.hint.tabOrderingMode",
						"How tabs are ordered: grouped by type, terminals first, or freely interleaved",
					)}
				/>

				<SettingToggle
					settingId="app.tab_cycling_all_types"
					row
					checked={settingsStore.state.tabCyclingAllTypes}
					onChange={(v) => settingsStore.setTabCyclingAllTypes(v)}
					label={t("appearance.label.tabCyclingAllTypes", "Cycle All Tab Types")}
					hint={t(
						"appearance.hint.tabCyclingAllTypes",
						"Next/previous tab shortcuts cycle through diff, markdown and editor tabs too — not just terminals",
					)}
				/>

				<SettingToggle
					settingId="app.tab_tree_enabled"
					row
					checked={settingsStore.state.tabTreeEnabled}
					onChange={(v) => settingsStore.setTabTreeEnabled(v)}
					label={t("appearance.label.tabTreeEnabled", "Nested Terminal Tabs")}
					hint={t(
						"appearance.hint.tabTreeEnabled",
						"Show each branch's open sessions and agent activity in a collapsible card under its sidebar row",
					)}
				/>

				<SettingSlider
					settingId="app.max_tab_name_length"
					row
					label={t("appearance.label.maxTabNameLength", "Max Tab Name Length")}
					value={settingsStore.state.maxTabNameLength}
					onChange={(v) => settingsStore.setMaxTabNameLength(v)}
					min={10}
					max={60}
					hint={t("appearance.hint.maxTabNameLength", "Maximum characters shown in tab names before truncating")}
				/>
			</SectionCard>
			<SectionCard title={t("appearance.heading.chat", "Chat")}>
				<SettingToggle
					data-non-setting="Client-local new-text indicator preference; no backend owner"
					row
					checked={transcriptPreferences.enabled()}
					onChange={(value) => transcriptPreferences.setEnabled(value)}
					label={t("appearance.label.newTextIndicator", "New text indicator")}
					hint={t(
						"appearance.hint.newTextIndicator",
						"Show New text below when a chat receives content while you read earlier messages. Saved on this client.",
					)}
				/>

				<SettingToggle
					settingId="app.chat_mute_intermediate_text"
					row
					checked={settingsStore.state.chatMuteIntermediateText}
					onChange={(v) => settingsStore.setChatMuteIntermediateText(v)}
					label={t("appearance.label.chatMuteIntermediateText", "Mute Intermediate Text")}
					hint={t(
						"appearance.hint.chatMuteIntermediateText",
						"Show assistant text that is followed by a tool call in the same turn smaller and dimmer, so the final answer stands out",
					)}
				/>
			</SectionCard>
			<SectionCard title={t("appearance.heading.filesAndPanes", "Files & Panes")}>
				<SettingToggle
					settingId="app.file_tree_colors_enabled"
					row
					checked={settingsStore.state.fileTreeColorsEnabled}
					onChange={(v) => settingsStore.setFileTreeColorsEnabled(v)}
					label={t("appearance.label.fileTreeColors", "File Type Colors")}
					hint={t(
						"appearance.hint.fileTreeColors",
						"Tint file browser icons by file type (VSCode-style), using a modern pastel palette",
					)}
				/>

				<SettingToggle
					settingId="app.open_files_to_side"
					row
					checked={settingsStore.state.openFilesToSide}
					onChange={(v) => settingsStore.setOpenFilesToSide(v)}
					label={t("appearance.label.openFilesToSide", "Open Files Beside Terminal")}
					hint={t(
						"appearance.hint.openFilesToSide",
						"Files opened from the file browser while a terminal is focused dock into a split pane instead of replacing the view",
					)}
				/>

				<SettingToggle
					settingId="app.hide_docked_file_tabs"
					row
					checked={settingsStore.state.hideDockedFileTabs}
					onChange={(v) => settingsStore.setHideDockedFileTabs(v)}
					label={t("appearance.label.hideDockedFileTabs", "Align Docked File Tabs")}
					hint={t(
						"appearance.hint.hideDockedFileTabs",
						"While split, file tabs docked in a pane cluster on the right of the tab bar, above their pane (VSCode-style)",
					)}
				/>

				<SettingToggle
					settingId="app.multiview_enabled"
					row
					checked={settingsStore.state.multiviewEnabled}
					onChange={(v) => {
						settingsStore.setMultiviewEnabled(v);
						if (!v) multiviewStore.close();
					}}
					label={t("appearance.label.multiview", "Terminal Multiview")}
					hint={t(
						"appearance.hint.multiview",
						"Grid view of every live terminal across all repos and branches (Cmd+Alt+M)",
					)}
				/>
			</SectionCard>
			<SectionCard title={t("appearance.heading.groups", "Repository Groups")}>
				<p class={s.hint}>
					{t("appearance.hint.groups", "Organize repositories into color-coded groups in the sidebar")}
				</p>

				<Show when={groups().length === 0}>
					<div class={s.groupsEmpty}>{t("groups.empty.noGroups", "No groups yet")}</div>
				</Show>

				<For each={groups()}>{(group) => <GroupSettingsItem group={group} />}</For>

				<Button
					data-non-setting="Create or remove a stable repository group through its owner"
					class={s.groupsAddBtn}
					onClick={() => repositoriesStore.createGroup(t("groups.defaultGroupName", "New Group"))}
				>
					{t("groups.btn.addGroup", "Add Group")}
				</Button>
			</SectionCard>
			<SectionCard title={t("appearance.heading.layout", "Layout")}>
				<div class={s.group}>
					<Button
						data-non-setting="Reset panel geometry through the existing UI layout owner"
						class={s.testBtn}
						onClick={() => uiStore.resetLayout()}
					>
						{t("appearance.btn.resetLayout", "Reset Panel Sizes")}
					</Button>
					<p class={s.hint}>{t("appearance.hint.resetLayout", "Reset sidebar and panel widths to default values")}</p>
				</div>
			</SectionCard>
			<SectionCard title={t("appearance.heading.uiLegend", "UI Legend")}>
				<p class={s.hint} style={{ "margin-bottom": "12px" }}>
					{t("appearance.hint.uiLegend", "Visual reference for colors, symbols, and badges used throughout the app")}
				</p>
				<UiLegend />
			</SectionCard>
		</div>
	);
};
