import { For } from "solid-js";
import { Button } from "../../components/ui/Button";
import styles from "./HeroMetrics.module.css";
import type { SessionStatus } from "./StatusBadge";

interface HeroMetricsProps {
	workingCount: number;
	idleCount: number;
	awaitingCount: number;
	selectedStates?: ReadonlySet<SessionStatus>;
	onToggleState?: (status: SessionStatus) => void;
}

export function HeroMetrics(props: HeroMetricsProps) {
	return (
		<div class={styles.row}>
			<For each={["busy", "idle", "question"] as const}>
				{(status) => (
					<Button
						class={styles.card}
						geometry="stretch"
						data-testid="metric-card"
						aria-pressed={props.selectedStates?.has(status) ?? false}
						onClick={() => props.onToggleState?.(status)}
					>
						<span class={styles.content}>
							<span class={styles.number} data-testid="metric-number">
								{status === "busy" ? props.workingCount : status === "idle" ? props.idleCount : props.awaitingCount}
							</span>
							<span class={styles.label} data-testid="metric-label">
								{status === "busy" ? "Working" : status === "idle" ? "Idle" : "Awaiting"}
							</span>
						</span>
					</Button>
				)}
			</For>
		</div>
	);
}
