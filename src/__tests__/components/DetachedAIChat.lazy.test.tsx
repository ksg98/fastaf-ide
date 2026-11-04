import { cleanup, render, screen } from "@solidjs/testing-library";
import { afterEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ loads: 0 }));

vi.mock("../../components/AIChatPanel/AIChatPanel", () => {
	state.loads++;
	return { AIChatPanel: () => <div>Detached AI Chat conversation</div> };
});
vi.mock("../../hooks/initPanelWindow", () => ({ initPanelWindow: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../stores/repositories", () => ({ repositoriesStore: { getActive: () => null } }));
vi.mock("../../stores/ui", () => ({ uiStore: { toggleAiChatPanel: () => {} } }));

import { aiChatPanelAdapter } from "../../panelAdapters/aiChat";

afterEach(cleanup);

it("loads the detached AI Chat panel when its window opens", async () => {
	expect(state.loads).toBe(0);
	const Detached = aiChatPanelAdapter.Component;
	render(() => <Detached params={new URLSearchParams("repoPath=%2Frepo")} />);
	expect(await screen.findByText("Detached AI Chat conversation")).toBeTruthy();
});
