import { createEffect, onCleanup, onMount } from "solid-js";
import type { VoiceAgentState } from "../../stores/voice";
import styles from "./VoiceOrb.module.css";
import { drawOrb, type OrbPhase, smoothLevel } from "./voiceOrbDraw";

/**
 * The voice agent, as a thing you can watch: a small canvas sphere that
 * breathes while idle, opens a halo when it hears you, brightens its core
 * while it speaks, and orbits a glint while it thinks.
 *
 * Cost is deliberately tiny — one canvas of `size` CSS pixels drawn at up to
 * 30 fps only while a session is live; the loop stops when the state goes
 * idle or the component unmounts. Levels come from the voice store's status
 * poll (microphone and speaker RMS from Rust), smoothed here so the picture
 * moves at animation pace rather than at polling pace.
 */
export interface VoiceOrbProps {
	state: VoiceAgentState;
	/** Microphone level, 0..1. */
	mic: number;
	/** Speaker level of the agent's own speech, 0..1. */
	output: number;
	/** Diameter in CSS pixels. */
	size?: number;
	class?: string;
	title?: string;
}

const FRAME_MS = 1000 / 30;

function phaseFor(state: VoiceAgentState): OrbPhase {
	switch (state) {
		case "muted":
			return "muted";
		case "thinking":
		case "transcribing":
			return "thinking";
		case "speaking":
			return "speaking";
		case "listening":
			return "listening";
		default:
			return "idle";
	}
}

export function VoiceOrb(props: VoiceOrbProps) {
	let canvas: HTMLCanvasElement | undefined;
	let raf = 0;
	let last = 0;
	let mic = 0;
	let output = 0;
	let running = false;

	const size = () => props.size ?? 56;

	const accent = (): string => {
		const v = getComputedStyle(document.documentElement).getPropertyValue("--accent-rgb").trim();
		return v || "90, 160, 248";
	};

	const still = (): boolean =>
		typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;

	// happy-dom has no canvas; the orb then renders as an empty element.
	const context2d = (): CanvasRenderingContext2D | null =>
		canvas && typeof canvas.getContext === "function" ? canvas.getContext("2d") : null;

	const frame = (now: number) => {
		if (!running || !canvas) return;
		const ctx = context2d();
		if (!ctx) return;
		const dt = last ? Math.min(0.1, (now - last) / 1000) : FRAME_MS / 1000;
		if (now - last >= FRAME_MS - 1) {
			last = now;
			mic = smoothLevel(mic, props.state === "muted" ? 0 : props.mic, dt);
			output = smoothLevel(output, props.output, dt);
			const dpr = window.devicePixelRatio || 1;
			const px = Math.round(size() * dpr);
			if (canvas.width !== px || canvas.height !== px) {
				canvas.width = px;
				canvas.height = px;
			}
			ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
			drawOrb(ctx, size(), {
				accent: accent(),
				t: now / 1000,
				phase: phaseFor(props.state),
				mic,
				output,
				still: still(),
			});
		}
		raf = requestAnimationFrame(frame);
	};

	const start = () => {
		if (running) return;
		running = true;
		last = 0;
		raf = requestAnimationFrame(frame);
	};

	const stop = () => {
		running = false;
		if (raf) cancelAnimationFrame(raf);
		raf = 0;
	};

	onMount(start);
	// The loop only runs while there is something to show; idle orbs still get
	// one frame so they are never blank.
	createEffect(() => {
		if (props.state === "idle") {
			stop();
			const ctx = context2d();
			if (ctx && canvas) {
				const dpr = window.devicePixelRatio || 1;
				canvas.width = Math.round(size() * dpr);
				canvas.height = Math.round(size() * dpr);
				ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
				drawOrb(ctx, size(), { accent: accent(), t: 0, phase: "idle", mic: 0, output: 0, still: true });
			}
		} else {
			start();
		}
	});
	onCleanup(stop);

	return (
		<canvas
			ref={canvas}
			class={`${styles.orb} ${props.class ?? ""}`}
			style={{ width: `${size()}px`, height: `${size()}px` }}
			role="img"
			aria-label={props.title ?? `Voice agent ${props.state}`}
			title={props.title}
			data-state={props.state}
		/>
	);
}

export default VoiceOrb;
