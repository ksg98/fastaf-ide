import type { DirEntry } from "../../types/fs";
import { formatRelativeTime } from "../../utils/time";
import g from "../shared/git-status.module.css";

/**
 * Hover tooltip for a file/dir row: the relative path, then what the row itself
 * no longer shows — the size and when it last changed:
 * `src/App.tsx\n3.4 KB · modified 3h ago`.
 */
export function fileTooltip(entry: DirEntry): string {
	const path = entry.symlink_target_kind
		? `${entry.path}\n${entry.symlink_target_kind} link → ${entry.symlink_target ?? "Target unavailable"}`
		: entry.path;
	// A link's size is the link's own, not its target's: leave it out.
	const size = entry.is_dir || entry.symlink_target_kind ? "" : formatSize(entry.size);
	// modified_at is seconds since the epoch (see DirEntry); formatRelativeTime wants ms.
	const age = entry.modified_at ? formatRelativeTime(entry.modified_at * 1000) : "";
	const meta = size && age ? `${size} · modified ${age}` : size || (age ? `Modified ${age}` : "");
	return meta ? `${path}\n${meta}` : path;
}

/** Map git_status string to CSS class for status dot */
export function getStatusClass(status: string): string {
	switch (status) {
		case "modified":
			return g.modified;
		case "staged":
			return g.staged;
		case "untracked":
			return g.untracked;
		default:
			return "";
	}
}

/** The word a status dot's tooltip says ("Modified"), or "" for no status. */
export function statusLabel(status: string): string {
	switch (status) {
		case "modified":
			return "Modified";
		case "staged":
			return "Staged";
		case "untracked":
			return "Untracked";
		default:
			return "";
	}
}

/** A matching line split around its match, as a content-search row shows it. */
export interface MatchPreview {
	before: string;
	hit: string;
	after: string;
}

const isWordChar = (c: string) => /\w/.test(c);

/**
 * Split a content-search line around its match (UTF-16 offsets, as the panel
 * receives them). When more than `lead` characters come before the match, only
 * the last `lead` are kept — from the start of a word when one begins in them
 * — behind a leading "…", so a match far along a long line is still on screen
 * (VS Code's search view does the same). The end of the line is left whole;
 * the row's own ellipsis cuts it.
 */
export function matchPreview(line: string, start: number, end: number, lead: number): MatchPreview {
	const hit = line.slice(start, end);
	const after = line.slice(end);
	const full = line.slice(0, start);
	const before = full.trimStart();
	if (before.length <= lead) return { before: full, hit, after };
	let cut = before.length - lead;
	// Never split a surrogate pair (an emoji) in two.
	const code = before.charCodeAt(cut);
	if (code >= 0xdc00 && code <= 0xdfff) cut++;
	for (let i = cut; i < before.length; i++) {
		if (isWordChar(before[i]) && !isWordChar(before[i - 1] ?? " ")) {
			cut = i;
			break;
		}
	}
	return { before: `…${before.slice(cut).trimStart()}`, hit, after };
}

/** Format file size for display */
export function formatSize(bytes: number): string {
	if (bytes === 0) return "";
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
