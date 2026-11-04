import { EditorView } from "@codemirror/view";
import { convertFileSrc } from "@tauri-apps/api/core";
import { type Accessor, createEffect, createSignal, onCleanup } from "solid-js";
import { registerNativeFileDropTarget } from "../../hooks/nativeFileDropTargets";
import { appLogger } from "../../stores/appLogger";
import { generateId } from "../../stores/ideas";
import { imageFileType, isImageFileType, saveImageFile, savePastedImage } from "../../utils/pastedImage";

/** File gestures own their insertion point; paste keeps its existing live-caret behavior. */
export function useComposeImages(editorView: Accessor<EditorView | undefined>, isOpen: Accessor<boolean>) {
	const [error, setError] = createSignal<string | null>(null);
	let disposed = false;
	onCleanup(() => {
		disposed = true;
	});
	let imageNoteId: string | undefined;
	const getNoteId = () => (imageNoteId ??= generateId());
	let insertions: Promise<void> = Promise.resolve();
	const pending = new Set<{ from: number; to: number }>();

	const attach = (files: (File | string)[], view: EditorView, point?: { x: number; y: number }) => {
		if (!files.length) return;
		setError(null);
		const selection = view.state.selection.main;
		const position = point ? view.posAtCoords(point) : null;
		const range = { from: position ?? selection.from, to: position ?? selection.to };
		pending.add(range);
		insertions = insertions.then(async () => {
			try {
				for (const source of files) {
					if (disposed || !isOpen()) return;
					const type = typeof source === "string" ? imageFileType(source) : source.type;
					if (!type || !isImageFileType(type)) {
						setError("Choose a PNG, JPEG, WebP or GIF image.");
						continue;
					}
					let file: File;
					if (typeof source === "string") {
						const response = await fetch(convertFileSrc(source));
						if (!response.ok) throw new Error("Unable to read dropped image");
						file = new File([await response.blob()], source, { type });
					} else file = source;
					const path = await saveImageFile(file, getNoteId);
					if (disposed || !isOpen()) return;
					if (!path) {
						setError("Failed to attach image. Try again.");
						continue;
					}
					const tag = `[image: ${path}]`;
					const end = range.from + tag.length;
					view.dispatch({ changes: { ...range, insert: tag } });
					// Replacement-start mapping stays before the insertion; advance explicitly.
					range.from = range.to = end;
				}
			} catch (err) {
				if (!disposed) setError("Failed to attach image. Try again.");
				appLogger.error("store", "Failed to attach image", err);
			} finally {
				pending.delete(range);
			}
		});
	};

	createEffect(() => {
		const view = editorView();
		if (!view || !isOpen()) return;
		onCleanup(registerNativeFileDropTarget(view.dom, (paths, point) => attach(paths, view, point)));
	});

	const extension = [
		EditorView.updateListener.of((update) => {
			if (!update.docChanged) return;
			for (const range of pending) {
				range.from = update.changes.mapPos(range.from, 1);
				range.to = Math.max(range.from, update.changes.mapPos(range.to, -1));
			}
		}),
		EditorView.domEventHandlers({
			paste: (event, view) => {
				const saved = savePastedImage(event, getNoteId);
				if (!event.defaultPrevented) return false;
				insertions = insertions.then(() =>
					saved
						.then((path) => {
							if (path) view.dispatch(view.state.replaceSelection(`[image: ${path}]`));
						})
						.catch((err) => appLogger.error("store", "Failed to insert pasted image", err)),
				);
				return true;
			},
			dragover: (event) => {
				if (!event.dataTransfer?.types.includes("Files")) return false;
				event.preventDefault();
				event.stopPropagation();
				event.dataTransfer.dropEffect = "copy";
				return true;
			},
			drop: (event, view) => {
				const files = Array.from(event.dataTransfer?.files ?? []);
				if (!files.length) return false;
				event.preventDefault();
				event.stopPropagation();
				attach(files, view, { x: event.clientX, y: event.clientY });
				return true;
			},
		}),
	];
	return {
		extension,
		error,
		pick: (files: File[]) => {
			const view = editorView();
			if (view) attach(files, view);
		},
	};
}
