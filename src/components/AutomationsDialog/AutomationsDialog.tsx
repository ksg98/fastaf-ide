import { createEffect, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { t } from "../../i18n";
import { appLogger } from "../../stores/appLogger";
import { automationsUi, createAutomationsStore } from "../../stores/automations";
import { registerModal } from "../../stores/modalStack";
import { IconClose, IconRefresh } from "../icons";
import { SearchField } from "../shared/SearchField";
import { Button } from "../ui/Button";
import { AutomationCard } from "./AutomationCard";
import s from "./AutomationsDialog.module.css";
import type { AutomationAdapter } from "./contract";
import { DefinitionEditor } from "./DefinitionEditor";
import { DetailHistory } from "./DetailHistory";
import { DialogTabs } from "./DialogTabs";
import { RunsView } from "./RunsView";
import { createAutomationAdapter } from "./transportAdapter";

export function AutomationsDialog(props: { onClose: () => void; adapter?: AutomationAdapter; connectionId?: string }) {
	const store = createAutomationsStore(props.adapter ?? createAutomationAdapter(props.connectionId));
	const [focusProfile, setFocusProfile] = createSignal(false);
	const [tab, setTab] = createSignal("definitions");
	const [search, setSearch] = createSignal("");
	const preferenceKey = "tuic-automations-select-first";
	const [selectFirst, setSelectFirst] = createSignal(
		(() => {
			try {
				return localStorage.getItem(preferenceKey) !== "false";
			} catch {
				return true;
			}
		})(),
	);
	const [confirmDelete, setConfirmDelete] = createSignal(false);
	let panel: HTMLDivElement | undefined, searchInput: HTMLInputElement | undefined;
	const priorFocus = document.activeElement;
	registerModal(props.onClose);
	onMount(() => {
		searchInput?.focus();
		void store.refresh().then(() => {
			const first = store.items()[0];
			if (
				selectFirst() &&
				first &&
				!store.draft() &&
				!focusProfile() &&
				!automationsUi.requestedRun() &&
				!automationsUi.requestedDefinition()
			)
				choose(first.definition);
		});
	});
	onCleanup(() => {
		store.dispose();
		if (priorFocus instanceof HTMLElement && priorFocus.isConnected) priorFocus.focus();
	});
	const repair = async (id: string) => {
		setFocusProfile(true);
		setTab("definitions");
		await store.openDefinition(id);
	};
	createEffect(() => {
		const id = automationsUi.requestedDefinition();
		if (id) void repair(id);
	});
	createEffect(() => {
		const id = automationsUi.requestedRun();
		if (id) {
			setTab("definitions");
			void store.openRun(id);
		}
	});
	createEffect(() => {
		store.draft()?.id;
		setConfirmDelete(false);
	});
	const choose = (value: Parameters<typeof store.select>[0]) => {
		setFocusProfile(false);
		store.select(value);
		void store.preview();
		void store.loadHistory();
	};
	const focusTrap = (event: KeyboardEvent) => {
		if (event.key !== "Tab") return;
		const controls = [
			...(panel?.querySelectorAll<HTMLElement>(
				'button:not(:disabled):not([tabindex="-1"]), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex="0"]',
			) ?? []),
		];
		const first = controls[0],
			last = controls.at(-1);
		if (event.shiftKey && document.activeElement === first) {
			event.preventDefault();
			last?.focus();
		} else if (!event.shiftKey && document.activeElement === last) {
			event.preventDefault();
			first?.focus();
		}
	};
	return (
		<div
			class={s.overlay}
			onClick={(event) => {
				if (event.target === event.currentTarget) props.onClose();
			}}
		>
			<div
				ref={panel}
				class={s.dialog}
				role="dialog"
				aria-modal="true"
				aria-labelledby="automations-title"
				onKeyDown={focusTrap}
			>
				<header class={s.header}>
					<h2 id="automations-title">{t("automations.title", "Automations")}</h2>
					<p class={s.subtitle}>{t("automations.machine", "Scheduled agent runs on this machine")}</p>
					<button
						type="button"
						class={s.close}
						aria-label={t("automations.close", "Close automations")}
						title={t("automations.close", "Close automations")}
						onClick={props.onClose}
					>
						<IconClose size={16} />
					</button>
				</header>
				<Show when={store.error()}>
					<div role="alert" class={`${s.error} ${s.banner}`}>
						{store.error()}
					</div>
				</Show>
				<Show when={store.notice()}>
					<div role="status" class={`${s.notice} ${s.banner}`}>
						{store.notice()}
					</div>
				</Show>
				{/* One bar under the header: the tabs where a panel puts its title, then the
				    list's tools (search, the open preference, refresh, new) on the same row. */}
				<div class={s.bar}>
					<DialogTabs
						selected={tab()}
						onSelect={(value) => {
							setTab(value);
							if (value === "runs") void store.loadRuns();
						}}
					/>
					<Show when={tab() === "definitions"}>
						<div class={s.toolbar}>
							<SearchField
								class={s.search}
								ref={(el) => {
									searchInput = el;
								}}
								aria-label={t("automations.search", "Search automations")}
								placeholder={t("automations.search", "Search automations")}
								value={search()}
								onInput={setSearch}
							/>
							<label class={s.check}>
								<input
									type="checkbox"
									checked={selectFirst()}
									onChange={(event) => {
										const value = event.currentTarget.checked;
										setSelectFirst(value);
										try {
											localStorage.setItem(preferenceKey, String(value));
										} catch (error) {
											appLogger.warn("settings", "Could not save automation selection preference", error);
										}
									}}
								/>
								{t("automations.selectFirst", "Select first automation on open")}
							</label>
							<button
								type="button"
								class={s.iconBtn}
								aria-label={t("automations.refresh", "Refresh")}
								title={t("automations.refresh", "Refresh")}
								disabled={store.busy() || store.loading()}
								onClick={() => void store.refresh()}
							>
								<IconRefresh size={16} />
							</button>
							<Button type="button" disabled={store.busy()} onClick={() => store.create()}>
								{t("automations.new", "New automation")}
							</Button>
						</div>
					</Show>
				</div>
				<Show when={tab() === "runs"}>
					<main class={s.detail} role="tabpanel" id="automations-panel-runs" aria-labelledby="automations-tab-runs">
						<RunsView
							store={store}
							connectionId={props.connectionId}
							onNavigate={props.onClose}
							onFix={(id) => void repair(id)}
						/>
					</main>
				</Show>
				<Show when={tab() === "definitions"}>
					<div
						class={s.content}
						role="tabpanel"
						id="automations-panel-definitions"
						aria-labelledby="automations-tab-definitions"
					>
						<aside class={s.sidebar} aria-label={t("automations.list", "Automation definitions")}>
							<Show when={store.loading()}>
								<p role="status">{t("automations.loading", "Loading automations…")}</p>
							</Show>
							<Show when={!store.loading() && !store.error() && store.items().length === 0}>
								<p class={s.empty}>
									{t("automations.empty", "No automations yet. Create one to schedule an agent run.")}
								</p>
							</Show>
							<For
								each={store
									.items()
									.filter((item) =>
										`${item.definition.name} ${item.definition.repository}`
											.toLocaleLowerCase()
											.includes(search().toLocaleLowerCase()),
									)}
							>
								{(item) => (
									<AutomationCard
										item={item}
										selected={store.draft()?.id === item.definition.id}
										disabled={store.busy()}
										onSelect={() => choose(item.definition)}
									/>
								)}
							</For>
							<Show
								when={
									store.items().length > 0 &&
									!store
										.items()
										.some((item) =>
											`${item.definition.name} ${item.definition.repository}`
												.toLocaleLowerCase()
												.includes(search().toLocaleLowerCase()),
										)
								}
							>
								<p class={s.empty}>{t("automations.noMatches", "No matching automations.")}</p>
							</Show>
						</aside>
						<main class={s.detail}>
							<Show
								when={store.draft()}
								fallback={<p class={s.empty}>{t("automations.select", "Select an automation or create one.")}</p>}
							>
								<div class={s.actions}>
									<Show when={!store.isNew()}>
										<Button
											type="button"
											disabled={store.busy()}
											onClick={() => void store.setEnabled(!store.draft()?.enabled)}
										>
											{store.draft()?.enabled ? t("automations.pause", "Pause") : t("automations.resume", "Resume")}
										</Button>
										<Button type="button" disabled={store.busy()} onClick={() => void store.runNow()}>
											{t("automations.runNow", "Run now")}
										</Button>
									</Show>
									<Button type="button" variant="primary" disabled={store.busy()} onClick={() => void store.save()}>
										{t("automations.save", "Save")}
									</Button>
									<Show when={!store.isNew()}>
										<Button
											type="button"
											variant="danger"
											disabled={store.busy()}
											onClick={() => setConfirmDelete(true)}
										>
											{t("automations.delete", "Delete")}
										</Button>
									</Show>
								</div>
								<Show when={confirmDelete()}>
									<div class={s.confirm} role="group" aria-label={t("automations.confirmDelete", "Confirm delete")}>
										<p>{t("automations.deleteHint", "Delete this automation? Saved run history is kept.")}</p>
										<Button type="button" variant="danger" disabled={store.busy()} onClick={() => void store.remove()}>
											{t("automations.confirmDelete", "Confirm delete")}
										</Button>
										<Button type="button" onClick={() => setConfirmDelete(false)}>
											{t("automations.cancel", "Cancel")}
										</Button>
									</div>
								</Show>
								<Show when={store.draft()?.id} keyed>
									{(_id) => <DefinitionEditor store={store} focusProfile={focusProfile()} />}
								</Show>
							</Show>
							<Show when={!store.isNew() && (store.draft() || store.runs().length > 0)}>
								<DetailHistory store={store} />
							</Show>
						</main>
					</div>
				</Show>
			</div>
		</div>
	);
}
