// The 33 IDE/terminal SVGs are inlined by the bundler, so whichever module
// holds this table carries them. It used to live in `stores/settings.ts`,
// which the mobile app reaches transitively through `stores/terminals.ts` —
// that dragged every desktop IDE icon into the mobile initial load graph.
// Only IdeLauncher (desktop-only) reads it, so it lives on its own here.

import alacritySvg from "../assets/icons/alacritty.svg";
import androidStudioSvg from "../assets/icons/android-studio.svg";
import clionSvg from "../assets/icons/clion.svg";
import cursorSvg from "../assets/icons/cursor.svg";
import datagripSvg from "../assets/icons/datagrip.svg";
import editorSvg from "../assets/icons/editor.svg";
import finderSvg from "../assets/icons/finder.svg";
import fleetSvg from "../assets/icons/fleet.svg";
import forkSvg from "../assets/icons/fork.svg";
import ghosttySvg from "../assets/icons/ghostty.svg";
import githubDesktopSvg from "../assets/icons/github-desktop.svg";
import gitkrakenSvg from "../assets/icons/gitkraken.svg";
import golandSvg from "../assets/icons/goland.svg";
import intellijSvg from "../assets/icons/intellij.svg";
import iterm2Svg from "../assets/icons/iterm2.svg";
import kittySvg from "../assets/icons/kitty.svg";
import neovimSvg from "../assets/icons/neovim.svg";
import phpstormSvg from "../assets/icons/phpstorm.svg";
import pycharmSvg from "../assets/icons/pycharm.svg";
import riderSvg from "../assets/icons/rider.svg";
import rubymineSvg from "../assets/icons/rubymine.svg";
import rustroverSvg from "../assets/icons/rustrover.svg";
import smergeSvg from "../assets/icons/smerge.svg";
import sourcetreeSvg from "../assets/icons/sourcetree.svg";
import terminalSvg from "../assets/icons/terminal.svg";
import towerSvg from "../assets/icons/tower.svg";
/** IDE icon SVG imports */
import vscodeSvg from "../assets/icons/vscode.svg";
import warpSvg from "../assets/icons/warp.svg";
import webstormSvg from "../assets/icons/webstorm.svg";
import weztermSvg from "../assets/icons/wezterm.svg";
import windsurfSvg from "../assets/icons/windsurf.svg";
import xcodeSvg from "../assets/icons/xcode.svg";
import zedSvg from "../assets/icons/zed.svg";
import type { IdeType } from "./settings";

/** IDE icon paths (SVG) */
export const IDE_ICON_PATHS: Record<IdeType, string> = {
	vscode: vscodeSvg,
	cursor: cursorSvg,
	zed: zedSvg,
	windsurf: windsurfSvg,
	neovim: neovimSvg,
	xcode: xcodeSvg,
	ghostty: ghosttySvg,
	wezterm: weztermSvg,
	alacritty: alacritySvg,
	kitty: kittySvg,
	warp: warpSvg,
	iterm2: iterm2Svg,
	sourcetree: sourcetreeSvg,
	"github-desktop": githubDesktopSvg,
	fork: forkSvg,
	gitkraken: gitkrakenSvg,
	smerge: smergeSvg,
	tower: towerSvg,
	intellij: intellijSvg,
	pycharm: pycharmSvg,
	webstorm: webstormSvg,
	goland: golandSvg,
	clion: clionSvg,
	phpstorm: phpstormSvg,
	rubymine: rubymineSvg,
	rider: riderSvg,
	datagrip: datagripSvg,
	rustrover: rustroverSvg,
	"android-studio": androidStudioSvg,
	fleet: fleetSvg,
	terminal: terminalSvg,
	finder: finderSvg,
	editor: editorSvg,
};
