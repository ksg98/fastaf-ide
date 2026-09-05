import { onboardingStore } from "../../stores/onboarding";
import { keyFor } from "../../utils/hotkey";
import s from "./WelcomeWell.module.css";

/**
 * The empty well on a fresh install. Instead of a placeholder illustration it
 * shows the one idea a new user has to get — many terminals, one per branch,
 * split and tiled — as three small moves with live-looking miniatures. Goes
 * away for good on "Got it" and is replaced by the tip of the day.
 */
export function WelcomeWell() {
	return (
		<div class={s.well} data-testid="welcome-well">
			<div class={s.intro}>
				<h2 class={s.title}>One place for every terminal</h2>
				<p class={s.lede}>
					FastAF runs a terminal per branch, so each agent gets its own room. The whole idea in three moves:
				</p>
			</div>

			<div class={s.cards}>
				<div class={s.card}>
					<div class={s.figure} aria-hidden="true">
						<div class={s.miniSidebar}>
							<span class={s.miniRepo} />
							<span class={s.miniBranch} />
							<span class={`${s.miniBranch} ${s.miniBranchActive}`} />
							<span class={s.miniBranch} />
						</div>
						<span class={s.miniArrow} />
						<div class={s.miniWell}>
							<span class={s.miniPrompt} />
							<span class={s.miniLine} />
							<span class={`${s.miniLine} ${s.miniLineShort}`} />
						</div>
					</div>
					<div class={s.cardTitle}>A terminal per branch</div>
					<p class={s.cardBody}>
						Click any branch in the sidebar. Its terminal opens here with its own shell, history and agent.
					</p>
				</div>

				<div class={s.card}>
					<div class={s.figure} aria-hidden="true">
						<div class={s.miniSplit}>
							<div class={s.miniPane}>
								<span class={s.miniPrompt} />
								<span class={s.miniLine} />
								<span class={`${s.miniLine} ${s.miniLineShort}`} />
							</div>
							<div class={s.miniPane}>
								<span class={s.miniPrompt} />
								<span class={`${s.miniLine} ${s.miniLineShort}`} />
							</div>
						</div>
					</div>
					<div class={s.cardTitle}>Split the well</div>
					<p class={s.cardBody}>Run two things side by side — a dev server next to the agent that is editing it.</p>
					<div class={s.keys}>
						<kbd class={s.kbd}>{keyFor("split-vertical")}</kbd>
						<kbd class={s.kbd}>{keyFor("split-horizontal")}</kbd>
					</div>
				</div>

				<div class={s.card}>
					<div class={s.figure} aria-hidden="true">
						<div class={s.miniGrid}>
							<div class={s.miniTile}>
								<span class={`${s.miniDot} ${s.miniDotBusy}`} />
							</div>
							<div class={s.miniTile}>
								<span class={s.miniDot} />
							</div>
							<div class={s.miniTile}>
								<span class={`${s.miniDot} ${s.miniDotWaiting}`} />
							</div>
							<div class={s.miniTile}>
								<span class={s.miniDot} />
							</div>
						</div>
					</div>
					<div class={s.cardTitle}>See them all</div>
					<p class={s.cardBody}>
						Multiview tiles every live terminal across all your repos, so you can watch several agents at once.
					</p>
					<div class={s.keys}>
						<kbd class={s.kbd}>{keyFor("toggle-multiview")}</kbd>
					</div>
				</div>
			</div>

			<div class={s.footer}>
				<button class={s.gotIt} onClick={() => onboardingStore.dismiss("welcome")}>
					Got it
				</button>
				<span class={s.footerNote}>This lives under Help › Getting started if you want it back.</span>
			</div>
		</div>
	);
}

export default WelcomeWell;
