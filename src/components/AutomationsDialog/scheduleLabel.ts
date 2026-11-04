import { t } from "../../i18n";

/** Display common cron shapes only. Rust remains the authority for occurrences. */
export function scheduleLabel(cron: string): string {
	const fields = cron.trim().split(/\s+/);
	if (fields.length !== 5) return cron;
	const [minute, hour, day, month, weekday] = fields;
	if (day !== "*" || month !== "*") return cron;
	const numeric = (value: string, max: number) => /^\d{1,2}$/.test(value) && Number(value) <= max;
	if (hour === "*" && weekday === "*") {
		if (minute === "*") return t("automations.everyMinute", "Every minute");
		const step = /^\*\/(\d{1,2})$/.exec(minute);
		if (step && Number(step[1]) > 0 && Number(step[1]) < 60 && 60 % Number(step[1]) === 0) {
			return Number(step[1]) === 1
				? t("automations.everyMinute", "Every minute")
				: t("automations.everyMinutes", "Every {count} minutes", { count: String(Number(step[1])) });
		}
		if (numeric(minute, 59))
			return t("automations.everyHourAt", "Every hour at :{minute}", { minute: minute.padStart(2, "0") });
	}
	if (!numeric(minute, 59) || !numeric(hour, 23)) return cron;
	const time = `${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`;
	if (weekday === "*") return t("automations.everyDayAt", "Every day at {time}", { time });
	if (weekday === "1-5") return t("automations.everyWeekdayAt", "Every weekday at {time}", { time });
	const days = [
		t("automations.sunday", "Sunday"),
		t("automations.monday", "Monday"),
		t("automations.tuesday", "Tuesday"),
		t("automations.wednesday", "Wednesday"),
		t("automations.thursday", "Thursday"),
		t("automations.friday", "Friday"),
		t("automations.saturday", "Saturday"),
	];
	if (/^[0-7]$/.test(weekday))
		return t("automations.everyWeekAt", "Every {day} at {time}", { day: days[Number(weekday) % 7], time });
	return cron;
}
