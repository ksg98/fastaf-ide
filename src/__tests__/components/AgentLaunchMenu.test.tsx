import { fireEvent, render, screen } from "@solidjs/testing-library";
import { describe, expect, it, vi } from "vitest";
import { AgentLaunchMenu } from "../../components/ContextMenu/AgentLaunchMenu";

describe("AgentLaunchMenu", () => {
	// Catches: rich rows drop identity icons, default markers, accessible labels or the selected action.
	it("renders agent/config identities and a terminal icon without noisy label punctuation", () => {
		const action = vi.fn();
		const onClose = vi.fn();
		// FastAF portals menus to <body> (ContextMenu.tsx), so the rows are looked up
		// on `screen` / `document`, not on the render container.
		render(() => (
			<AgentLaunchMenu
				visible={true}
				x={0}
				y={0}
				onClose={onClose}
				items={[
					{
						label: "Claude Code Fast",
						agentName: "Claude Code",
						agentType: "claude",
						configName: "Fast",
						isDefault: true,
						action,
					},
					{ label: "Codex CLI", agentName: "Codex CLI", agentType: "codex", isDefault: false, action: () => {} },
					{ label: "Terminal", action: () => {} },
				]}
			/>
		));
		const agent = screen.getByRole("button", { name: "Claude Code Fast" });
		expect(agent.querySelector("svg")).not.toBeNull();
		expect(agent.querySelector(".configName")?.textContent).toBe("Fast");
		expect(agent.querySelector('[title="Default configuration"]')).not.toBeNull();
		expect(screen.getByRole("button", { name: "Codex CLI" }).querySelector(".defaultMark")).toBeNull();
		expect(screen.getByRole("button", { name: "Terminal" }).querySelector("svg")).not.toBeNull();
		const menu = document.querySelector(".menu.large");
		expect(menu).not.toBeNull();
		expect(menu?.textContent).not.toContain("(Default)");
		expect(menu?.textContent).not.toContain("—");
		fireEvent.click(agent);
		expect(action).toHaveBeenCalledOnce();
		expect(onClose).toHaveBeenCalledOnce();
	});
});
