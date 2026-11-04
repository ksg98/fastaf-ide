// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createInMemoryWorkItemProvider } from "../../../../plugins/testing/inMemoryWorkItemProvider";
import type { WorkItemDetail } from "../../../../types/work-items.gen";
import { TasksDetail } from "../TasksDetail";
import { detail, provider, reference } from "./detailFixture";

// A stale response from an async provider settles over several microtasks; only a macrotask outlasts them all.
const flushMacrotask = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

afterEach(() => vi.useRealTimers());

describe("TasksDetail", () => {
	// Catches: a rejected transition leaves an optimistic status visible or submits a display name instead of its ID.
	it("failed_status_change_rolls_back", async () => {
		let reject: (error: Error) => void = () => {};
		let submitted = "";
		const source = provider({
			act: async (_ref, action) => {
				if (action.kind === "transition") submitted = action.value;
				return new Promise((_resolve, fail) => {
					reject = fail;
				});
			},
		});
		render(() => <TasksDetail provider={source} reference={reference} />);
		fireEvent.click(await screen.findByRole("button", { name: "Close as completed" }));
		expect(screen.getByRole("status").textContent).toContain("Close as completed");
		expect(submitted).toBe("close-completed");
		reject(new Error("HTTP 422: transition rejected"));
		await screen.findByRole("alert");
		expect(screen.getByRole("status").textContent).toBe("Open");
		expect(screen.getByRole("button", { name: "Close as completed" })).not.toBeDisabled();
	});

	// Catches: sanitization drops a real bot comment's collapsible HTML.
	it("bot_comment_details_survive_sanitize", async () => {
		render(() => <TasksDetail provider={provider()} reference={reference} />);
		await screen.findByText("CodeRabbit");
		const comments = screen.getByLabelText("Comments");
		expect(comments.querySelector("details summary")?.textContent).toContain("Actions performed");
		expect(comments.querySelector("details")?.textContent).toContain("Review triggered.");
	});

	// Catches: comment HTML executes script, event handlers, CSS or javascript links.
	it("script_in_comment_is_removed", async () => {
		const unsafe = detail();
		const entry = unsafe.comments.entries[0];
		if (entry.kind === "normal")
			entry.value.body =
				'<script>alert(1)</script><style>body{display:none}</style><p style="position:fixed" onclick="alert(1)">Safe text</p><a href="javascript:alert(1)">bad link</a>';
		const { container } = render(() => (
			<TasksDetail provider={provider({ detail: async () => unsafe })} reference={reference} />
		));
		await screen.findByText("Safe text");
		expect(container.querySelector("script, style, [onclick], [style], [href^='javascript:']")).toBeNull();
	});

	// Catches: replacing a comment object or its body during refresh collapses an expanded details section.
	it("refresh_keeps_open_details_state", async () => {
		let changed = false;
		const source = provider({
			detail: async () => {
				const value = detail();
				const entry = value.comments.entries[0];
				if (changed && entry.kind === "normal") entry.value.body += "\nUpdated comment.";
				return value;
			},
		});
		render(() => <TasksDetail provider={source} reference={reference} />);
		await screen.findByText("CodeRabbit");
		const comments = () => screen.getByLabelText("Comments");
		const section = comments().querySelector("details");
		if (!section) throw new Error("Missing recorded details");
		section.open = true;
		fireEvent(section, new Event("toggle"));
		changed = true;
		fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
		await screen.findByText("Updated comment.");
		await waitFor(() => expect(comments().querySelector("details")?.open).toBe(true));
	});

	// Catches: provider pagination or review variants are silently omitted from the conversation.
	it("all_comment_sources_and_next_page_are_visible", async () => {
		const value = detail();
		const author = { id: "reviewer", name: "Reviewer", avatarUrl: null, bot: false };
		const comment = {
			id: "thread-comment",
			author,
			body: "Fix this line",
			createdAt: "2026-10-10T12:02:00Z",
			url: null,
		};
		const source = provider({
			comments: async () => ({
				entries: [
					{
						kind: "review_thread",
						value: {
							id: "thread-1",
							resolved: false,
							outdated: false,
							path: "src/main.rs",
							line: 42,
							originalLine: 42,
							commitId: "abc",
							comments: [comment],
							finding: null,
						},
					},
					{
						kind: "review_summary",
						value: {
							comment: { ...comment, id: "summary", body: "Needs changes" },
							state: "CHANGES_REQUESTED",
							commitId: "abc",
						},
					},
				],
				nextCursor: null,
			}),
		});
		value.comments.nextCursor = "page-2";
		const { container } = render(() => <TasksDetail provider={source} reference={reference} />);
		fireEvent.click(await screen.findByRole("button", { name: "Load more comments" }));
		await screen.findByText("Fix this line");
		expect(container.textContent).toContain("src/main.rs:42");
		expect(container.textContent).toContain("CHANGES_REQUESTED");
		expect(container.textContent).toContain("Needs changes");
		expect(screen.queryByRole("button", { name: "Load more comments" })).toBeNull();
	});

	// Catches: editing a field only updates local controls, and submitting a comment clears an unaccepted draft.
	it("edits_and_comments_show_authoritative_action_results", async () => {
		const value = detail();
		const source = provider({
			act: async (_ref, action) => {
				if (action.kind === "edit_field") {
					value.item.fields[action.value.fieldId] = action.value.value;
					value.item.title = "Priority updated";
				}
				if (action.kind === "comment")
					value.comments.entries.push({
						kind: "normal",
						value: {
							id: "new-comment",
							author: { id: "me", name: "Me", avatarUrl: null, bot: false },
							body: action.value,
							createdAt: "2026-10-10T12:03:00Z",
							url: null,
						},
					});
				return { kind: "item", value: structuredClone(value) };
			},
		});
		render(() => <TasksDetail provider={source} reference={reference} />);
		fireEvent.change(await screen.findByLabelText("Priority"), { target: { value: "low" } });
		fireEvent.click(screen.getByRole("button", { name: "Save Priority" }));
		await screen.findByText("Priority updated");
		expect(screen.getByLabelText("Priority")).toHaveValue("low");
		fireEvent.input(screen.getByLabelText("New comment"), { target: { value: "A new comment" } });
		fireEvent.click(screen.getByRole("button", { name: "Add comment" }));
		await screen.findByText("A new comment");
		expect(screen.getByLabelText("New comment")).toHaveValue("");
	});

	// Catches: an enabled provider comment action fails and the user's draft is lost.
	it("rejected_comment_retains_the_draft", async () => {
		render(() => (
			<TasksDetail
				provider={provider({
					act: async () => {
						throw new Error("HTTP 403: comment rejected");
					},
				})}
				reference={reference}
			/>
		));
		fireEvent.input(await screen.findByLabelText("New comment"), { target: { value: "Keep my draft" } });
		fireEvent.click(screen.getByRole("button", { name: "Add comment" }));
		await screen.findByRole("alert");
		expect(screen.getByLabelText("New comment")).toHaveValue("Keep my draft");
	});

	// Catches: the UI accepts an action locally but never displays the real A4 provider's mutation.
	it("a4_fake_transition_and_comment_round_trip_through_the_detail", async () => {
		const source = createInMemoryWorkItemProvider();
		const ref = { providerId: source.providerId, accountId: source.accountId, id: "1" };
		render(() => <TasksDetail provider={source} reference={ref} />);
		fireEvent.click(await screen.findByRole("button", { name: "Closed" }));
		await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Closed"));
		fireEvent.input(screen.getByLabelText("New comment"), { target: { value: "Fake provider persisted this" } });
		fireEvent.click(screen.getByRole("button", { name: "Add comment" }));
		await screen.findByText("Fake provider persisted this");
	});

	// Catches: a late response from the previous item overwrites the newly opened detail.
	it("switching_items_ignores_the_previous_response", async () => {
		let finish: (value: WorkItemDetail) => void = () => {};
		const [ref, setRef] = createSignal(reference);
		const source = provider({
			detail: async (target) => {
				if (target.id === "1")
					return new Promise((resolve) => {
						finish = resolve;
					});
				const value = detail();
				value.item.title = "Second item";
				value.item.reference = target;
				return value;
			},
		});
		render(() => <TasksDetail provider={source} reference={ref()} />);
		setRef({ ...reference, id: "2" });
		await screen.findByText("Second item");
		finish(detail());
		await flushMacrotask();
		expect(screen.queryByText("Inspect the work item")).toBeNull();
	});

	// Catches: the hidden Tasks surface continues polling or never resumes when shown.
	it("periodic_refresh_pauses_while_hidden", async () => {
		vi.useFakeTimers();
		let version = 0;
		const source = provider({
			detail: async () => {
				const value = detail();
				value.item.title = `Version ${++version}`;
				return value;
			},
		});
		const [visible, setVisible] = createSignal(true);
		render(() => <TasksDetail provider={source} reference={reference} visible={visible()} />);
		await vi.advanceTimersByTimeAsync(0);
		expect(screen.getByText("Version 1")).toBeInTheDocument();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(screen.getByText("Version 2")).toBeInTheDocument();
		setVisible(false);
		await vi.advanceTimersByTimeAsync(120_000);
		expect(version).toBe(2);
		setVisible(true);
		await vi.advanceTimersByTimeAsync(0);
		expect(screen.getByText("Version 3")).toBeInTheDocument();
	});

	// Catches: a detail first mounted in a hidden tab never loads when that tab becomes visible.
	it("initially_hidden_detail_loads_when_shown", async () => {
		const [visible, setVisible] = createSignal(false);
		render(() => <TasksDetail provider={provider()} reference={reference} visible={visible()} />);
		expect(screen.queryByText("Inspect the work item")).toBeNull();
		setVisible(true);
		await screen.findByText("Inspect the work item");
	});

	// Catches: a refresh started before a status action resolves later and restores the old state.
	it("refresh_started_before_transition_cannot_overwrite_its_result", async () => {
		let reads = 0;
		let finish: (value: WorkItemDetail) => void = () => {};
		const source = provider({
			detail: async () => {
				if (++reads === 1) return detail();
				return new Promise((resolve) => {
					finish = resolve;
				});
			},
			act: async () => {
				const value = detail();
				value.item.state = { id: "closed", name: "Closed", tone: "neutral" };
				return { kind: "item", value };
			},
		});
		render(() => <TasksDetail provider={source} reference={reference} />);
		fireEvent.click(await screen.findByRole("button", { name: "Refresh" }));
		fireEvent.click(screen.getByRole("button", { name: "Close as completed" }));
		await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Closed"));
		finish(detail());
		await flushMacrotask();
		expect(screen.getByRole("status").textContent).toBe("Closed");
	});
});
