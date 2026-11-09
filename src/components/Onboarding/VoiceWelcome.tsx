import { type Component, createSignal, onCleanup, Show } from "solid-js";
import helloUrl from "../../assets/voice/hello.m4a";
import { t } from "../../i18n";
import { appLogger } from "../../stores/appLogger";
import { onboardingStore } from "../../stores/onboarding";
import { voiceSetup } from "../../stores/voiceSetup";
import { IconMic } from "../icons";
import { VoiceOrb } from "../ui/VoiceOrb";
import s from "./VoiceWelcome.module.css";

/** Sphere diameter; the canvas is larger, to leave room for the halo. */
const ORB = 112;
const ORB_CANVAS = Math.round(ORB / 0.6);
/** Progress ring: radius and box, in the ring's own units. */
const RING_R = 65;
const RING_BOX = 134;
const RING_LENGTH = 2 * Math.PI * RING_R;

/**
 * The first thing a new install shows: FastAF is something you talk to.
 *
 * One button turns voice on. It greets the user out loud straight away — a
 * short recording in FastAF's own voice that ships with the app, so the first
 * spoken sentence does not wait for a download — while the speech model and
 * the voice download behind it. When they are in, the empty well's composer
 * is already listening for what to build. "Not now" leaves voice off and goes
 * on to the terminals introduction; the orb in the dock offers this again.
 */
export const VoiceWelcome: Component = () => {
	const [greeting, setGreeting] = createSignal(false);
	let audio: HTMLAudioElement | undefined;

	onCleanup(() => audio?.pause());

	/** Say hello. Runs inside the click, which is what lets a webview play sound. */
	const greet = () => {
		try {
			audio = new Audio(helloUrl);
			audio.addEventListener("ended", () => setGreeting(false));
			setGreeting(true);
			void audio.play().catch(() => setGreeting(false));
		} catch (err) {
			setGreeting(false);
			appLogger.debug("voice", "Greeting could not play", err);
		}
	};

	const turnOn = async () => {
		if (voiceSetup.state.running) return;
		greet();
		if (await voiceSetup.run()) {
			voiceSetup.requestFirstPrompt();
			onboardingStore.dismiss("voice");
			// Straight to "what should we build": the terminals introduction
			// stays under Help › Getting started.
			onboardingStore.dismiss("welcome");
		}
	};

	const later = () => {
		audio?.pause();
		voiceSetup.dismiss();
		onboardingStore.dismiss("voice");
	};

	const busy = () => voiceSetup.state.running;
	const failed = () => voiceSetup.state.step === "failed";

	return (
		<div class={s.welcome} data-testid="voice-welcome">
			<span class={s.orbBox} style={{ width: `${ORB}px`, height: `${ORB}px` }}>
				<VoiceOrb
					state={greeting() ? "speaking" : busy() ? "thinking" : "listening"}
					mic={0}
					output={greeting() ? 0.55 : 0}
					size={ORB_CANVAS}
				/>
				<Show when={busy()}>
					<svg class={s.ring} viewBox={`0 0 ${RING_BOX} ${RING_BOX}`} aria-hidden="true">
						<circle class={s.ringTrack} cx={RING_BOX / 2} cy={RING_BOX / 2} r={RING_R} />
						<circle
							class={s.ringFill}
							cx={RING_BOX / 2}
							cy={RING_BOX / 2}
							r={RING_R}
							stroke-dasharray={`${RING_LENGTH}`}
							stroke-dashoffset={`${RING_LENGTH * (1 - voiceSetup.percent() / 100)}`}
						/>
					</svg>
				</Show>
			</span>

			<Show
				when={busy()}
				fallback={
					<div class={s.copy}>
						<h1 class={s.title}>{t("voiceWelcome.title", "Talk to your agents.")}</h1>
						<p class={s.lede}>
							{t(
								"voiceWelcome.lede",
								"Say what you want built. FastAF hands it to Claude Code or Codex, watches the work, and tells you when it is done.",
							)}
						</p>
						<Show when={failed()}>
							<p class={s.problem} data-testid="voice-welcome-error">
								{voiceSetup.state.error}
							</p>
						</Show>
						<button type="button" class={s.go} onClick={() => void turnOn()} data-testid="voice-welcome-on">
							<IconMic size={16} />
							{failed() ? t("voiceWelcome.retry", "Try again") : t("voiceWelcome.turnOn", "Turn on voice")}
						</button>
						<button type="button" class={s.later} onClick={later} data-testid="voice-welcome-later">
							{t("voiceWelcome.later", "Not now, I'll type")}
						</button>
					</div>
				}
			>
				<div class={s.copy} data-testid="voice-welcome-progress">
					<div class={s.who}>{t("talk.agentName", "FastAF")}</div>
					<p class={s.say}>
						{t("voiceWelcome.hello", "Hi, I'm FastAF. Give me a moment to get ready, then tell me what to build.")}
					</p>
					<p class={s.progress}>
						{t("voiceWelcome.progress", "Getting speech ready · {percent}%", { percent: String(voiceSetup.percent()) })}
					</p>
				</div>
			</Show>

			<p class={s.foot}>
				{t("voiceWelcome.foot", "Speech runs on this Mac. Nothing you say leaves it. One download, about {mb} MB.", {
					mb: String(voiceSetup.downloadMb() || 660),
				})}
			</p>
		</div>
	);
};

export default VoiceWelcome;
