import { For, onCleanup, Show } from "solid-js";
import { waitingItemsStore } from "../../stores/waitingItems";
import { cx } from "../../utils";
import { IconAlert, IconRefresh, IconTerminal } from "../icons";
import s from "./AgentHealthView.module.css";

/** A failure is red, a stall amber; any other kind the backend adds stays neutral. */
const dotClass = (kind: string) => (kind === "Failed" ? s.dotFailed : kind === "Stalled" ? s.dotStalled : undefined);

/** Agent failures and stalls. Items that wait on the user live in Plans and Stories and the bell. */
export function AgentHealthView(props: { onOpenSession: (sessionId: string, connectionId: string | null) => void }) {
	onCleanup(waitingItemsStore.retain({ health: true }));
	return (
		<section class={s.health} aria-label="Agent health" aria-busy={waitingItemsStore.loading()}>
			{/* One 32px row while there is nothing to report: the label, the all-clear
			    beside it, and the refresh. Where the facts come from is the label's tooltip. */}
			<div class={s.heading}>
				<h4
					data-tooltip="Failures and stalls from this machine's sessions and registered projects. A stall is flagged by the machine that runs the session."
					data-tooltip-pos="bottom"
					data-tooltip-align="left"
				>
					Agent health
				</h4>
				<Show when={waitingItemsStore.snapshot()}>
					{(data) => (
						<span class={s.summary}>
							{data().health.length === 0 ? "No agent failures or stalls reported." : `${data().health.length}`}
						</span>
					)}
				</Show>
				<button
					type="button"
					class={s.refresh}
					aria-label="Refresh health"
					data-tooltip="Refresh health"
					data-tooltip-pos="bottom"
					data-tooltip-align="right"
					onClick={() => void waitingItemsStore.refresh()}
				>
					<IconRefresh size={16} />
				</button>
			</div>
			<Show when={waitingItemsStore.failed()}>
				<p role="alert" class={s.alert}>
					<IconAlert size={14} />
					<span>Agent health is unavailable. Refresh to try again.</span>
				</p>
			</Show>
			<Show when={waitingItemsStore.liveFailed()}>
				<p role="alert" class={s.alert}>
					<IconAlert size={14} />
					<span>Live updates are unavailable. Refresh to see the current state.</span>
				</p>
			</Show>
			<Show when={waitingItemsStore.snapshot()}>
				{(data) => (
					<For each={data().health}>
						{(agent) => (
							<article class={s.item}>
								<span class={cx(s.dot, dotClass(agent.kind))} aria-hidden="true" />
								<div class={s.body}>
									<strong class={s.title}>
										{agent.kind} · {agent.name}
									</strong>
									<p class={s.reason}>{agent.reason}</p>
									<Show when={agent.connectionId}>
										<p class={s.remote}>Remote: {agent.connectionId}</p>
									</Show>
								</div>
								<button
									type="button"
									class={s.inspect}
									aria-label="Inspect terminal"
									data-tooltip="Inspect terminal"
									data-tooltip-align="right"
									onClick={() => props.onOpenSession(agent.sessionId, agent.connectionId)}
								>
									<IconTerminal size={16} />
								</button>
							</article>
						)}
					</For>
				)}
			</Show>
		</section>
	);
}
