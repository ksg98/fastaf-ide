import { type Component, createEffect, Show } from "solid-js";
import { t } from "../../i18n";
import { registerModal } from "../../stores/modalStack";
import { ColorSwatchPicker } from "./ColorSwatchPicker";
import { DEFAULT_COLOR_PRESETS } from "./colorPresets";
import d from "./dialog.module.css";

export interface ColorPickerDialogProps {
	visible: boolean;
	title: string;
	currentColor: string;
	onClose: () => void;
	onConfirm: (color: string) => void;
}

export const ColorPickerDialog: Component<ColorPickerDialogProps> = (props) => {
	createEffect(() => {
		if (!props.visible) return;

		// Escape-to-close is handled centrally (stores/modalStack): registering routes
		// Escape to props.onClose AND stops it reaching the terminal underneath.
		registerModal(props.onClose);
	});

	const handleChange = (color: string) => {
		props.onConfirm(color);
		props.onClose();
	};

	return (
		<Show when={props.visible}>
			<div class={d.overlay} onClick={props.onClose}>
				<div class={d.popover} onClick={(e) => e.stopPropagation()}>
					<div class={d.header}>
						<h4>{props.title}</h4>
					</div>
					<div class={d.body}>
						<ColorSwatchPicker color={props.currentColor} presets={DEFAULT_COLOR_PRESETS} onChange={handleChange} />
					</div>
					<div class={d.actions}>
						<button class={d.cancelBtn} onClick={props.onClose}>
							{t("colorPickerDialog.cancel", "Cancel")}
						</button>
					</div>
				</div>
			</div>
		</Show>
	);
};
