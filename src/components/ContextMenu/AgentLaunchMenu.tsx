import type { Component } from "solid-js";
import { Show } from "solid-js";
import type { AgentType } from "../../agents";
import { IconCheck, IconTerminal } from "../icons";
import { AgentIcon } from "../ui/AgentIcon";
import { ContextMenu, type ContextMenuItem, type ContextMenuProps } from "./ContextMenu";
import s from "./ContextMenu.module.css";

export interface AgentLaunchMenuItem extends ContextMenuItem {
	agentType?: AgentType;
	agentName?: string;
	configName?: string;
	isDefault?: boolean;
}

/** Rich presentation is restricted to the new-tab agent picker. */
export const AgentLaunchMenu: Component<Omit<ContextMenuProps, "items" | "size"> & { items: AgentLaunchMenuItem[] }> = (
	props,
) => (
	<ContextMenu
		{...props}
		size="large"
		items={props.items.map((item) => ({
			...item,
			icon: item.agentType ? <AgentIcon agent={item.agentType} size={16} /> : <IconTerminal size={16} />,
			labelContent: (
				<span class={s.launchLabel}>
					<span>{item.agentName ?? item.label}</span>
					<Show when={item.configName}>
						<span class={s.configName}>{item.configName}</span>
					</Show>
					{/* The default only needs marking where an agent has several
					    configurations; on a lone row every agent would carry the tick. */}
					<Show when={item.isDefault && item.configName}>
						<span class={s.defaultMark} title="Default configuration">
							<IconCheck size={14} aria-label="Default configuration" />
						</span>
					</Show>
				</span>
			),
		}))}
	/>
);
