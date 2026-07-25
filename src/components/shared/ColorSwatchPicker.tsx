import { type Component, For, Show } from "solid-js";
import { t } from "../../i18n";
import { cx } from "../../utils";
import s from "../SettingsPanel/Settings.module.css";
import type { ColorPreset } from "./colorPresets";

export interface ColorSwatchPickerProps {
	color: string;
	presets: readonly ColorPreset[];
	onChange: (color: string) => void;
}

export const ColorSwatchPicker: Component<ColorSwatchPickerProps> = (props) => {
	const isCustomColor = () => props.color && !props.presets.some((preset) => preset.hex === props.color);

	return (
		<div class={s.groupColorPicker}>
			<For each={props.presets}>
				{(preset) => (
					<button
						class={cx(s.colorSwatch, props.color === preset.hex && s.active)}
						style={{ background: preset.hex }}
						onClick={() => props.onChange(preset.hex)}
						title={preset.name}
					/>
				)}
			</For>
			<label
				class={cx(s.colorSwatch, s.colorSwatchCustom, isCustomColor() && s.active)}
				style={{
					background: isCustomColor() ? props.color : "var(--bg-tertiary)",
				}}
				title={t("groups.btn.customColor", "Custom color")}
			>
				<input type="color" value={props.color || "#999999"} onInput={(e) => props.onChange(e.currentTarget.value)} />
				<Show when={!isCustomColor()}>
					<span class={s.colorSwatchLabel}>&#x22EF;</span>
				</Show>
			</label>
			<button
				class={cx(s.colorSwatch, s.colorSwatchClear, !props.color && s.active)}
				onClick={() => props.onChange("")}
				title={t("groups.btn.noColor", "No color")}
			>
				&times;
			</button>
		</div>
	);
};
