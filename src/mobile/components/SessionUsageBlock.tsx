import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { rpc } from "../../transport";
import {
	formatQuotaPlan,
	formatQuotaWindowDetails,
	formatUsageTime,
	type QuotaWindow,
} from "../../utils/sessionUsageFormatting";
import styles from "../screens/SessionDetailScreen.module.css";

/** Rust owns selection and cost semantics; the shared presenter owns local display. */
interface SessionUsage {
	availability: "available" | "unavailable";
	model: string | null;
	reason: string | null;
	stale: boolean;
	lines: { label: string; value: string }[];
	quota_windows?: QuotaWindow[];
	observed_at_ms?: number | null;
}

/** Mounted only while the overflow is open; no inventory polling or sticky ticker state. */
export function SessionUsageBlock(props: { sessionId: string }) {
	// Session list snapshots change on each active poll; only identity changes reload usage.
	const sessionId = createMemo(() => props.sessionId);
	const [usage, setUsage] = createSignal<SessionUsage | null>(null);
	const [loading, setLoading] = createSignal(true);
	createEffect(() => {
		const id = sessionId();
		let active = true;
		onCleanup(() => {
			active = false;
		});
		setUsage(null);
		setLoading(true);
		void rpc<SessionUsage>("get_session_usage", { sessionId: id })
			.then((snapshot) => {
				if (active) setUsage(snapshot);
			})
			.catch(() => {
				if (active) setUsage(null);
			})
			.finally(() => {
				if (active) setLoading(false);
			});
	});
	return (
		<section class={styles.usageBlock} aria-label="Session usage" aria-live="polite">
			<Show when={!loading()} fallback={<div>Usage: loading…</div>}>
				<Show when={usage()?.model}>{(model) => <div>Model: {model()}</div>}</Show>
				<Show
					when={usage()?.availability === "available"}
					fallback={
						<>
							<div>Usage not available</div>
							<Show when={usage()?.reason}>
								<div>{usage()!.reason}</div>
							</Show>
						</>
					}
				>
					<Show when={usage()?.stale}>
						<div>Last known usage (stale)</div>
					</Show>
					<Show when={usage()?.quota_windows?.[0]}>{(quota) => <div>{formatQuotaPlan(quota())}</div>}</Show>
					<For each={usage()?.quota_windows}>{(quota) => <div>{formatQuotaWindowDetails(quota)}</div>}</For>
					<Show when={usage()?.observed_at_ms && formatUsageTime(usage()!.observed_at_ms!)}>
						{(time) => <div>Report as of: {time()} local</div>}
					</Show>
					<For each={usage()?.lines}>
						{(line) => (
							<div>
								{line.label}: {line.value}
							</div>
						)}
					</For>
				</Show>
			</Show>
		</section>
	);
}
