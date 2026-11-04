import fs from "node:fs";
import path from "node:path";
import { fireEvent, render, waitFor } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { invoke, testSound, setVolume, setAudioDevice, setAutoToastCards, setSoundEnabled } = vi.hoisted(() => ({
	invoke: vi.fn(),
	testSound: vi.fn(),
	setVolume: vi.fn(),
	setAudioDevice: vi.fn(),
	setAutoToastCards: vi.fn(),
	setSoundEnabled: vi.fn(),
}));
vi.mock("../../../invoke", () => ({ invoke }));
vi.mock("../../../transport", () => ({ isTauri: () => true }));
vi.mock("../../../stores/appLogger", () => ({ appLogger: { warn: vi.fn() } }));
vi.mock("../ExpertSetting", () => ({ ExpertSetting: (props: { children: unknown }) => props.children }));
vi.mock("../../../services/tasksNotifications", () => ({
	tasksNotifications: { enabled: () => false, setEnabled: vi.fn() },
}));
vi.mock("../../../stores/notifications", () => ({
	notificationsStore: {
		state: {
			isAvailable: true,
			autoToastCards: true,
			config: {
				enabled: true,
				volume: 0.5,
				audio_device: null,
				sounds: {},
				silence_remote_completions: true,
				toasts_in_bell: true,
				pr_native_notifications: true,
			},
		},
		testSound,
		setVolume,
		setAudioDevice,
		setAutoToastCards,
		setEnabled: vi.fn(),
		setSoundEnabled,
		setSilenceRemoteCompletions: vi.fn(),
		setToastsInBell: vi.fn(),
		setPrNativeNotifications: vi.fn(),
		reset: vi.fn(),
	},
}));

import { settingsCatalogue } from "../../../generated/settingsCatalogue";
import { SettingInput, SettingSelect, SettingSlider, SettingToggle } from "../SettingFields";
import { SettingsShell } from "../SettingsShell";
import { NotificationsTab } from "../tabs/NotificationsTab";

describe("Application Settings restyle contracts", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		invoke.mockResolvedValue([{ name: "USB speakers", is_default: false }]);
	});

	// Catches: a row migration starts CoreAudio discovery on mount or loses the explicit device selection action.
	it("enumerates audio devices only after consent and routes the selected output", async () => {
		const view = render(() => <NotificationsTab />);
		expect(invoke).not.toHaveBeenCalled();
		fireEvent.click(view.getByRole("button", { name: "Choose output device…" }));
		await waitFor(() => expect(view.getByRole("option", { name: "USB speakers" })).toBeInTheDocument());
		expect(invoke).toHaveBeenCalledExactlyOnceWith("list_audio_output_devices");
		fireEvent.change(view.getByRole("combobox"), { target: { value: "USB speakers" } });
		expect(setAudioDevice).toHaveBeenCalledWith("USB speakers");
	});

	// Catches: a finite dynamic sound row presenting one descriptor but writing another event.
	it("dynamic_sound_ids_match_the_actual_owner_callback", () => {
		const view = render(() => <NotificationsTab />);
		const ids = Object.keys(settingsCatalogue.fields).filter((id) => id.startsWith("notifications.sounds."));
		for (const id of ids) {
			const control = view.container.querySelector(`input[data-setting-id="${id}"]`);
			expect(control).not.toBeNull();
			fireEvent.change(control!, { target: { checked: false } });
			expect(setSoundEnabled).toHaveBeenLastCalledWith(id.slice("notifications.sounds.".length), false);
		}
	});

	// Catches: moving the volume control previews continuously while dragging or routes a per-client preference to audio config.
	it("previews volume on commit and keeps card routing on the client preference action", () => {
		const view = render(() => <NotificationsTab />);
		const volume = view.getByRole("slider", { name: "Master Volume" });
		fireEvent.input(volume, { target: { value: "80" } });
		expect(setVolume).toHaveBeenCalledWith(0.8);
		expect(testSound).not.toHaveBeenCalled();
		fireEvent.change(volume, { target: { value: "80" } });
		expect(testSound).toHaveBeenCalledWith("info");
		fireEvent.change(view.getByRole("switch", { name: "Show cards from the active terminal" }), {
			target: { checked: false },
		});
		expect(setAutoToastCards).toHaveBeenCalledWith(false);
		fireEvent.click(view.getByRole("button", { name: "Preview Question" }));
		expect(testSound).toHaveBeenLastCalledWith("question");
		expect(view.getByRole("switch", { name: "Question" })).toBeInTheDocument();
		expect(view.getByRole("switch", { name: "Completion" })).toBeInTheDocument();
	});

	// Catches: labelled row controls lose their callback, rejected-input restoration, blur validation or reactive description.
	it("keeps row control labels, rejection and commit boundaries", () => {
		const [hint, setHint] = createSignal("Stored path");
		const blur = vi.fn();
		const change = vi.fn();
		const commit = vi.fn();
		const view = render(() => (
			<>
				<SettingInput row label="Path" value="/saved" onInput={() => false} onBlur={blur} hint={hint()} />
				<SettingToggle row label="Enabled" checked onChange={change} />
				<SettingSelect
					row
					label="Mode"
					value="a"
					onChange={change}
					options={[
						{ value: "a", label: "A" },
						{ value: "b", label: "B" },
					]}
				/>
				<SettingSlider row label="Limit" value={5} min={0} max={10} onChange={change} onCommit={commit} />
			</>
		));
		const input = view.getByRole("textbox", { name: "Path" });
		fireEvent.input(input, { target: { value: "bad" } });
		expect(input).toHaveValue("/saved");
		setHint("Rejected path retained");
		expect(view.getByRole("textbox", { name: "Path" })).toBe(input);
		expect(input).toHaveAccessibleDescription("Rejected path retained");
		fireEvent.blur(input);
		expect(blur).toHaveBeenCalledOnce();
		fireEvent.change(view.getByRole("switch", { name: "Enabled" }), { target: { checked: false } });
		expect(change).toHaveBeenLastCalledWith(false);
		fireEvent.change(view.getByRole("combobox", { name: "Mode" }), { target: { value: "b" } });
		expect(change).toHaveBeenLastCalledWith("b");
		fireEvent.input(view.getByRole("slider", { name: "Limit" }), { target: { value: "8" } });
		expect(change).toHaveBeenLastCalledWith(8);
		expect(commit).not.toHaveBeenCalled();
		fireEvent.change(view.getByRole("slider", { name: "Limit" }), { target: { value: "8" } });
		expect(commit).toHaveBeenCalledWith(8);
	});
	// Catches: compact navigation hides the only way to clear a query that still filters the page list.
	it("keeps an active search clearable alongside the compact selector", () => {
		const [query, setQuery] = createSignal("general");
		const view = render(() => (
			<SettingsShell
				visible
				title="Settings"
				onClose={() => {}}
				activeTab="general"
				onTabChange={() => {}}
				tabs={[
					{ key: "general", label: "General" },
					{ key: "appearance", label: "Appearance" },
				].filter((tab) => tab.label.toLowerCase().includes(query()))}
				navHeader={
					<div>
						<input
							aria-label="Search settings"
							value={query()}
							onInput={(event) => setQuery(event.currentTarget.value)}
						/>
						<button onClick={() => setQuery("")}>Clear search</button>
					</div>
				}
			>
				<p>Page</p>
			</SettingsShell>
		));
		expect(view.queryByRole("option", { name: "Appearance" })).toBeNull();
		expect(view.getByRole("textbox", { name: "Search settings" }).closest(".navSearch")).not.toBeNull();
		const css = fs.readFileSync(path.join(__dirname, "../Settings.module.css"), "utf8");
		expect(css).toContain(".nav > :not(.compactNav):not(.navSearch)");
		fireEvent.click(view.getByRole("button", { name: "Clear search" }));
		expect(view.getByRole("textbox", { name: "Search settings" })).toHaveValue("");
		expect(view.getByRole("option", { name: "Appearance" })).toBeInTheDocument();
	});
});

// Catches: asynchronously populated repository options leave the compact picker on General.
it("selects the active repository when its navigation option arrives", () => {
	const [tabs, setTabs] = createSignal([{ key: "general", label: "General" }]);
	const view = render(() => (
		<SettingsShell
			visible
			title="Settings"
			onClose={() => {}}
			activeTab="repo:/fixture"
			onTabChange={() => {}}
			tabs={tabs()}
		>
			<p>Repository</p>
		</SettingsShell>
	));
	setTabs([
		{ key: "general", label: "General" },
		{ key: "repo:/fixture", label: "Fixture repository" },
	]);
	expect(view.getByRole("combobox", { name: "Settings page" })).toHaveValue("repo:/fixture");
});
