import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TelegramTab } from "../TelegramTab";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("../../../../invoke", () => ({ invoke }));
const initial = {
	enabled: true,
	token_set: true,
	bot_alias: "test_bot",
	registered_agent_name: "Writer",
	chats: ["123"],
	pairing_pending: true,
	recent_events: [],
	connected: true,
	polling_owner: "this_app",
	last_error: null,
	last_message_time: null,
};
beforeEach(() => {
	invoke.mockReset();
	invoke.mockImplementation(async (command: string) =>
		command === "telegram_settings" ? initial : { code: "ABC123" },
	);
});
afterEach(() => {
	cleanup();
	vi.useRealTimers();
});
describe("Telegram setup", () => {
	// Catches: password is shown as plain text or retained in the form after sending.
	it("clears the password and sends only the replacement action", async () => {
		render(() => <TelegramTab />);
		const field = await screen.findByLabelText("Bot token");
		expect(field.getAttribute("type")).toBe("password");
		fireEvent.input(field, { target: { value: "123:fake-token" } });
		fireEvent.click(screen.getByText("Save and check bot"));
		await waitFor(() =>
			expect(invoke).toHaveBeenCalledWith("telegram_setup", { change: { action: "token", token: "123:fake-token" } }),
		);
		expect((field as HTMLInputElement).value).toBe("");
		expect(screen.queryByText("123:fake-token")).toBeNull();
	});
	// Catches: setup invents a UUID/chat binding instead of submitting the explicit user choice.
	it("offers both pairing and explicit chat IDs with removal", async () => {
		render(() => <TelegramTab />);
		await screen.findByLabelText("Add chat by ID");
		fireEvent.click(screen.getByText("Link chat"));
		await screen.findByText(/Send ABC123/);
		await waitFor(() => expect(screen.getByText("Link chat").hasAttribute("disabled")).toBe(false));
		fireEvent.input(screen.getByLabelText("Add chat by ID"), { target: { value: "456" } });
		fireEvent.click(screen.getByText("Add chat ID"));
		await waitFor(() =>
			expect(invoke).toHaveBeenCalledWith("telegram_setup", { change: { action: "add_chat", chat_id: "456" } }),
		);
		await waitFor(() => expect(screen.getByText("Remove").hasAttribute("disabled")).toBe(false));
		fireEvent.click(screen.getByText("Remove"));
		await waitFor(() =>
			expect(invoke).toHaveBeenCalledWith("telegram_setup", { change: { action: "remove_chat", chat_id: "123" } }),
		);
	});
	// Catches: Settings authorizes a selected peer instead of respecting MCP registration.
	it("shows registration read-only and toggles without writing a target", async () => {
		render(() => <TelegramTab />);
		await screen.findByText("Writer");
		expect(screen.queryByRole("combobox")).toBeNull();
		fireEvent.click(screen.getByRole("switch", { name: "Enable Telegram" }));
		await waitFor(() =>
			expect(invoke).toHaveBeenCalledWith("telegram_setup", { change: { action: "configure", enabled: false } }),
		);
	});
	// Catches: an unregistered adapter silently appears to have an agent.
	it("shows the explicit unregistered status", async () => {
		invoke.mockResolvedValue({ ...initial, registered_agent_name: null });
		render(() => <TelegramTab />);
		await screen.findByText("No agent registered");
		expect(screen.getByText(/Telegram MCP tool.*register/)).toBeTruthy();
	});
	// Catches: the connected owner is hidden, or pairing is offered with no live poller.
	it.each([
		["this_app", true, "Connected (this app)"],
		["tuic_remote", true, "Connected (tuic-remote)"],
		[null, false, "No poller connected. Check the bot token and enable Telegram in this app or tuic-remote."],
	] as const)("identifies owner %s and gates pairing", async (polling_owner, connected, status) => {
		invoke.mockResolvedValue({ ...initial, polling_owner, connected });
		render(() => <TelegramTab />);
		const summary = await screen.findByRole("status");
		expect(summary.querySelector('[data-testid="status-badge"]')?.textContent).toBe(status);
		expect(screen.getByText("Link chat").hasAttribute("disabled")).toBe(!connected);
		if (!connected) expect(screen.getByText(/Connect a poller before linking/)).toBeTruthy();
	});
	// Catches: setup failures leave an endless waiting label with pairing still enabled.
	it.each([
		[{ enabled: false }, "Disabled — enable Telegram to start polling."],
		[{ token_set: false }, "No bot token — save and check a token first."],
		[
			{ last_error: "telegram_owner_conflict" },
			"Polling stopped or retrying. Resolve the error below, then disable and enable Telegram.",
		],
	])("explains inactive setup %j", async (change, status) => {
		invoke.mockResolvedValue({ ...initial, connected: false, polling_owner: null, ...change });
		render(() => <TelegramTab />);
		const summary = await screen.findByRole("status");
		expect(summary.querySelector('[data-testid="status-badge"]')?.textContent).toBe(status);
		expect(screen.getByText("Link chat").hasAttribute("disabled")).toBe(true);
	});
	// Catches: a failed getMe appears successful or drops the safe error category.
	it("shows typed setup errors", async () => {
		invoke.mockImplementation(async (command: string) => {
			if (command === "telegram_settings") return initial;
			throw "telegram_unauthorized";
		});
		render(() => <TelegramTab />);
		fireEvent.input(await screen.findByLabelText("Bot token"), { target: { value: "bad-token" } });
		fireEvent.click(screen.getByText("Save and check bot"));
		expect((await screen.findByRole("alert")).textContent).toContain("telegram_unauthorized");
	});
});

// Catches: a consumed code stays visible after the existing status refresh reports linking.
it("clears the consumed pairing hint after refresh 1955", async () => {
	vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
	let linked = false;
	invoke.mockImplementation(async (command: string) =>
		command === "telegram_settings"
			? { ...initial, chats: linked ? ["123", "456"] : ["123"], pairing_pending: !linked }
			: { code: "ABC123" },
	);
	render(() => <TelegramTab />);
	fireEvent.click(await screen.findByText("Link chat"));
	await screen.findByText(/Send ABC123/);
	linked = true;
	await vi.advanceTimersByTimeAsync(3000);
	await screen.findByText("456");
	expect(screen.queryByText(/Send ABC123/)).toBeNull();
});

// Catches: activity is hidden or stale while Settings stays open.
it("renders safe recent events and refreshes while open 1956", async () => {
	vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
	let updated = false;
	invoke.mockImplementation(async () => ({
		...initial,
		recent_events: updated
			? [
					{ id: 3, time: 1000, direction: "out", kind: "reply", outcome: "sent", preview: "Chat linked." },
					{ id: 2, time: 999, direction: "in", kind: "pairing", outcome: "delivered", preview: "[redacted]" },
					{ id: 1, time: 998, direction: "in", kind: "message", outcome: "dropped: no agent", preview: "Hello" },
				]
			: [],
	}));
	render(() => <TelegramTab />);
	await screen.findByText("No recent Telegram events.");
	updated = true;
	await vi.advanceTimersByTimeAsync(3000);
	const replies = await screen.findAllByRole("status");
	expect(replies.map((node) => node.textContent).filter((text) => !text?.includes("Connected (this app)"))).toEqual([
		"Chat linked.",
		"[redacted]",
		"Hello",
	]);
	expect(screen.getByLabelText(/out · reply · sent/)).toBeTruthy();
	expect(screen.getByLabelText(/in · message · dropped: no agent/)).toBeTruthy();
	expect(screen.queryByText("No recent Telegram events.")).toBeNull();
});
