/**
 * The voice orb's drawing, kept as a pure function so the canvas component
 * stays a thin shell and the look can be previewed anywhere with a 2D context.
 *
 * One sphere, lit from the top left, with two things moving on it:
 *   - the core, which swells and brightens with the agent's own speech
 *     (`output`), so you can see it talk;
 *   - a halo ring outside it, which grows with the microphone (`mic`), so
 *     you can see it hear you.
 * A slow breath keeps it alive while idle; thinking adds one orbiting glint.
 * Muted drains the colour. Nothing here allocates per frame beyond gradients.
 */

export type OrbPhase = "idle" | "listening" | "thinking" | "speaking" | "muted";

export interface OrbParams {
	/** Accent colour as an "r, g, b" triple. */
	accent: string;
	/** Time in seconds — drives the breath and the thinking glint. */
	t: number;
	phase: OrbPhase;
	/** Smoothed microphone level, 0..1. */
	mic: number;
	/** Smoothed speaker level, 0..1. */
	output: number;
	/** Skip continuous motion (prefers-reduced-motion); levels still show. */
	still: boolean;
}

const TAU = Math.PI * 2;

export function drawOrb(ctx: CanvasRenderingContext2D, size: number, p: OrbParams): void {
	const cx = size / 2;
	const cy = size / 2;
	// Base radius leaves room for the halo at full mic level.
	const base = size * 0.3;
	const breath = p.still ? 0 : Math.sin(p.t * (TAU / 4.2)) * 0.5 + 0.5; // 0..1 over 4.2 s
	const muted = p.phase === "muted";
	const rgb = muted ? "128, 128, 128" : p.accent;

	ctx.clearRect(0, 0, size, size);

	// ── Halo: the microphone. Grows outward and fades as it grows. ──
	const micR = base * (1.12 + p.mic * 0.7 + breath * 0.02);
	if (!muted && p.mic > 0.01) {
		const halo = ctx.createRadialGradient(cx, cy, base * 0.95, cx, cy, micR);
		halo.addColorStop(0, `rgba(${rgb}, ${0.45 * p.mic + 0.08})`);
		halo.addColorStop(1, `rgba(${rgb}, 0)`);
		ctx.fillStyle = halo;
		ctx.beginPath();
		ctx.arc(cx, cy, micR, 0, TAU);
		ctx.fill();
	}

	// ── Ambient glow behind the sphere: brighter while speaking. ──
	const glowStrength = muted ? 0.05 : 0.1 + p.output * 0.35 + breath * 0.04;
	const glowR = base * (1.35 + p.output * 0.25);
	const glow = ctx.createRadialGradient(cx, cy, base * 0.4, cx, cy, glowR);
	glow.addColorStop(0, `rgba(${rgb}, ${glowStrength})`);
	glow.addColorStop(1, `rgba(${rgb}, 0)`);
	ctx.fillStyle = glow;
	ctx.beginPath();
	ctx.arc(cx, cy, glowR, 0, TAU);
	ctx.fill();

	// ── The sphere itself. Breathes a little; swells with speech. ──
	const r = base * (1 + breath * 0.03 + p.output * 0.1);
	const body = ctx.createRadialGradient(cx - r * 0.35, cy - r * 0.4, r * 0.1, cx, cy, r);
	if (muted) {
		body.addColorStop(0, "rgba(150, 150, 150, 0.55)");
		body.addColorStop(0.6, "rgba(90, 90, 90, 0.55)");
		body.addColorStop(1, "rgba(40, 40, 40, 0.7)");
	} else {
		body.addColorStop(0, `rgba(255, 255, 255, ${0.55 + p.output * 0.3})`);
		body.addColorStop(0.35, `rgba(${rgb}, 0.95)`);
		body.addColorStop(1, `rgba(${rgb}, 0.55)`);
	}
	ctx.fillStyle = body;
	ctx.beginPath();
	ctx.arc(cx, cy, r, 0, TAU);
	ctx.fill();

	// ── Core: the voice. A bright centre that opens up as the agent speaks. ──
	if (!muted && p.output > 0.01) {
		const coreR = r * (0.25 + p.output * 0.45);
		const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreR);
		core.addColorStop(0, `rgba(255, 255, 255, ${0.5 + p.output * 0.45})`);
		core.addColorStop(1, "rgba(255, 255, 255, 0)");
		ctx.fillStyle = core;
		ctx.beginPath();
		ctx.arc(cx, cy, coreR, 0, TAU);
		ctx.fill();
	}

	// ── Rim light: a thin bright arc along the top-left edge, glass style. ──
	ctx.save();
	ctx.beginPath();
	ctx.arc(cx, cy, r, 0, TAU);
	ctx.clip();
	const rim = ctx.createRadialGradient(cx - r * 0.2, cy - r * 0.25, r * 0.7, cx, cy, r * 1.02);
	rim.addColorStop(0, "rgba(255, 255, 255, 0)");
	rim.addColorStop(0.85, "rgba(255, 255, 255, 0)");
	rim.addColorStop(1, `rgba(255, 255, 255, ${muted ? 0.15 : 0.35})`);
	ctx.fillStyle = rim;
	ctx.fillRect(0, 0, size, size);
	ctx.restore();

	// ── Thinking: one glint orbiting the sphere. ──
	if (p.phase === "thinking" && !p.still) {
		const a = p.t * (TAU / 1.8);
		const gx = cx + Math.cos(a) * r * 0.78;
		const gy = cy + Math.sin(a) * r * 0.78;
		const glint = ctx.createRadialGradient(gx, gy, 0, gx, gy, r * 0.3);
		glint.addColorStop(0, "rgba(255, 255, 255, 0.85)");
		glint.addColorStop(1, "rgba(255, 255, 255, 0)");
		ctx.fillStyle = glint;
		ctx.beginPath();
		ctx.arc(gx, gy, r * 0.3, 0, TAU);
		ctx.fill();
	}

	// ── Muted: a slash, so the state reads without colour. ──
	if (muted) {
		ctx.strokeStyle = "rgba(255, 255, 255, 0.7)";
		ctx.lineWidth = Math.max(1.5, size * 0.03);
		ctx.lineCap = "round";
		ctx.beginPath();
		ctx.moveTo(cx - r * 0.55, cy + r * 0.55);
		ctx.lineTo(cx + r * 0.55, cy - r * 0.55);
		ctx.stroke();
	}
}

/**
 * Level smoothing: fast attack so speech onsets register, slow release so
 * the orb settles rather than flickers. `dt` in seconds.
 */
export function smoothLevel(current: number, target: number, dt: number): number {
	const rate = target > current ? 18 : 6;
	const k = 1 - Math.exp(-rate * dt);
	return current + (target - current) * k;
}
