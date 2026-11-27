import { type Component, For, onCleanup, Show } from "solid-js";
import { appLogger } from "../../stores/appLogger";
import {
	answerOutsideRequest,
	isFabbricaId,
	openFabbricaConsole,
	type WaitingItem,
	waitingItemsStore,
} from "../../stores/waitingItems";
import { Button } from "../ui/Button";
import s from "./StoriesDialog.module.css";

/** Manual checks of this project, plus the
 *  Fabbrica items every project shows. Fabbrica outside requests are answered here; every other answer stays in its source. */
export const WaitingOnYou: Component<{ project: string; onSelect: (item: WaitingItem) => void }> = (props) => {
	onCleanup(waitingItemsStore.retain());
	const items = () =>
		waitingItemsStore.snapshot()?.items.filter((item) => item.project === props.project || isFabbricaId(item.id)) ?? [];
	const warnings = () => waitingItemsStore.snapshot()?.warnings ?? [];
	// An unreadable or unconnected Fabbrica is not "nothing to do": say so.
	const fabbricaNotice = () => {
		const fabbrica = waitingItemsStore.snapshot()?.fabbrica;
		if (fabbrica?.state === "unknown") return `Fabbrica state is unknown: ${fabbrica.reason ?? "the read failed"}`;
		if (fabbrica?.state === "connect") return "Connect Fabbrica: authorize the fabbrica server in Settings › MCP.";
		return null;
	};
	const select = (item: WaitingItem) => (isFabbricaId(item.id) ? openFabbricaConsole() : props.onSelect(item));
	const answer = (item: WaitingItem, decision: "accept" | "decline") =>
		answerOutsideRequest(item, decision).catch((error: unknown) =>
			appLogger.warn("panel", "Could not answer the outside request", error),
		);
	const detail = (item: WaitingItem) => {
		if (item.kind === "manual_check") return "Manual check";
		return item.detail;
	};
	return (
		<Show when={items().length > 0 || warnings().length > 0 || fabbricaNotice() || waitingItemsStore.failed()}>
			<section class={s.waiting} aria-label="Waiting on you">
				<h3>{`Waiting on you · ${items().length}`}</h3>
				<Show when={waitingItemsStore.failed()}>
					<p class={s.muted}>Waiting items are unavailable.</p>
				</Show>
				<For each={warnings()}>{(warning) => <p class={s.muted}>{warning}</p>}</For>
				<Show when={fabbricaNotice()}>{(notice) => <p class={s.muted}>{notice()}</p>}</Show>
				{/* One row per item. An outside request is answered here, so its two
				    answers sit at the end of its own row; the rest open their source. */}
				<nav class={`${s.items} ${s.waitingList}`} aria-label="Waiting items">
					<For each={items()}>
						{(item) => (
							<div class={s.waitingRow}>
								<button data-control-layout="row" type="button" class={s.item} onClick={() => select(item)}>
									<span>{item.title}</span>
									<small>{detail(item)}</small>
								</button>
								<Show when={item.kind === "outside_request"}>
									<div class={s.waitingActions} role="group" aria-label={`Answer: ${item.title}`}>
										<Button size="compact" onClick={() => answer(item, "accept")}>
											Accept
										</Button>
										<Button size="compact" variant="ghost" onClick={() => answer(item, "decline")}>
											Decline
										</Button>
									</div>
								</Show>
							</div>
						)}
					</For>
				</nav>
			</section>
		</Show>
	);
};
