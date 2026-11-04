import { type Accessor, createEffect, createSignal, onCleanup } from "solid-js";
import type { AcpProviderRetry } from "../../stores/acpTranscript";

/** One presentation timer for the selected conversation, owned by the panel. */
export function createRetryCountdown(retry: Accessor<AcpProviderRetry | null>): Accessor<string | null> {
	const [text, setText] = createSignal<string | null>(null);
	createEffect(() => {
		const status = retry();
		if (!status || status.retryAt === undefined) {
			setText(status?.text ?? null);
			return;
		}
		const deadline = status.retryAt;
		const update = () => {
			const seconds = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
			setText(
				status.text.replace(
					/retrying in \d+s(?= \(attempt \d+\/\d+\)$)/,
					seconds > 0 ? `retrying in ${seconds}s` : "retrying now",
				),
			);
			return seconds;
		};
		if (update() === 0) return;
		const timer = setInterval(() => {
			if (update() === 0) clearInterval(timer);
		}, 1000);
		onCleanup(() => clearInterval(timer));
	});
	return text;
}
