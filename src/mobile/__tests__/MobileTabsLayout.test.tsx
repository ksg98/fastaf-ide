// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BottomTabs } from "../components/BottomTabs";
import { TopBar } from "../components/TopBar";

afterEach(cleanup);

describe("mobile tab layout", () => {
	it("shows five tabs with Sessions before Chat and no Settings tab", () => {
		const view = render(() => <BottomTabs aiChatAvailable={true} active="sessions" onSelect={() => {}} />);
		const names = [...view.getByRole("navigation").querySelectorAll("button")].map((button) =>
			button.getAttribute("aria-label"),
		);
		expect(names).toEqual(["Sessions", "Chat", "Files", "Progress", "Activity"]);
	});

	it("opens Settings from the app bar overflow", async () => {
		const onOpenSettings = vi.fn();
		const view = render(() => <TopBar isConnected onOpenSettings={onOpenSettings} />);
		await fireEvent.click(view.getByRole("button", { name: "More options" }));
		await fireEvent.click(view.getByRole("menuitem", { name: "Settings" }));
		expect(onOpenSettings).toHaveBeenCalledOnce();
		expect(view.queryByRole("menuitem", { name: "Settings" })).toBeNull();
	});
});
