import type { Component } from "solid-js";
import s from "./ZoomIndicator.module.css";

export interface ZoomIndicatorProps {
	/** App zoom factor, where 1 is 100%. */
	level: number;
}

export const ZoomIndicator: Component<ZoomIndicatorProps> = (props) => {
	const percentage = () => Math.round(props.level * 100);

	return (
		<span class={s.indicator} data-testid="zoom-indicator">
			{percentage()}%
		</span>
	);
};
