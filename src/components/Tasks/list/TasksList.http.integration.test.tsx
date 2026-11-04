import "@testing-library/jest-dom/vitest";
import { request } from "node:http";
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { listDemo } from "./demo";
import { TasksList } from "./TasksList";

// Opt-in: requires an isolated worktree tuic-remote, never Boss's desktop instance.
const endpoint = process.env.TUIC_TASKS_HTTP_TEST_URL;
const previousUrl = window.location.href;

beforeEach(() => {
	vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(600);
	vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(800);
});

afterEach(() => {
	cleanup();
	window.location.href = previousUrl;
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

// Catches: mounted complete-list mode forwards unsupported title sort to the provider,
// or does not render the real Rust projection across the second provider page.
it.skipIf(!endpoint)("mounted_120_item_list_sorts_titles_through_real_rust_http", async () => {
	const url = new URL(endpoint!);
	expect(url.hostname).toBe("127.0.0.1");
	expect(url.port).not.toBe("9876");
	vi.stubGlobal("__TAURI_SHIM__", true);
	vi.stubGlobal(
		"fetch",
		(input: string, init: RequestInit) =>
			new Promise((resolve, reject) => {
				const connection = request(
					input,
					{
						method: init.method,
						headers: {
							...Object.fromEntries(new Headers(init.headers)),
							Cookie: "tui-session=tasks-criteria-test-only",
						},
					},
					(response) => {
						let body = "";
						response.setEncoding("utf8");
						response.on("data", (chunk) => {
							body += chunk;
						});
						response.on("end", () =>
							resolve(
								new Response(body, {
									status: response.statusCode,
									headers: { "Content-Type": response.headers["content-type"] ?? "" },
								}),
							),
						);
					},
				);
				connection.on("error", reject);
				connection.end(init.body);
			}),
	);
	window.location.href = url.href;
	const provider = listDemo(120);
	provider.fields.forEach((field) => {
		field.sortable = field.id === "title";
	});
	const list = provider.list.bind(provider);
	const cursors: (string | null)[] = [];
	provider.list = async (query, signal) => {
		if (query.sort) throw new Error("Provider rejects title sorting");
		cursors.push(query.cursor);
		return { ...(await list(query, signal)), total: 120 };
	};
	render(() => <TasksList providers={[provider]} onOpen={() => {}} />);
	await screen.findAllByRole("button", { name: /Task/ });
	fireEvent.click(screen.getByRole("button", { name: "Filters" }));
	fireEvent.change(screen.getByLabelText("Sort tasks"), { target: { value: "title" } });
	await waitFor(() => expect(screen.getAllByRole("listitem")[0]).toHaveTextContent("Task 00001"));
	fireEvent.click(screen.getByLabelText("Reverse task sort"));
	await waitFor(() => expect(screen.getAllByRole("listitem")[0]).toHaveTextContent("Task 00120"));
	expect(screen.getAllByRole("listitem")[0]).toHaveAttribute("aria-setsize", "120");
	expect(screen.getByRole("status")).not.toHaveTextContent("Provider rejects");
	expect(cursors).toContain(null);
	expect(cursors.some((cursor) => cursor !== null)).toBe(true);
});
