import { invoke } from "@tauri-apps/api/core";

/**
 * File pickers, routed through our own Rust command instead of
 * `@tauri-apps/plugin-dialog`.
 *
 * The plugin builds `NSOpenPanel`/`NSSavePanel` inside its own main-thread
 * closure, so when AppKit's window-server link is interrupted — the degraded
 * state the Mac lands in after standby — the binding's NULL check panics on the
 * main thread and the whole app dies, PTY sessions included. That is the
 * 2026-09-18 crash. `src-tauri/src/native_dialog.rs` owns the main-thread frame
 * so the unwind is caught and surfaces here as a rejected promise.
 *
 * Import these instead of `open`/`save` from `@tauri-apps/plugin-dialog`. The
 * plugin's `confirm`/`message` are unaffected — they build `NSAlert`, not a
 * panel — and stay where they are.
 */

export interface DialogFilter {
	name: string;
	extensions: string[];
}

export interface OpenDialogOptions {
	title?: string;
	defaultPath?: string;
	directory?: boolean;
	multiple?: boolean;
	filters?: DialogFilter[];
}

export interface SaveDialogOptions {
	title?: string;
	defaultPath?: string;
	fileName?: string;
}

type PickKind = "file" | "files" | "folder" | "save";

async function pick(
	kind: PickKind,
	opts: { title?: string; defaultPath?: string; fileName?: string; filters?: DialogFilter[] },
): Promise<string[] | null> {
	const picked = await invoke<string[] | null>("pick_path", {
		kind,
		title: opts.title ?? null,
		defaultPath: opts.defaultPath ?? null,
		fileName: opts.fileName ?? null,
		filters: opts.filters ?? null,
	});
	return picked ?? null;
}

/**
 * Mirrors the shape the plugin's `open` returned — `string` for a single pick,
 * `string[]` when `multiple` — so call sites keep their existing narrowing.
 *
 * The overloads carry that distinction in the type, as the plugin's did: without
 * them every caller gets `string | string[]` and has to re-narrow a case that
 * cannot happen, which is what `multiple: false` already ruled out.
 */
export async function openDialog(opts: OpenDialogOptions & { multiple: true }): Promise<string[] | null>;
export async function openDialog(opts?: OpenDialogOptions & { multiple?: false }): Promise<string | null>;
export async function openDialog(opts?: OpenDialogOptions): Promise<string | string[] | null>;
export async function openDialog(opts: OpenDialogOptions = {}): Promise<string | string[] | null> {
	const kind: PickKind = opts.directory ? "folder" : opts.multiple ? "files" : "file";
	const picked = await pick(kind, opts);
	if (!picked || picked.length === 0) return null;
	return opts.multiple ? picked : picked[0];
}

export async function saveDialog(opts: SaveDialogOptions = {}): Promise<string | null> {
	const picked = await pick("save", opts);
	return picked?.[0] ?? null;
}
