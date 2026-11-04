import { cleanup, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BottomTabs } from "../components/BottomTabs";

afterEach(cleanup);

describe("mobile chat navigation", () => {
	it("opens Chat as the primary mobile tab", () => {
		const select = vi.fn();
		render(() => <BottomTabs aiChatAvailable={true} active={"chat"} onSelect={select} />);
		const chat = screen.getByRole("button", { name: "Chat" });
		expect(chat.getAttribute("aria-current")).toBe("page");
		chat.click();
		expect(select).toHaveBeenCalledWith("chat");
	});
});
