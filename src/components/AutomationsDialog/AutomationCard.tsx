import { Show } from "solid-js";
import { t } from "../../i18n";
import { pathBasename } from "../../utils/pathUtils";
import s from "./AutomationsDialog.module.css";
import type { AutomationListItem } from "./contract";
import { runStatusLabel } from "./runStatusLabel";
import { zonedTime } from "./ScheduleFields";
import { scheduleLabel } from "./scheduleLabel";

export function AutomationCard(props: {
	item: AutomationListItem;
	selected: boolean;
	disabled: boolean;
	onSelect: () => void;
}) {
	const definition = () => props.item.definition;
	return (
		<button
			data-control-layout="card"
			type="button"
			disabled={props.disabled}
			class={s.item}
			aria-pressed={props.selected}
			onClick={props.onSelect}
		>
			<span class={s.itemTitle}>
				<span>{definition().name}</span>
				<small class={s.badge} data-enabled={definition().enabled}>
					{definition().enabled ? t("automations.active", "Active") : t("automations.paused", "Paused")}
				</small>
			</span>
			{/* Two one-line meta rows under the name, parts joined by a middle dot (CSS).
			    The schedule label is exact (it falls back to the cron), so the cron
			    itself lives in the editor; the zone is the next run's tooltip. */}
			<span class={s.itemMeta}>
				<span class={s.repository} title={definition().repository}>
					{pathBasename(definition().repository.replace(/[\\/]+$/, "")) || definition().repository}
				</span>
				<span class={s.schedule}>
					{definition().once_local != null
						? `${t("automations.once", "Once")} ${definition().once_local}`
						: scheduleLabel(definition().cron)}
				</span>
			</span>
			<span class={s.itemMeta}>
				<Show when={props.item.next_run_ms !== null}>
					<time dateTime={new Date(props.item.next_run_ms as number).toISOString()} title={definition().timezone}>
						{t("automations.nextRunAt", "Next: {time}", {
							time: zonedTime(props.item.next_run_ms as number, definition().timezone),
						})}
					</time>
				</Show>
				<Show when={props.item.last_status}>
					<strong class={s.runStatus} data-status={props.item.last_status}>
						{runStatusLabel(props.item.last_status as string)}
					</strong>
				</Show>
			</span>
		</button>
	);
}
