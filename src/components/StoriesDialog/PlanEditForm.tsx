import { createSignal, createUniqueId, For, Show } from "solid-js";
import { t } from "../../i18n";
import { Button } from "../ui/Button";
import { Select } from "../ui/Select";
import { Textarea } from "../ui/Textarea";
import s from "./StoriesDialog.module.css";

export interface EditablePlan {
	id: string;
	revision: number;
	title: string;
	source: string;
}

export type PlanEditPatch = Partial<Pick<EditablePlan, "title" | "source">>;

/** Keep the initial revision and draft stable across refreshes and failed saves. */
export function PlanEditForm(props: {
	plan: EditablePlan;
	sources: { title: string; source: string }[];
	sourcesLoading: boolean;
	busy: boolean;
	error: string;
	onRefreshSources: () => void;
	onOpenSource: (source: string) => void;
	onSave: (patch: PlanEditPatch) => void;
	onCancel: () => void;
}) {
	const baseline = props.plan;
	const [title, setTitle] = createSignal(baseline.title);
	const [source, setSource] = createSignal(baseline.source);
	const [otherSource, setOtherSource] = createSignal(/^https?:\/\//i.test(baseline.source));
	const otherOption = "__other_source__";
	const saveHintId = createUniqueId();
	const pickerId = createUniqueId();
	const patch = (): PlanEditPatch => {
		const result: PlanEditPatch = {};
		if (title().trim() !== baseline.title) result.title = title().trim();
		if (source().trim() !== baseline.source) result.source = source().trim();
		return result;
	};
	const saveReason = () => {
		if (props.busy) return t("stories.planEdit.saving", "Saving plan…");
		if (!title().trim()) return t("stories.planEdit.titleRequired", "Enter a plan title to save.");
		if (!source().trim())
			return t("stories.planEdit.sourceRequired", "Choose a plan document or paste a link to save.");
		if (!Object.keys(patch()).length) return t("stories.planEdit.unchanged", "Change the title or document to save.");
		return "";
	};
	return (
		<form
			class={s.form}
			aria-label={t("stories.planEdit.open", "Edit plan")}
			onSubmit={(event) => {
				event.preventDefault();
				if (!saveReason()) props.onSave(patch());
			}}
		>
			<h3>{t("stories.planEdit.open", "Edit plan")}</h3>
			<label>
				{t("stories.planEdit.title", "Plan title")}
				<Textarea
					autoGrow
					required
					maxlength={200}
					value={title()}
					disabled={props.busy}
					onInput={(event) => setTitle(event.currentTarget.value)}
				/>
			</label>
			<div class={s.sourceHeader}>
				<label for={pickerId}>{t("stories.planEdit.document", "Repository plan document")}</label>
				<Button size="compact" disabled={props.busy || props.sourcesLoading} onClick={props.onRefreshSources}>
					{t("stories.refreshPlans", "Refresh")}
				</Button>
			</div>
			<Select
				id={pickerId}
				value={otherSource() ? otherOption : source()}
				disabled={props.busy || props.sourcesLoading}
				onChange={(event) => {
					const value = event.currentTarget.value;
					if (!value) return;
					setOtherSource(value === otherOption);
					if (value !== otherOption) setSource(value);
				}}
			>
				<option value="">
					{props.sourcesLoading
						? t("stories.loading", "Loading plans and stories…")
						: t("stories.planEdit.chooseDocument", "Choose a repository plan…")}
				</option>
				<Show
					when={
						baseline.source &&
						!/^https?:\/\//i.test(baseline.source) &&
						!props.sources.some((candidate) => candidate.source === baseline.source)
					}
				>
					<option value={baseline.source} selected={!otherSource() && source() === baseline.source}>
						{baseline.title}
					</option>
				</Show>
				<For each={props.sources}>
					{(candidate) => (
						<option value={candidate.source} selected={!otherSource() && source() === candidate.source}>
							{candidate.title}
						</option>
					)}
				</For>
				<option value={otherOption}>{t("stories.planEdit.otherSource", "Other link…")}</option>
			</Select>

			<Show when={otherSource()}>
				<label>
					{t("stories.planSource", "Plan document or link")}
					<Textarea
						autoGrow
						required
						maxlength={4096}
						value={source()}
						disabled={props.busy}
						onInput={(event) => setSource(event.currentTarget.value)}
					/>
				</label>
			</Show>
			<Show when={source().trim()}>
				<div class={s.sourceRow}>
					<Show when={!otherSource()}>
						<p class={s.sourcePath} title={source().trim()}>
							{source().trim()}
						</p>
					</Show>
					<Button size="compact" disabled={props.busy} onClick={() => props.onOpenSource(source().trim())}>
						{t("stories.planEdit.openSource", "Open")}
					</Button>
				</div>
			</Show>
			<Show when={props.error}>
				<p role="alert" class={s.editError}>
					{props.error}
				</p>
			</Show>
			<p id={saveHintId} hidden>
				{saveReason()}
			</p>
			<div class={s.inline}>
				<Button
					variant="primary"
					type="submit"
					disabled={!!saveReason()}
					title={saveReason()}
					aria-describedby={saveHintId}
				>
					{t("stories.edit.save", "Save")}
				</Button>
				<Button type="button" disabled={props.busy} onClick={props.onCancel}>
					{t("stories.edit.cancel", "Cancel")}
				</Button>
			</div>
		</form>
	);
}
