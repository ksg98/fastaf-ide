import type { Component } from "solid-js";
import { t } from "../../../i18n";
import s from "../Settings.module.css";
import { SectionCard, SettingPageHeader } from "../SettingsPrimitives";
import { RemoteMachinesPanel } from "./services/RemoteMachinesPanel";

/** Top-level "Remote Machines" page: a heading (so search has a scroll
 * target) wrapping the existing connection-management panel. */
export const RemoteMachinesTab: Component = () => (
	<div class={s.section}>
		<SettingPageHeader
			title={t("settings.remoteMachines", "Remote Machines")}
			description="Connect to named SSH and direct daemons; manage their deployment and lifetime."
			scope="This machine"
			breadcrumb="Integrations / Remote Machines"
		/>
		<SectionCard title="Connections and SSH discovery">
			<RemoteMachinesPanel />
		</SectionCard>
	</div>
);
