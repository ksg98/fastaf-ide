import type { JSX } from "solid-js";

/**
 * The app's one icon set (docs/frontend/STYLE_GUIDE.md › Icons).
 *
 * Every chrome icon is drawn on the same 24-unit grid with the same round
 * 1.75 stroke in `currentColor`, so a toolbar, a sidebar row and a composer
 * button read as one family at any size. Size is the only knob: 16px in
 * toolbars and rows, 14px in dense chips. Monochrome always; colour comes
 * from the surrounding text colour, never from the icon.
 *
 * Path data is adapted from Lucide (https://lucide.dev), ISC License:
 * Copyright (c) for portions of Lucide are held by Cole Bemis 2013-2022 as part
 * of Feather (MIT). All other copyright (c) for Lucide are held by Lucide
 * Contributors 2022. Permission to use, copy, modify, and/or distribute this
 * software for any purpose with or without fee is hereby granted, provided that
 * the above copyright notice and this permission notice appear in all copies.
 */

export interface IconProps {
	/** Rendered width and height in px (default 16). */
	size?: number;
	class?: string;
	/** Stroke width on the 24-unit grid (default 1.75). */
	stroke?: number;
	"aria-label"?: string;
}

function icon(body: () => JSX.Element) {
	return (props: IconProps) => (
		<svg
			class={props.class}
			width={props.size ?? 16}
			height={props.size ?? 16}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			stroke-width={props.stroke ?? 1.75}
			stroke-linecap="round"
			stroke-linejoin="round"
			aria-hidden={props["aria-label"] ? undefined : "true"}
			aria-label={props["aria-label"]}
			role={props["aria-label"] ? "img" : undefined}
		>
			{body()}
		</svg>
	);
}

export const IconPanelLeft = icon(() => (
	<>
		<rect width="18" height="18" x="3" y="3" rx="3" />
		<path d="M9 3v18" />
	</>
));

export const IconFolder = icon(() => (
	<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
));

export const IconFolderOpen = icon(() => (
	<path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2" />
));

/** Pencil over a page — "start something new" (Codex's New chat glyph). */
export const IconCompose = icon(() => (
	<>
		<path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
		<path d="M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z" />
	</>
));

export const IconSearch = icon(() => (
	<>
		<circle cx="11" cy="11" r="7.5" />
		<path d="m20.5 20.5-4.2-4.2" />
	</>
));

export const IconPlus = icon(() => (
	<>
		<path d="M5 12h14" />
		<path d="M12 5v14" />
	</>
));

export const IconClose = icon(() => (
	<>
		<path d="M18 6 6 18" />
		<path d="m6 6 12 12" />
	</>
));

export const IconMore = icon(() => (
	<>
		<circle cx="12" cy="12" r="1" />
		<circle cx="19" cy="12" r="1" />
		<circle cx="5" cy="12" r="1" />
	</>
));

export const IconChevronDown = icon(() => <path d="m6 9 6 6 6-6" />);

export const IconChevronRight = icon(() => <path d="m9 18 6-6-6-6" />);

export const IconSettings = icon(() => (
	<>
		<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
		<circle cx="12" cy="12" r="3" />
	</>
));

export const IconHelp = icon(() => (
	<>
		<circle cx="12" cy="12" r="9.5" />
		<path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
		<path d="M12 17h.01" />
	</>
));

export const IconLayers = icon(() => (
	<>
		<path d="m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z" />
		<path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65" />
		<path d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65" />
	</>
));

export const IconFunnel = icon(() => (
	<path d="M10 20a1 1 0 0 0 .553.895l2 1A1 1 0 0 0 14 21v-7a2 2 0 0 1 .517-1.341L21.74 4.67A1 1 0 0 0 21 3H3a1 1 0 0 0-.742 1.67l7.225 7.989A2 2 0 0 1 10 14z" />
));

export const IconArchive = icon(() => (
	<>
		<rect width="20" height="5" x="2" y="3" rx="1" />
		<path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8" />
		<path d="M10 12h4" />
	</>
));

export const IconShield = icon(() => (
	<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
));

export const IconArrowDownLine = icon(() => (
	<>
		<path d="M12 17V3" />
		<path d="m6 11 6 6 6-6" />
		<path d="M19 21H5" />
	</>
));

export const IconArrowUpLine = icon(() => (
	<>
		<path d="m18 9-6-6-6 6" />
		<path d="M12 3v14" />
		<path d="M5 21h14" />
	</>
));

export const IconRefresh = icon(() => (
	<>
		<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
		<path d="M21 3v5h-5" />
		<path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
		<path d="M8 16H3v5" />
	</>
));

export const IconTerminal = icon(() => (
	<>
		<path d="m7 11 2-2-2-2" />
		<path d="M11 13h4" />
		<rect width="18" height="18" x="3" y="3" rx="3" />
	</>
));

export const IconGrid = icon(() => (
	<>
		<rect width="7" height="7" x="3" y="3" rx="1.5" />
		<rect width="7" height="7" x="14" y="3" rx="1.5" />
		<rect width="7" height="7" x="14" y="14" rx="1.5" />
		<rect width="7" height="7" x="3" y="14" rx="1.5" />
	</>
));

/** Stacked pages — the file browser. */
export const IconFiles = icon(() => (
	<>
		<path d="M20 7h-3a2 2 0 0 1-2-2V2" />
		<path d="M9 18a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h7l4 4v10a2 2 0 0 1-2 2Z" />
		<path d="M3 7.6v12.8A1.6 1.6 0 0 0 4.6 22h9.8" />
	</>
));

/** Branch with a merge — the Git panel. */
export const IconGit = icon(() => (
	<>
		<circle cx="18" cy="18" r="3" />
		<circle cx="6" cy="6" r="3" />
		<path d="M6 21V9a9 9 0 0 0 9 9" />
	</>
));

export const IconBranch = icon(() => (
	<>
		<path d="M6 3v12" />
		<circle cx="18" cy="6" r="3" />
		<circle cx="6" cy="18" r="3" />
		<path d="M18 9a9 9 0 0 1-9 9" />
	</>
));

export const IconPullRequest = icon(() => (
	<>
		<circle cx="18" cy="18" r="3" />
		<circle cx="6" cy="6" r="3" />
		<path d="M13 6h3a2 2 0 0 1 2 2v7" />
		<path d="M6 9v12" />
	</>
));

export const IconChat = icon(() => <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />);

export const IconLightbulb = icon(() => (
	<>
		<path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5" />
		<path d="M9 18h6" />
		<path d="M10 22h4" />
	</>
));

/** Page with lines — the markdown panel. */
export const IconDocument = icon(() => (
	<>
		<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
		<path d="M14 2v4a2 2 0 0 0 2 2h4" />
		<path d="M16 13H8" />
		<path d="M16 17H8" />
		<path d="M10 9H8" />
	</>
));

export const IconBell = icon(() => (
	<>
		<path d="M10.268 21a2 2 0 0 0 3.464 0" />
		<path d="M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326" />
	</>
));

export const IconBolt = icon(() => (
	<path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z" />
));

export const IconEye = icon(() => (
	<>
		<path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0" />
		<circle cx="12" cy="12" r="3" />
	</>
));

export const IconAlert = icon(() => (
	<>
		<circle cx="12" cy="12" r="9.5" />
		<path d="M12 8v4" />
		<path d="M12 16h.01" />
	</>
));

export const IconHistory = icon(() => (
	<>
		<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
		<path d="M3 3v5h5" />
		<path d="M12 7v5l4 2" />
	</>
));

export const IconTrash = icon(() => (
	<>
		<path d="M3 6h18" />
		<path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
		<path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
	</>
));

export const IconExternal = icon(() => (
	<>
		<path d="M15 3h6v6" />
		<path d="M10 14 21 3" />
		<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
	</>
));

export const IconMic = icon(() => (
	<>
		<path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
		<path d="M19 10v2a7 7 0 0 1-14 0v-2" />
		<path d="M12 19v3" />
	</>
));

export const IconWaveform = icon(() => (
	<>
		<path d="M2 10v3" />
		<path d="M6 6v11" />
		<path d="M10 3v18" />
		<path d="M14 8v7" />
		<path d="M18 5v13" />
		<path d="M22 10v3" />
	</>
));

export const IconArrowUp = icon(() => (
	<>
		<path d="m5 12 7-7 7 7" />
		<path d="M12 19V5" />
	</>
));

export const IconSparkle = icon(() => (
	<>
		<path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z" />
	</>
));

export const IconCode = icon(() => (
	<>
		<path d="m16 18 6-6-6-6" />
		<path d="m8 6-6 6 6 6" />
	</>
));
