/** Developer fixture: the real PR Files tab and diff viewer; GitHub answers from recorded threads via a fetch stub. */
import { render } from "solid-js/web";
import "../../../global.css";
import "../../../styles.css";
import { PrDiffTab } from "../PrDiffTab";
import type { ReviewThread } from "../reviewThreads";
import { recordedPr } from "./recorded";
import "./preview.css";

const { headSha, threads } = recordedPr(340803);
const state: { threads: ReviewThread[]; moved: boolean; submitted: unknown[] } = {
	threads: structuredClone(threads),
	moved: false,
	submitted: [],
};
(window as unknown as { __fixture: typeof state }).__fixture = state;

const live = threads.find((t) => !t.isOutdated && !t.isResolved) as ReviewThread;
const outdated = threads.find((t) => t.isOutdated) as ReviewThread;
const hunk = (path: string, start: number) =>
	`diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -${start},4 +${start},5 @@\n context before\n-const old = load();\n+const next = await load();\n+validate(next);\n context after\n context tail`;
const hunkAround = (path: string, line: number) => hunk(path, line - 3);
const diff = [hunkAround(live.path, live.line as number), hunkAround("src/other.ts", 10)].join("\n");

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const realFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
	const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
	const body = init?.body ? JSON.parse(String(init.body)) : {};
	switch (url.pathname) {
		case "/repo/pr-line-threads":
			return json({ headSha, threads: state.threads, hasNextPage: false, endCursor: null });
		case "/repo/pr-thread-resolved": {
			const thread = state.threads.find((t) => t.id === body.threadId) as ReviewThread;
			thread.isResolved = body.resolved;
			return json(thread);
		}
		case "/repo/pr-thread-reply": {
			const comment = {
				id: `reply-${Date.now()}`,
				body: body.body,
				author: { login: "you" },
				createdAt: new Date().toISOString(),
			};
			return json(comment);
		}
		case "/repo/pr-draft-review":
			if (state.moved)
				return new Response("review-head-changed: Refresh and review the new commits before submitting", {
					status: 409,
				});
			state.submitted.push(body.draft);
			return json({ id: 1, url: "https://example.invalid/review/1", state: "COMMENTED" });
		case "/repo/file":
			return new Response("", { status: 404 });
		default:
			if (url.pathname.startsWith("/repo/")) return new Response("", { status: 404 });
			return realFetch(input, init);
	}
};

function Preview() {
	return (
		<>
			<div class="fixture-controls">
				<label>
					<input type="checkbox" onChange={(event) => (state.moved = event.currentTarget.checked)} />
					PR head moves before submit
				</label>
				<span id="fixture-ids" data-live={live.id} data-outdated={outdated.id} />
			</div>
			<div class="fixture-tab">
				<PrDiffTab prNumber={340803} prTitle="Recorded review threads" diff={diff} repoPath="/fixture/repo" />
			</div>
		</>
	);
}
const root = document.getElementById("root");
if (!root) throw new Error("Missing fixture root");
render(() => <Preview />, root);
