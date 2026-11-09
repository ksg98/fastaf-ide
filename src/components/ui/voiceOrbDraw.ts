/**
 * The voice orb's drawing, kept as a pure function so the canvas component
 * stays a thin shell and the look can be previewed anywhere with a 2D context.
 *
 * One sphere of opaque glass, lit from the top left, with three things moving
 * on it:
 *   - a halo ring outside it, which grows with the microphone (`mic`), so
 *     you can see it hear you;
 *   - the core, which opens and brightens with the agent's own speech
 *     (`output`), so you can see it talk;
 *   - one glint orbiting inside it while it thinks.
 * A slow breath keeps it alive while listening. Muted drains the colour.
 *
 * The body is opaque on purpose. A translucent white highlight over a dark
 * window reads as a grey smudge once the orb is larger than a toolbar icon,
 * and the dock draws it at 78 px.
 */

export type OrbPhase = "idle" | "listening" | "thinking" | "speaking" | "muted";

export interface OrbParams {
	/** Accent colour as an "r, g, b" triple. */
	accent: string;
	/** Time in seconds — drives the breath, the inner lights and the glint. */
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
const MUTED_RGB = [128, 128, 128];
/** Below this canvas size the inner lights are too small to see. */
const LIGHTS_MIN_SIZE = 60;

/** Blend two colours channel by channel; returns an "r, g, b" triple. */
function mix(from: number[], to: number[], amount: number): string {
	return from.map((v, i) => Math.round(v + (to[i] - v) * amount)).join(", ");
}

function parseTriple(triple: string): number[] {
	const parts = triple.split(",").map((part) => Number(part.trim()));
	return parts.length === 3 && parts.every((n) => Number.isFinite(n)) ? parts : [90, 160, 248];
}

export function drawOrb(ctx: CanvasRenderingContext2D, size: number, p: OrbParams): void {
	const cx = size / 2;
	const cy = size / 2;
	// Base radius leaves room for the halo at full mic level.
	const base = size * 0.3;
	const breath = p.still ? 0 : Math.sin(p.t * (TAU / 4.2)) * 0.5 + 0.5; // 0..1 over 4.2 s
	const muted = p.phase === "muted";
	const colour = muted ? MUTED_RGB : parseTriple(p.accent);
	const rgb = colour.join(", ");

	ctx.clearRect(0, 0, size, size);

	// ── Halo: the microphone. Grows outward and fades as it grows. ──
	const micR = base * (1.12 + p.mic * 0.7 + breath * 0.02);
	if (!muted && p.mic > 0.01) {
		const halo = ctx.createRadialGradient(cx, cy, base * 0.95, cx, cy, micR);
		halo.addColorStop(0, `rgba(${rgb}, ${0.5 * p.mic + 0.1})`);
		halo.addColorStop(1, `rgba(${rgb}, 0)`);
		ctx.fillStyle = halo;
		ctx.beginPath();
		ctx.arc(cx, cy, micR, 0, TAU);
		ctx.fill();
	}

	// ── Ambient glow behind the sphere: brighter while speaking. ──
	const glowStrength = muted ? 0.06 : 0.2 + p.output * 0.3 + breath * 0.08;
	const glowR = base * (1.45 + p.output * 0.25);
	const glow = ctx.createRadialGradient(cx, cy, base * 0.5, cx, cy, glowR);
	glow.addColorStop(0, `rgba(${rgb}, ${glowStrength})`);
	glow.addColorStop(1, `rgba(${rgb}, 0)`);
	ctx.fillStyle = glow;
	ctx.beginPath();
	ctx.arc(cx, cy, glowR, 0, TAU);
	ctx.fill();

	// ── The sphere itself. Breathes a little; swells with speech. ──
	const r = base * (1 + breath * 0.03 + p.output * 0.1);
	const body = ctx.createRadialGradient(cx - r * 0.38, cy - r * 0.44, r * 0.05, cx, cy, r * 1.06);
	body.addColorStop(0, `rgb(${mix(colour, [255, 255, 255], muted ? 0.45 : 0.85)})`);
	body.addColorStop(0.12, `rgb(${mix(colour, [255, 255, 255], muted ? 0.15 : 0.32)})`);
	body.addColorStop(0.34, `rgb(${rgb})`);
	body.addColorStop(1, `rgb(${mix(colour, muted ? [20, 20, 20] : [6, 10, 60], 0.55)})`);
	ctx.fillStyle = body;
	ctx.beginPath();
	ctx.arc(cx, cy, r, 0, TAU);
	ctx.fill();

	ctx.save();
	ctx.beginPath();
	ctx.arc(cx, cy, r, 0, TAU);
	ctx.clip();

	// ── Slow lights drifting inside the glass, so a large orb is alive rather
	//    than a flat ball. ──
	if (!muted && size > LIGHTS_MIN_SIZE) {
		const drift = [0.21, -0.29, 0.17];
		for (let i = 0; i < drift.length; i++) {
			const a = (p.still ? 0 : p.t * drift[i]) + i * 2.1;
			const bx = cx + Math.cos(a) * r * 0.5;
			const by = cy + Math.sin(a * 1.4) * r * 0.42 + r * 0.12;
			const light = ctx.createRadialGradient(bx, by, 0, bx, by, r * 0.62);
			light.addColorStop(0, `rgba(255, 255, 255, ${0.055 + p.output * 0.2})`);
			light.addColorStop(1, "rgba(255, 255, 255, 0)");
			ctx.fillStyle = light;
			ctx.fillRect(0, 0, size, size);
		}
	}

	// ── Core: the voice. A bright centre that opens up as the agent speaks. ──
	if (!muted && p.output > 0.01) {
		const coreR = r * (0.3 + p.output * 0.5);
		const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreR);
		core.addColorStop(0, `rgba(255, 255, 255, ${0.45 + p.output * 0.5})`);
		core.addColorStop(1, "rgba(255, 255, 255, 0)");
		ctx.fillStyle = core;
		ctx.beginPath();
		ctx.arc(cx, cy, coreR, 0, TAU);
		ctx.fill();
	}

	// ── Shade toward the lower edge, then a thin rim of light, glass style. ──
	const shade = ctx.createRadialGradient(cx - r * 0.15, cy - r * 0.2, r * 0.55, cx, cy, r * 1.02);
	shade.addColorStop(0, "rgba(0, 0, 0, 0)");
	shade.addColorStop(1, "rgba(0, 0, 0, 0.3)");
	ctx.fillStyle = shade;
	ctx.fillRect(0, 0, size, size);
	const rim = ctx.createRadialGradient(cx + r * 0.12, cy + r * 0.16, r * 0.82, cx, cy, r * 1.01);
	rim.addColorStop(0, "rgba(255, 255, 255, 0)");
	rim.addColorStop(0.9, "rgba(255, 255, 255, 0)");
	rim.addColorStop(1, `rgba(255, 255, 255, ${muted ? 0.2 : 0.5})`);
	ctx.fillStyle = rim;
	ctx.fillRect(0, 0, size, size);

	// ── Thinking: one glint orbiting inside the sphere. ──
	if (p.phase === "thinking" && !p.still) {
		const a = p.t * (TAU / 1.8);
		const gx = cx + Math.cos(a) * r * 0.74;
		const gy = cy + Math.sin(a) * r * 0.74;
		const glint = ctx.createRadialGradient(gx, gy, 0, gx, gy, r * 0.34);
		glint.addColorStop(0, "rgba(255, 255, 255, 0.95)");
		glint.addColorStop(1, "rgba(255, 255, 255, 0)");
		ctx.fillStyle = glint;
		ctx.fillRect(0, 0, size, size);
	}
	ctx.restore();

	// ── Muted: a slash, so the state reads without colour. ──
	if (muted) {
		ctx.strokeStyle = "rgba(255, 255, 255, 0.8)";
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
