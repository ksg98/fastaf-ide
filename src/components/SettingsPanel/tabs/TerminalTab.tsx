import { type Component, createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import { t } from "../../../i18n";
import type { FontType } from "../../../stores/settings";
import { FONT_FAMILIES, settingsStore } from "../../../stores/settings";
import { getTerminalTheme } from "../../../themes";
import { ExpertSetting } from "../ExpertSetting";
import { SettingInput, SettingSelect, SettingSlider, SettingToggle } from "../SettingFields";
import s from "../Settings.module.css";
import { SectionCard, SettingPageHeader } from "../SettingsPrimitives";
import w from "./WorkspaceTabs.module.css";

interface PreviewSpan {
	text: string;
	color?: string;
	bg?: string;
	bold?: boolean;
}

type PreviewLine = PreviewSpan[];

const PREVIEW_LINES: PreviewLine[] = [
	[
		{ text: " projectX ", bg: "blue", color: "white", bold: true },
		{ text: "", color: "blue", bg: "green" },
		{ text: "  main ", bg: "green", color: "black", bold: true },
		{ text: "", color: "green" },
		{ text: " cat server.ts" },
	],
	[
		{ text: "import", color: "dim" },
		{ text: " { serve } " },
		{ text: "from", color: "dim" },
		{ text: ' "http"', color: "green" },
		{ text: ";" },
	],
	[{ text: "const", color: "dim" }, { text: " port = " }, { text: "8080", color: "yellow" }, { text: ";" }],
	[{ text: "" }],
	[
		{ text: " projectX ", bg: "blue", color: "white", bold: true },
		{ text: "", color: "blue", bg: "green" },
		{ text: "  main ", bg: "green", color: "black", bold: true },
		{ text: "", color: "green" },
		{ text: " git diff" },
	],
	[{ text: "@@ -2,3 +2,5 @@", color: "cyan" }],
	[{ text: "-const port = 8080;", color: "red" }],
	[{ text: "+const port = 3000;", color: "green" }],
	[{ text: "+serve({ port });", color: "green" }],
	[{ text: "" }],
	[
		{ text: " projectX ", bg: "blue", color: "white", bold: true },
		{ text: "", color: "blue", bg: "green" },
		{ text: "  main ", bg: "green", color: "black", bold: true },
		{ text: "", color: "green" },
		{ text: " npm test" },
	],
	[{ text: "✓", color: "green" }, { text: " server " }, { text: "(4ms)", color: "dim" }],
	[{ text: "✓", color: "green" }, { text: " routes " }, { text: "(2ms)", color: "dim" }],
	[{ text: "✓", color: "green" }, { text: " logger " }, { text: "(1ms)", color: "dim" }],
	[{ text: "" }],
	[
		{ text: " projectX ", bg: "blue", color: "white", bold: true },
		{ text: "", color: "blue", bg: "green" },
		{ text: "  main ", bg: "green", color: "black", bold: true },
		{ text: "", color: "green" },
		{ text: " " },
	],
];

function getThemeColor(name: string): string {
	const theme = getTerminalTheme(settingsStore.state.theme);
	const map: Record<string, string | undefined> = {
		fg: theme.foreground,
		bg: theme.background,
		cursor: theme.cursor,
		dim: theme.brightBlack,
		red: theme.red,
		green: theme.green,
		yellow: theme.yellow,
		blue: theme.blue,
		magenta: theme.magenta,
		cyan: theme.cyan,
		white: theme.white,
		black: theme.black,
		brightRed: theme.brightRed,
		brightGreen: theme.brightGreen,
		brightYellow: theme.brightYellow,
		brightBlue: theme.brightBlue,
	};
	return map[name] ?? theme.foreground ?? "#c0c0c0";
}

/** WCAG relative luminance of a #rrggbb color (0 = black, 1 = white). */
function luminance(hex: string): number {
	const h = hex.replace("#", "");
	const ch = (i: number) => {
		const s = parseInt(h.slice(i, i + 2), 16) / 255;
		return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * ch(0) + 0.7152 * ch(2) + 0.0722 * ch(4);
}

/**
 * Pick a readable text color (near-white or near-black) for a powerline segment
 * fill — whichever yields the higher WCAG contrast. Real prompts (agnoster) do
 * this implicitly; the ANSI `white`/`black` tokens alone fail against saturated
 * fills — worst on light themes where ANSI `white` is a dark gray, and on
 * mid-luminance fills where a fixed threshold guesses wrong.
 */
function readableOn(fillHex: string): string {
	const dark = "#1a1a1a";
	const light = "#ffffff";
	const l = luminance(fillHex);
	const contrast = (a: number, b: number) => {
		const hi = Math.max(a, b);
		const lo = Math.min(a, b);
		return (hi + 0.05) / (lo + 0.05);
	};
	return contrast(luminance(dark), l) >= contrast(luminance(light), l) ? dark : light;
}

const TerminalPreview: Component = () => {
	const fontFamily = createMemo(() => FONT_FAMILIES[settingsStore.state.font] ?? "monospace");
	const fontSize = () => settingsStore.state.defaultFontSize;
	const fontWeight = () => settingsStore.state.fontWeight;
	const cursorStyle = () => settingsStore.state.cursorStyle;
	let canvasRef!: HTMLCanvasElement;
	const [cursorVisible, setCursorVisible] = createSignal(true);

	const paint = (showCursor: boolean) => {
		const canvas = canvasRef;
		if (!canvas) return;
		const ctx = canvas.getContext("2d");
		if (!ctx) return;

		const dpr = window.devicePixelRatio || 1;
		const font = fontFamily();
		const size = fontSize();
		const weight = fontWeight();
		const cursor = cursorStyle();

		ctx.font = `${weight} ${size}px ${font}`;
		const mW = ctx.measureText("W");
		const cellW = Math.round(mW.width);
		const ascent = mW.fontBoundingBoxAscent ?? mW.actualBoundingBoxAscent ?? size * 0.8;
		const descent = mW.fontBoundingBoxDescent ?? mW.actualBoundingBoxDescent ?? size * 0.2;
		const charH = ascent + descent;
		const cellH = Math.floor(Math.ceil(charH * dpr) * 1.2) / dpr;
		const baseline = Math.ceil(ascent);

		const rows = PREVIEW_LINES.length;
		const maxCols = 40;
		const w = maxCols * cellW + 12;
		const h = rows * cellH + 8;

		canvas.width = Math.round(w * dpr);
		canvas.height = Math.round(h * dpr);
		canvas.style.width = `${w}px`;
		canvas.style.height = `${h}px`;
		ctx.scale(dpr, dpr);

		const bgColor = getThemeColor("bg");
		ctx.fillStyle = bgColor;
		ctx.fillRect(0, 0, w, h);

		const fgDefault = getThemeColor("fg");
		const padLeft = 6;

		for (let row = 0; row < rows; row++) {
			const line = PREVIEW_LINES[row];
			const y = row * cellH + 4;
			let col = 0;

			for (const span of line) {
				const text = span.text;
				if (!text) continue;

				if (span.bg) {
					ctx.fillStyle = getThemeColor(span.bg);
					ctx.fillRect(padLeft + col * cellW, y, text.length * cellW, cellH);
				}

				// Powerline segment text: pick a readable color for the fill instead
				// of the literal ANSI token (which fails against saturated fills).
				// Arrow glyphs (U+E0B0) keep their span color — they tint the bg.
				const isArrowGlyph = [...text].some((ch) => (ch.codePointAt(0) ?? 0) >= 0xe000);
				if (span.bg && !isArrowGlyph) {
					ctx.fillStyle = readableOn(getThemeColor(span.bg));
				} else {
					ctx.fillStyle = span.color ? getThemeColor(span.color) : fgDefault;
				}
				const fontStr = span.bold ? `700 ${size}px ${font}` : `${weight} ${size}px ${font}`;
				ctx.font = fontStr;

				for (let i = 0; i < text.length; i++) {
					const cp = text.codePointAt(i) ?? 0;
					const gx = padLeft + (col + i) * cellW;
					if (cp === 0xe0b0) {
						ctx.beginPath();
						ctx.moveTo(gx, y);
						ctx.lineTo(gx + cellW, y + cellH / 2);
						ctx.lineTo(gx, y + cellH);
						ctx.closePath();
						ctx.fill();
					} else {
						ctx.fillText(text[i], gx, y + baseline);
					}
				}
				col += text.length;
			}
		}

		if (showCursor) {
			const lastLine = PREVIEW_LINES[rows - 1];
			let cursorCol = 0;
			for (const span of lastLine) cursorCol += span.text.length;
			const cx = padLeft + cursorCol * cellW;
			const cy = (rows - 1) * cellH + 4;
			ctx.fillStyle = getThemeColor("cursor");
			if (cursor === "bar") {
				ctx.fillRect(cx, cy, 2, cellH);
			} else if (cursor === "block") {
				ctx.fillRect(cx, cy, cellW, cellH);
			} else {
				ctx.fillRect(cx, cy + cellH - 2, cellW, 2);
			}
		}
	};

	createEffect(() => {
		fontFamily();
		fontSize();
		fontWeight();
		cursorStyle();
		settingsStore.state.theme;
		const show = cursorVisible();
		queueMicrotask(() => paint(show));
	});

	let blinkTimer: ReturnType<typeof setInterval> | undefined;
	const startBlink = () => {
		if (blinkTimer) return;
		setCursorVisible(true);
		blinkTimer = setInterval(() => setCursorVisible((v) => !v), 530);
	};
	const stopBlink = () => {
		if (blinkTimer) {
			clearInterval(blinkTimer);
			blinkTimer = undefined;
		}
	};

	createEffect(() => {
		const canvas = canvasRef;
		if (!canvas) return;
		const observer = new IntersectionObserver(
			([entry]) => {
				if (entry.isIntersecting) startBlink();
				else stopBlink();
			},
			{ threshold: 0.1 },
		);
		observer.observe(canvas);
		onCleanup(() => {
			observer.disconnect();
			stopBlink();
		});
	});

	return (
		<div class={s.terminalPreview}>
			<div class={s.terminalPreviewTitlebar}>
				<div class={`${s.terminalPreviewDot} ${s.terminalPreviewDotClose}`} />
				<div class={`${s.terminalPreviewDot} ${s.terminalPreviewDotMin}`} />
				<div class={`${s.terminalPreviewDot} ${s.terminalPreviewDotMax}`} />
				<div class={s.terminalPreviewTitleText}>zsh</div>
			</div>
			<div class={s.terminalPreviewCanvas}>
				<canvas ref={canvasRef} />
			</div>
		</div>
	);
};

const fontOptions = Object.keys(FONT_FAMILIES).map((value) => ({ value, label: value }));

export const TerminalTab: Component = () => {
	return (
		<div class={`${s.section} ${w.page}`}>
			<SettingPageHeader title="Terminal" scope="Application defaults" breadcrumb="Workspace / Terminal" />
			<SectionCard title={t("general.heading.terminal", "Terminal")}>
				<ExpertSetting configKey="app.shell" value={settingsStore.state.shell}>
					<SettingInput
						settingId="app.shell"
						row
						label={t("general.label.shell", "Shell")}
						value={settingsStore.state.shell ?? ""}
						onInput={(v) => settingsStore.setShell(v)}
						placeholder={t("general.placeholder.shell", "Default shell")}
						hint={t("general.hint.shell", "Shell used in terminals (leave blank for system default)")}
					/>
				</ExpertSetting>

				<div class={w.typography}>
					<div>
						<SettingSelect
							settingId="app.font_family"
							row
							label={t("appearance.label.terminalFont", "Terminal Font")}
							value={settingsStore.state.font}
							onChange={(v) => settingsStore.setFont(v as FontType)}
							options={fontOptions}
							hint={t("appearance.hint.terminalFont", "Monospace font for terminals")}
						/>

						<SettingSlider
							settingId="app.default_font_size"
							row
							label={t("appearance.label.defaultFontSize", "Default Font Size")}
							value={settingsStore.state.defaultFontSize}
							onChange={(v) => settingsStore.setDefaultFontSize(v)}
							min={8}
							max={32}
							suffix="px"
							hint={t("appearance.hint.defaultFontSize", "Default font size for new terminals")}
						/>

						<ExpertSetting configKey="app.font_weight" value={settingsStore.state.fontWeight}>
							<SettingSlider
								settingId="app.font_weight"
								row
								label={t("appearance.label.fontWeight", "Font Weight")}
								value={settingsStore.state.fontWeight}
								onChange={(v) => settingsStore.setFontWeight(v)}
								min={100}
								max={900}
								step={100}
								hint={t(
									"appearance.hint.fontWeight",
									"Terminal font weight (200 = ExtraLight, 400 = Regular, 700 = Bold)",
								)}
							/>
						</ExpertSetting>

						<SettingSelect
							settingId="app.cursor_style"
							row
							label={t("appearance.label.cursorStyle", "Cursor Style")}
							value={settingsStore.state.cursorStyle}
							onChange={(v) => settingsStore.setCursorStyle(v as "bar" | "block" | "underline")}
							options={[
								{ value: "bar", label: t("appearance.cursorStyle.bar", "Bar") },
								{ value: "block", label: t("appearance.cursorStyle.block", "Block") },
								{ value: "underline", label: t("appearance.cursorStyle.underline", "Underline") },
							]}
							hint={t(
								"appearance.hint.cursorStyle",
								"Shape of the terminal cursor. Applies immediately to all terminals.",
							)}
						/>
					</div>
				</div>
			</SectionCard>
			<SectionCard title="Preview">
				<TerminalPreview />
			</SectionCard>
			<SectionCard title="Behavior">
				<SettingToggle
					settingId="app.copy_on_select"
					row
					checked={settingsStore.state.copyOnSelect}
					onChange={(v) => settingsStore.setCopyOnSelect(v)}
					label={t("general.toggle.copyOnSelect", "Copy on select")}
					hint={t("general.hint.copyOnSelect", "Automatically copy selected text to clipboard")}
				/>

				<SettingToggle
					settingId="app.terminal_drag_selects"
					row
					checked={settingsStore.state.terminalDragSelects}
					onChange={(v) => settingsStore.setTerminalDragSelects(v)}
					label={t("general.toggle.terminalDragSelects", "Drag to select in full-screen apps")}
					hint={t(
						"general.hint.terminalDragSelects",
						"Click-and-drag selects text even when an app (vim, htop) captures the mouse; a plain click is still sent to the app",
					)}
				/>

				<ExpertSetting configKey="app.osc52_clipboard" value={settingsStore.state.osc52Clipboard}>
					<SettingToggle
						settingId="app.osc52_clipboard"
						row
						checked={settingsStore.state.osc52Clipboard}
						onChange={(v) => settingsStore.setOsc52Clipboard(v)}
						label={t("general.toggle.osc52Clipboard", "Allow OSC 52 clipboard writes")}
						hint={t(
							"general.hint.osc52Clipboard",
							"Let terminal programs set the system clipboard (OSC 52). A notice appears on each write. Disable to ignore clipboard writes from terminal output.",
						)}
					/>
				</ExpertSetting>

				<SettingSlider
					settingId="app.terminal_scroll_sensitivity"
					row
					label={t("general.label.scrollSensitivity", "Scroll sensitivity")}
					value={settingsStore.state.terminalScrollSensitivity}
					onChange={(v) => settingsStore.setTerminalScrollSensitivity(v)}
					min={20}
					max={200}
					step={10}
					suffix="%"
					hint={t(
						"general.hint.scrollSensitivity",
						"How fast the terminal scrolls per wheel/trackpad tick (100% = raw device speed)",
					)}
				/>

				<SettingToggle
					settingId="app.show_block_timestamps"
					row
					checked={settingsStore.state.showBlockTimestamps}
					onChange={(v) => settingsStore.setShowBlockTimestamps(v)}
					label={t("general.toggle.showBlockTimestamps", "Show block timestamps")}
					hint={t(
						"general.hint.showBlockTimestamps",
						"While Ctrl+Cmd is held, label each command block with how long ago it started",
					)}
				/>

				<ExpertSetting configKey="app.block_folding_enabled" value={settingsStore.state.blockFoldingEnabled}>
					<SettingToggle
						settingId="app.block_folding_enabled"
						row
						checked={settingsStore.state.blockFoldingEnabled}
						onChange={(v) => settingsStore.setBlockFoldingEnabled(v)}
						label={t("general.toggle.blockFolding", "Block folding")}
						hint={t(
							"general.hint.blockFolding",
							"Let the Toggle Block Fold shortcut collapse a command block's output. Already-folded blocks stay collapsed when this is off.",
						)}
					/>
				</ExpertSetting>

				<ExpertSetting configKey="app.show_scrollbar_marks" value={settingsStore.state.showScrollbarMarks}>
					<SettingToggle
						settingId="app.show_scrollbar_marks"
						row
						checked={settingsStore.state.showScrollbarMarks}
						onChange={(v) => settingsStore.setShowScrollbarMarks(v)}
						label={t("general.toggle.showScrollbarMarks", "Show scrollbar marks")}
						hint={t(
							"general.hint.showScrollbarMarks",
							"Mark each command's position on the terminal scrollbar, so a long scrollback shows where output began",
						)}
					/>
				</ExpertSetting>

				<ExpertSetting configKey="app.scrollback_reflow" value={settingsStore.state.scrollbackReflow}>
					<SettingToggle
						settingId="app.scrollback_reflow"
						row
						checked={settingsStore.state.scrollbackReflow}
						onChange={(v) => settingsStore.setScrollbackReflow(v)}
						label={t("general.toggle.scrollbackReflow", "Reflow scrollback on resize")}
						hint={t(
							"general.hint.scrollbackReflow",
							"Re-wrap scrollback history when the terminal changes width, so old output stays readable after a side panel opens. Turn it off to leave history lines as they were written and truncate them instead. The visible screen is never reflowed either way.",
						)}
					/>
				</ExpertSetting>
			</SectionCard>
		</div>
	);
};
