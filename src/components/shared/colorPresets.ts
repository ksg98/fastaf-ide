export interface ColorPreset {
	hex: string;
	name: string;
}

export const DEFAULT_COLOR_PRESETS: readonly ColorPreset[] = [
	{ hex: "#4A9EFF", name: "Blue" },
	{ hex: "#FF6B6B", name: "Red" },
	{ hex: "#50C878", name: "Green" },
	{ hex: "#FFB347", name: "Orange" },
	{ hex: "#B19CD9", name: "Purple" },
	{ hex: "#FF85A2", name: "Pink" },
	{ hex: "#5BC0BE", name: "Teal" },
	{ hex: "#FFD93D", name: "Yellow" },
];
