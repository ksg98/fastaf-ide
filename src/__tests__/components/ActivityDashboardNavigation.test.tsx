import { fireEvent, render, screen } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ActivityDashboard } from "../../components/ActivityDashboard/ActivityDashboard";
import { TerminalArea } from "../../components/TerminalArea";
import { activityDashboardStore } from "../../stores/activityDashboard";
import { appLogger } from "../../stores/appLogger";
import { globalWorkspaceStore, MANUAL_SCOPE } from "../../stores/globalWorkspace";
import { paneLayoutStore } from "../../stores/paneLayout";
import { repositoriesStore } from "../../stores/repositories";
import { savedPaneLayouts } from "../../stores/savedPaneLayouts";
import { terminalsStore } from "../../stores/terminals";
import { navigateToTerminal } from "../../utils/navigateToTerminal";
import { globalWorkspaceTabIds } from "../../utils/paneTabOrder";
import { makeTerminal } from "../helpers/store";
import "../mocks/tauri";

// Keep the real TerminalArea visibility logic; replace only terminal transport/rendering.
vi.mock("../../components/Terminal", () => ({
	Terminal: (props: { id: string }) => (
		<span data-testid={`terminal-${props.id}`}>{terminalsStore.get(props.id)?.sessionId}</span>
	),
}));
vi.mock("../../components/PaneTree/PaneTree", () => ({ PaneNodeView: () => <div /> }));
vi.mock("../../hooks/useFileDrop", () => ({ useFileDrop: () => ({ attachTo: () => {}, isDragging: () => false }) }));
vi.mock("../../components/TipOfTheDay/TipOfTheDay", () => ({ default: () => null }));

const repoPath = "/activity-navigation";

function coordinator() {
	repositoriesStore.add({ path: repoPath, displayName: "Coordinator" });
	repositoriesStore.setWorkspace(repoPath, "main", { worktreePath: repoPath });
	repositoriesStore.setActive(repoPath);
	repositoriesStore.setActiveWorkspace(repoPath, "main");
	const id = terminalsStore.add(makeTerminal({ name: "COORDINATOR", sessionId: "coordinator-session", cwd: repoPath }));
	terminalsStore.setRepoPath(id, repoPath);
	repositoriesStore.addTerminalToWorkspace(repoPath, "main", id);
	terminalsStore.setActive(id);
	return id;
}

function parkedAgent() {
	const id = terminalsStore.add(
		makeTerminal({ name: "parity-ego", sessionId: "ego-session", agentType: "ego", cwd: "/unregistered/ego" }),
	);
	terminalsStore.update(id, { shellState: "idle" });
	globalWorkspaceStore.promote(id, MANUAL_SCOPE);
	return id;
}

beforeEach(() => {
	vi.spyOn(appLogger, "info").mockImplementation(() => {});
});

afterEach(() => {
	activityDashboardStore.close();
	globalWorkspaceStore.deactivate();
	globalWorkspaceStore.setScope(MANUAL_SCOPE);
	for (const id of terminalsStore.getIds()) terminalsStore.remove(id);
	repositoriesStore.remove(repoPath);
	paneLayoutStore.reset();
	terminalsStore._testCancelPendingTimers();
	repositoriesStore._testCancelPendingSave();
	paneLayoutStore._testCancelPendingSave();
	savedPaneLayouts.clear();
	vi.restoreAllMocks();
});

describe("Activity Dashboard session navigation", () => {
	// Catches: a parked agent replaces the active content while its own tab remains hidden.
	it("activity_open_inactive_agent_creates_its_own_tab", () => {
		const previous = coordinator();
		const agent = parkedAgent();
		activityDashboardStore.open();
		render(() => <ActivityDashboard />);

		fireEvent.click(screen.getByText("parity-ego"));

		expect(globalWorkspaceTabIds() ?? []).toContain(agent);
		expect(terminalsStore.state.activeId).toBe(agent);
		expect(terminalsStore.get(previous)?.sessionId).toBe("coordinator-session");
		expect(terminalsStore.get(previous)?.name).toBe("COORDINATOR");
		expect(repositoriesStore.getActiveTerminals()).toEqual([previous]);
		expect(activityDashboardStore.state.isOpen).toBe(false);

		// Reopening focuses the same session/tab instead of creating a duplicate.
		navigateToTerminal(agent);
		expect(globalWorkspaceTabIds()?.filter((id) => id === agent)).toHaveLength(1);
		expect(terminalsStore.getIds()).toHaveLength(2);
	});

	// Catches: navigating back to an owned session leaves the unrelated global tab strip visible.
	it("opens_a_repository_tab_outside_the_manual_workspace", () => {
		const previous = coordinator();
		parkedAgent();
		globalWorkspaceStore.activate();

		navigateToTerminal(previous);

		expect(globalWorkspaceTabIds()).toBeNull();
		expect(repositoriesStore.getActiveTerminals()).toContain(previous);
		expect(terminalsStore.state.activeId).toBe(previous);
	});

	// Catches: opening an undocked session leaves the previous session visible or rebinds its content.
	it("shows_an_owned_session_without_rebinding_the_previous_pane", () => {
		const previous = coordinator();
		const agent = terminalsStore.add(makeTerminal({ name: "worker", sessionId: "worker-session" }));
		repositoriesStore.addTerminalToWorkspace(repoPath, "main", agent);
		const group = paneLayoutStore.createGroup();
		paneLayoutStore.setRoot({ type: "leaf", id: group });
		paneLayoutStore.setActiveGroup(group);
		paneLayoutStore.addTab(group, { id: previous, type: "terminal" });
		paneLayoutStore.split(group, "horizontal");
		paneLayoutStore.setActiveGroup(group);

		render(() => (
			<TerminalArea
				onTerminalFocus={() => {}}
				onCloseTab={() => {}}
				onOpenFilePath={() => {}}
				onContextMenu={() => {}}
			/>
		));

		navigateToTerminal(agent);

		expect(screen.getByTestId(`terminal-${agent}`).closest(".terminal-pane")?.classList.contains("active")).toBe(true);
		expect(screen.getByTestId(`terminal-${agent}`).textContent).toBe("worker-session");
		expect(screen.getByTestId(`terminal-${previous}`).closest(".terminal-pane")?.classList.contains("active")).toBe(
			false,
		);
		expect(terminalsStore.get(previous)?.sessionId).toBe("coordinator-session");
		expect(terminalsStore.get(previous)?.name).toBe("COORDINATOR");
	});

	// Catches: opening another workspace's session inserts it into the previous workspace's split.
	it("does_not_dock_another_workspace_session_into_the_previous_split", () => {
		const previous = coordinator();
		const agent = terminalsStore.add(makeTerminal({ name: "feature-worker", sessionId: "feature-session" }));
		repositoriesStore.setWorkspace(repoPath, "feature", { worktreePath: `${repoPath}/feature` });
		repositoriesStore.addTerminalToWorkspace(repoPath, "feature", agent);
		const group = paneLayoutStore.createGroup();
		paneLayoutStore.setRoot({ type: "leaf", id: group });
		paneLayoutStore.setActiveGroup(group);
		paneLayoutStore.addTab(group, { id: previous, type: "terminal" });
		paneLayoutStore.split(group, "horizontal");
		paneLayoutStore.setActiveGroup(group);
		const previousLayout = paneLayoutStore.serialize();

		navigateToTerminal(agent);

		expect(repositoriesStore.getActiveTerminals()).toEqual([agent]);
		expect(terminalsStore.state.activeId).toBe(agent);
		expect(paneLayoutStore.serialize()).toEqual(previousLayout);
	});

	// Catches: manual parking is looked up only in the currently consolidated repository scope.
	it("opens_a_parked_agent_from_another_workspace_scope", () => {
		const previous = coordinator();
		const agent = parkedAgent();
		globalWorkspaceStore.setScope(repoPath);
		globalWorkspaceStore.promote(previous);
		globalWorkspaceStore.activate();

		navigateToTerminal(agent);

		expect(globalWorkspaceTabIds()).toEqual([agent]);
		expect(globalWorkspaceStore.getScope()).toBe(MANUAL_SCOPE);
		expect(terminalsStore.state.activeId).toBe(agent);
		expect(terminalsStore.get(previous)?.sessionId).toBe("coordinator-session");
	});
});
