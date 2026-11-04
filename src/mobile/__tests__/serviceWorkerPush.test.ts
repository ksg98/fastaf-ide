import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";

type Notice = {
	tag: string;
	body: string;
	data: { url: string };
	close: () => void;
};

it("keeps different session pushes actionable while replacing repeats of one session", async () => {
	const handlers = new Map<string, (event: unknown) => void>();
	const notices = new Map<string, Notice>();
	const opened: string[] = [];
	const worker = readFileSync("public/sw.js", "utf8");
	runInNewContext(worker, {
		// Stryker's preamble reads the active mutant from the context's own `process.env`; without it
		// every mutant of sw.js stays inert and the run scores 0 killed.
		process,
		self: {
			addEventListener: (type: string, handler: (event: unknown) => void) => handlers.set(type, handler),
			registration: {
				showNotification: async (_title: string, options: Notice) => {
					// A browser replaces a visible notification with the same tag.
					notices.set(options.tag, { ...options, close: () => undefined });
				},
			},
		},
		clients: {
			matchAll: async () => [],
			openWindow: async (url: string) => {
				opened.push(url);
			},
		},
	});

	async function dispatch(type: string, fields: object) {
		const pending: Promise<unknown>[] = [];
		const handler = handlers.get(type);
		expect(handler, `${type} listener`).toBeDefined();
		handler?.({ ...fields, waitUntil: (promise: Promise<unknown>) => pending.push(promise) });
		await Promise.all(pending);
	}
	async function push(url: string, body: string) {
		await dispatch("push", { data: { json: () => ({ title: "FastAF", body, url }) } });
	}

	await push("/mobile/session/a", "A first question");
	await push("/mobile/session/b", "B question");
	expect(notices.size).toBe(2);

	await push("/mobile/session/a", "A new question");
	expect(notices.size).toBe(2);
	const surviving = [...notices.values()];
	expect(surviving.map((notice) => notice.body).sort()).toEqual(["A new question", "B question"]);
	await push("/mobile", "General alert");
	await push("/mobile", "Updated general alert");
	expect(notices.size).toBe(3);
	expect([...notices.values()].map((notice) => notice.body).sort()).toEqual([
		"A new question",
		"B question",
		"Updated general alert",
	]);
	await push("/mobile?repo=%2Frepo&session=chat-a", "First chat question");
	await push("/mobile?repo=%2Frepo&session=chat-b", "Second chat question");
	expect(notices.size).toBe(5);
	expect(notices.has("tuic-acp-chat-a")).toBe(true);
	expect(notices.has("tuic-acp-chat-b")).toBe(true);
	expect([...notices.values()].map((notice) => notice.body)).toEqual(
		expect.arrayContaining(["First chat question", "Second chat question"]),
	);

	for (const notice of surviving) {
		await dispatch("notificationclick", { notification: notice });
	}
	expect(opened.sort()).toEqual(["/mobile/session/a", "/mobile/session/b"]);
});

it("shows a generic actionable notification for invalid push payloads", async () => {
	const handlers = new Map<string, (event: unknown) => void>();
	const notices: Array<{ title: string; body: string; data: { url: string }; close: () => void }> = [];
	const opened: string[] = [];
	runInNewContext(readFileSync("public/sw.js", "utf8"), {
		// Stryker's preamble reads the active mutant from the context's own `process.env`; without it
		// every mutant of sw.js stays inert and the run scores 0 killed.
		process,
		self: {
			addEventListener: (type: string, handler: (event: unknown) => void) => handlers.set(type, handler),
			registration: {
				showNotification: async (title: string, options: Notice) => {
					notices.push({ title, body: options.body, data: options.data, close: () => undefined });
				},
			},
		},
		clients: {
			matchAll: async () => [],
			openWindow: async (url: string) => {
				opened.push(url);
			},
		},
	});

	async function dispatch(type: string, fields: object) {
		const pending: Promise<unknown>[] = [];
		const handler = handlers.get(type);
		expect(handler, `${type} listener`).toBeDefined();
		handler?.({ ...fields, waitUntil: (promise: Promise<unknown>) => pending.push(promise) });
		await Promise.all(pending);
	}

	const invalidPayloads = [
		{ name: "missing", data: undefined },
		{
			name: "malformed",
			data: {
				json: () => {
					throw new SyntaxError("bad JSON");
				},
			},
		},
		{ name: "null", data: { json: () => null } },
		{ name: "array", data: { json: () => ["unexpected"] } },
		{ name: "string", data: { json: () => "unexpected" } },
		{ name: "number", data: { json: () => 42 } },
	];
	for (const [index, { name, data }] of invalidPayloads.entries()) {
		await dispatch("push", { data });
		expect(notices, `${name} payload creates a new notification`).toHaveLength(index + 1);
		const notice = notices.at(-1);
		expect(notice, `${name} payload shows notification`).toMatchObject({
			title: "FastAF",
			body: "",
			data: { url: "/mobile" },
		});
		if (notice) await dispatch("notificationclick", { notification: notice });
		expect(opened, `${name} click opens a window`).toHaveLength(index + 1);
		expect(opened.at(-1), `${name} notification opens mobile`).toBe("/mobile");
	}
});

type ShownOptions = { tag: string; icon: string; badge: string; data: { url: string } };

async function showPush(url: string): Promise<ShownOptions> {
	let handler: ((event: unknown) => void) | undefined;
	let shown: ShownOptions | undefined;
	runInNewContext(readFileSync("public/sw.js", "utf8"), {
		// See the first test: Stryker needs `process` inside the context.
		process,
		self: {
			addEventListener: (type: string, listener: (event: unknown) => void) => {
				if (type === "push") handler = listener;
			},
			registration: {
				showNotification: async (_title: string, options: ShownOptions) => {
					shown = options;
				},
			},
		},
	});
	const pending: Promise<unknown>[] = [];
	handler?.({
		data: { json: () => ({ title: "FastAF", body: "b", url }) },
		waitUntil: (promise: Promise<unknown>) => pending.push(promise),
	});
	await Promise.all(pending);
	if (!shown) throw new Error("push listener did not show a notification");
	return shown;
}

// Each row names the plausible sw.js bug it catches.
it.each([
	// id capture shortened to one character
	["/mobile/session/abc", "tuic-session-abc"],
	["/mobile/session/abc/", "tuic-session-abc"],
	["/mobile/session/abc?x=1", "tuic-session-abc"],
	["/mobile/session/abc#frag", "tuic-session-abc"],
	// lost ^ anchor: a foreign path containing the session route is not a session deep link
	["/x/mobile/session/a", "tuic-push"],
	// boundary after the id: a longer path is not a session deep link, so it shares the generic tag
	["/mobile/session/a/extra", "tuic-push"],
	// chat deep link still uses its own tag
	["/mobile?repo=%2Frepo&session=chat-a", "tuic-acp-chat-a"],
	// empty fallback tag would merge unrelated generic pushes
	["/mobile", "tuic-push"],
])("tags the push for %s as %s", async (url, tag) => {
	expect((await showPush(url)).tag).toBe(tag);
});

it("shows the app icon and badge and keeps the deep link in the notification data", async () => {
	const options = await showPush("/mobile/session/a");
	expect(options.icon).toBe("/mobile-icon.svg?v=2");
	expect(options.badge).toBe("/mobile-icon.svg?v=2");
	expect(options.data).toEqual({ url: "/mobile/session/a" });
});
