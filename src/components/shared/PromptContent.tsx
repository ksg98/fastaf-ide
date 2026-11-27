import { convertFileSrc } from "@tauri-apps/api/core";
import { type Component, createMemo, createSignal, For, type JSX, Show } from "solid-js";
import { isTauri } from "../../transport";
import { browserLocalImageUrl } from "../../utils/repoImageUrl";
import s from "./PromptContent.module.css";

/** Wider than two grid cells side by side: cropping it to one cell would show a blank middle. */
const STRIP_RATIO = 3.2;

const ImagePreview: Component<{ path: string }> = (props) => {
	const [failed, setFailed] = createSignal(false);
	const [strip, setStrip] = createSignal(false);
	const src = createMemo(() => (isTauri() ? convertFileSrc(props.path) : browserLocalImageUrl(props.path, true)));
	return (
		// In a grid the picture fills its cell, cropped; a very wide strip is shown whole instead.
		<div class={s.frame} title={props.path} data-fit={strip() ? "contain" : undefined}>
			<Show
				when={src() && !failed()}
				fallback={
					<span class={s.unavailable} role="img" aria-label="Image unavailable">
						Image unavailable
					</span>
				}
			>
				<img
					src={src()!}
					alt="Attached image"
					onLoad={(event) => {
						const { naturalWidth, naturalHeight } = event.currentTarget;
						setStrip(naturalHeight > 0 && naturalWidth / naturalHeight > STRIP_RATIO);
					}}
					onError={() => setFailed(true)}
				/>
			</Show>
		</div>
	);
};

// DEFERRED (2026-11-06) — native ACP image blocks arrive as plain "Image".
// They need backend source references before they can use these path-based previews.
/** The same attachment presentation for queued prompts and delivered user messages. */
export const PromptContent: Component<{ text: string; prose?: (text: string) => JSX.Element }> = (props) => {
	const content = createMemo(() => {
		const images: string[] = [];
		const text = props.text.replace(/\[image:\s*([^\]\r\n]+)\]/g, (_, path: string) => {
			images.push(path.trim());
			return "";
		});
		return { images, text: images.length ? text.trim() : text };
	});
	return (
		<div class={s.content}>
			<Show when={content().images.length}>
				<div
					class={s.images}
					data-prompt-images={
						content().images.length === 1 ? "single" : content().images.length === 2 ? "pair" : "grid"
					}
				>
					<For each={content().images}>{(path) => <ImagePreview path={path} />}</For>
				</div>
			</Show>
			<Show when={content().text}>
				<div class={s.prose}>{props.prose ? props.prose(content().text) : content().text}</div>
			</Show>
		</div>
	);
};
