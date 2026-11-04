import type { Component } from "solid-js";
import { t } from "../../../i18n";
import { Input } from "../../ui/Input";
import { Textarea } from "../../ui/Textarea";
import { ContextualHelp } from "../ContextualHelp";
import s from "../Settings.module.css";
import { SectionCard } from "../SettingsPrimitives";
import r from "./RepositoryTabs.module.css";
import type { RepoTabProps } from "./RepoWorktreeTab";

export const RepoScriptsTab: Component<RepoTabProps> = (props) => {
	const setupPlaceholder = () =>
		props.settings.setupScript === null
			? `${t("repoScripts.placeholder.inheriting", "Inheriting:")} ${props.defaults.setupScript || t("repoScripts.placeholder.noGlobalScript", "no global script")}`
			: "#!/bin/bash\nnpm install";

	const runPlaceholder = () =>
		props.settings.runScript === null
			? `${t("repoScripts.placeholder.inheriting", "Inheriting:")} ${props.defaults.runScript || t("repoScripts.placeholder.noGlobalScript", "no global script")}`
			: "#!/bin/bash\nnpm run dev";

	const archivePlaceholder = () =>
		props.settings.archiveScript === null
			? `${t("repoScripts.placeholder.inheriting", "Inheriting:")} ${props.defaults.archiveScript || t("repoScripts.placeholder.noGlobalScript", "no global script")}`
			: "#!/bin/bash\ndocker compose down";

	return (
		<div class={`${s.section} ${r.page}`}>
			<SectionCard title={t("repoScripts.heading.designMode", "Design Mode")}>
				<div class={s.group}>
					<div class={s.helpLabel}>
						<label for="repo-dev-server-url">{t("repoScripts.label.devServerUrl", "Dev Server URL")}</label>
						<ContextualHelp label={t("repoScripts.label.devServerUrl", "Dev Server URL")} />
					</div>
					<Input
						data-setting-id="repositories.repos.{key}.dev_server_url"
						id="repo-dev-server-url"
						type="url"
						value={props.settings.devServerUrl ?? ""}
						onInput={(e) => props.onUpdate("devServerUrl", e.currentTarget.value || null)}
						placeholder="http://localhost:5173"
					/>
					<p class={s.hint}>
						{t(
							"repoScripts.hint.devServerUrl",
							"Open this URL in Chrome when Design Mode starts. Leave empty to navigate manually.",
						)}
					</p>
				</div>
			</SectionCard>
			<SectionCard
				title={t("repoScripts.heading.automationScripts", "Automation Scripts")}
				description="Scripts run locally and are never included in team exports. Empty fields inherit the global script."
			>
				<div class={s.group}>
					<div class={s.helpLabel}>
						<label for="repo-setup-script">{t("repoScripts.label.setupScript", "Setup Script")}</label>
						<ContextualHelp label={t("repoScripts.label.setupScript", "Setup Script")} />
					</div>
					<Textarea
						data-setting-id="repositories.repos.{key}.setup_script"
						id="repo-setup-script"
						value={props.settings.setupScript ?? ""}
						onInput={(e) => {
							const val = e.currentTarget.value;
							props.onUpdate("setupScript", val === "" ? null : val);
						}}
						placeholder={setupPlaceholder()}
						rows={6}
					/>
					<p class={s.hint}>
						{t("repoScripts.hint.setupScript", "Shell script run when creating a new worktree.")}
						{props.settings.setupScript === null
							? ` ${t("repoScripts.hint.useGlobalDefault", "Using global default.")}`
							: ""}
					</p>
				</div>

				<div class={s.group}>
					<div class={s.helpLabel}>
						<label for="repo-run-script">{t("repoScripts.label.runScript", "Run Script")}</label>
						<ContextualHelp label={t("repoScripts.label.runScript", "Run Script")} />
					</div>
					<Textarea
						data-setting-id="repositories.repos.{key}.run_script"
						id="repo-run-script"
						value={props.settings.runScript ?? ""}
						onInput={(e) => {
							const val = e.currentTarget.value;
							props.onUpdate("runScript", val === "" ? null : val);
						}}
						placeholder={runPlaceholder()}
						rows={6}
					/>
					<p class={s.hint}>
						{t("repoScripts.hint.runScript", "Shell script run when launching the worktree.")}
						{props.settings.runScript === null
							? ` ${t("repoScripts.hint.useGlobalDefault", "Using global default.")}`
							: ""}
					</p>
				</div>

				<div class={s.group}>
					<div class={s.helpLabel}>
						<label for="repo-archive-script">{t("repoScripts.label.archiveScript", "Archive Script")}</label>
						<ContextualHelp label={t("repoScripts.label.archiveScript", "Archive Script")} />
					</div>
					<Textarea
						data-setting-id="repositories.repos.{key}.archive_script"
						id="repo-archive-script"
						value={props.settings.archiveScript ?? ""}
						onInput={(e) => {
							const val = e.currentTarget.value;
							props.onUpdate("archiveScript", val === "" ? null : val);
						}}
						placeholder={archivePlaceholder()}
						rows={6}
					/>
					<p class={s.hint}>
						{t("repoScripts.hint.archiveScript", "Shell script run before archiving or deleting a worktree.")}
						{props.settings.archiveScript === null
							? ` ${t("repoScripts.hint.useGlobalDefault", "Using global default.")}`
							: ""}
					</p>
				</div>
			</SectionCard>
		</div>
	);
};
